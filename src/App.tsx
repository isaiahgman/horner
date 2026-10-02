import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";

import {
  isCloudDataError,
  isCloudPermissionError,
  isVerifiedGoogleAccount,
} from "./data/cloud-config.js";
import { watchForCloudRefreshEvents } from "./data/cloud-refresh-events.js";
import {
  clearExplicitSignInIntent,
  clearPendingGuestAdoption,
  claimLegacyReadingState,
  GUEST_READING_STATE_SCOPE,
  loadReadingState,
  readExplicitSignInIntent,
  readPendingGuestAdoption,
  readLegacyReadingState,
  replaceReadingState,
  saveReadingState,
  stageExplicitSignInIntent,
  stagePendingGuestAdoption,
  userReadingStateScope,
  type PendingGuestAdoption,
  type ReadingStateScope,
  type UserReadingStateScope,
} from "./data/database.js";
import {
  decideReconciliation,
  resolveLoadedCloudState,
} from "./data/reconcile.js";
import {
  bibleLinkFor,
  isMobileOrTablet,
  type NavigatorLike,
} from "./domain/bible-links.js";
import { parseBackupJson, serializeBackup } from "./domain/backup.js";
import {
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
  type ChapterReference,
  type ListId,
} from "./domain/lists.js";
import {
  additionalCompletedCount,
  chapterAtOffset,
  completeNextAdditionalChapter,
  completedCount,
  coreCompleted,
  createInitialState,
  MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION,
  rebaseReadingState,
  resetReadingState,
  rolloverIfNeeded,
  setCompletion,
  setPreviousSessionCompletedCount,
  setPreviousSessionCompletion,
  setReadingSettings,
  undoLastAdditionalChapter,
  type ReadingSession,
  type ReadingState,
} from "./domain/state.js";

import { isQaPreview, qaCommitSha, qaPrNumber } from "./qa-preview.js";

type View = "today" | "history" | "settings";
type SyncStatus = "local" | "syncing" | "saved" | "offline" | "denied" | "error";

interface ActiveProfileSnapshot {
  readonly generation: number;
  readonly scope: ReadingStateScope;
  readonly userId: string | null;
}

interface PendingGuestAdoptionGuard {
  readonly claimToken: string | null;
  readonly scope: UserReadingStateScope;
}

const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024;
const CLOUD_OPERATION_TIMEOUT_MS = 15_000;
// This is only a one-time local-storage migration marker. It is not an access
// control rule; cloud authorization is UID-scoped in firestore.rules.
const LEGACY_OWNER_EMAIL = isQaPreview ? undefined : "isaiahgathala@gmail.com";

class CloudOperationTimeoutError extends Error {}

function withCloudTimeout<Value>(operation: Promise<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new CloudOperationTimeoutError("Cloud operation timed out")),
      CLOUD_OPERATION_TIMEOUT_MS,
    );
    void operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

type CloudModule = typeof import("./data/cloud.js");
let cloudModulePromise: Promise<CloudModule> | undefined;

function loadCloudModule(): Promise<CloudModule> {
  cloudModulePromise ??= withCloudTimeout(isQaPreview
    ? import("./data/cloud-preview.js")
    : import("./data/cloud.js"))
    .catch((error: unknown) => {
      cloudModulePromise = undefined;
      throw error;
    });
  return cloudModulePromise;
}

function chapterReference(listId: ListId, chapterId: ChapterId): ChapterReference {
  const reference = READING_LIST_BY_ID[listId].chapters.find(({ id }) => id === chapterId);
  if (!reference) throw new RangeError(`${chapterId} is not part of list ${listId}`);
  return reference;
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

function initialAdditionalRevealCount(completedAdditional: number): number {
  const completeBatches = Math.ceil(completedAdditional / 3);
  return Math.min(
    Math.max(3, completeBatches * 3),
    MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION - 1,
  );
}

function SessionRows({
  session,
  interactive,
  mobileReader,
  onChange,
  onContinue,
  expandedListId,
  afterRow,
}: {
  readonly session: ReadingSession;
  readonly interactive: boolean;
  readonly mobileReader: boolean;
  readonly onChange?: ((listId: ListId, completed: boolean) => void) | undefined;
  readonly onContinue?: ((listId: ListId) => void) | undefined;
  readonly expandedListId?: ListId | null | undefined;
  readonly afterRow?: ((listId: ListId) => ReactNode) | undefined;
}) {
  return (
    <div className="chapter-list">
      {LIST_IDS.map((listId, index) => {
        const reference = chapterReference(listId, session.chapters[listId]);
        const label = reference.label;
        const link = bibleLinkFor(reference, mobileReader);
        const checked = coreCompleted(session, listId);
        const additional = additionalCompletedCount(session, listId);
        const canContinue = checked && Boolean(onContinue);
        const continuationId = `continue-${session.readingDate}-${listId}`;
        return (
          <div className="chapter-section" key={listId}>
            <div className={`chapter-row ${checked ? "is-complete" : ""} ${canContinue ? "has-continuation" : ""}`}>
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
                <a
                  href={link.href}
                  target={link.target}
                  rel={link.rel}
                  referrerPolicy="no-referrer"
                  aria-label={mobileReader
                    ? `Open ${label} in YouVersion`
                    : `Open ${label} on ESV.org in a new tab`}
                >
                  {label}
                </a>
              </div>
              {canContinue ? (
                <button
                  className="continue-button"
                  type="button"
                  aria-expanded={expandedListId === listId}
                  aria-controls={continuationId}
                  aria-label={additional > 0
                    ? `Continue ${READING_LIST_BY_ID[listId].name}; ${additional} additional chapters read`
                    : `Read more from ${READING_LIST_BY_ID[listId].name}`}
                  onClick={() => onContinue?.(listId)}
                >
                  <strong aria-hidden="true">{additional > 0 ? `+${additional}` : "+"}</strong>
                  <span aria-hidden="true">More</span>
                </button>
              ) : (
                <span className="open-arrow" aria-hidden="true">↗</span>
              )}
            </div>
            {afterRow?.(listId)}
          </div>
        );
      })}
    </div>
  );
}

function AdditionalChapterRow({
  session,
  listId,
  offset,
  checked,
  interactive,
  mobileReader,
  onChange,
}: {
  readonly session: ReadingSession;
  readonly listId: ListId;
  readonly offset: number;
  readonly checked: boolean;
  readonly interactive: boolean;
  readonly mobileReader: boolean;
  readonly onChange?: ((completed: boolean) => void) | undefined;
}) {
  const reference = chapterAtOffset(session, listId, offset);
  const link = bibleLinkFor(reference, mobileReader);
  const firstChapter = READING_LIST_BY_ID[listId].chapters[0];
  const beginsAgain = offset > 0 && reference.id === firstChapter?.id;
  const positionId = `additional-position-${session.readingDate}-${listId}-${offset}`;

  return (
    <>
      {beginsAgain && <p className="loop-note">List begins again</p>}
      <div className={`additional-row ${checked ? "is-complete" : "is-upcoming"} ${interactive ? "is-actionable" : ""}`}>
        <button
          className="additional-check"
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${checked ? "Mark additional chapter unread" : "Mark additional chapter read"}: ${reference.label}`}
          aria-describedby={positionId}
          disabled={!interactive}
          onClick={() => onChange?.(!checked)}
        >
          <span aria-hidden="true">{checked ? "✓" : ""}</span>
        </button>
        <div className="additional-copy">
          <span id={positionId}>Additional chapter {offset}</span>
          <a
            href={link.href}
            target={link.target}
            rel={link.rel}
            referrerPolicy="no-referrer"
            aria-label={mobileReader
              ? `Open additional ${reference.label} in YouVersion`
              : `Open additional ${reference.label} on ESV.org in a new tab`}
            aria-describedby={positionId}
          >
            {reference.label}
          </a>
        </div>
        <span className="open-arrow" aria-hidden="true">↗</span>
      </div>
    </>
  );
}

function AdditionalReadingPanel({
  session,
  listId,
  revealedCount,
  showEarlier,
  interactive,
  mobileReader,
  onToggleEarlier,
  onShowNext,
  onCollapse,
  onComplete,
  onUndo,
}: {
  readonly session: ReadingSession;
  readonly listId: ListId;
  readonly revealedCount: number;
  readonly showEarlier: boolean;
  readonly interactive: boolean;
  readonly mobileReader: boolean;
  readonly onToggleEarlier: () => void;
  readonly onShowNext: () => void;
  readonly onCollapse: () => void;
  readonly onComplete: (expectedCompletedCount: number) => void;
  readonly onUndo: (expectedCompletedCount: number) => void;
}) {
  const completed = session.completedCounts[listId];
  const additional = additionalCompletedCount(session, listId);
  const boundedRevealed = Math.min(
    revealedCount,
    MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION - 1,
  );
  // Keep the latest completed chapter, the next chapter, and a small preview
  // visible as the reader undoes across previously revealed batch boundaries.
  const compactVisibleEnd = Math.min(
    boundedRevealed,
    Math.max(6, completed + 2),
  );
  const compactedCount = Math.max(0, compactVisibleEnd - 6);
  const hiddenCount = showEarlier ? 0 : compactedCount;
  const visibleEnd = showEarlier ? boundedRevealed : compactVisibleEnd;
  const offsets = Array.from(
    { length: visibleEnd - hiddenCount },
    (_, index) => hiddenCount + index + 1,
  );
  const listName = READING_LIST_BY_ID[listId].name;
  const panelId = `continue-${session.readingDate}-${listId}`;
  const headingId = `${panelId}-heading`;
  const canRevealNextBatch = additional >= boundedRevealed
    && completed < MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION;

  return (
    <section
      className="continuation-panel"
      id={panelId}
      aria-labelledby={headingId}
    >
      <div className="continuation-heading">
        <div>
          <p className="eyebrow">Beyond today&apos;s ten</p>
          <h3 id={headingId}>{listName}</h3>
        </div>
        <span>{additional} today</span>
      </div>

      {compactedCount > 0 && (
        <button
          className="earlier-chapters-button"
          type="button"
          aria-expanded={showEarlier}
          onClick={onToggleEarlier}
        >
          {showEarlier ? "Hide" : "Show"} {compactedCount} earlier additional {compactedCount === 1 ? "chapter" : "chapters"}
          <span aria-hidden="true">{showEarlier ? "⌃" : "⌄"}</span>
        </button>
      )}

      <div className="additional-list">
        {offsets.map((offset) => {
          const checked = offset < completed;
          const isLatestCompleted = checked && offset === completed - 1;
          const isNext = !checked && offset === completed;
          return (
            <AdditionalChapterRow
              key={offset}
              session={session}
              listId={listId}
              offset={offset}
              checked={checked}
              interactive={interactive && (isLatestCompleted || isNext)}
              mobileReader={mobileReader}
              onChange={(nextChecked) => {
                if (nextChecked) onComplete(completed);
                else onUndo(completed);
              }}
            />
          );
        })}
      </div>

      {canRevealNextBatch && (
        <button className="show-next-button" type="button" onClick={onShowNext}>
          Show next 3 chapters
        </button>
      )}
      {completed === MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION && (
        <p className="continuation-limit" role="status">
          This reading day has reached the per-list safety limit.
        </p>
      )}
      <button className="collapse-continuation" type="button" onClick={onCollapse}>
        Collapse
      </button>
    </section>
  );
}

function HistoryAdditionalReading({
  session,
  interactive,
  mobileReader,
  onUndo,
}: {
  readonly session: ReadingSession;
  readonly interactive: boolean;
  readonly mobileReader: boolean;
  readonly onUndo?: ((listId: ListId, expectedCompletedCount: number) => void) | undefined;
}) {
  const [openLists, setOpenLists] = useState<ReadonlySet<ListId>>(() => new Set());
  const listsWithAdditionalReading = LIST_IDS.filter(
    (listId) => additionalCompletedCount(session, listId) > 0,
  );
  if (listsWithAdditionalReading.length === 0) return null;

  return (
    <section className="history-additional" aria-label="Additional chapters">
      <div className="history-additional-heading">
        <strong>Beyond the ten</strong>
        <span>+{additionalCompletedCount(session)}</span>
      </div>
      {listsWithAdditionalReading.map((listId) => {
        const completed = session.completedCounts[listId];
        const additional = additionalCompletedCount(session, listId);
        return (
          <details
            className="history-additional-group"
            key={listId}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setOpenLists((current) => {
                const next = new Set(current);
                if (open) next.add(listId);
                else next.delete(listId);
                return next;
              });
            }}
          >
            <summary>
              <span>{READING_LIST_BY_ID[listId].name}</span>
              <small>
                +{additional} {additional === 1 ? "chapter" : "chapters"}
                <span aria-hidden="true">⌄</span>
              </small>
            </summary>
            {openLists.has(listId) && (
              <div className="additional-list is-history">
                {Array.from({ length: additional }, (_, index) => index + 1).map((offset) => (
                  <AdditionalChapterRow
                    key={offset}
                    session={session}
                    listId={listId}
                    offset={offset}
                    checked
                    interactive={interactive && offset === completed - 1}
                    mobileReader={mobileReader}
                    onChange={() => onUndo?.(listId, completed)}
                  />
                ))}
              </div>
            )}
          </details>
        );
      })}
    </section>
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
  const [expandedListId, setExpandedListId] = useState<ListId | null>(null);
  const [revealedAdditionalCounts, setRevealedAdditionalCounts] = useState<
    Partial<Record<ListId, number>>
  >({});
  const [showEarlierAdditional, setShowEarlierAdditional] = useState(false);
  const stateRef = useRef<ReadingState | undefined>(undefined);
  const accountRef = useRef<User | null>(null);
  const storageScopeRef = useRef<ReadingStateScope>(GUEST_READING_STATE_SCOPE);
  const authGenerationRef = useRef(0);
  const cloudWriteRef = useRef(0);
  const localWriteRef = useRef(0);
  const activeCloudReconciliationRef = useRef<{
    readonly generation: number;
    readonly promise: Promise<void>;
    readonly userId: string;
  } | undefined>(undefined);
  const reconcilingRef = useRef(true);
  const interactionLockCountRef = useRef(1);
  const initialAuthPendingRef = useRef(true);
  const explicitSignInRef = useRef(false);
  const authObserverReadyRef = useRef(false);
  const authObserverUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const authActionRef = useRef<"sign-in" | "sign-out" | undefined>(undefined);
  const pendingGuestAdoptionRef = useRef<PendingGuestAdoptionGuard | undefined>(undefined);
  const cloudConflictRef = useRef(false);
  const cloudDataErrorRef = useRef(false);
  const mountedRef = useRef(true);
  const importInputRef = useRef<HTMLInputElement>(null);

  const captureActiveProfile = (): ActiveProfileSnapshot => ({
    generation: authGenerationRef.current,
    scope: storageScopeRef.current,
    userId: accountRef.current?.uid ?? null,
  });

  const isActiveProfile = (profile: ActiveProfileSnapshot): boolean => (
    mountedRef.current
    && profile.generation === authGenerationRef.current
    && profile.scope === storageScopeRef.current
    && profile.userId === (accountRef.current?.uid ?? null)
  );

  const clearPendingGuestAdoptionGuard = (
    scope: UserReadingStateScope,
    claimToken: string,
  ) => {
    const pending = pendingGuestAdoptionRef.current;
    if (pending?.scope === scope && pending.claimToken === claimToken) {
      pendingGuestAdoptionRef.current = undefined;
    }
  };

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
    if (!user || cloudDataErrorRef.current) return;
    const userScope = userReadingStateScope(user.uid);
    if (pendingGuestAdoptionRef.current?.scope === userScope) {
      // Until a server read proves this account is new, guest-derived local
      // progress must never enter Firestore through an ordinary setDoc.
      return;
    }
    const generation = authGenerationRef.current;
    const userId = user.uid;
    const writeId = ++cloudWriteRef.current;
    setSyncStatus(navigator.onLine ? "syncing" : "offline");

    // Submit every write immediately while the page is active. The scoped
    // IndexedDB copy remains the durable offline source for later retries.
    void withCloudTimeout(loadCloudModule())
      .then((cloud) => cloud.saveCloudState(userId, next))
      .then(() => {
        if (
          writeId === cloudWriteRef.current &&
          generation === authGenerationRef.current &&
          accountRef.current?.uid === userId
        ) {
          setSyncStatus("saved");
        }
      })
      .catch((error: unknown) => {
        if (
          writeId !== cloudWriteRef.current ||
          generation !== authGenerationRef.current ||
          accountRef.current?.uid !== userId
        ) return;
        if (isCloudPermissionError(error)) {
          requireCloudConflictResolution();
        } else {
          setSyncStatus("offline");
        }
      });
  };

  const submitLocalSave = (next: ReadingState) => {
    const scope = storageScopeRef.current;
    const writeId = ++localWriteRef.current;
    // IndexedDB transactions are opened immediately and therefore retain
    // invocation order even if React renders several quick taps together.
    void saveReadingState(scope, next)
      .then(() => {
        if (
          writeId === localWriteRef.current
          && scope === storageScopeRef.current
        ) setStorageError("");
      })
      .catch(() => {
        if (
          writeId === localWriteRef.current
          && scope === storageScopeRef.current
        ) {
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

  const rolloverLocalState = (queueCloudSave = true) => {
    const current = stateRef.current;
    if (!current) return;
    const next = rolloverIfNeeded(current, new Date());
    if (next === current) return;
    stateRef.current = next;
    setState(next);
    submitLocalSave(next);
    if (queueCloudSave) submitCloudSave(next);
  };

  const requestCloudReconciliation = (
    requestedUser: User | null = accountRef.current,
  ): Promise<void> => {
    if (!requestedUser) return Promise.resolve();
    const requestedScope = userReadingStateScope(requestedUser.uid);
    if (
      cloudConflictRef.current ||
      accountRef.current?.uid !== requestedUser.uid ||
      storageScopeRef.current !== requestedScope
    ) return Promise.resolve();
    if (!navigator.onLine) {
      setSyncStatus("offline");
      rolloverLocalState(false);
      return Promise.resolve();
    }

    const generation = authGenerationRef.current;
    const existing = activeCloudReconciliationRef.current;
    if (
      existing?.generation === generation &&
      existing.userId === requestedUser.uid
    ) return existing.promise;

    lockInteractions();
    setSyncStatus("syncing");
    const userId = requestedUser.uid;
    const operation = (async () => {
      try {
        const cloud = await withCloudTimeout(loadCloudModule());
        if (
          generation === authGenerationRef.current
          && accountRef.current?.uid === userId
          && storageScopeRef.current === requestedScope
        ) {
          pendingGuestAdoptionRef.current = {
            scope: requestedScope,
            claimToken: null,
          };
        }
        const guestCandidate = await readPendingGuestAdoption(requestedScope);
        if (
          !mountedRef.current
          || generation !== authGenerationRef.current
          || accountRef.current?.uid !== userId
          || storageScopeRef.current !== requestedScope
        ) return;
        pendingGuestAdoptionRef.current = guestCandidate
          ? { scope: requestedScope, claimToken: guestCandidate.claimToken }
          : undefined;
        try {
          await withCloudTimeout(cloud.waitForCloudWrites());
        } catch (error) {
          if (error instanceof CloudOperationTimeoutError) throw error;
          // A rejected queued write must not prevent reading the authoritative
          // server copy. Reconciliation below decides which state survives.
        }
        const loaded = await withCloudTimeout(cloud.loadCloudState(userId));
        if (
          !mountedRef.current ||
          generation !== authGenerationRef.current ||
          accountRef.current?.uid !== userId ||
          storageScopeRef.current !== requestedScope
        ) return;

        const local = stateRef.current;
        if (!local) return;
        // A pending guest adoption may become this account's local state only
        // when the server has no document. Any existing remote copy wins,
        // regardless of the guest-derived local revision.
        const decision = guestCandidate && loaded
          ? "remote"
          : loaded
            ? decideReconciliation(local, loaded.state)
            : "local";
        const conflictChoice =
          decision === "conflict" && !window.confirm(
            "This device and cloud both have different progress. Press OK to keep this device, or Cancel to restore the cloud copy.",
          )
            ? "remote"
            : "local";
        const resolved = resolveLoadedCloudState(
          local,
          loaded,
          new Date(),
          conflictChoice,
          Boolean(guestCandidate && loaded),
        );

        stateRef.current = resolved.state;
        setState(resolved.state);
        let savedLocally = false;
        try {
          await replaceReadingState(requestedScope, resolved.state);
          savedLocally = true;
          if (
            generation === authGenerationRef.current
            && storageScopeRef.current === requestedScope
          ) setStorageError("");
        } catch {
          if (
            generation === authGenerationRef.current
            && storageScopeRef.current === requestedScope
          ) {
            setStorageError("Cloud progress opened, but this device could not save its local copy. Export a backup before closing.");
          }
        }
        if (savedLocally && guestCandidate && loaded) {
          try {
            const cleared = await clearPendingGuestAdoption(
              requestedScope,
              guestCandidate.claimToken,
            );
            if (cleared) {
              clearPendingGuestAdoptionGuard(
                requestedScope,
                guestCandidate.claimToken,
              );
            }
          } catch {
            // A retained candidate is safe. A later reconciliation will see
            // the account's cloud document and clear it without adopting it.
          }
        }
        if (
          !mountedRef.current ||
          generation !== authGenerationRef.current ||
          accountRef.current?.uid !== userId ||
          storageScopeRef.current !== requestedScope
        ) return;

        cloudDataErrorRef.current = false;
        if (guestCandidate && !loaded) {
          if (!savedLocally) {
            setSyncStatus("offline");
            return;
          }

          const created = await withCloudTimeout(
            cloud.createCloudStateIfAbsent(userId, resolved.state),
          );
          if (created) {
            try {
              const cleared = await clearPendingGuestAdoption(
                requestedScope,
                guestCandidate.claimToken,
              );
              if (cleared) {
                clearPendingGuestAdoptionGuard(
                  requestedScope,
                  guestCandidate.claimToken,
                );
              }
            } catch {
              // Keeping the marker is safe. The next server read will find
              // this newly created document and clear it then.
            }
            if (
              generation === authGenerationRef.current
              && accountRef.current?.uid === userId
              && storageScopeRef.current === requestedScope
            ) setSyncStatus("saved");
            return;
          }

          // Another device created the account between our read and create.
          // Re-read it and make that remote copy authoritative before the
          // guest-adoption marker can be removed.
          const appeared = await withCloudTimeout(cloud.loadCloudState(userId));
          if (!appeared) throw new Error("Cloud profile changed during creation");
          if (
            !mountedRef.current
            || generation !== authGenerationRef.current
            || accountRef.current?.uid !== userId
            || storageScopeRef.current !== requestedScope
          ) return;

          const remoteResolved = resolveLoadedCloudState(
            resolved.state,
            appeared,
            new Date(),
            "remote",
            true,
          );
          stateRef.current = remoteResolved.state;
          setState(remoteResolved.state);
          await replaceReadingState(requestedScope, remoteResolved.state);
          const cleared = await clearPendingGuestAdoption(
            requestedScope,
            guestCandidate.claimToken,
          );
          if (cleared) {
            clearPendingGuestAdoptionGuard(
              requestedScope,
              guestCandidate.claimToken,
            );
          }
          // Local persistence and adoption cleanup can outlive an account
          // change. Never submit this recovered copy through a newer profile.
          if (
            !mountedRef.current
            || generation !== authGenerationRef.current
            || accountRef.current?.uid !== userId
            || storageScopeRef.current !== requestedScope
          ) return;
          if (remoteResolved.upload) submitCloudSave(remoteResolved.state);
          else setSyncStatus("saved");
          return;
        }
        if (resolved.upload) submitCloudSave(resolved.state);
        else setSyncStatus("saved");
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== authGenerationRef.current ||
          accountRef.current?.uid !== userId ||
          storageScopeRef.current !== requestedScope
        ) return;
        if (isCloudDataError(error)) {
          cloudDataErrorRef.current = true;
          setSyncStatus("error");
          setMessage("The cloud copy could not be read safely. This device copy was kept and was not uploaded.");
          rolloverLocalState(false);
        } else if (isCloudPermissionError(error)) {
          const guestGeneration = ++authGenerationRef.current;
          cloudWriteRef.current += 1;
          localWriteRef.current += 1;
          setSyncStatus("denied");
          setMessage("Cloud access was denied. Your device copy was not uploaded.");
          void activateGuestProfile(guestGeneration);
          const cloud = await withCloudTimeout(loadCloudModule()).catch(() => undefined);
          void cloud?.signOutOfCloud().catch(() => undefined);
        } else {
          setSyncStatus("offline");
          rolloverLocalState(false);
        }
      } finally {
        const active = activeCloudReconciliationRef.current;
        if (
          active?.generation === generation &&
          active.userId === userId
        ) {
          activeCloudReconciliationRef.current = undefined;
        }
        unlockInteractions();
      }
    })();
    activeCloudReconciliationRef.current = {
      generation,
      promise: operation,
      userId,
    };
    return operation;
  };

  const beginProfileTransition = () => {
    // Every transition owns a lock. The separate bootstrap lock is released
    // exactly once, so a stale initial auth event cannot unlock a newer one.
    lockInteractions();
    stateRef.current = undefined;
    setState(undefined);
  };

  const finishProfileTransition = () => {
    unlockInteractions();
    finishInitialAuthCheck();
  };

  const activateGuestProfile = async (generation: number): Promise<void> => {
    if (!mountedRef.current || generation !== authGenerationRef.current) return;
    beginProfileTransition();
    accountRef.current = null;
    cloudDataErrorRef.current = false;
    pendingGuestAdoptionRef.current = undefined;
    storageScopeRef.current = GUEST_READING_STATE_SCOPE;
    setAccount(null);
    setSyncStatus("local");
    try {
      let stored: ReadingState | undefined;
      try {
        stored = await loadReadingState(GUEST_READING_STATE_SCOPE);
      } catch {
        if (generation === authGenerationRef.current) {
          setStorageError("Saved guest progress on this device could not be opened. Sign in to restore a cloud copy, or import a JSON backup.");
        }
      }
      if (!mountedRef.current || generation !== authGenerationRef.current) return;

      const base = stored ?? createInitialState(new Date());
      const current = rolloverIfNeeded(base, new Date());
      stateRef.current = current;
      setState(current);
      if (!stored || current !== stored) {
        try {
          await replaceReadingState(GUEST_READING_STATE_SCOPE, current);
          if (mountedRef.current && generation === authGenerationRef.current) {
            setStorageError("");
          }
        } catch {
          if (mountedRef.current && generation === authGenerationRef.current) {
            setStorageError("This device could not save guest progress. Sign in or export a backup before closing.");
          }
        }
      }
    } finally {
      finishProfileTransition();
    }
  };

  const activateUserProfile = async (
    user: User,
    adoptGuestIfNew: boolean,
    generation: number,
    explicitSignInIntentToken?: string,
  ): Promise<void> => {
    if (!mountedRef.current || generation !== authGenerationRef.current) return;
    beginProfileTransition();
    const scope = userReadingStateScope(user.uid);
    storageScopeRef.current = scope;
    accountRef.current = user;
    cloudDataErrorRef.current = false;
    pendingGuestAdoptionRef.current = { scope, claimToken: null };
    setAccount(user);
    setSyncStatus("syncing");
    setMessage("");
    try {
      let current: ReadingState | undefined;
      let guestCandidate: PendingGuestAdoption | undefined;
      let storageReadSucceeded = false;
      try {
        current = await loadReadingState(scope);
        if (
          !isQaPreview
          && !current
          && user.email?.toLowerCase() === LEGACY_OWNER_EMAIL
        ) {
          const legacy = await readLegacyReadingState();
          if (legacy) {
            current = await claimLegacyReadingState(scope, legacy.claimToken);
          }
        }
        guestCandidate = await readPendingGuestAdoption(scope);
        if (!current && !guestCandidate && adoptGuestIfNew) {
          const guest = await loadReadingState(GUEST_READING_STATE_SCOPE)
            ?? createInitialState(new Date());
          guestCandidate = await stagePendingGuestAdoption(scope, guest);
          current = guestCandidate.state;
        } else if (!current && guestCandidate) {
          current = guestCandidate.state;
        }
        storageReadSucceeded = true;
      } catch {
        if (generation === authGenerationRef.current) {
          setStorageError("Saved progress for this account could not be opened. The cloud copy will be checked before changes are enabled.");
        }
      }
      if (
        !mountedRef.current
        || generation !== authGenerationRef.current
        || accountRef.current?.uid !== user.uid
        || storageScopeRef.current !== scope
      ) return;

      if (storageReadSucceeded) {
        pendingGuestAdoptionRef.current = guestCandidate
          ? { scope, claimToken: guestCandidate.claimToken }
          : undefined;
        if (explicitSignInIntentToken) {
          clearExplicitSignInIntent(explicitSignInIntentToken);
        }
      }

      current ??= createInitialState(new Date());
      stateRef.current = current;
      setState(current);
      try {
        await replaceReadingState(scope, current);
        if (generation === authGenerationRef.current) setStorageError("");
      } catch {
        if (generation === authGenerationRef.current) {
          setStorageError("This account's progress could not be saved on this device. Keep cloud protection on or export a backup.");
        }
      }
      if (
        !mountedRef.current
        || generation !== authGenerationRef.current
        || accountRef.current?.uid !== user.uid
        || storageScopeRef.current !== scope
      ) return;

      await requestCloudReconciliation(user);
    } finally {
      finishProfileTransition();
    }
  };

  const handleCloudAccount = (cloud: CloudModule, user: User | null) => {
    const generation = ++authGenerationRef.current;
    cloudWriteRef.current += 1;
    localWriteRef.current += 1;
    if (cloudConflictRef.current) {
      cloudConflictRef.current = false;
      unlockInteractions();
    }
    setReloadRequired(false);

    if (!user) {
      explicitSignInRef.current = false;
      void activateGuestProfile(generation);
      return;
    }
    if (!isVerifiedGoogleAccount(user)) {
      explicitSignInRef.current = false;
      const explicitIntent = readExplicitSignInIntent();
      if (explicitIntent) clearExplicitSignInIntent(explicitIntent.token);
      setSyncStatus("denied");
      setMessage("Cloud protection requires a verified Google account.");
      void activateGuestProfile(generation);
      void cloud.signOutOfCloud().catch(() => undefined);
      return;
    }

    const explicitIntent = readExplicitSignInIntent();
    const adoptGuestIfNew = explicitSignInRef.current || Boolean(explicitIntent);
    explicitSignInRef.current = false;
    void activateUserProfile(
      user,
      adoptGuestIfNew,
      generation,
      explicitIntent?.token,
    );
  };

  const installCloudAccountObserver = (cloud: CloudModule) => {
    if (authObserverReadyRef.current) return;
    authObserverReadyRef.current = true;
    authObserverUnsubscribeRef.current = cloud.observeCloudAccount((user) => {
      if (mountedRef.current) handleCloudAccount(cloud, user);
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      let cloud: CloudModule;
      try {
        cloud = await withCloudTimeout(loadCloudModule());
      } catch {
        if (!cancelled) await activateGuestProfile(authGenerationRef.current);
        return;
      }
      if (cancelled) return;

      installCloudAccountObserver(cloud);
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      authObserverReadyRef.current = false;
      authGenerationRef.current += 1;
      cloudWriteRef.current += 1;
      localWriteRef.current += 1;
      authObserverUnsubscribeRef.current?.();
      authObserverUnsubscribeRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const refreshReadingDate = () => {
      if (reconcilingRef.current) return;
      const current = stateRef.current;
      if (!current || rolloverIfNeeded(current, new Date()) === current) return;
      const user = accountRef.current;
      if (user && navigator.onLine) {
        void requestCloudReconciliation(user);
      } else {
        rolloverLocalState();
      }
    };
    const interval = window.setInterval(refreshReadingDate, 60_000);
    const stopRefreshEvents = watchForCloudRefreshEvents({
      documentTarget: document,
      refreshCloud: () => void requestCloudReconciliation(accountRef.current),
      refreshLocal: refreshReadingDate,
      shouldRefreshCloud: () => Boolean(
        !reconcilingRef.current &&
        !cloudConflictRef.current &&
        accountRef.current &&
        navigator.onLine,
      ),
      windowTarget: window,
    });
    return () => {
      window.clearInterval(interval);
      stopRefreshEvents();
    };
  }, []);

  useEffect(() => {
    const onOffline = () => {
      if (accountRef.current) setSyncStatus("offline");
    };
    const onOnline = () => {
      const user = accountRef.current;
      if (
        !user ||
        cloudConflictRef.current ||
        (reconcilingRef.current && !activeCloudReconciliationRef.current)
      ) return;
      const generation = authGenerationRef.current;
      setSyncStatus("syncing");
      void (async () => {
        if (
          !mountedRef.current ||
          !navigator.onLine ||
          generation !== authGenerationRef.current ||
          accountRef.current?.uid !== user.uid
        ) return;

        const active = activeCloudReconciliationRef.current;
        if (
          active?.generation === generation &&
          active.userId === user.uid
        ) {
          await active.promise;
        }
        if (
          mountedRef.current &&
          navigator.onLine &&
          generation === authGenerationRef.current &&
          accountRef.current?.uid === user.uid
        ) {
          await requestCloudReconciliation(user);
        }
      })();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    setExpandedListId(null);
    setRevealedAdditionalCounts({});
    setShowEarlierAdditional(false);
  }, [account?.uid, state?.activeSession.readingDate]);

  const history = useMemo(() => [...(state?.history ?? [])].reverse(), [state?.history]);
  const mobileReader = useMemo(
    () => isMobileOrTablet(navigator as Navigator & NavigatorLike),
    [],
  );

  if (!state) {
    return <main className="loading">Opening your next ten…</main>;
  }

  const todayCompleted = completedCount(state.activeSession);
  const todayAdditional = additionalCompletedCount(state.activeSession);
  const syncLabel = isQaPreview
    ? "QA preview · synthetic guest data only"
    : reloadRequired
    ? "Cloud version needs review"
    : reconciling
      ? "Checking cloud backup…"
    : account
      ? syncStatus === "syncing"
        ? "Syncing with cloud…"
        : syncStatus === "offline"
          ? "Signed in — cloud unavailable"
          : syncStatus === "error"
            ? "Cloud copy needs attention"
            : "Protected in cloud"
      : syncStatus === "denied"
        ? "Cloud access denied — check Settings"
        : "Device only — sign in under Settings";

  const prepareTodayMutation = (): ReadingState | undefined => {
    if (reconcilingRef.current) return;
    const current = stateRef.current;
    if (!current) return;
    const rolled = rolloverIfNeeded(current, new Date());
    if (rolled !== current) {
      persistState(rolled);
      setExpandedListId(null);
      setMessage("A new reading day has begun. Your tap was not applied; please try again.");
      return;
    }
    return current;
  };

  const revealContinuation = (listId: ListId) => {
    if (expandedListId === listId) {
      setExpandedListId(null);
      setShowEarlierAdditional(false);
      return;
    }
    const completedAdditional = additionalCompletedCount(state.activeSession, listId);
    setRevealedAdditionalCounts((current) => ({
      ...current,
      [listId]: Math.max(
        current[listId] ?? 0,
        initialAdditionalRevealCount(completedAdditional),
      ),
    }));
    setShowEarlierAdditional(false);
    setExpandedListId(listId);
  };

  const updateToday = (listId: ListId, completed: boolean) => {
    const current = prepareTodayMutation();
    if (!current) return;
    try {
      const next = setCompletion(current, listId, completed);
      persistState(next);
      if (!completed && next !== current) {
        setExpandedListId(null);
        setShowEarlierAdditional(false);
      }
    } catch (error) {
      const additional = additionalCompletedCount(current.activeSession, listId);
      if (!completed && additional > 0) {
        setRevealedAdditionalCounts((revealed) => ({
          ...revealed,
          [listId]: Math.max(
            revealed[listId] ?? 0,
            initialAdditionalRevealCount(additional),
          ),
        }));
        setShowEarlierAdditional(false);
        setExpandedListId(listId);
        setMessage(`Undo ${additional} additional ${additional === 1 ? "chapter" : "chapters"} before marking the core chapter unread.`);
      } else {
        setMessage(error instanceof Error ? error.message : "That reading could not be changed.");
      }
    }
  };

  const completeAdditional = (listId: ListId, expectedCompletedCount: number) => {
    const current = prepareTodayMutation();
    if (!current) return;
    try {
      const next = completeNextAdditionalChapter(current, listId, expectedCompletedCount);
      if (next === current) return;
      const reference = chapterAtOffset(current.activeSession, listId, expectedCompletedCount);
      persistState(next);
      setMessage(`${reference.label} marked read. ${additionalCompletedCount(next.activeSession)} additional ${additionalCompletedCount(next.activeSession) === 1 ? "chapter" : "chapters"} today.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That chapter could not be marked read.");
    }
  };

  const undoAdditional = (listId: ListId, expectedCompletedCount: number) => {
    const current = prepareTodayMutation();
    if (!current) return;
    try {
      const next = undoLastAdditionalChapter(current, listId, expectedCompletedCount);
      if (next === current) return;
      const reference = chapterAtOffset(current.activeSession, listId, expectedCompletedCount - 1);
      persistState(next);
      setMessage(`${reference.label} marked unread.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That reading could not be undone.");
    }
  };

  const prepareHistoryMutation = (
    visibleSession: ReadingSession,
    listId: ListId,
    expectedCompletedCount: number,
  ): ReadingState | undefined => {
    if (reconcilingRef.current) return;
    const current = stateRef.current;
    if (!current) return;
    const rolled = rolloverIfNeeded(current, new Date());
    if (rolled !== current) {
      persistState(rolled);
      setMessage("A new reading day has begun. History refreshed; your tap was not applied. Review the latest day and try again.");
      return;
    }

    const latest = current.history.at(-1);
    if (
      !latest
      || latest.readingDate !== visibleSession.readingDate
      || latest.chapters[listId] !== visibleSession.chapters[listId]
      || latest.completedCounts[listId] !== expectedCompletedCount
    ) {
      setMessage("History changed. Your tap was not applied; review the latest reading day and try again.");
      return;
    }
    return current;
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
    if (isQaPreview) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const profile = captureActiveProfile();
    lockInteractions();
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error("That backup is too large to import.");
      }
      const importedState = rolloverIfNeeded(
        parseBackupJson(await file.text(), new Date()),
        new Date(),
      );
      if (!isActiveProfile(profile)) return;
      const current = stateRef.current;
      if (!current) return;
      downloadBackup(current, "-before-import");
      const imported = rebaseReadingState(importedState, current.revision);
      await replaceReadingState(profile.scope, imported);
      if (!isActiveProfile(profile)) return;
      stateRef.current = imported;
      setState(imported);
      setStorageError("");
      submitCloudSave(imported);
      setMessage("Backup restored.");
    } catch (error) {
      if (isActiveProfile(profile)) {
        setMessage(error instanceof Error ? error.message : "Could not restore this backup.");
      }
    } finally {
      unlockInteractions();
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset all reading progress and return to Day 1?")) return;
    const profile = captureActiveProfile();
    const current = stateRef.current;
    if (!current) return;
    lockInteractions();
    try {
      downloadBackup(current, "-before-reset");
      const fresh = resetReadingState(current, new Date());
      await replaceReadingState(profile.scope, fresh);
      if (!isActiveProfile(profile)) return;
      stateRef.current = fresh;
      setState(fresh);
      setStorageError("");
      submitCloudSave(fresh);
      setMessage("Progress reset to Day 1. A safety backup was downloaded.");
    } catch {
      if (isActiveProfile(profile)) {
        setMessage("Progress could not be reset. Your current reading was left unchanged.");
      }
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
    if (isQaPreview) return;
    if (authActionRef.current || reconcilingRef.current) return;
    authActionRef.current = "sign-in";
    lockInteractions();
    let explicitIntentToken: string | undefined;
    try {
      setMessage("");
      setSyncStatus("syncing");
      const cloud = await withCloudTimeout(loadCloudModule());
      explicitIntentToken = stageExplicitSignInIntent()?.token;
      explicitSignInRef.current = true;
      const user = await cloud.signInToCloud();
      if (!isVerifiedGoogleAccount(user)) {
        explicitSignInRef.current = false;
        if (explicitIntentToken) {
          clearExplicitSignInIntent(explicitIntentToken);
        }
        await cloud.signOutOfCloud();
        setSyncStatus("denied");
        setMessage("Cloud protection requires a verified Google account.");
        return;
      }
      // Normally the auth observer performs the profile switch. This fallback
      // recovers if the cloud module could not load during initial startup.
      if (!authObserverReadyRef.current) {
        explicitSignInRef.current = false;
        const generation = ++authGenerationRef.current;
        cloudWriteRef.current += 1;
        localWriteRef.current += 1;
        await activateUserProfile(
          user,
          true,
          generation,
          explicitIntentToken,
        );
        installCloudAccountObserver(cloud);
      }
    } catch (error) {
      explicitSignInRef.current = false;
      if (explicitIntentToken && !accountRef.current) {
        clearExplicitSignInIntent(explicitIntentToken);
      }
      setSyncStatus("local");
      setMessage(error instanceof Error ? error.message : "Google sign-in did not finish.");
    } finally {
      authActionRef.current = undefined;
      unlockInteractions();
    }
  };

  const signOut = async () => {
    if (authActionRef.current || reconcilingRef.current) return;
    authActionRef.current = "sign-out";
    lockInteractions();
    try {
      const cloud = await withCloudTimeout(loadCloudModule());
      await cloud.signOutOfCloud();
      if (!authObserverReadyRef.current) {
        const generation = ++authGenerationRef.current;
        cloudWriteRef.current += 1;
        localWriteRef.current += 1;
        await activateGuestProfile(generation);
      }
      setMessage("Signed out. Your account progress is hidden; this device's guest profile is ready.");
    } catch {
      setMessage("Sign-out did not finish. Try again when you are online.");
    } finally {
      authActionRef.current = undefined;
      unlockInteractions();
    }
  };

  return (
    <div className="app-shell">
      {isQaPreview && (
        <aside className="qa-preview-banner" aria-label="QA preview">
          <strong>QA preview · PR #{qaPrNumber} · {qaCommitSha?.slice(0, 12)}</strong>
          <span>Synthetic guest data only. Sign-in and backup import are disabled. This public link expires.</span>
        </aside>
      )}
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
            {(todayCompleted === 10 || todayAdditional > 0) && (
              <div className="reading-summary" role="status" aria-live="polite">
                {todayCompleted === 10 && <strong>Today&apos;s ten are complete.</strong>}
                {todayAdditional > 0 && (
                  <span>Beyond the ten · {todayAdditional} {todayAdditional === 1 ? "chapter" : "chapters"}</span>
                )}
              </div>
            )}
            <div
              className={`sync-chip ${account ? "is-cloud" : ""} ${syncStatus === "denied" || syncStatus === "error" ? "is-warning" : ""}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true">{account ? "●" : "○"}</span>
              {syncLabel}
            </div>
            <SessionRows
              session={state.activeSession}
              interactive={!reconciling}
              mobileReader={mobileReader}
              onChange={updateToday}
              onContinue={revealContinuation}
              expandedListId={expandedListId}
              afterRow={(listId) => (
                expandedListId === listId
                && coreCompleted(state.activeSession, listId)
              ) ? (
                <AdditionalReadingPanel
                  session={state.activeSession}
                  listId={listId}
                  revealedCount={revealedAdditionalCounts[listId]
                    ?? initialAdditionalRevealCount(
                      additionalCompletedCount(state.activeSession, listId),
                    )}
                  showEarlier={showEarlierAdditional}
                  interactive={!reconciling}
                  mobileReader={mobileReader}
                  onToggleEarlier={() => setShowEarlierAdditional((visible) => !visible)}
                  onShowNext={() => {
                    setRevealedAdditionalCounts((current) => ({
                      ...current,
                      [listId]: Math.min(
                        (current[listId] ?? initialAdditionalRevealCount(
                          additionalCompletedCount(state.activeSession, listId),
                        )) + 3,
                        MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION - 1,
                      ),
                    }));
                    setShowEarlierAdditional(false);
                  }}
                  onCollapse={() => {
                    setExpandedListId(null);
                    setShowEarlierAdditional(false);
                  }}
                  onComplete={(expectedCompletedCount) => {
                    completeAdditional(listId, expectedCompletedCount);
                  }}
                  onUndo={(expectedCompletedCount) => {
                    undoAdditional(listId, expectedCompletedCount);
                  }}
                />
              ) : null}
            />
            <p className="quiet-note">Unchecked chapters stay here. Every chapter you mark read advances this list after the {formatHour(state.settings.rolloverHour)} reading-day boundary.</p>
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
                  <span>
                    <strong>{formatDate(session.readingDate)}</strong>
                    <small>
                      {completedCount(session)} of 10 completed
                      {additionalCompletedCount(session) > 0
                        ? ` · +${additionalCompletedCount(session)} more`
                        : ""}
                    </small>
                  </span>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <SessionRows
                  session={session}
                  interactive={!reconciling && index === 0}
                  mobileReader={mobileReader}
                  onChange={index === 0 ? (listId, completed) => {
                    try {
                      const current = prepareHistoryMutation(
                        session,
                        listId,
                        session.completedCounts[listId],
                      );
                      if (!current) return;
                      persistState(setPreviousSessionCompletion(current, listId, completed));
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "That reading can no longer be changed.");
                    }
                  } : undefined}
                />
                <HistoryAdditionalReading
                  session={session}
                  interactive={!reconciling && index === 0}
                  mobileReader={mobileReader}
                  onUndo={index === 0 ? (listId, expectedCompletedCount) => {
                    try {
                      const current = prepareHistoryMutation(
                        session,
                        listId,
                        expectedCompletedCount,
                      );
                      if (!current) return;
                      const next = setPreviousSessionCompletedCount(
                        current,
                        listId,
                        expectedCompletedCount - 1,
                      );
                      if (next === current) return;
                      const reference = chapterAtOffset(
                        session,
                        listId,
                        expectedCompletedCount - 1,
                      );
                      persistState(next);
                      setMessage(`${reference.label} removed from this reading day.`);
                    } catch (error) {
                      setMessage(error instanceof Error
                        ? error.message
                        : "That reading can no longer be changed.");
                    }
                  } : undefined}
                />
                {index === 0 && <p className="quiet-note">You can correct the latest reading until a later chapter in that list is marked complete.</p>}
              </details>
            ))}
          </section>
        )}

        {view === "settings" && (
          <section className="secondary-view settings-view">
            <p className="eyebrow">Local and private</p>
            <h2>Settings</h2>
            {isQaPreview ? (
            <div className="setting-card"><strong>Synthetic QA preview.</strong><p>Reading stays in this preview’s local guest profile. Cloud accounts and personal backup imports are disabled.</p></div>
            ) : <div className={`setting-card cloud-card ${account ? "connected" : ""}`}>
              {account ? (
                <>
                  <div><strong>{syncStatus === "saved" ? "Cloud protection is on." : "Signed in to cloud."}</strong><p>{account.email} · {syncStatus === "syncing" ? "Checking and saving…" : syncStatus === "offline" ? "Cloud unavailable; device copy is safe" : syncStatus === "error" ? "Cloud copy could not be read; device copy was not uploaded" : syncStatus === "denied" ? "Another cloud version needs review" : "All changes saved"}</p><p>Only this verified Google account can read the cloud copy.</p></div>
                  {(syncStatus === "offline" || syncStatus === "error") && <button type="button" onClick={() => void requestCloudReconciliation()} disabled={reconciling}>Retry cloud</button>}
                  <button type="button" onClick={signOut} disabled={reconciling}>Sign out</button>
                </>
              ) : (
                <>
                  <div><strong>{syncStatus === "denied" ? "Cloud access needs attention." : "Protect your progress."}</strong><p>Sign in with your Google account so clearing browser data or changing phones does not erase your reading history.</p></div>
                  <button className="primary-button" type="button" onClick={signIn} disabled={reconciling}>{reconciling ? "Checking cloud…" : "Sign in with Google"}</button>
                </>
              )}
            </div>}
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
              <div><strong>Portable backup.</strong><p>{isQaPreview ? "Export synthetic test progress only. Do not use this temporary preview for personal reading." : "Cloud sync is automatic when signed in. JSON gives you an additional independent copy whenever you want one."}</p></div>
              <button type="button" onClick={exportBackup}>Export JSON backup</button>
              {!isQaPreview && <>
                <button type="button" onClick={() => importInputRef.current?.click()} disabled={reconciling}>Import JSON backup</button>
                <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={importBackup} />
              </>}
              <button type="button" onClick={requestPersistentStorage}>Request persistent storage</button>
            </div>
            <button className="danger-button" type="button" onClick={reset} disabled={reconciling}>Reset to Day 1</button>
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
