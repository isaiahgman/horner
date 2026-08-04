import Dexie, { type EntityTable } from "dexie";

import type { ReadingState } from "../domain/state.js";

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

export async function loadReadingState(): Promise<ReadingState | undefined> {
  return (await database.appState.get("primary"))?.state;
}

export async function saveReadingState(state: ReadingState): Promise<void> {
  await database.appState.put({ id: "primary", state });
}

export async function replaceReadingState(state: ReadingState): Promise<void> {
  await database.transaction("rw", database.appState, async () => {
    await database.appState.clear();
    await database.appState.put({ id: "primary", state });
  });
}
