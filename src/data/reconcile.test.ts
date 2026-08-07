import { describe, expect, it } from "vitest";

import {
  createInitialState,
  rolloverIfNeeded,
  setCompletion,
} from "../domain/state.js";
import {
  decideReconciliation,
  resolveLoadedCloudState,
} from "./reconcile.js";

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

  it("rolls over and uploads local progress when no cloud copy exists", () => {
    const local = setCompletion(createInitialState(NOW), "gospels", true);
    const result = resolveLoadedCloudState(
      local,
      undefined,
      new Date("2026-08-04T12:00:00"),
      "remote",
    );

    expect(result.decision).toBe("local");
    expect(result.upload).toBe(true);
    expect(result.state.activeSession.readingDate).toBe("2026-08-04");
    expect(result.state.activeSession.chapters.gospels).toBe("matthew:2");
  });

  it("compares raw revisions before rolling over the selected copy", () => {
    const base = createInitialState(NOW);
    const local = rolloverIfNeeded(base, new Date("2026-08-04T12:00:00"));
    const remote = setCompletion(base, "acts", true);
    const result = resolveLoadedCloudState(
      local,
      { state: remote, needsMigration: false },
      new Date("2026-08-04T12:00:00"),
      "local",
    );

    expect(local.revision).toBe(remote.revision);
    expect(result.decision).toBe("conflict");
    expect(result.state.activeSession.readingDate).toBe("2026-08-04");
    expect(result.state.activeSession.completed.acts).toBe(false);
    expect(result.state.revision).toBe(2);
    expect(result.upload).toBe(true);
  });

  it("restores a newer remote copy without uploading it again", () => {
    const local = createInitialState(NOW);
    const remote = setCompletion(local, "acts", true);
    const result = resolveLoadedCloudState(
      local,
      { state: remote, needsMigration: false },
      NOW,
      "local",
    );

    expect(result).toEqual({
      state: remote,
      decision: "remote",
      upload: false,
    });
  });

  it("uploads a restored remote copy when rollover or migration changes the cloud", () => {
    const remote = setCompletion(createInitialState(NOW), "gospels", true);
    const nextDay = new Date("2026-08-04T12:00:00");
    const rolled = resolveLoadedCloudState(
      createInitialState(NOW),
      { state: remote, needsMigration: false },
      nextDay,
      "remote",
    );
    const migrated = resolveLoadedCloudState(
      remote,
      { state: remote, needsMigration: true },
      NOW,
      "remote",
    );

    expect(rolled.decision).toBe("remote");
    expect(rolled.state.activeSession.readingDate).toBe("2026-08-04");
    expect(rolled.state.activeSession.chapters.gospels).toBe("matthew:2");
    expect(rolled.upload).toBe(true);
    expect(migrated).toEqual({
      state: remote,
      decision: "same",
      upload: true,
    });
  });

  it("honors either explicit choice for divergent equal revisions", () => {
    const base = createInitialState(NOW);
    const local = setCompletion(base, "gospels", true);
    const remote = setCompletion(base, "acts", true);
    const keepLocal = resolveLoadedCloudState(
      local,
      { state: remote, needsMigration: false },
      NOW,
      "local",
    );
    const keepRemote = resolveLoadedCloudState(
      local,
      { state: remote, needsMigration: false },
      NOW,
      "remote",
    );

    expect(keepLocal.decision).toBe("conflict");
    expect(keepLocal.state.activeSession.completed.gospels).toBe(true);
    expect(keepLocal.state.activeSession.completed.acts).toBe(false);
    expect(keepLocal.state.revision).toBe(2);
    expect(keepLocal.upload).toBe(true);

    expect(keepRemote).toEqual({
      state: remote,
      decision: "conflict",
      upload: false,
    });
  });

  it("keeps an existing cloud profile ahead of guest-derived local progress", () => {
    const remote = setCompletion(createInitialState(NOW), "acts", true);
    let guestDerived = setCompletion(createInitialState(NOW), "gospels", true);
    guestDerived = setCompletion(guestDerived, "psalms", true);

    const result = resolveLoadedCloudState(
      guestDerived,
      { state: remote, needsMigration: false },
      NOW,
      "local",
      true,
    );

    expect(guestDerived.revision).toBeGreaterThan(remote.revision);
    expect(result).toEqual({
      state: remote,
      decision: "remote",
      upload: false,
    });
  });
});
