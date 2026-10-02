import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the production adapter with only the Firebase SDK boundary mocked.
// These tests must never initialize Firebase or contact a live account.
const sdk = vi.hoisted(() => ({
  getDocFromServer: vi.fn(),
  getDocsFromServer: vi.fn(),
  setDoc: vi.fn(),
  transactionGet: vi.fn(),
  transactionSet: vi.fn(),
}));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: vi.fn(),
  getAuth: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  ...sdk,
  doc: (_: unknown, ...path: string[]) => path.join("/"),
  collection: (_: unknown, ...path: string[]) => path.join("/"),
  initializeFirestore: vi.fn(),
  memoryLocalCache: vi.fn(),
  serverTimestamp: () => "synthetic-server-timestamp",
  waitForPendingWrites: vi.fn(),
  runTransaction: async (_: unknown, callback: (transaction: unknown) => Promise<boolean>) =>
    callback({ get: sdk.transactionGet, set: sdk.transactionSet }),
}));

import { createInitialState, rolloverIfNeeded, setCompletion } from "../domain/state.js";
import { createCloudStateIfAbsent, loadCloudState, saveCloudState } from "./cloud.js";
import { encodeCloudCurrent, encodeCloudSession } from "./cloud-codec.js";
import { CloudDataError } from "./cloud-config.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const USER_ID = "synthetic-reader";
const USER_PATH = `users/${USER_ID}`;

function snapshot(value: unknown) {
  return { exists: () => value !== undefined, data: () => value };
}

beforeEach(() => {
  for (const mock of Object.values(sdk)) mock.mockReset();
});

describe("cloud document operations", () => {
  it.each([2, 3])("loads schema %i with one read and no history query or writes", async (schemaVersion) => {
    const state = setCompletion(createInitialState(NOW), "gospels", true);
    const current = encodeCloudCurrent(state);
    const { activeCompletedCounts: _, ...shared } = current;
    const document = schemaVersion === 3
      ? current
      : { ...shared, schemaVersion: 2, activeCompletedMask: 1 };
    sdk.getDocFromServer.mockResolvedValue(snapshot(document));

    expect(await loadCloudState(USER_ID)).toEqual({ state, needsMigration: schemaVersion === 2 });
    expect(sdk.getDocFromServer).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });

  it("returns an absent profile after one read without querying history or creating data", async () => {
    sdk.getDocFromServer.mockResolvedValue(snapshot(undefined));

    expect(await loadCloudState(USER_ID)).toBeUndefined();
    expect(sdk.getDocFromServer).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.setDoc).not.toHaveBeenCalled();
    expect(sdk.transactionSet).not.toHaveBeenCalled();
  });

  it("loads legacy history once without changing the original cloud copy", async () => {
    const state = rolloverIfNeeded(
      setCompletion(createInitialState(NOW), "gospels", true),
      new Date("2026-10-03T12:00:00Z"),
    );
    const { activeCompletedCounts: _, history: __, ...shared } = encodeCloudCurrent(state);
    sdk.getDocFromServer.mockResolvedValue(snapshot({ ...shared, schemaVersion: 1, activeCompletedMask: 0 }));
    sdk.getDocsFromServer.mockResolvedValue({
      docs: state.history.map((session) => snapshot(encodeCloudSession(session))),
    });

    expect(await loadCloudState(USER_ID)).toEqual({ state, needsMigration: true });
    expect(sdk.getDocFromServer).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    expect(sdk.getDocsFromServer).toHaveBeenCalledExactlyOnceWith(`${USER_PATH}/sessions`);
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });

  it("rejects invalid current data without fallback history reads or replacement writes", async () => {
    sdk.getDocFromServer.mockResolvedValue(snapshot({ ...encodeCloudCurrent(createInitialState(NOW)), revision: -1 }));

    await expect(loadCloudState(USER_ID)).rejects.toBeInstanceOf(CloudDataError);
    expect(sdk.getDocFromServer).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });

  it("saves one complete recovery document with one write and no preparatory reads", async () => {
    const state = rolloverIfNeeded(
      setCompletion(createInitialState(NOW), "gospels", true),
      new Date("2026-10-03T12:00:00Z"),
    );

    await saveCloudState(USER_ID, state);

    expect(sdk.setDoc).toHaveBeenCalledExactlyOnceWith(USER_PATH, {
      ...encodeCloudCurrent(state),
      updatedAt: "synthetic-server-timestamp",
    });
    expect(sdk.getDocFromServer).not.toHaveBeenCalled();
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.transactionGet).not.toHaveBeenCalled();
  });

  it.each([false, true])("reads once per create transaction attempt when a profile exists: %s", async (exists) => {
    const state = createInitialState(NOW);
    sdk.transactionGet.mockResolvedValue(snapshot(exists ? encodeCloudCurrent(state) : undefined));

    expect(await createCloudStateIfAbsent(USER_ID, state)).toBe(!exists);
    expect(sdk.transactionGet).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    if (exists) {
      expect(sdk.transactionSet).not.toHaveBeenCalled();
    } else {
      expect(sdk.transactionSet).toHaveBeenCalledExactlyOnceWith(USER_PATH, {
        ...encodeCloudCurrent(state),
        updatedAt: "synthetic-server-timestamp",
      });
    }
    expect(sdk.getDocFromServer).not.toHaveBeenCalled();
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });

  it("propagates quota exhaustion without an adapter retry or fallback write", async () => {
    const quotaError = { code: "resource-exhausted" };
    sdk.getDocFromServer.mockRejectedValue(quotaError);

    await expect(loadCloudState(USER_ID)).rejects.toBe(quotaError);
    expect(sdk.getDocFromServer).toHaveBeenCalledExactlyOnceWith(USER_PATH);
    expect(sdk.getDocsFromServer).not.toHaveBeenCalled();
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });
});
