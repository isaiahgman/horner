import type { ReadingState } from "../domain/state.js";

export type ReconciliationDecision = "local" | "remote" | "same" | "conflict";

function equivalentState(left: ReadingState, right: ReadingState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFreshLocalState(state: ReadingState): boolean {
  return (
    state.revision === 0 &&
    state.history.length === 0 &&
    Object.values(state.activeSession.completed).every((completed) => !completed)
  );
}

export function decideReconciliation(
  local: ReadingState,
  remote: ReadingState,
): ReconciliationDecision {
  if (equivalentState(local, remote)) return "same";
  if (local.revision > remote.revision) return "local";
  if (remote.revision > local.revision) return "remote";
  if (isFreshLocalState(local)) return "remote";
  return "conflict";
}
