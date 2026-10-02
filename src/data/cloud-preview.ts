/**
 * Guest-only implementation. All Firebase imports here are type-only and erased.
 * Never initialize Firebase, restore an account, or contact any remote service.
 */
import type { User } from "firebase/auth";
import type { ReadingState } from "../domain/state.js";
import type { LoadedCloudState } from "./cloud.js";
export { isCloudPermissionError } from "./cloud-config.js";

export function observeCloudAccount(listener: (user: User | null) => void): () => void {
  let active = true;
  queueMicrotask(() => { if (active) listener(null); });
  return () => { active = false; };
}

function unavailable(): never {
  throw new Error("Cloud accounts are disabled in this synthetic QA preview.");
}

export async function signInToCloud(): Promise<User> { return unavailable(); }
export async function signOutOfCloud(): Promise<void> { return unavailable(); }
export async function loadCloudState(_userId: string): Promise<LoadedCloudState | undefined> {
  return unavailable();
}
export async function saveCloudState(_userId: string, _state: ReadingState): Promise<void> {
  return unavailable();
}
export async function createCloudStateIfAbsent(_userId: string, _state: ReadingState): Promise<boolean> {
  return unavailable();
}
export async function waitForCloudWrites(): Promise<void> { return unavailable(); }
