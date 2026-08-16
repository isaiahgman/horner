import { describe, expect, it } from "vitest";

import {
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
} from "../domain/lists.js";
import {
  completeNextAdditionalChapter,
  createInitialState,
  createSession,
  MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION,
  rolloverIfNeeded,
  setCompletion,
  type ListRecord,
  type ReadingSession,
  type ReadingState,
} from "../domain/state.js";
import {
  cloudStateNeedsMigration,
  cloudStateUsesLegacySessions,
  decodeCloudState,
  encodeCloudCurrent,
  encodeCloudSession,
  MAX_CLOUD_HISTORY_SESSIONS,
  MAX_ENCODED_CLOUD_BYTES,
} from "./cloud-codec.js";

function completedMask(session: ReadingSession): number {
  return LIST_IDS.reduce(
    (mask, listId, index) =>
      mask | (session.completedCounts[listId] > 0 ? 1 << index : 0),
    0,
  );
}

function cursorIndexes(session: ReadingSession): number[] {
  return LIST_IDS.map((listId) =>
    cursorForChapter(listId, session.chapters[listId]),
  );
}

function version2Document(state: ReadingState): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: state.revision,
    cursorIndexes: LIST_IDS.map((listId) => state.cursors[listId]),
    activeReadingDate: state.activeSession.readingDate,
    activeCompletedMask: completedMask(state.activeSession),
    rolloverHour: state.settings.rolloverHour,
    preferredBibleUrl: state.settings.preferredBibleUrl ?? null,
    history: state.history.map((session) =>
      `${session.readingDate}|${cursorIndexes(session).join(",")}|${completedMask(session)}`
    ),
  };
}

function completeAdditional(
  state: ReadingState,
  listId: Parameters<typeof completeNextAdditionalChapter>[1],
  amount: number,
): ReadingState {
  let next = state;
  for (let index = 0; index < amount; index += 1) {
    next = completeNextAdditionalChapter(next, listId);
  }
  return next;
}

function maxCountRecord(): ListRecord<number> {
  return Object.fromEntries(
    LIST_IDS.map((listId) => [
      listId,
      MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION,
    ]),
  ) as ListRecord<number>;
}

function dateKeyAt(day: number): string {
  const date = new Date(Date.UTC(2000, 0, 1 + day));
  return date.toISOString().slice(0, 10);
}

function maximumCloudState(): ReadingState {
  const initial = createInitialState(new Date("2000-01-01T12:00:00Z"), {
    rolloverHour: 23,
    preferredBibleUrl: `https://example.com/${"a".repeat(2_028)}`,
  });
  const counts = maxCountRecord();
  let cursors = { ...initial.cursors };
  const history: ReadingSession[] = [];

  for (let day = 0; day < MAX_CLOUD_HISTORY_SESSIONS; day += 1) {
    history.push({
      ...createSession(dateKeyAt(day), cursors),
      completedCounts: counts,
    });
    cursors = Object.fromEntries(
      LIST_IDS.map((listId) => [
        listId,
        (
          cursors[listId] +
          MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION
        ) % READING_LIST_BY_ID[listId].chapters.length,
      ]),
    ) as ListRecord<number>;
  }

  return {
    ...initial,
    revision: Number.MAX_SAFE_INTEGER,
    cursors,
    activeSession: {
      ...createSession(dateKeyAt(MAX_CLOUD_HISTORY_SESSIONS), cursors),
      completedCounts: counts,
    },
    history,
  };
}

describe("cloud state codec", () => {
  it("round-trips current core and additional progress", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = completeAdditional(state, "gospels", 2);
    state = setCompletion(state, "acts", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    state = setCompletion(state, "wisdom", true);
    state = completeAdditional(state, "wisdom", 3);

    const encoded = encodeCloudCurrent(state);
    expect(encoded.schemaVersion).toBe(3);
    expect(encoded.activeCompletedCounts[4]).toBe(4);
    expect(encoded.history[0]?.split("|")[2]).toHaveLength(20);
    expect(decodeCloudState(encoded)).toEqual(state);
    expect(cloudStateNeedsMigration(encoded)).toBe(false);
    expect(cloudStateUsesLegacySessions(encoded)).toBe(false);
  });

  it("migrates version 2 masks without reading a legacy session collection", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    state = setCompletion(state, "acts", true);
    const previous = version2Document(state);

    expect(cloudStateNeedsMigration(previous)).toBe(true);
    expect(cloudStateUsesLegacySessions(previous)).toBe(false);
    expect(decodeCloudState(previous)).toEqual(state);
  });

  it("migrates version 1 documents and their session collection", () => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    const { history: _history, revision: _revision, ...shared } = version2Document(state);
    const legacy = { ...shared, schemaVersion: 1 };

    expect(cloudStateNeedsMigration(legacy)).toBe(true);
    expect(cloudStateUsesLegacySessions(legacy)).toBe(true);
    expect(
      decodeCloudState(legacy, state.history.map(encodeCloudSession)),
    ).toEqual({ ...state, revision: 0 });
  });

  it("keeps the maximum fixed-width history below the cloud byte guard", () => {
    const state = maximumCloudState();
    const encoded = encodeCloudCurrent(state);
    const bytes = new TextEncoder().encode(JSON.stringify(encoded)).byteLength;

    expect(encoded.history).toHaveLength(MAX_CLOUD_HISTORY_SESSIONS);
    expect(encoded.history.every((entry) => entry.split("|")[2]?.length === 20))
      .toBe(true);
    expect(bytes).toBeLessThan(MAX_ENCODED_CLOUD_BYTES);
    expect(bytes).toBeGreaterThan(600_000);
    expect(decodeCloudState(encoded)).toEqual(state);
  });

  it("rejects cursor indexes outside their published lists", () => {
    const state = createInitialState(new Date("2026-08-03T12:00:00"));
    const encoded = encodeCloudCurrent(state);
    expect(() =>
      decodeCloudState({
        ...encoded,
        cursorIndexes: [...LIST_IDS.map(() => 0), 999],
      })
    ).toThrow(/invalid cursor list/);
  });

  it.each([
    { activeCompletedCounts: [-1, ...Array(9).fill(0)] },
    { activeCompletedCounts: [1.5, ...Array(9).fill(0)] },
    { activeCompletedCounts: [1_024, ...Array(9).fill(0)] },
    { activeCompletedCounts: Array(9).fill(0) },
    { activeCompletedCounts: ["1", ...Array(9).fill(0)] },
  ])("rejects malformed active completed counts %#", (replacement) => {
    const encoded = encodeCloudCurrent(
      createInitialState(new Date("2026-08-03T12:00:00")),
    );
    expect(() => decodeCloudState({ ...encoded, ...replacement })).toThrow(
      /invalid completed-count list|invalid completed count/,
    );
  });

  it.each([
    "0".repeat(19),
    "0".repeat(19) + "!",
    "0".repeat(19) + "Z",
    "zz" + "00".repeat(9),
  ])("rejects malformed compact completed counts %s", (counts) => {
    let state = createInitialState(new Date("2026-08-03T12:00:00"));
    state = rolloverIfNeeded(state, new Date("2026-08-04T12:00:00"));
    const encoded = encodeCloudCurrent(state);
    const [entry] = encoded.history;
    const parts = entry!.split("|");
    const invalidEntry = `${parts[0]}|${parts[1]}|${counts}`;

    expect(() => decodeCloudState({ ...encoded, history: [invalidEntry] }))
      .toThrow(/invalid completed counts|invalid completed count/);
  });

  it("rejects non-list, oversized, and structurally invalid history", () => {
    const encoded = encodeCloudCurrent(
      createInitialState(new Date("2026-08-03T12:00:00")),
    );

    expect(() => decodeCloudState({ ...encoded, history: "not-a-list" }))
      .toThrow(/invalid history/);
    expect(() => decodeCloudState({
      ...encoded,
      history: Array(MAX_CLOUD_HISTORY_SESSIONS + 1).fill("invalid"),
    })).toThrow(/history is too large/);
    expect(() => decodeCloudState({ ...encoded, history: ["invalid"] }))
      .toThrow(/invalid compact session/);
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
