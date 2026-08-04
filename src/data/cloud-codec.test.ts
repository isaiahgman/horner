import { describe, expect, it } from "vitest";

import { LIST_IDS } from "../domain/lists.js";
import {
  createInitialState,
  rolloverIfNeeded,
  setCompletion,
} from "../domain/state.js";
import {
  cloudStateNeedsMigration,
  decodeCloudState,
  encodeCloudCurrent,
  encodeCloudSession,
} from "./cloud-codec.js";

describe("cloud state codec", () => {
  it("round-trips current progress and normalized history", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = setCompletion(state, "acts", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    state = setCompletion(state, "wisdom", true);

    const restored = decodeCloudState(
      encodeCloudCurrent(state),
      state.history.map(encodeCloudSession),
    );
    expect(restored).toEqual(state);
  });

  it("migrates version 1 documents and their session collection", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    const encoded = encodeCloudCurrent(state);
    const { history: _history, revision: _revision, ...shared } = encoded;
    const legacy = { ...shared, schemaVersion: 1 };

    expect(cloudStateNeedsMigration(legacy)).toBe(true);
    expect(
      decodeCloudState(legacy, state.history.map(encodeCloudSession)),
    ).toEqual({ ...state, revision: 0 });
  });

  it("rejects cursor indexes outside their published lists", () => {
    const state = createInitialState(new Date("2026-08-03T12:00:00"));
    const encoded = encodeCloudCurrent(state);
    expect(() =>
      decodeCloudState({ ...encoded, cursorIndexes: [...LIST_IDS.map(() => 0), 999] }, []),
    ).toThrow(/invalid cursor list/);
  });

  it("rejects malformed, unsafe, or inconsistent cloud data", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    state = setCompletion(state, "acts", true);
    state = rolloverIfNeeded(state, new Date("2026-08-05T12:00:00"));
    const encoded = encodeCloudCurrent(state);

    expect(() => decodeCloudState({ ...encoded, revision: -1 })).toThrow(
      /invalid revision/,
    );
    expect(() => decodeCloudState({
      ...encoded,
      preferredBibleUrl: "javascript:alert(1)",
    })).toThrow(/HTTPS URL/);
    expect(() => decodeCloudState({
      ...encoded,
      history: [...encoded.history].reverse(),
    })).toThrow(/strictly increasing/);
    expect(() => decodeCloudState({
      ...encoded,
      history: encoded.history.map((session, index) =>
        index === 0 ? session.replace(/^\d{4}-\d{2}-\d{2}/, "2026-02-30") : session,
      ),
    })).toThrow(/invalid reading date/);
  });
});
