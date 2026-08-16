import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeCloudCurrent } from "./cloud-codec.js";
import { LIST_IDS } from "../domain/lists.js";
import {
  completeNextAdditionalChapter,
  createInitialState,
  setCompletion,
} from "../domain/state.js";
import type { ReadingSession, ReadingState } from "../domain/state.js";

const dexieMock = vi.hoisted(() => ({
  records: new Map<string, { id: string; state: unknown }>(),
  failNextPut: false,
  versions: [] as number[],
}));

vi.mock("dexie", () => {
  const table = {
    async get(id: string) {
      const record = dexieMock.records.get(id);
      return record === undefined ? undefined : structuredClone(record);
    },
    async put(record: { id: string; state: unknown }) {
      if (dexieMock.failNextPut) {
        dexieMock.failNextPut = false;
        throw new Error("simulated IndexedDB failure");
      }
      dexieMock.records.set(record.id, structuredClone(record));
      return record.id;
    },
    async delete(id: string) {
      dexieMock.records.delete(id);
    },
  };

  class MockDexie {
    appState: typeof table | undefined;

    version(version: number) {
      dexieMock.versions.push(version);
      return {
        stores: (_schema: Record<string, string>) => {
          this.appState = table;
        },
      };
    }

    async transaction<Value>(
      _mode: string,
      _table: typeof table,
      operation: () => Promise<Value>,
    ): Promise<Value> {
      const before = structuredClone([...dexieMock.records.entries()]);
      try {
        return await operation();
      } catch (error) {
        dexieMock.records.clear();
        for (const [key, value] of before) dexieMock.records.set(key, value);
        throw error;
      }
    }
  }

  return { default: MockDexie };
});

import {
  claimLegacyReadingState,
  clearExplicitSignInIntent,
  clearPendingGuestAdoption,
  EXPLICIT_SIGN_IN_INTENT_TTL_MS,
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
} from "./database.js";

const EXPLICIT_SIGN_IN_INTENT_KEY = "horner-next-ten-explicit-sign-in-v1";
const LEGACY_PENDING_STATE_KEY = "horner-next-ten-pending-v2";
const PREVIOUS_GUEST_PENDING_STATE_KEY = "horner-next-ten-pending-v3:guest";
const GUEST_PENDING_STATE_KEY = "horner-next-ten-pending-v4:guest";
const USER_PENDING_STATE_KEY = "horner-next-ten-pending-v4:uid:firebase-user_1";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const localStorage = new MemoryStorage();
let tokenSeed = 0;

function stateAt(revision: number): ReadingState {
  let state = createInitialState(new Date("2026-08-03T12:00:00"));
  for (let index = 0; index < revision; index += 1) {
    state = setCompletion(state, index % 2 === 0 ? "gospels" : "acts", index % 4 < 2);
  }
  if (state.revision !== revision) {
    throw new Error(`Test fixture produced revision ${state.revision}, not ${revision}`);
  }
  return state;
}

function completedMask(session: ReadingSession): number {
  return LIST_IDS.reduce(
    (mask, listId, index) =>
      mask | (session.completedCounts[listId] > 0 ? 1 << index : 0),
    0,
  );
}

function previousJournalValue(state: ReadingState): string {
  return JSON.stringify({
    schemaVersion: 2,
    revision: state.revision,
    cursorIndexes: LIST_IDS.map((listId) => state.cursors[listId]),
    activeReadingDate: state.activeSession.readingDate,
    activeCompletedMask: completedMask(state.activeSession),
    rolloverHour: state.settings.rolloverHour,
    preferredBibleUrl: state.settings.preferredBibleUrl ?? null,
    history: [],
  });
}

function domainVersion1State(state: ReadingState): unknown {
  const legacySession = (session: ReadingSession) => ({
    readingDate: session.readingDate,
    chapters: session.chapters,
    completed: Object.fromEntries(
      LIST_IDS.map((listId) => [listId, session.completedCounts[listId] > 0]),
    ),
  });
  return {
    ...state,
    version: 1,
    activeSession: legacySession(state.activeSession),
    history: state.history.map(legacySession),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  dexieMock.records.clear();
  dexieMock.failNextPut = false;
  localStorage.clear();
  tokenSeed = 0;
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    crypto: {
      getRandomValues(values: Uint8Array) {
        tokenSeed += 1;
        values.fill(tokenSeed);
        return values;
      },
    },
    localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
  });
});

describe("cross-tab explicit sign-in intent", () => {
  it("persists one short-lived intent across synchronous calls", () => {
    const now = 1_800_000_000_000;
    const staged = stageExplicitSignInIntent(now);

    expect(staged).toEqual({
      token: "01".repeat(16),
      createdAt: now,
    });
    expect(readExplicitSignInIntent(now + 1_000)).toEqual(staged);
    expect(JSON.parse(localStorage.getItem(EXPLICIT_SIGN_IN_INTENT_KEY)!)).toEqual(
      staged,
    );
  });

  it("does not clear a newer intent when given a stale token", () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const original = stageExplicitSignInIntent(now)!;
    const replacement = stageExplicitSignInIntent(now + 1)!;
    vi.mocked(Date.now).mockReturnValue(now + 2);

    expect(clearExplicitSignInIntent(original.token)).toBe(false);
    expect(readExplicitSignInIntent(now + 2)).toEqual(replacement);
    expect(clearExplicitSignInIntent(replacement.token)).toBe(true);
    expect(readExplicitSignInIntent(now + 2)).toBeUndefined();
  });

  it("removes expired and invalid intent metadata", () => {
    const now = 1_800_000_000_000;
    const staged = stageExplicitSignInIntent(now);
    expect(
      readExplicitSignInIntent(now + EXPLICIT_SIGN_IN_INTENT_TTL_MS - 1),
    ).toEqual(staged);
    expect(
      readExplicitSignInIntent(now + EXPLICIT_SIGN_IN_INTENT_TTL_MS),
    ).toBeUndefined();
    expect(localStorage.getItem(EXPLICIT_SIGN_IN_INTENT_KEY)).toBeNull();

    localStorage.setItem(EXPLICIT_SIGN_IN_INTENT_KEY, "{not-json");
    expect(readExplicitSignInIntent(now)).toBeUndefined();
    expect(localStorage.getItem(EXPLICIT_SIGN_IN_INTENT_KEY)).toBeNull();

    localStorage.setItem(
      EXPLICIT_SIGN_IN_INTENT_KEY,
      JSON.stringify({ token: "01".repeat(16), createdAt: now, readingState: {} }),
    );
    expect(readExplicitSignInIntent(now)).toBeUndefined();
    expect(localStorage.getItem(EXPLICIT_SIGN_IN_INTENT_KEY)).toBeNull();
  });

  it("degrades safely when localStorage is unavailable", () => {
    const now = 1_800_000_000_000;
    const currentCrypto = window.crypto;
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      crypto: currentCrypto,
      get localStorage(): Storage {
        throw new Error("storage blocked");
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
    });

    expect(stageExplicitSignInIntent(now)).toBeUndefined();
    expect(readExplicitSignInIntent(now)).toBeUndefined();
    expect(clearExplicitSignInIntent("01".repeat(16))).toBe(false);
  });
});

describe("reading-state scopes", () => {
  it("opens physical IndexedDB version 2 as a mixed-client write barrier", () => {
    expect(dexieMock.versions).toEqual([1, 2]);
  });

  it("constructs user scopes and rejects empty, control, and path-like UIDs", async () => {
    expect(userReadingStateScope("firebase-user_1")).toBe("user:firebase-user_1");
    expect(() => userReadingStateScope("")).toThrow(TypeError);
    expect(() => userReadingStateScope("../owner")).toThrow(TypeError);
    expect(() => userReadingStateScope("owner/account")).toThrow(TypeError);
    expect(() => userReadingStateScope("owner\\account")).toThrow(TypeError);
    expect(() => userReadingStateScope("owner\naccount")).toThrow(TypeError);
    expect(() => userReadingStateScope("x".repeat(129))).toThrow(TypeError);
    await expect(loadReadingState("user:../owner" as never)).rejects.toThrow(TypeError);
    await expect(loadReadingState("primary" as never)).rejects.toThrow(TypeError);
  });

  it("keeps guest and user records isolated when one scope is replaced", async () => {
    const userScope = userReadingStateScope("firebase-user_1");
    const guest = stateAt(0);
    const user = stateAt(1);
    const replacement = stateAt(2);

    await saveReadingState(GUEST_READING_STATE_SCOPE, guest);
    await saveReadingState(userScope, user);
    await replaceReadingState(GUEST_READING_STATE_SCOPE, replacement);

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(replacement);
    expect(await loadReadingState(userScope)).toEqual(user);
    expect([...dexieMock.records.keys()].sort()).toEqual(["guest", userScope]);
  });

  it("uses separate write-ahead journals and recovers only the failed scope", async () => {
    const userScope = userReadingStateScope("firebase-user_1");
    const guest = stateAt(1);
    const user = stateAt(2);

    dexieMock.failNextPut = true;
    await expect(saveReadingState(GUEST_READING_STATE_SCOPE, guest)).rejects.toThrow(
      /simulated IndexedDB failure/,
    );
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).not.toBeNull();
    expect(localStorage.getItem(USER_PENDING_STATE_KEY)).toBeNull();

    await saveReadingState(userScope, user);
    expect(localStorage.getItem(USER_PENDING_STATE_KEY)).toBeNull();
    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(guest);
    expect(await loadReadingState(userScope)).toEqual(user);
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("recovers the previous v3 journal namespace and writes through to IndexedDB", async () => {
    const pending = stateAt(2);
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue(pending),
    );

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(pending);
    expect(dexieMock.records.get("guest")?.state).toEqual(pending);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("accepts a newer v3 journal while IndexedDB still uses domain v1", async () => {
    const legacyStored = stateAt(1);
    const pending = stateAt(2);
    dexieMock.records.set("guest", {
      id: "guest",
      state: domainVersion1State(legacyStored),
    });
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue(pending),
    );

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(pending);
    expect(dexieMock.records.get("guest")?.state).toEqual(pending);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("does not let a higher-revision v3 mask journal erase durable additional counts", async () => {
    let durable = setCompletion(
      createInitialState(new Date("2026-08-03T12:00:00")),
      "gospels",
      true,
    );
    durable = completeNextAdditionalChapter(durable, "gospels");
    dexieMock.records.set("guest", { id: "guest", state: durable });
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue({ ...durable, revision: 99 }),
    );

    const loaded = await loadReadingState(GUEST_READING_STATE_SCOPE);
    expect(loaded).toEqual(durable);
    expect(loaded?.activeSession.completedCounts.gospels).toBe(2);
    expect(dexieMock.records.get("guest")?.state).toEqual(durable);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("keeps v4 journal authority over current IndexedDB at an equal revision", async () => {
    const initial = createInitialState(new Date("2026-08-03T12:00:00"));
    const stored = setCompletion(initial, "gospels", true);
    const pending = setCompletion(initial, "acts", true);
    dexieMock.records.set("guest", { id: "guest", state: stored });
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue({ ...stored, revision: 99 }),
    );
    localStorage.setItem(
      GUEST_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(pending)),
    );

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(pending);
    expect(dexieMock.records.get("guest")?.state).toEqual(pending);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("recovers the highest revision across previous and current journals", async () => {
    const previous = stateAt(2);
    const current = stateAt(1);
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue(previous),
    );
    localStorage.setItem(
      GUEST_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(current)),
    );

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(previous);
    expect(dexieMock.records.get("guest")?.state).toEqual(previous);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("prefers the current journal format for an equal-revision divergence", async () => {
    const initial = createInitialState(new Date("2026-08-03T12:00:00"));
    const previous = setCompletion(initial, "gospels", true);
    const current = setCompletion(initial, "acts", true);
    localStorage.setItem(
      PREVIOUS_GUEST_PENDING_STATE_KEY,
      previousJournalValue(previous),
    );
    localStorage.setItem(
      GUEST_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(current)),
    );

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(current);
    expect(dexieMock.records.get("guest")?.state).toEqual(current);
    expect(localStorage.getItem(PREVIOUS_GUEST_PENDING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("best-effort writes a normalized domain v1 record through to IndexedDB", async () => {
    const current = stateAt(1);
    dexieMock.records.set("guest", {
      id: "guest",
      state: domainVersion1State(current),
    });

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(current);
    expect(dexieMock.records.get("guest")?.state).toEqual(current);
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });

  it("retains a v4 journal when domain migration write-through fails", async () => {
    const current = stateAt(1);
    dexieMock.records.set("guest", {
      id: "guest",
      state: domainVersion1State(current),
    });
    dexieMock.failNextPut = true;

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(current);
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).not.toBeNull();
    expect(dexieMock.records.get("guest")?.state).toEqual(domainVersion1State(current));

    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toEqual(current);
    expect(dexieMock.records.get("guest")?.state).toEqual(current);
    expect(localStorage.getItem(GUEST_PENDING_STATE_KEY)).toBeNull();
  });
});

describe("pending guest adoption", () => {
  it("persists candidates independently by validated user scope", async () => {
    const firstScope = userReadingStateScope("firebase-user_1");
    const secondScope = userReadingStateScope("firebase-user_2");
    const firstState = stateAt(1);
    const secondState = stateAt(2);

    const first = await stagePendingGuestAdoption(firstScope, firstState);
    const second = await stagePendingGuestAdoption(secondScope, secondState);

    expect(await readPendingGuestAdoption(firstScope)).toEqual(first);
    expect(await readPendingGuestAdoption(secondScope)).toEqual(second);
    expect(first.claimToken).not.toBe(second.claimToken);
    expect(await loadReadingState(firstScope)).toBeUndefined();
    expect(await loadReadingState(secondScope)).toBeUndefined();
    expect(await loadReadingState(GUEST_READING_STATE_SCOPE)).toBeUndefined();
    expect(
      await clearPendingGuestAdoption(secondScope, first.claimToken),
    ).toBe(false);

    await replaceReadingState(firstScope, stateAt(0));
    await saveReadingState(GUEST_READING_STATE_SCOPE, stateAt(0));
    expect(await readPendingGuestAdoption(firstScope)).toEqual(first);
    expect(await readPendingGuestAdoption(secondScope)).toEqual(second);
    await expect(
      stagePendingGuestAdoption("user:../owner" as never, firstState),
    ).rejects.toThrow(TypeError);
  });

  it("keeps a newly staged candidate when an older token attempts to clear it", async () => {
    const scope = userReadingStateScope("firebase-user_1");
    const original = await stagePendingGuestAdoption(scope, stateAt(1));
    const replacement = await stagePendingGuestAdoption(scope, stateAt(2));

    expect(
      await clearPendingGuestAdoption(scope, original.claimToken),
    ).toBe(false);
    expect(await readPendingGuestAdoption(scope)).toEqual(replacement);
  });

  it("clears only the candidate matching the expected opaque token", async () => {
    const scope = userReadingStateScope("firebase-user_1");
    const candidate = await stagePendingGuestAdoption(scope, stateAt(1));

    expect(
      await clearPendingGuestAdoption(scope, candidate.claimToken),
    ).toBe(true);
    expect(await readPendingGuestAdoption(scope)).toBeUndefined();
    expect(
      await clearPendingGuestAdoption(scope, candidate.claimToken),
    ).toBe(false);
  });
});

describe("legacy owner migration", () => {
  it("reads without mutation, then atomically claims the newer legacy journal", async () => {
    const stored = stateAt(1);
    const pending = stateAt(2);
    dexieMock.records.set("primary", { id: "primary", state: stored });
    localStorage.setItem(
      LEGACY_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(pending)),
    );

    const legacy = await readLegacyReadingState();
    expect(legacy?.state).toEqual(pending);
    expect(dexieMock.records.has("primary")).toBe(true);
    expect(localStorage.getItem(LEGACY_PENDING_STATE_KEY)).not.toBeNull();

    const userScope = userReadingStateScope("firebase-user_1");
    const claimed = await claimLegacyReadingState(userScope, legacy!.claimToken);
    expect(claimed).toEqual(pending);
    expect(dexieMock.records.has("primary")).toBe(false);
    expect(localStorage.getItem(LEGACY_PENDING_STATE_KEY)).toBeNull();
    expect(await loadReadingState(userScope)).toEqual(pending);
  });

  it("rejects a stale claim without touching legacy or scoped data", async () => {
    const original = stateAt(1);
    const changed = stateAt(2);
    const existingUser = stateAt(0);
    dexieMock.records.set("primary", { id: "primary", state: original });
    const legacy = await readLegacyReadingState();
    const userScope = userReadingStateScope("firebase-user_1");
    dexieMock.records.set(userScope, { id: userScope, state: existingUser });
    localStorage.setItem(
      LEGACY_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(changed)),
    );

    expect(await claimLegacyReadingState(userScope, legacy!.claimToken)).toBeUndefined();
    expect(dexieMock.records.get("primary")?.state).toEqual(original);
    expect(dexieMock.records.get(userScope)?.state).toEqual(existingUser);
    expect(localStorage.getItem(LEGACY_PENDING_STATE_KEY)).not.toBeNull();
  });

  it("can recover a valid legacy journal without deleting an invalid primary record", async () => {
    const pending = stateAt(1);
    dexieMock.records.set("primary", { id: "primary", state: { broken: true } });
    localStorage.setItem(
      LEGACY_PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(pending)),
    );

    const legacy = await readLegacyReadingState();
    expect(legacy?.state).toEqual(pending);
    expect(dexieMock.records.get("primary")?.state).toEqual({ broken: true });
    expect(localStorage.getItem(LEGACY_PENDING_STATE_KEY)).not.toBeNull();
  });

  it("cannot claim legacy owner progress into the guest profile", async () => {
    dexieMock.records.set("primary", { id: "primary", state: stateAt(0) });
    const legacy = await readLegacyReadingState();
    await expect(
      claimLegacyReadingState(GUEST_READING_STATE_SCOPE as never, legacy!.claimToken),
    ).rejects.toThrow(/only be claimed by a user scope/);
    expect(dexieMock.records.has("primary")).toBe(true);
  });
});
