import {
  rebaseReadingState,
  rolloverIfNeeded,
  type ReadingState,
} from "../domain/state.js";

export type ReconciliationDecision = "local" | "remote" | "same" | "conflict";
export type ReconciliationConflictChoice = "local" | "remote";

export interface LoadedCloudState {
  readonly state: ReadingState;
  readonly needsMigration: boolean;
}

export interface ResolvedCloudState {
  readonly state: ReadingState;
  readonly decision: ReconciliationDecision;
  readonly upload: boolean;
}

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

export function resolveLoadedCloudState(
  local: ReadingState,
  loaded: LoadedCloudState | undefined,
  now: Date,
  conflictChoice: ReconciliationConflictChoice,
  preferExistingRemote = false,
): ResolvedCloudState {
  if (!loaded) {
    return {
      state: rolloverIfNeeded(local, now),
      decision: "local",
      upload: true,
    };
  }

  // Compare the stored copies before applying today's rollover. Otherwise an
  // older copy can appear newer solely because it was rolled over first.
  const decision = preferExistingRemote
    ? "remote"
    : decideReconciliation(local, loaded.state);
  let selected: ReadingState;
  let upload = loaded.needsMigration;

  if (decision === "local") {
    selected = local;
    upload = true;
  } else if (decision === "remote" || decision === "same") {
    selected = loaded.state;
  } else if (conflictChoice === "local") {
    selected = rebaseReadingState(local, loaded.state.revision);
    upload = true;
  } else {
    selected = loaded.state;
  }

  const rolled = rolloverIfNeeded(selected, now);
  return {
    state: rolled,
    decision,
    upload: upload || rolled !== selected,
  };
}
