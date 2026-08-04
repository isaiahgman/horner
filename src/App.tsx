import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";

import {
  loadCloudState,
  observeCloudAccount,
  replaceCloudState,
  saveCloudState,
  signInToCloud,
  signOutOfCloud,
} from "./data/cloud.js";
import { loadReadingState, replaceReadingState, saveReadingState } from "./data/database.js";
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
  rolloverIfNeeded,
  setCompletion,
  setPreviousSessionCompletion,
  type ReadingSession,
  type ReadingState,
} from "./domain/state.js";

type View = "today" | "history" | "settings";
type SyncStatus = "local" | "syncing" | "saved" | "offline";

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
              <a href={bibleUrl(label)} target="_blank" rel="noreferrer">{label}</a>
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
  const [account, setAccount] = useState<User | null>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const stateRef = useRef<ReadingState | undefined>(undefined);
  const accountRef = useRef<User | null>(null);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());

  const queueCloudSave = (next: ReadingState, replace = false) => {
    const user = accountRef.current;
    if (!user) return;
    setSyncStatus("syncing");
    syncQueue.current = syncQueue.current
      .catch(() => undefined)
      .then(() => replace ? replaceCloudState(user.uid, next) : saveCloudState(user.uid, next))
      .then(() => setSyncStatus("saved"))
      .catch(() => setSyncStatus("offline"));
  };

  const persistState = (next: ReadingState, replace = false) => {
    stateRef.current = next;
    setState(next);
    void saveReadingState(next);
    queueCloudSave(next, replace);
  };

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: () => void = () => undefined;
    void (async () => {
      const stored = await loadReadingState();
      const current = rolloverIfNeeded(stored ?? createInitialState(new Date()), new Date());
      await saveReadingState(current);
      if (cancelled) return;
      stateRef.current = current;
      setState(current);

      unsubscribe = observeCloudAccount((user) => {
        accountRef.current = user;
        setAccount(user);
        if (!user) {
          setSyncStatus("local");
          return;
        }
        setSyncStatus("syncing");
        void (async () => {
          try {
            const remote = await loadCloudState(user.uid);
            if (cancelled) return;
            if (remote) {
              const refreshed = rolloverIfNeeded(remote, new Date());
              stateRef.current = refreshed;
              setState(refreshed);
              await replaceReadingState(refreshed);
              if (refreshed !== remote) await saveCloudState(user.uid, refreshed);
            } else if (stateRef.current) {
              await replaceCloudState(user.uid, stateRef.current);
            }
            if (!cancelled) setSyncStatus("saved");
          } catch {
            if (!cancelled) setSyncStatus("offline");
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
      setState((current) => {
        if (!current) return current;
        const next = rolloverIfNeeded(current, new Date());
        if (next !== current) {
          stateRef.current = next;
          void saveReadingState(next);
          queueCloudSave(next);
        }
        return next;
      });
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

  const history = useMemo(() => [...(state?.history ?? [])].reverse(), [state?.history]);

  if (!state) {
    return <main className="loading">Opening your next ten…</main>;
  }

  const updateToday = (listId: ListId, completed: boolean) => {
    persistState(setCompletion(state, listId, completed));
  };

  const exportBackup = () => {
    const blob = new Blob([serializeBackup(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `next-ten-backup-${state.activeSession.readingDate}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Backup downloaded.");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = rolloverIfNeeded(parseBackupJson(await file.text()), new Date());
      await replaceReadingState(imported);
      persistState(imported, true);
      setMessage("Backup restored.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not restore this backup.");
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset all reading progress and return to Day 24?")) return;
    const fresh = createInitialState(new Date(), state.settings);
    await replaceReadingState(fresh);
    persistState(fresh, true);
    setMessage("Progress reset to Day 24.");
  };

  const requestPersistentStorage = async () => {
    const granted = await navigator.storage?.persist?.();
    setMessage(granted ? "This device granted persistent storage." : "Storage stays local; keep regular JSON backups.");
  };

  const signIn = async () => {
    try {
      setSyncStatus("syncing");
      await signInToCloud();
    } catch (error) {
      setSyncStatus("local");
      setMessage(error instanceof Error ? error.message : "Google sign-in did not finish.");
    }
  };

  const signOut = async () => {
    await signOutOfCloud();
    setMessage("Signed out. This device still has its local copy.");
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
        {view === "today" && (
          <section className="today-view">
            <div className="session-heading">
              <div>
                <p className="eyebrow">{formatDate(state.activeSession.readingDate)}</p>
                <h2>Here are your next ten.</h2>
              </div>
              <div className="progress-orb" aria-label={`${completedCount(state.activeSession)} of 10 complete`}>
                <strong>{completedCount(state.activeSession)}</strong><span>/10</span>
              </div>
            </div>
            <div className="progress-track"><span style={{ width: `${completedCount(state.activeSession) * 10}%` }} /></div>
            <div className={`sync-chip ${account ? "is-cloud" : ""}`}>
              <span aria-hidden="true">{account ? "●" : "○"}</span>
              {account
                ? syncStatus === "syncing" ? "Saving to cloud…" : syncStatus === "offline" ? "Offline — saved on device" : "Protected in cloud"
                : "Device only — sign in under Settings"}
            </div>
            <SessionRows session={state.activeSession} interactive onChange={updateToday} />
            <p className="quiet-note">Unchecked chapters stay here. Checked chapters advance after the 4:00 a.m. reading-day boundary.</p>
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
                  interactive={index === 0}
                  onChange={index === 0 ? (listId, completed) => {
                    try {
                      persistState(setPreviousSessionCompletion(state, listId, completed));
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
                  <div><strong>Cloud protection is on.</strong><p>{account.email} · {syncStatus === "syncing" ? "Saving…" : syncStatus === "offline" ? "Offline; changes will retry" : "All changes saved"}</p></div>
                  <button type="button" onClick={signOut}>Sign out</button>
                </>
              ) : (
                <>
                  <div><strong>Protect your progress.</strong><p>Sign in with Google so clearing Safari or changing phones cannot erase your reading history.</p></div>
                  <button className="primary-button" type="button" onClick={signIn}>Sign in with Google</button>
                </>
              )}
            </div>
            <div className="setting-card">
              <label htmlFor="rollover">Reading day begins</label>
              <select
                id="rollover"
                value={state.settings.rolloverHour}
                onChange={(event) => persistState({
                  ...state,
                  settings: { ...state.settings, rolloverHour: Number(event.target.value) },
                })}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>{hour === 0 ? "12:00 a.m." : hour < 12 ? `${hour}:00 a.m.` : hour === 12 ? "12:00 p.m." : `${hour - 12}:00 p.m.`}</option>
                ))}
              </select>
            </div>
            <div className="setting-card stack">
              <div><strong>Portable backup.</strong><p>Cloud sync is automatic when signed in. JSON gives you an additional independent copy whenever you want one.</p></div>
              <button type="button" onClick={exportBackup}>Export JSON backup</button>
              <label className="file-button">Import JSON backup<input type="file" accept="application/json,.json" onChange={importBackup} /></label>
              <button type="button" onClick={requestPersistentStorage}>Request persistent storage</button>
            </div>
            <button className="danger-button" type="button" onClick={reset}>Reset to Day 24</button>
          </section>
        )}
      </main>

      {message && <button className="toast" type="button" onClick={() => setMessage("")}>{message}</button>}

      <nav className="bottom-nav" aria-label="Main navigation">
        <button aria-current={view === "today" ? "page" : undefined} className={view === "today" ? "active" : ""} onClick={() => setView("today")} type="button"><NavIcon view="today" />Today</button>
        <button aria-current={view === "history" ? "page" : undefined} className={view === "history" ? "active" : ""} onClick={() => setView("history")} type="button"><NavIcon view="history" />History</button>
        <button aria-current={view === "settings" ? "page" : undefined} className={view === "settings" ? "active" : ""} onClick={() => setView("settings")} type="button"><NavIcon view="settings" />Settings</button>
      </nav>
    </div>
  );
}
