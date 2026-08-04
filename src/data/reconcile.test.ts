import { describe, expect, it } from "vitest";

import { createInitialState, setCompletion } from "../domain/state.js";
import { decideReconciliation } from "./reconcile.js";

const NOW = new Date("2026-08-03T12:00:00");

describe("cloud reconciliation", () => {
  it("keeps newer local progress made while signed out", () => {
    const remote = setCompletion(createInitialState(NOW), "gospels", true);
    const local = setCompletion(remote, "acts", true);
    expect(decideReconciliation(local, remote)).toBe("local");
  });

  it("restores newer cloud progress after browser storage is cleared", () => {
    const local = createInitialState(NOW);
    let remote = setCompletion(createInitialState(NOW), "gospels", true);
    remote = setCompletion(remote, "acts", true);
    expect(decideReconciliation(local, remote)).toBe("remote");
  });

  it("restores legacy cloud progress over a genuinely fresh local state", () => {
    const local = createInitialState(NOW);
    const remote = {
      ...setCompletion(createInitialState(NOW), "gospels", true),
      revision: 0,
    };
    expect(decideReconciliation(local, remote)).toBe("remote");
  });

  it("requires an explicit choice for equal-revision divergent progress", () => {
    const base = createInitialState(NOW);
    const local = setCompletion(base, "gospels", true);
    const remote = setCompletion(base, "acts", true);
    expect(decideReconciliation(local, remote)).toBe("conflict");
  });

  it("recognizes identical copies", () => {
    const state = setCompletion(createInitialState(NOW), "gospels", true);
    expect(decideReconciliation(state, state)).toBe("same");
  });
});
