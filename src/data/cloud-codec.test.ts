import { describe, expect, it } from "vitest";

import { LIST_IDS } from "../domain/lists.js";
import {
  createInitialState,
  rolloverIfNeeded,
  setCompletion,
} from "../domain/state.js";
import {
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

  it("rejects cursor indexes outside their published lists", () => {
    const state = createInitialState(new Date("2026-08-03T12:00:00"));
    const encoded = encodeCloudCurrent(state);
    expect(() =>
      decodeCloudState({ ...encoded, cursorIndexes: [...LIST_IDS.map(() => 0), 999] }, []),
    ).toThrow(/invalid cursor list/);
  });
});
