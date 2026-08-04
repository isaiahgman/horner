import Dexie, { type EntityTable } from "dexie";

import { normalizeReadingState } from "../domain/backup.js";
import { decodeCloudState, encodeCloudCurrent } from "./cloud-codec.js";
import type { ReadingState } from "../domain/state.js";

const PENDING_STATE_KEY = "horner-next-ten-pending-v2";
const DATABASE_TIMEOUT_MS = 5_000;

interface StoredState {
  readonly id: "primary";
  readonly state: ReadingState;
}

class HornerDatabase extends Dexie {
  appState!: EntityTable<StoredState, "id">;

  constructor() {
    super("horner-next-ten");
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

function pendingStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readPendingState(): ReadingState | undefined {
  const storage = pendingStorage();
  if (!storage) return undefined;
  try {
    const value = storage.getItem(PENDING_STATE_KEY);
    return value ? decodeCloudState(JSON.parse(value) as unknown) : undefined;
  } catch {
    try {
      storage.removeItem(PENDING_STATE_KEY);
    } catch {
      // Storage can become unavailable between calls. IndexedDB remains the
      // primary persistence path in that case.
    }
    return undefined;
  }
}

function stagePendingState(state: ReadingState): void {
  try {
    pendingStorage()?.setItem(
      PENDING_STATE_KEY,
      JSON.stringify(encodeCloudCurrent(state)),
    );
  } catch {
    // The compact journal stays under 850 kB by design, but a browser may
    // still disable synchronous storage. The IndexedDB write continues.
  }
}

function clearPendingState(expectedRevision?: number): void {
  const storage = pendingStorage();
  if (!storage) return;
  try {
    if (expectedRevision !== undefined) {
      const pending = readPendingState();
      if (pending && pending.revision !== expectedRevision) return;
    }
    storage.removeItem(PENDING_STATE_KEY);
  } catch {
    // A retained journal is safe: the next load compares its revision with
    // IndexedDB and removes it once the durable copy is confirmed.
  }
}

export async function loadReadingState(): Promise<ReadingState | undefined> {
  const pending = readPendingState();
  let storedState: ReadingState | undefined;
  try {
    const stored = await withTimeout(
      database.appState.get("primary"),
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
        database.appState.put({ id: "primary", state: pending }),
        "Recovering pending progress",
      );
      clearPendingState(pending.revision);
    } catch {
      // Keep the compact journal so this recovery can be retried next launch.
    }
    return pending;
  }

  if (pending) clearPendingState();
  return storedState;
}

export async function saveReadingState(state: ReadingState): Promise<void> {
  // localStorage is only a compact write-ahead journal. Its synchronous write
  // closes the tiny page-reload window before IndexedDB commits; IndexedDB
  // remains the authoritative local store and clears the matching journal.
  stagePendingState(state);
  await withTimeout(
    database.appState.put({ id: "primary", state }),
    "Saving device progress",
  );
  clearPendingState(state.revision);
}

export async function replaceReadingState(state: ReadingState): Promise<void> {
  await withTimeout(
    database.transaction("rw", database.appState, async () => {
      await database.appState.clear();
      await database.appState.put({ id: "primary", state });
    }),
    "Replacing device progress",
  );
  clearPendingState();
}
