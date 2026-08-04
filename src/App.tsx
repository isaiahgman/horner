import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";

import { CLOUD_OWNER_EMAIL, isCloudPermissionError } from "./data/cloud-config.js";
import { loadReadingState, replaceReadingState, saveReadingState } from "./data/database.js";
import { decideReconciliation } from "./data/reconcile.js";
import { parseBackupJson, serializeBackup } from "./domain/backup.js";
import {
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
  type ListId,
} from "./domain/lists.js";
import {
  completedCount,
  createInitialState,
  rebaseReadingState,
  resetReadingState,
  rolloverIfNeeded,
  setCompletion,
  setPreviousSessionCompletion,
  setReadingSettings,
  type ReadingSession,
  type ReadingState,
} from "./domain/state.js";

type View = "today" | "history" | "settings";
type SyncStatus = "local" | "syncing" | "saved" | "offline" | "denied";

const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024;

type CloudModule = typeof import("./data/cloud.js");
let cloudModulePromise: Promise<CloudModule> | undefined;

function loadCloudModule(): Promise<CloudModule> {
  cloudModulePromise ??= import("./data/cloud.js").catch((error: unknown) => {
    cloudModulePromise = undefined;
    throw error;
  });
  return cloudModulePromise;
}

function chapterLabel(listId: ListId, chapterId: ChapterId): string {
  return (
    READING_LIST_BY_ID[listId].chapters.find(({ id }) => id === chapterId)?.label ??
    chapterId
  );
}

function NavIcon({ view }: { readonly view: View }) {
  if (view === "today") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.25" />
        <path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.46 5.46l1.42 1.42M17.12 17.12l1.42 1.42M18.54 5.46l-1.42 1.42M6.88 17.12l-1.42 1.42" />
      </svg>
    );
  }
  if (view === "history") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 7.75v4.7l3.2 1.85" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h7M15 6.5h5M4 12h3M11 12h9M4 17.5h9M17 17.5h3" />
      <circle cx="13" cy="6.5" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17.5" r="2" />
    </svg>
  );
}

function formatDate(dateKey: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${dateKey}T12:00:00`));
}

function formatHour(hour: number): string {
  if (hour === 0) return "12:00 a.m.";
  if (hour < 12) return `${hour}:00 a.m.`;
  if (hour === 12) return "12:00 p.m.";
  return `${hour - 12}:00 p.m.`;
}

function bibleUrl(label: string): string {
  return `https://www.biblegateway.com/passage/?search=${encodeURIComponent(label)}`;
}

function SessionRows({
  session,
  interactive,
  onChange,
}: {
  readonly session: ReadingSession;
  readonly interactive: boolean;
  readonly onChange?: ((listId: ListId, completed: boolean) => void) | undefined;
}) {
  return (
    <div className="chapter-list">
      {LIST_IDS.map((listId, index) => {
        const label = chapterLabel(listId, session.chapters[listId]);
        const checked = session.completed[listId];
        return (
          <div className={`chapter-row ${checked ? "is-complete" : ""}`} key={listId}>
            <button
              className="check-button"
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={`${checked ? "Mark unread" : "Mark read"}: ${label}`}
              disabled={!interactive}
              onClick={() => onChange?.(listId, !checked)}
            >
              <span aria-hidden="true">{checked ? "✓" : ""}</span>
            </button>
            <div className="chapter-copy">
              <span className="list-name">{index + 1}. {READING_LIST_BY_ID[listId].name}</span>
              <a href={bibleUrl(label)} target="_blank" rel="noopener noreferrer">{label}</a>
            </div>
            <span className="open-arrow" aria-hidden="true">↗</span>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<ReadingState>();
  const [view, setView] = useState<View>("today");
  const [message, setMessage] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const [account, setAccount] = useState<User | null>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const [reconciling, setReconciling] = useState(true);
  const [storageError, setStorageError] = useState("");
  const stateRef = useRef<ReadingState | undefined>(undefined);
  const accountRef = useRef<User | null>(null);
  const authGenerationRef = useRef(0);
  const cloudWriteRef = useRef(0);
  const localWriteRef = useRef(0);
  const reconcilingRef = useRef(true);
  const interactionLockCountRef = useRef(1);
  const initialAuthPendingRef = useRef(true);
  const cloudReconcileNeededRef = useRef(false);
  const cloudConflictRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const lockInteractions = () => {
    interactionLockCountRef.current += 1;
    reconcilingRef.current = true;
    setReconciling(true);
  };

  const unlockInteractions = () => {
    interactionLockCountRef.current = Math.max(0, interactionLockCountRef.current - 1);
    const locked = interactionLockCountRef.current > 0;
    reconcilingRef.current = locked;
    setReconciling(locked);
  };

  const finishInitialAuthCheck = () => {
    if (!initialAuthPendingRef.current) return;
    initialAuthPendingRef.current = false;
    unlockInteractions();
  };

  const requireCloudConflictResolution = () => {
    if (cloudConflictRef.current) return;
    cloudConflictRef.current = true;
    setSyncStatus("denied");
    lockInteractions();
    setReloadRequired(true);
    setMessage("Cloud has another version. Your device copy is safe; reload to choose which progress to keep.");
  };

  const submitCloudSave = (next: ReadingState) => {
    const user = accountRef.current;
    if (!user) return;
    const writeId = ++cloudWriteRef.current;
    setSyncStatus(navigator.onLine ? "syncing" : "offline");

    // Submit every write immediately. Firestore can then place every mutation
    // in its durable offline queue instead of leaving later taps in JS memory.
    void loadCloudModule()
      .then((cloud) => cloud.saveCloudState(user.uid, next))
      .then(() => {
        if (writeId === cloudWriteRef.current) setSyncStatus("saved");
      })
      .catch((error: unknown) => {
        if (writeId !== cloudWriteRef.current) return;
        if (isCloudPermissionError(error)) {
          requireCloudConflictResolution();
        } else {
          setSyncStatus("offline");
        }
      });
  };

  const submitLocalSave = (next: ReadingState) => {
    const writeId = ++localWriteRef.current;
    // IndexedDB transactions are opened immediately and therefore retain
    // invocation order even if React renders several quick taps together.
    void saveReadingState(next)
      .then(() => {
        if (writeId === localWriteRef.current) setStorageError("");
      })
      .catch(() => {
        if (writeId === localWriteRef.current) {
          setStorageError("This device could not save locally. Keep cloud protection on or export a backup before closing.");
        }
      });
  };

  const persistState = (next: ReadingState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    submitLocalSave(next);
    submitCloudSave(next);
  };

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: () => void = () => undefined;
    void (async () => {
      let current: ReadingState;
      try {
        const stored = await loadReadingState();
        current = rolloverIfNeeded(stored ?? createInitialState(new Date()), new Date());
        if (!stored || current !== stored) submitLocalSave(current);
      } catch {
        current = createInitialState(new Date());
        setStorageError("Saved progress on this device could not be opened. Sign in to restore the cloud copy, or import a JSON backup.");
      }
      if (cancelled) return;
      stateRef.current = current;
      setState(current);

      let cloud: CloudModule;
      try {
        cloud = await loadCloudModule();
      } catch {
        setSyncStatus("local");
        finishInitialAuthCheck();
        return;
      }
      if (cancelled) return;

      unsubscribe = cloud.observeCloudAccount((user) => {
        const generation = ++authGenerationRef.current;
        if (!user) {
          finishInitialAuthCheck();
          accountRef.current = null;
          cloudReconcileNeededRef.current = false;
          setAccount(null);
          setSyncStatus("local");
          setState(stateRef.current);
          return;
        }
        lockInteractions();
        finishInitialAuthCheck();
        if (
          user.email?.toLowerCase() !== CLOUD_OWNER_EMAIL ||
          !user.emailVerified
        ) {
          accountRef.current = null;
          setAccount(null);
          setSyncStatus("denied");
          setMessage(`That Google account is not authorized. Use ${CLOUD_OWNER_EMAIL}.`);
          setState(stateRef.current);
          void cloud.signOutOfCloud().catch(() => undefined);
          unlockInteractions();
          return;
        }
        accountRef.current = user;
        setAccount(user);
        if (!navigator.onLine) {
          cloudReconcileNeededRef.current = true;
          setSyncStatus("offline");
          setState(stateRef.current);
          unlockInteractions();
          return;
        }
        setSyncStatus("syncing");
        void (async () => {
          try {
            const loaded = await cloud.loadCloudState(user.uid);
            if (
              cancelled ||
              generation !== authGenerationRef.current ||
              accountRef.current?.uid !== user.uid
            ) return;
            cloudReconcileNeededRef.current = false;

            const local = stateRef.current ?? current;
            let resolved = local;
            let upload = !loaded;
            if (loaded) {
              const remote = rolloverIfNeeded(loaded.state, new Date());
              const decision = decideReconciliation(local, remote);
              const keepLocal =
                decision === "local" ||
                (decision === "conflict" && window.confirm(
                  "This device and cloud both have different progress. Press OK to keep this device, or Cancel to restore the cloud copy.",
                ));
              if (keepLocal) {
                if (decision === "conflict") {
                  resolved = rebaseReadingState(local, remote.revision);
                }
                upload = true;
              } else if (decision === "remote" || decision === "conflict") {
                resolved = remote;
              }
              if (decision === "same") resolved = remote;
              upload ||= loaded.needsMigration || remote !== loaded.state;
            }

            stateRef.current = resolved;
            setState(resolved);
            try {
              await replaceReadingState(resolved);
              setStorageError("");
            } catch {
              setStorageError("Cloud progress opened, but this device could not save its local copy. Export a backup before closing.");
            }
            if (upload) submitCloudSave(resolved);
            else setSyncStatus("saved");
          } catch (error) {
            if (
              !cancelled &&
              generation === authGenerationRef.current
            ) {
              setState(stateRef.current);
              if (isCloudPermissionError(error)) {
                accountRef.current = null;
                setAccount(null);
                setSyncStatus("denied");
                setMessage(`Cloud access was denied. Sign in with ${CLOUD_OWNER_EMAIL}.`);
                void cloud.signOutOfCloud().catch(() => undefined);
              } else {
                cloudReconcileNeededRef.current = true;
                setSyncStatus("offline");
              }
            }
          } finally {
            unlockInteractions();
          }
        })();
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const refresh = () => {
      if (reconcilingRef.current) return;
      const current = stateRef.current;
      if (!current) return;
      const next = rolloverIfNeeded(current, new Date());
      if (next !== current) persistState(next);
    };
    const interval = window.setInterval(refresh, 60_000);
    const onVisibility = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    const onOffline = () => {
      if (accountRef.current) setSyncStatus("offline");
    };
    const onOnline = () => {
      if (!accountRef.current) return;
      if (cloudReconcileNeededRef.current) {
        setSyncStatus("syncing");
        void loadCloudModule()
          .then((cloud) => cloud.waitForCloudWrites())
          .catch(() => undefined)
          .finally(() => window.location.reload());
        return;
      }
      const writeId = cloudWriteRef.current;
      setSyncStatus("syncing");
      void loadCloudModule()
        .then((cloud) => cloud.waitForCloudWrites())
        .then(() => {
          if (writeId === cloudWriteRef.current) setSyncStatus("saved");
        })
        .catch((error: unknown) => {
          if (writeId !== cloudWriteRef.current) return;
          if (isCloudPermissionError(error)) {
            requireCloudConflictResolution();
          } else {
            setSyncStatus("offline");
          }
        });
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const history = useMemo(() => [...(state?.history ?? [])].reverse(), [state?.history]);

  if (!state) {
    return <main className="loading">Opening your next ten…</main>;
  }

  const todayCompleted = completedCount(state.activeSession);
  const syncLabel = reloadRequired
    ? "Cloud version needs review"
    : reconciling
      ? "Checking cloud backup…"
    : account
      ? syncStatus === "syncing"
        ? "Saving to cloud…"
        : syncStatus === "offline"
          ? "Offline — changes will retry"
          : "Protected in cloud"
      : syncStatus === "denied"
        ? "Cloud access denied — check Settings"
        : "Device only — sign in under Settings";

  const updateToday = (listId: ListId, completed: boolean) => {
    const current = stateRef.current;
    if (current) persistState(setCompletion(current, listId, completed));
  };

  const downloadBackup = (backupState: ReadingState, suffix = "") => {
    const blob = new Blob([serializeBackup(backupState)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `next-ten-backup-${backupState.activeSession.readingDate}${suffix}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const exportBackup = () => {
    downloadBackup(stateRef.current ?? state);
    setMessage("Backup downloaded.");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    lockInteractions();
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error("That backup is too large to import.");
      }
      const importedState = rolloverIfNeeded(
        parseBackupJson(await file.text(), new Date()),
        new Date(),
      );
      const current = stateRef.current ?? state;
      downloadBackup(current, "-before-import");
      const imported = rebaseReadingState(importedState, current.revision);
      await replaceReadingState(imported);
      stateRef.current = imported;
      setState(imported);
      setStorageError("");
      submitCloudSave(imported);
      setMessage("Backup restored.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not restore this backup.");
    } finally {
      unlockInteractions();
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset all reading progress and return to Day 24?")) return;
    const current = stateRef.current ?? state;
    lockInteractions();
    try {
      downloadBackup(current, "-before-reset");
      const fresh = resetReadingState(current, new Date());
      await replaceReadingState(fresh);
      stateRef.current = fresh;
      setState(fresh);
      setStorageError("");
      submitCloudSave(fresh);
      setMessage("Progress reset to Day 24. A safety backup was downloaded.");
    } catch {
      setMessage("Progress could not be reset. Your current reading was left unchanged.");
    } finally {
      unlockInteractions();
    }
  };

  const requestPersistentStorage = async () => {
    try {
      const granted = await navigator.storage?.persist?.();
      setMessage(granted ? "This device granted persistent storage." : "Storage stays local; keep regular JSON backups.");
    } catch {
      setMessage("This browser could not change its storage setting. Cloud protection and JSON backups still work.");
    }
  };

  const signIn = async () => {
    try {
      setSyncStatus("syncing");
      const cloud = await loadCloudModule();
      await cloud.signInToCloud();
    } catch (error) {
      setSyncStatus("local");
      setMessage(error instanceof Error ? error.message : "Google sign-in did not finish.");
    }
  };

  const signOut = async () => {
    try {
      const cloud = await loadCloudModule();
      await cloud.signOutOfCloud();
      setMessage("Signed out. This device still has its local copy.");
    } catch {
      setMessage("Sign-out did not finish. Try again when you are online.");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">10</div>
        <div>
          <p className="eyebrow">Horner reading</p>
          <h1>Next Ten</h1>
        </div>
      </header>

      <main>
        {storageError && <div className="storage-alert" role="alert">{storageError}</div>}
        {view === "today" && (
          <section className="today-view">
            <div className="session-heading">
              <div>
                <p className="eyebrow">{formatDate(state.activeSession.readingDate)}</p>
                <h2>Here are your next ten.</h2>
              </div>
              <div
                className="progress-orb"
                role="progressbar"
                aria-label="Chapters completed today"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={todayCompleted}
              >
                <strong>{todayCompleted}</strong><span>/10</span>
              </div>
            </div>
            <div className="progress-track" aria-hidden="true"><span style={{ width: `${todayCompleted * 10}%` }} /></div>
            <div
              className={`sync-chip ${account ? "is-cloud" : syncStatus === "denied" ? "is-warning" : ""}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true">{account ? "●" : "○"}</span>
              {syncLabel}
            </div>
            <SessionRows session={state.activeSession} interactive={!reconciling} onChange={updateToday} />
            <p className="quiet-note">Unchecked chapters stay here. Checked chapters advance after the {formatHour(state.settings.rolloverHour)} reading-day boundary.</p>
          </section>
        )}

        {view === "history" && (
          <section className="secondary-view">
            <p className="eyebrow">Your reading</p>
            <h2>History</h2>
            {history.length === 0 ? (
              <div className="empty-state">Your completed reading days will appear here after the first rollover.</div>
            ) : history.map((session, index) => (
              <details className="history-card" key={session.readingDate}>
                <summary>
                  <span><strong>{formatDate(session.readingDate)}</strong><small>{completedCount(session)} of 10 completed</small></span>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <SessionRows
                  session={session}
                  interactive={!reconciling && index === 0}
                  onChange={index === 0 ? (listId, completed) => {
                    try {
                      const current = stateRef.current;
                      if (current) {
                        persistState(setPreviousSessionCompletion(current, listId, completed));
                      }
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "That reading can no longer be changed.");
                    }
                  } : undefined}
                />
                {index === 0 && <p className="quiet-note">You can correct the latest session until its next chapter is marked complete.</p>}
              </details>
            ))}
          </section>
        )}

        {view === "settings" && (
          <section className="secondary-view settings-view">
            <p className="eyebrow">Local and private</p>
            <h2>Settings</h2>
            <div className={`setting-card cloud-card ${account ? "connected" : ""}`}>
              {account ? (
                <>
                  <div><strong>Cloud protection is on.</strong><p>{account.email} · {syncStatus === "syncing" ? "Saving…" : syncStatus === "offline" ? "Offline; changes will retry" : syncStatus === "denied" ? "Another cloud version needs review" : "All changes saved"}</p><p>Only this verified Google account can read the cloud copy.</p></div>
                  {syncStatus === "offline" && <button type="button" onClick={() => window.location.reload()}>Retry cloud</button>}
                  <button type="button" onClick={signOut} disabled={reconciling}>Sign out</button>
                </>
              ) : (
                <>
                  <div><strong>{syncStatus === "denied" ? "Cloud access needs attention." : "Protect your progress."}</strong><p>Sign in with {CLOUD_OWNER_EMAIL} so clearing Safari or changing phones cannot erase your reading history.</p></div>
                  <button className="primary-button" type="button" onClick={signIn} disabled={reconciling}>{reconciling ? "Checking cloud…" : "Sign in with Google"}</button>
                </>
              )}
            </div>
            <div className="setting-card">
              <label htmlFor="rollover">Reading day begins</label>
              <select
                id="rollover"
                value={state.settings.rolloverHour}
                disabled={reconciling}
                onChange={(event) => {
                  const current = stateRef.current;
                  if (current) {
                    persistState(setReadingSettings(current, {
                      ...current.settings,
                      rolloverHour: Number(event.target.value),
                    }));
                  }
                }}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>{formatHour(hour)}</option>
                ))}
              </select>
            </div>
            <div className="setting-card stack">
              <div><strong>Portable backup.</strong><p>Cloud sync is automatic when signed in. JSON gives you an additional independent copy whenever you want one.</p></div>
              <button type="button" onClick={exportBackup}>Export JSON backup</button>
              <button type="button" onClick={() => importInputRef.current?.click()} disabled={reconciling}>Import JSON backup</button>
              <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={importBackup} />
              <button type="button" onClick={requestPersistentStorage}>Request persistent storage</button>
            </div>
            <button className="danger-button" type="button" onClick={reset} disabled={reconciling}>Reset to Day 24</button>
          </section>
        )}
      </main>

      {message && (
        <div className="toast" role="status" aria-live="polite">
          <span>{message}</span>
          <button
            type="button"
            aria-label={reloadRequired ? "Reload and reconcile cloud progress" : "Dismiss message"}
            onClick={() => reloadRequired ? window.location.reload() : setMessage("")}
          >{reloadRequired ? "Reload" : "×"}</button>
        </div>
      )}

      <nav className="bottom-nav" aria-label="Main navigation">
        <button aria-current={view === "today" ? "page" : undefined} className={view === "today" ? "active" : ""} onClick={() => setView("today")} type="button"><NavIcon view="today" />Today</button>
        <button aria-current={view === "history" ? "page" : undefined} className={view === "history" ? "active" : ""} onClick={() => setView("history")} type="button"><NavIcon view="history" />History</button>
        <button aria-current={view === "settings" ? "page" : undefined} className={view === "settings" ? "active" : ""} onClick={() => setView("settings")} type="button"><NavIcon view="settings" />Settings</button>
      </nav>
    </div>
  );
}
