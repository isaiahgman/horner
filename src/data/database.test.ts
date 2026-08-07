import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeCloudCurrent } from "./cloud-codec.js";
import { createInitialState, setCompletion } from "../domain/state.js";
import type { ReadingState } from "../domain/state.js";

const dexieMock = vi.hoisted(() => ({
  records: new Map<string, { id: string; state: unknown }>(),
  failNextPut: false,
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

    version(_version: number) {
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
const GUEST_PENDING_STATE_KEY = "horner-next-ten-pending-v3:guest";
const USER_PENDING_STATE_KEY = "horner-next-ten-pending-v3:uid:firebase-user_1";

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
