import { describe, expect, it } from "vitest";

import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  type ChapterId,
  type ListId,
} from "./lists.js";
import {
  completedCount,
  createInitialState,
  createSession,
  readingDateFor,
  rolloverIfNeeded,
  setCompletion,
  setPreviousSessionCompletion,
  toggleCompletion,
  undoLastRollover,
  type ListRecord,
  type ReadingState,
} from "./state.js";

const localDate = (value: string): Date => new Date(value);

function stateAt(
  now: Date,
  chapterIds: Partial<Record<ListId, ChapterId>>,
): ReadingState {
  const initial = createInitialState(now);
  const cursors = Object.fromEntries(
    LIST_IDS.map((listId) => {
      const chapterId = chapterIds[listId];
      return [
        listId,
        chapterId === undefined
          ? initial.cursors[listId]
          : cursorForChapter(listId, chapterId),
      ];
    }),
  ) as ListRecord<number>;
  return { ...initial, cursors, activeSession: createSession(initial.activeSession.readingDate, cursors) };
}

describe("reading-day calculation", () => {
  it("uses a 4 a.m. local boundary by default", () => {
    expect(readingDateFor(localDate("2026-08-03T03:59:59"), 4)).toBe("2026-08-02");
    expect(readingDateFor(localDate("2026-08-03T04:00:00"), 4)).toBe("2026-08-03");
  });

  it("supports midnight and rejects invalid boundary hours", () => {
    expect(readingDateFor(localDate("2026-08-03T00:00:00"), 0)).toBe("2026-08-03");
    expect(() => readingDateFor(new Date(), 24)).toThrow(RangeError);
    expect(() => readingDateFor(new Date("invalid"), 4)).toThrow(RangeError);
  });
});

describe("reading state machine", () => {
  it("creates one fixed chapter from each list", () => {
    const state = createInitialState(localDate("2026-08-03T12:00:00"));
    expect(Object.values(state.activeSession.chapters)).toHaveLength(10);
    expect(Object.values(state.activeSession.chapters)).toEqual([
      "matthew:24",
      "genesis:24",
      "1-corinthians:8",
      "james:2",
      "job:24",
      "psalm:24",
      "proverbs:24",
      "joshua:24",
      "isaiah:24",
      "acts:24",
    ]);
    expect(completedCount(state.activeSession)).toBe(0);
  });

  it("records completion without replacing the visible chapter", () => {
    const state = createInitialState(localDate("2026-08-03T12:00:00"));
    const checked = toggleCompletion(state, "gospels");
    expect(checked.activeSession.chapters.gospels).toBe("matthew:24");
    expect(checked.activeSession.completed.gospels).toBe(true);
    expect(state.activeSession.completed.gospels).toBe(false);
  });

  it("advances only checked lists at the next reading day", () => {
    let state = stateAt(localDate("2026-08-03T12:00:00"), {
      gospels: "matthew:24",
      pentateuch: "genesis:24",
      romansToHebrews: "1-corinthians:8",
      thessaloniansToRevelation: "james:2",
      wisdom: "job:24",
      psalms: "psalm:24",
      proverbs: "proverbs:24",
      history: "joshua:24",
      prophets: "isaiah:24",
      acts: "acts:24",
    });
    const completed: ListId[] = [
      "gospels",
      "pentateuch",
      "thessaloniansToRevelation",
      "psalms",
      "proverbs",
      "prophets",
      "acts",
    ];
    for (const listId of completed) state = setCompletion(state, listId, true);

    const next = rolloverIfNeeded(state, localDate("2026-08-04T12:00:00"));
    const labels = Object.fromEntries(
      LIST_IDS.map((listId) => [listId, chapterAt(listId, next.cursors[listId]).label]),
    );
    expect(labels).toEqual({
      gospels: "Matthew 25",
      pentateuch: "Genesis 25",
      romansToHebrews: "1 Corinthians 8",
      thessaloniansToRevelation: "James 3",
      wisdom: "Job 24",
      psalms: "Psalm 25",
      proverbs: "Proverbs 25",
      history: "Joshua 24",
      prophets: "Isaiah 25",
      acts: "Acts 25",
    });
    expect(next.history).toHaveLength(1);
    expect(completedCount(next.activeSession)).toBe(0);
  });

  it("creates no phantom sessions or extra advancement after skipped days", () => {
    let friday = createInitialState(localDate("2026-07-31T12:00:00"));
    for (const listId of LIST_IDS.slice(0, 6)) {
      friday = setCompletion(friday, listId, true);
    }

    const monday = rolloverIfNeeded(friday, localDate("2026-08-03T12:00:00"));
    expect(monday.history).toHaveLength(1);
    expect(monday.history[0]?.readingDate).toBe("2026-07-31");
    expect(monday.activeSession.readingDate).toBe("2026-08-03");
    for (const [index, listId] of LIST_IDS.entries()) {
      expect(monday.cursors[listId]).toBe(
        friday.cursors[listId] + (index < 6 ? 1 : 0),
      );
    }
  });

  it("is idempotent within one reading day", () => {
    const state = setCompletion(
      createInitialState(localDate("2026-08-03T10:00:00")),
      "gospels",
      true,
    );
    const sameDay = rolloverIfNeeded(state, localDate("2026-08-03T23:00:00"));
    expect(sameDay).toBe(state);
  });

  it("loops each list independently", () => {
    let state = stateAt(localDate("2026-08-03T12:00:00"), { acts: "acts:28" });
    state = setCompletion(state, "acts", true);
    const next = rolloverIfNeeded(state, localDate("2026-08-04T12:00:00"));
    expect(next.activeSession.chapters.acts).toBe("acts:1");
    expect(next.activeSession.chapters.gospels).toBe("matthew:24");
  });

  it("can undo a rollover before the new session has progress", () => {
    let state = createInitialState(localDate("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    const rolled = rolloverIfNeeded(state, localDate("2026-08-04T12:00:00"));
    const undone = undoLastRollover(rolled);
    expect(undone).toEqual(state);
  });

  it("refuses to discard progress while undoing a rollover", () => {
    let state = createInitialState(localDate("2026-08-03T12:00:00"));
    state = rolloverIfNeeded(state, localDate("2026-08-04T12:00:00"));
    state = setCompletion(state, "acts", true);
    expect(() => undoLastRollover(state)).toThrow(/new session has progress/);
  });

  it("repairs the latest session and recalculates the current chapter", () => {
    let state = createInitialState(localDate("2026-08-03T12:00:00"));
    state = setCompletion(state, "gospels", true);
    state = rolloverIfNeeded(state, localDate("2026-08-04T12:00:00"));
    expect(state.activeSession.chapters.gospels).toBe("matthew:25");

    const repaired = setPreviousSessionCompletion(state, "gospels", false);
    expect(repaired.history[0]?.completed.gospels).toBe(false);
    expect(repaired.activeSession.chapters.gospels).toBe("matthew:24");
  });

  it("does not roll backward when the device clock moves backward", () => {
    const state = createInitialState(localDate("2026-08-03T12:00:00"));
    expect(rolloverIfNeeded(state, localDate("2026-08-02T12:00:00"))).toBe(state);
  });
});
