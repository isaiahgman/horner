import Dexie, { type EntityTable } from "dexie";

import { normalizeReadingState } from "../domain/backup.js";
import { decodeCloudState, encodeCloudCurrent } from "./cloud-codec.js";
import type { ReadingState } from "../domain/state.js";

export const GUEST_READING_STATE_SCOPE = "guest" as const;
export type UserReadingStateScope = `user:${string}`;
export type ReadingStateScope =
  | typeof GUEST_READING_STATE_SCOPE
  | UserReadingStateScope;

const USER_SCOPE_PREFIX = "user:";
const FIREBASE_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_STATE_PREFIX = "horner-next-ten-pending-v3:";
const LEGACY_PENDING_STATE_KEY = "horner-next-ten-pending-v2";
const LEGACY_STATE_ID = "primary";
const PENDING_GUEST_ADOPTION_PREFIX = "pending-guest-adoption:";
const PENDING_GUEST_ADOPTION_KIND = "pending-guest-adoption";
const EXPLICIT_SIGN_IN_INTENT_KEY = "horner-next-ten-explicit-sign-in-v1";
export const EXPLICIT_SIGN_IN_INTENT_TTL_MS = 10 * 60 * 1_000;
const CLAIM_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const DATABASE_TIMEOUT_MS = 5_000;

type PendingGuestAdoptionId =
  `${typeof PENDING_GUEST_ADOPTION_PREFIX}${UserReadingStateScope}`;
type StoredStateId =
  | ReadingStateScope
  | typeof LEGACY_STATE_ID
  | PendingGuestAdoptionId;

interface StoredState {
  readonly id: StoredStateId;
  readonly state: ReadingState;
  readonly kind?: typeof PENDING_GUEST_ADOPTION_KIND;
  readonly claimToken?: string;
}

export interface LegacyReadingState {
  readonly state: ReadingState;
  /** Opaque proof that both legacy stores are unchanged when claimed. */
  readonly claimToken: string;
}

export interface PendingGuestAdoption {
  readonly state: ReadingState;
  /** Opaque concurrency token required to clear this exact candidate. */
  readonly claimToken: string;
}

export interface ExplicitSignInIntent {
  readonly token: string;
  readonly createdAt: number;
}

interface LegacySnapshot extends LegacyReadingState {
  readonly pendingStorage: Storage | undefined;
  readonly pendingValue: string | null | undefined;
}

class HornerDatabase extends Dexie {
  appState!: EntityTable<StoredState, "id">;

  constructor() {
    super("horner-next-ten");
    // The primary key was already an unqualified string in version 1, so
    // scoped IDs can share the existing store without an IndexedDB upgrade.
    this.version(1).stores({ appState: "id" });
  }
}

const database = new HornerDatabase();

function withTimeout<Value>(operation: Promise<Value>, description: string): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(`${description} timed out`)),
      DATABASE_TIMEOUT_MS,
    );
    void operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(description));
      },
    );
  });
}

function assertFirebaseUid(uid: unknown): asserts uid is string {
  if (typeof uid !== "string" || !FIREBASE_UID_PATTERN.test(uid)) {
    throw new TypeError(
      "Firebase UID must contain 1 to 128 letters, numbers, underscores, or hyphens",
    );
  }
}

function userIdFromScope(scope: UserReadingStateScope): string {
  const uid = scope.slice(USER_SCOPE_PREFIX.length);
  assertFirebaseUid(uid);
  return uid;
}

function assertReadingStateScope(scope: unknown): asserts scope is ReadingStateScope {
  if (scope === GUEST_READING_STATE_SCOPE) return;
  if (typeof scope !== "string" || !scope.startsWith(USER_SCOPE_PREFIX)) {
    throw new TypeError("Reading-state scope must be guest or user:<Firebase uid>");
  }
  userIdFromScope(scope as UserReadingStateScope);
}

function assertUserReadingStateScope(
  scope: unknown,
): asserts scope is UserReadingStateScope {
  assertReadingStateScope(scope);
  if (scope === GUEST_READING_STATE_SCOPE) {
    throw new TypeError("Legacy owner progress can only be claimed by a user scope");
  }
}

export function userReadingStateScope(uid: string): UserReadingStateScope {
  assertFirebaseUid(uid);
  return `${USER_SCOPE_PREFIX}${uid}`;
}

function pendingGuestAdoptionId(
  scope: UserReadingStateScope,
): PendingGuestAdoptionId {
  assertUserReadingStateScope(scope);
  return `${PENDING_GUEST_ADOPTION_PREFIX}${scope}`;
}

function createClaimToken(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function assertClaimToken(claimToken: unknown): asserts claimToken is string {
  if (typeof claimToken !== "string" || !CLAIM_TOKEN_PATTERN.test(claimToken)) {
    throw new TypeError("A valid opaque token is required");
  }
}

function pendingStateKey(scope: ReadingStateScope): string {
  assertReadingStateScope(scope);
  if (scope === GUEST_READING_STATE_SCOPE) {
    return `${PENDING_STATE_PREFIX}guest`;
  }
  // A separate namespace segment prevents a user UID from ever colliding with
  // the guest journal, even if UID validation changes in the future.
  return `${PENDING_STATE_PREFIX}uid:${encodeURIComponent(userIdFromScope(scope))}`;
}

function pendingStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function assertIntentTime(now: unknown): asserts now is number {
  if (!Number.isSafeInteger(now) || Number(now) < 0) {
    throw new TypeError("Explicit sign-in intent time must be a nonnegative integer");
  }
}

function decodeExplicitSignInIntent(value: string): ExplicitSignInIntent | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.token !== "string" ||
      !CLAIM_TOKEN_PATTERN.test(record.token) ||
      !Number.isSafeInteger(record.createdAt) ||
      Number(record.createdAt) < 0
    ) {
      return undefined;
    }
    return { token: record.token, createdAt: Number(record.createdAt) };
  } catch {
    return undefined;
  }
}

function removeStorageValueIfUnchanged(
  storage: Storage,
  key: string,
  expectedValue: string,
): boolean {
  try {
    if (storage.getItem(key) !== expectedValue) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

interface ExplicitSignInIntentSnapshot {
  readonly intent: ExplicitSignInIntent;
  readonly storage: Storage;
  readonly storedValue: string;
}

function readExplicitSignInIntentSnapshot(
  now: number,
): ExplicitSignInIntentSnapshot | undefined {
  assertIntentTime(now);
  const storage = pendingStorage();
  if (!storage) return undefined;

  let storedValue: string | null;
  try {
    storedValue = storage.getItem(EXPLICIT_SIGN_IN_INTENT_KEY);
  } catch {
    return undefined;
  }
  if (storedValue === null) return undefined;

  const intent = decodeExplicitSignInIntent(storedValue);
  if (
    !intent ||
    intent.createdAt > now ||
    now - intent.createdAt >= EXPLICIT_SIGN_IN_INTENT_TTL_MS
  ) {
    removeStorageValueIfUnchanged(
      storage,
      EXPLICIT_SIGN_IN_INTENT_KEY,
      storedValue,
    );
    return undefined;
  }
  return { intent, storage, storedValue };
}

/**
 * Stages short-lived metadata indicating that Google sign-in was explicitly
 * requested. localStorage makes this synchronously visible to another tab.
 */
export function stageExplicitSignInIntent(
  now: number = Date.now(),
): ExplicitSignInIntent | undefined {
  assertIntentTime(now);
  const storage = pendingStorage();
  if (!storage) return undefined;
  const intent: ExplicitSignInIntent = {
    token: createClaimToken(),
    createdAt: now,
  };
  try {
    storage.setItem(EXPLICIT_SIGN_IN_INTENT_KEY, JSON.stringify(intent));
    return intent;
  } catch {
    return undefined;
  }
}

/** Returns the current unexpired explicit-sign-in intent without consuming it. */
export function readExplicitSignInIntent(
  now: number = Date.now(),
): ExplicitSignInIntent | undefined {
  return readExplicitSignInIntentSnapshot(now)?.intent;
}

/** Clears only the currently stored intent whose opaque token still matches. */
export function clearExplicitSignInIntent(expectedToken: string): boolean {
  assertClaimToken(expectedToken);
  const snapshot = readExplicitSignInIntentSnapshot(Date.now());
  if (!snapshot || snapshot.intent.token !== expectedToken) return false;
  return removeStorageValueIfUnchanged(
    snapshot.storage,
    EXPLICIT_SIGN_IN_INTENT_KEY,
    snapshot.storedValue,
  );
}

function decodePendingValue(value: string | null | undefined): ReadingState | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return decodeCloudState(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function readPendingState(scope: ReadingStateScope): ReadingState | undefined {
  const storage = pendingStorage();
  if (!storage) return undefined;
  const key = pendingStateKey(scope);
  try {
    const value = storage.getItem(key);
    if (value === null) return undefined;
    const state = decodePendingValue(value);
    if (state) return state;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can become unavailable between calls. IndexedDB remains the
      // primary persistence path in that case.
    }
  }
  return undefined;
}

function stagePendingState(scope: ReadingStateScope, state: ReadingState): void {
  try {
    pendingStorage()?.setItem(
      pendingStateKey(scope),
      JSON.stringify(encodeCloudCurrent(state)),
    );
  } catch {
    // The compact journal stays under 850 kB by design, but a browser may
    // still disable synchronous storage. The IndexedDB write continues.
  }
}

function clearPendingState(scope: ReadingStateScope, expectedRevision?: number): void {
  const storage = pendingStorage();
  if (!storage) return;
  const key = pendingStateKey(scope);
  try {
    if (expectedRevision !== undefined) {
      const pending = readPendingState(scope);
      if (pending && pending.revision !== expectedRevision) return;
    }
    storage.removeItem(key);
  } catch {
    // A retained journal is safe: the next load compares its revision with
    // IndexedDB and removes it once the durable copy is confirmed.
  }
}

export async function loadReadingState(
  scope: ReadingStateScope,
): Promise<ReadingState | undefined> {
  assertReadingStateScope(scope);
  const pending = readPendingState(scope);
  let storedState: ReadingState | undefined;
  try {
    const stored = await withTimeout(
      database.appState.get(scope),
      "Opening device storage",
    );
    storedState = stored ? normalizeReadingState(stored.state) : undefined;
  } catch (error) {
    if (pending) return pending;
    throw error;
  }

  if (pending && (!storedState || pending.revision >= storedState.revision)) {
    try {
      await withTimeout(
        database.appState.put({ id: scope, state: pending }),
        "Recovering pending progress",
      );
      clearPendingState(scope, pending.revision);
    } catch {
      // Keep the compact journal so this recovery can be retried next launch.
    }
    return pending;
  }

  if (pending) clearPendingState(scope);
  return storedState;
}

export async function saveReadingState(
  scope: ReadingStateScope,
  state: ReadingState,
): Promise<void> {
  assertReadingStateScope(scope);
  // localStorage is only a compact write-ahead journal. Its synchronous write
  // closes the tiny page-reload window before IndexedDB commits; IndexedDB
  // remains the authoritative local store and clears the matching journal.
  stagePendingState(scope, state);
  await withTimeout(
    database.appState.put({ id: scope, state }),
    "Saving device progress",
  );
  clearPendingState(scope, state.revision);
}

export async function replaceReadingState(
  scope: ReadingStateScope,
  state: ReadingState,
): Promise<void> {
  assertReadingStateScope(scope);
  // A scoped replacement overwrites only this profile. Other signed-in users
  // and the guest profile must remain intact on a shared browser.
  stagePendingState(scope, state);
  await withTimeout(
    database.appState.put({ id: scope, state }),
    "Replacing device progress",
  );
  clearPendingState(scope, state.revision);
}

/**
 * Durably records guest progress that an explicitly signed-in account may
 * adopt after cloud reconciliation confirms the account has no prior state.
 * This record is separate from both profiles and is never returned by
 * loadReadingState.
 */
export async function stagePendingGuestAdoption(
  scope: UserReadingStateScope,
  state: ReadingState,
): Promise<PendingGuestAdoption> {
  const id = pendingGuestAdoptionId(scope);
  const candidate: PendingGuestAdoption = {
    state: normalizeReadingState(state),
    claimToken: createClaimToken(),
  };
  await withTimeout(
    database.appState.put({
      id,
      state: candidate.state,
      kind: PENDING_GUEST_ADOPTION_KIND,
      claimToken: candidate.claimToken,
    }),
    "Saving pending guest adoption",
  );
  return candidate;
}

/** Reads a previously staged guest-adoption candidate without consuming it. */
export async function readPendingGuestAdoption(
  scope: UserReadingStateScope,
): Promise<PendingGuestAdoption | undefined> {
  const stored = await withTimeout(
    database.appState.get(pendingGuestAdoptionId(scope)),
    "Opening pending guest adoption",
  );
  if (!stored) return undefined;
  if (
    stored.kind !== PENDING_GUEST_ADOPTION_KIND ||
    stored.claimToken === undefined
  ) {
    throw new Error("Pending guest adoption is invalid");
  }
  assertClaimToken(stored.claimToken);
  return {
    state: normalizeReadingState(stored.state),
    claimToken: stored.claimToken,
  };
}

/**
 * Clears only the candidate identified by the expected token. Returns false
 * when there is no candidate or a newer staging operation replaced it.
 */
export async function clearPendingGuestAdoption(
  scope: UserReadingStateScope,
  expectedClaimToken: string,
): Promise<boolean> {
  const id = pendingGuestAdoptionId(scope);
  assertClaimToken(expectedClaimToken);
  let cleared = false;
  await withTimeout(
    database.transaction("rw", database.appState, async () => {
      const stored = await database.appState.get(id);
      if (!stored || stored.claimToken !== expectedClaimToken) return;
      if (stored.kind !== PENDING_GUEST_ADOPTION_KIND) {
        throw new Error("Pending guest adoption is invalid");
      }
      await database.appState.delete(id);
      cleared = true;
    }),
    "Clearing pending guest adoption",
  );
  return cleared;
}

function readLegacyPendingValue(): {
  readonly storage: Storage | undefined;
  readonly value: string | null | undefined;
} {
  const storage = pendingStorage();
  if (!storage) return { storage: undefined, value: undefined };
  try {
    return { storage, value: storage.getItem(LEGACY_PENDING_STATE_KEY) };
  } catch {
    return { storage: undefined, value: undefined };
  }
}

function legacyClaimToken(
  stored: StoredState | undefined,
  pendingValue: string | null | undefined,
): string {
  return JSON.stringify([
    pendingValue === undefined ? { unavailable: true } : pendingValue,
    stored === undefined ? null : stored.state,
  ]);
}

async function readLegacySnapshot(): Promise<LegacySnapshot | undefined> {
  const pending = readLegacyPendingValue();
  const stored = await withTimeout(
    database.appState.get(LEGACY_STATE_ID),
    "Opening legacy device storage",
  );
  const pendingState = decodePendingValue(pending.value);
  let storedState: ReadingState | undefined;
  try {
    storedState = stored ? normalizeReadingState(stored.state) : undefined;
  } catch (error) {
    // Preserve the old IndexedDB record, but still allow its valid write-ahead
    // journal to be inspected and claimed as the recoverable copy.
    if (!pendingState) throw error;
  }
  const state =
    pendingState && (!storedState || pendingState.revision >= storedState.revision)
      ? pendingState
      : storedState;
  if (!state) return undefined;

  return {
    state,
    claimToken: legacyClaimToken(stored, pending.value),
    pendingStorage: pending.storage,
    pendingValue: pending.value,
  };
}

/**
 * Reads the pre-profile device state without modifying either legacy store.
 * The caller must decide that the signed-in account is the legacy owner before
 * passing the returned token to claimLegacyReadingState.
 */
export async function readLegacyReadingState(): Promise<LegacyReadingState | undefined> {
  const snapshot = await readLegacySnapshot();
  return snapshot
    ? { state: snapshot.state, claimToken: snapshot.claimToken }
    : undefined;
}

/**
 * Moves an unchanged legacy snapshot into a user profile. A stale claim token
 * is rejected without changing or removing any legacy data.
 */
export async function claimLegacyReadingState(
  scope: UserReadingStateScope,
  claimToken: string,
): Promise<ReadingState | undefined> {
  assertUserReadingStateScope(scope);
  if (typeof claimToken !== "string" || claimToken.length === 0) {
    throw new TypeError("A legacy claim token is required");
  }

  const snapshot = await readLegacySnapshot();
  if (!snapshot || snapshot.claimToken !== claimToken) return undefined;

  let claimed = false;
  await withTimeout(
    database.transaction("rw", database.appState, async () => {
      const stored = await database.appState.get(LEGACY_STATE_ID);
      const pending = readLegacyPendingValue();
      if (legacyClaimToken(stored, pending.value) !== claimToken) return;

      stagePendingState(scope, snapshot.state);
      await database.appState.put({ id: scope, state: snapshot.state });
      await database.appState.delete(LEGACY_STATE_ID);
      claimed = true;
    }),
    "Claiming legacy device progress",
  );

  if (!claimed) return undefined;
  clearPendingState(scope, snapshot.state.revision);

  // localStorage cannot join the IndexedDB transaction. Remove only the exact
  // legacy journal that contributed to this claim, and only after the scoped
  // IndexedDB copy is durable.
  if (snapshot.pendingStorage && snapshot.pendingValue !== undefined) {
    try {
      if (
        snapshot.pendingStorage.getItem(LEGACY_PENDING_STATE_KEY) ===
        snapshot.pendingValue
      ) {
        snapshot.pendingStorage.removeItem(LEGACY_PENDING_STATE_KEY);
      }
    } catch {
      // The migrated scoped copy is durable. A retained legacy journal can be
      // safely reconsidered on a future launch instead of being deleted blind.
    }
  }
  return snapshot.state;
}
