import { createElement, type EffectCallback } from "react";
import { renderToString } from "react-dom/server";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, setCompletion, type ReadingState } from "./domain/state.js";

const harness = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  stateUpdates: [] as Array<{ initial: unknown; value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  observe: vi.fn(),
  load: vi.fn(),
  replace: vi.fn(),
  readAdoption: vi.fn(),
  clearAdoption: vi.fn(),
  loadCloud: vi.fn(),
  createCloud: vi.fn(),
  saveCloud: vi.fn(),
}));

// Render with React's real state/ref hooks, then run the captured lifecycle
// effects explicitly. Setter calls are observed without client rerenders; these
// tests cover lifecycle state updates and persistence/cloud routing, not DOM
// rendering. No browser, Firebase account, or personal data is used.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: EffectCallback) => { harness.effects.push(effect); },
    useState: (initial: unknown) => {
      const [value, setValue] = react.useState(initial);
      return [value, (next: unknown) => {
        harness.stateUpdates.push({ initial, value: next });
        setValue(next);
      }];
    },
    useRef: (initial: unknown) => {
      const ref = react.useRef(initial);
      harness.refs.push(ref);
      return ref;
    },
  };
});

vi.mock("./data/database.js", () => ({
  GUEST_READING_STATE_SCOPE: "guest",
  userReadingStateScope: (uid: string) => `user:${uid}`,
  loadReadingState: harness.load,
  replaceReadingState: harness.replace,
  saveReadingState: vi.fn(),
  readPendingGuestAdoption: harness.readAdoption,
  clearPendingGuestAdoption: harness.clearAdoption,
  readExplicitSignInIntent: vi.fn(),
  clearExplicitSignInIntent: vi.fn(),
  stageExplicitSignInIntent: vi.fn(),
  stagePendingGuestAdoption: vi.fn(),
  readLegacyReadingState: vi.fn(),
  claimLegacyReadingState: vi.fn(),
}));

vi.mock("./data/cloud.js", () => ({
  observeCloudAccount: harness.observe,
  loadCloudState: harness.loadCloud,
  createCloudStateIfAbsent: harness.createCloud,
  saveCloudState: harness.saveCloud,
  waitForCloudWrites: vi.fn().mockResolvedValue(undefined),
  signInToCloud: vi.fn(),
  signOutOfCloud: vi.fn(),
}));

import { App } from "./App.js";

const NOW = new Date("2026-10-02T12:00:00");
const USER_A = { uid: "synthetic-a", emailVerified: true, providerData: [{ providerId: "google.com" }] } as User;
const USER_B = { uid: "synthetic-b", emailVerified: true, providerData: [{ providerId: "google.com" }] } as User;
const SCOPE_A = `user:${USER_A.uid}`;
const SCOPE_B = `user:${USER_B.uid}`;
const records = new Map<string, ReadingState>();
const cleanups: Array<() => void> = [];

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  harness.effects.length = 0;
  harness.stateUpdates.length = 0;
  harness.refs.length = 0;
  const windowTarget = new EventTarget();
  Object.assign(windowTarget, {
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: vi.fn(() => true),
  });
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true, userAgent: "synthetic-test", maxTouchPoints: 0 });
  records.clear();
  harness.load.mockImplementation(async (scope: string) => records.get(scope));
  harness.replace.mockImplementation(async (scope: string, state: ReadingState) => {
    records.set(scope, structuredClone(state));
  });
  harness.readAdoption.mockResolvedValue(undefined);
  harness.loadCloud.mockResolvedValue(undefined);
  harness.clearAdoption.mockResolvedValue(true);
  harness.saveCloud.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountApp(): Promise<(user: User | null) => void> {
  let observer: ((user: User | null) => void) | undefined;
  harness.observe.mockImplementation((listener: (user: User | null) => void) => {
    observer = listener;
    return vi.fn();
  });
  renderToString(createElement(App));
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  await vi.waitFor(() => expect(observer).toBeDefined());
  return observer!;
}

function publishedReadingStates(): ReadingState[] {
  return harness.stateUpdates.map(({ value }) => value).filter((value): value is ReadingState =>
    typeof value === "object" && value !== null && "activeSession" in value,
  );
}

function hasOpenError(): boolean {
  return harness.stateUpdates.some(({ value }) =>
    typeof value === "string" && value.includes("could not be opened"),
  );
}

describe("failed profile reads", () => {
  it.each([null, USER_A])("preserves durable progress and blocks refresh writes for %j", async (user) => {
    const scope = user ? SCOPE_A : "guest";
    const saved = setCompletion(createInitialState(NOW), "acts", true);
    records.set(scope, saved);
    harness.load.mockRejectedValue(new Error("synthetic local read failure"));
    // Even an available older cloud copy must not replace unreadable local data.
    harness.loadCloud.mockResolvedValue({ state: createInitialState(NOW), needsMigration: false });
    const changeAccount = await mountApp();
    changeAccount(user);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(records.get(scope)).toEqual(saved);
    expect(publishedReadingStates()).toEqual([]);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.saveCloud).not.toHaveBeenCalled();
    expect(harness.loadCloud).not.toHaveBeenCalled();
  });

  it.each([null, USER_A])("recovers unchanged saved progress after a successful retry for %j", async (user) => {
    const scope = user ? SCOPE_A : "guest";
    const saved = setCompletion(createInitialState(NOW), "acts", true);
    records.set(scope, saved);
    harness.load.mockRejectedValueOnce(new Error("synthetic transient read failure"));
    harness.loadCloud.mockResolvedValue({ state: saved, needsMigration: false });
    const changeAccount = await mountApp();
    changeAccount(user);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));
    expect(harness.replace).not.toHaveBeenCalled();

    // A fresh profile activation retries loading. The browser test covers the
    // actual Retry button's full reload against a real IndexedDB record.
    changeAccount(user);
    await vi.waitFor(() => expect(publishedReadingStates()).toContainEqual(saved));
    await vi.advanceTimersByTimeAsync(0);
    expect(records.get(scope)).toEqual(saved);
    expect(harness.saveCloud).not.toHaveBeenCalled();
  });

  it.each([null, USER_A])("still initializes genuinely absent progress for %j", async (user) => {
    const scope = user ? SCOPE_A : "guest";
    const changeAccount = await mountApp();
    changeAccount(user);
    await vi.waitFor(() => expect(records.has(scope)).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(records.get(scope)).toEqual(createInitialState(NOW));
    expect(hasOpenError()).toBe(false);
    if (user) expect(harness.saveCloud).toHaveBeenCalledWith(user.uid, createInitialState(NOW));
    else expect(harness.saveCloud).not.toHaveBeenCalled();
  });

  it("still restores a valid cloud copy when local progress is genuinely absent", async () => {
    const cloudState = setCompletion(createInitialState(NOW), "gospels", true);
    harness.loadCloud.mockResolvedValue({ state: cloudState, needsMigration: false });
    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(records.get(SCOPE_A)).toEqual(cloudState));
    expect(publishedReadingStates().at(-1)).toEqual(cloudState);
    expect(hasOpenError()).toBe(false);
    expect(harness.saveCloud).not.toHaveBeenCalled();
  });

  it("keeps pending-adoption metadata failures from rewriting an account", async () => {
    const saved = setCompletion(createInitialState(NOW), "acts", true);
    records.set(SCOPE_A, saved);
    harness.readAdoption.mockRejectedValue(new Error("synthetic metadata read failure"));
    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));
    expect(records.get(SCOPE_A)).toEqual(saved);
    expect(publishedReadingStates()).toEqual([]);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.loadCloud).not.toHaveBeenCalled();
  });

  it("ignores an earlier account's late load after the new account fails to open", async () => {
    const oldLoad = deferred<ReadingState>();
    const oldState = setCompletion(createInitialState(NOW), "gospels", true);
    const newState = setCompletion(createInitialState(NOW), "acts", true);
    records.set(SCOPE_A, oldState);
    records.set(SCOPE_B, newState);
    harness.load.mockImplementation((scope: string) => scope === SCOPE_A
      ? oldLoad.promise : Promise.reject(new Error("synthetic new-profile failure")));
    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(harness.load).toHaveBeenCalledWith(SCOPE_A));
    changeAccount(USER_B);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));
    oldLoad.resolve(oldState);
    await vi.advanceTimersByTimeAsync(0);

    expect(publishedReadingStates()).toEqual([]);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.saveCloud).not.toHaveBeenCalled();
    expect(records.get(SCOPE_A)).toEqual(oldState);
    expect(records.get(SCOPE_B)).toEqual(newState);
  });

  it("ignores an earlier account's late cloud response after the new account fails to open", async () => {
    const oldCloud = deferred<{ state: ReadingState; needsMigration: boolean }>();
    const oldState = createInitialState(NOW);
    const newerCloudState = setCompletion(oldState, "gospels", true);
    records.set(SCOPE_A, oldState);
    harness.load.mockImplementation(async (scope: string) => {
      if (scope === SCOPE_B) throw new Error("synthetic new-profile failure");
      return records.get(scope);
    });
    harness.loadCloud.mockImplementation(() => oldCloud.promise);
    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(harness.loadCloud).toHaveBeenCalledWith(USER_A.uid));
    changeAccount(USER_B);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));
    const stateCount = publishedReadingStates().length;
    const localWrites = harness.replace.mock.calls.length;
    oldCloud.resolve({ state: newerCloudState, needsMigration: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(publishedReadingStates()).toHaveLength(stateCount);
    expect(harness.replace.mock.calls).toHaveLength(localWrites);
    expect(harness.saveCloud).not.toHaveBeenCalled();
    expect(records.get(SCOPE_A)).toEqual(oldState);
  });

  it.each([null, USER_B])("can open another valid profile after the current one fails: %j", async (user) => {
    const nextScope = user ? SCOPE_B : "guest";
    const nextState = setCompletion(createInitialState(NOW), "acts", true);
    records.set(nextScope, nextState);
    harness.load.mockImplementation(async (scope: string) => {
      if (scope === SCOPE_A) throw new Error("synthetic account A read failure");
      return records.get(scope);
    });
    harness.loadCloud.mockResolvedValue({ state: nextState, needsMigration: false });
    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(hasOpenError()).toBe(true));
    changeAccount(user);
    await vi.waitFor(() => expect(publishedReadingStates()).toContainEqual(nextState));
    expect(harness.replace.mock.calls.every(([scope]) => scope === nextScope)).toBe(true);
    expect(harness.saveCloud).not.toHaveBeenCalled();
  });
});
