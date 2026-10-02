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
const cleanups: Array<() => void> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
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
  harness.replace.mockResolvedValue(undefined);
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

describe("account changes during guest-adoption reconciliation", () => {
  const cases = (["recovery write", "adoption cleanup"] as const).flatMap((pauseAt) =>
    (["unchanged", "new account", "sign-out", "new generation", "unmount"] as const)
      .map((transition) => ({ pauseAt, transition })),
  );

  it.each(cases)("keeps recovery scoped after $pauseAt / $transition", async ({ pauseAt, transition }) => {
    const guest = createInitialState(NOW);
    const remoteA = setCompletion(createInitialState(new Date("2026-10-01T12:00:00")), "gospels", true);
    const nextProfile = setCompletion(createInitialState(NOW), "acts", true);
    const pendingA = { state: guest, claimToken: "a".repeat(32) };
    const recoveryWrite = deferred();
    let recoveryStarted = false;
    let changedGeneration = false;

    harness.load.mockImplementation(async () => changedGeneration ? nextProfile : guest);
    harness.readAdoption.mockImplementation(async () => changedGeneration ? undefined : pendingA);
    harness.createCloud.mockResolvedValue(false);
    let readsA = 0;
    harness.loadCloud.mockImplementation(async () => {
      if (changedGeneration) return { state: nextProfile, needsMigration: false };
      readsA += 1;
      return readsA === 1 ? undefined : { state: remoteA, needsMigration: false };
    });
    harness.replace.mockImplementation(async (scope: string, state: ReadingState) => {
      if (scope === SCOPE_A && state.activeSession.chapters.gospels === "matthew:2"
        && pauseAt === "recovery write") {
        recoveryStarted = true;
        await recoveryWrite.promise;
      }
    });
    harness.clearAdoption.mockImplementation(async () => {
      if (pauseAt === "adoption cleanup") {
        recoveryStarted = true;
        await recoveryWrite.promise;
      }
      return true;
    });

    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(recoveryStarted).toBe(true));

    // Firebase can notify this tab when another tab switches accounts, even
    // while the current tab's controls are locked by reconciliation.
    if (transition === "unmount") {
      for (const cleanup of cleanups.splice(0)) cleanup();
    } else if (transition !== "unchanged") {
      changedGeneration = true;
      const nextUser = transition === "sign-out" ? null
        : transition === "new generation" ? USER_A : USER_B;
      changeAccount(nextUser);
      await vi.waitFor(() => expect(harness.load).toHaveBeenLastCalledWith(
        nextUser ? `user:${nextUser.uid}` : "guest",
      ));
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.stateUpdates).toContainEqual({ initial: undefined, value: nextProfile });
    }
    const beforeResume = {
      updates: harness.stateUpdates.length,
      localWrites: harness.replace.mock.calls.length,
      saves: harness.saveCloud.mock.calls.length,
    };
    recoveryWrite.resolve();
    await vi.waitFor(() => expect(harness.clearAdoption).toHaveBeenCalledWith(SCOPE_A, pendingA.claimToken));
    await vi.advanceTimersByTimeAsync(0);

    if (transition !== "unchanged") {
      expect(harness.saveCloud.mock.calls).toHaveLength(beforeResume.saves);
      expect(harness.replace.mock.calls).toHaveLength(beforeResume.localWrites);
      // Releasing the old lock is allowed; publishing old reading/account
      // state or a misleading sync status after the transition is not.
      expect(harness.stateUpdates.slice(beforeResume.updates)
        .filter(({ initial }) => initial === undefined || initial === "local")).toEqual([]);
    } else {
      // The normal recovery still uploads its rolled-over copy to account A.
      expect(harness.saveCloud).toHaveBeenCalledExactlyOnceWith(USER_A.uid, expect.objectContaining({
        revision: remoteA.revision + 1,
        activeSession: expect.objectContaining({
          chapters: expect.objectContaining({ gospels: "matthew:2" }),
        }),
      }));
    }
    expect(harness.clearAdoption).toHaveBeenCalledExactlyOnceWith(SCOPE_A, pendingA.claimToken);
  });

  it("keeps the new account's pending-adoption guard and unavailable status", async () => {
    const guest = createInitialState(NOW);
    // No rollover or migration is needed, so the obsolete recovery would
    // previously publish 'saved' even without submitting a cloud write.
    const remoteA = setCompletion(createInitialState(NOW), "gospels", true);
    const pendingA = { state: guest, claimToken: "a".repeat(32) };
    const pendingB = { state: guest, claimToken: "b".repeat(32) };
    const cleanup = deferred();
    harness.load.mockResolvedValue(guest);
    harness.readAdoption.mockImplementation(async (scope: string) => scope === SCOPE_A ? pendingA : pendingB);
    harness.createCloud.mockResolvedValue(false);
    let readsA = 0;
    harness.loadCloud.mockImplementation(async (uid: string) => {
      if (uid === USER_B.uid) throw new Error("synthetic offline response");
      readsA += 1;
      return readsA === 1 ? undefined : { state: remoteA, needsMigration: false };
    });
    harness.clearAdoption.mockImplementation(async () => {
      await cleanup.promise;
      return true;
    });

    const changeAccount = await mountApp();
    changeAccount(USER_A);
    await vi.waitFor(() => expect(harness.clearAdoption).toHaveBeenCalledWith(SCOPE_A, pendingA.claimToken));
    changeAccount(USER_B);
    await vi.waitFor(() => expect(harness.stateUpdates).toContainEqual({ initial: "local", value: "offline" }));
    const updates = harness.stateUpdates.length;
    const localWrites = harness.replace.mock.calls.length;
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saveCloud).not.toHaveBeenCalled();
    expect(harness.replace.mock.calls).toHaveLength(localWrites);
    expect(harness.stateUpdates.slice(updates)
      .filter(({ initial }) => initial === undefined || initial === "local")).toEqual([]);
    expect(harness.clearAdoption).toHaveBeenCalledExactlyOnceWith(SCOPE_A, pendingA.claimToken);
    expect(harness.refs.map(({ current }) => current)).toContainEqual({
      scope: SCOPE_B,
      claimToken: pendingB.claimToken,
    });
  });
});
