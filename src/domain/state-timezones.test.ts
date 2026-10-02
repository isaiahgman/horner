import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBackupJson, serializeBackup } from "./backup.js";
import { LIST_IDS } from "./lists.js";
import {
  completeNextAdditionalChapter,
  createInitialState,
  readingDateFor,
  rolloverIfNeeded,
  setCompletion,
} from "./state.js";

// Vitest's default fork pool gives this file its own process. Keep timezone
// changes sequential and restore them after each case, including failures.
afterEach(() => vi.unstubAllEnvs());

describe.sequential("reading-day rollover in local timezones", () => {
  it.each([
    ["America/New_York", "2026-03-08T04:00:00-04:00", 240, "2026-03-07", "2026-03-08"],
    ["America/New_York", "2026-11-01T04:00:00-05:00", 300, "2026-10-31", "2026-11-01"],
    ["Australia/Lord_Howe", "2026-04-05T04:00:00+10:30", -630, "2026-04-04", "2026-04-05"],
    ["Australia/Lord_Howe", "2026-10-04T04:00:00+11:00", -660, "2026-10-03", "2026-10-04"],
    ["Pacific/Kiritimati", "2027-01-01T04:00:00+14:00", -840, "2026-12-31", "2027-01-01"],
    ["Pacific/Honolulu", "2027-01-01T04:00:00-10:00", 600, "2026-12-31", "2027-01-01"],
    ["Asia/Kathmandu", "2028-02-29T04:00:00+05:45", -345, "2028-02-28", "2028-02-29"],
    ["UTC", "2028-03-01T04:00:00Z", 0, "2028-02-29", "2028-03-01"],
  ] as const)(
    "preserves progress across %s boundary %s",
    (timezone, boundary, offset, previousDate, nextDate) => {
      vi.stubEnv("TZ", timezone);
      const atBoundary = new Date(boundary);
      const beforeBoundary = new Date(atBoundary.getTime() - 1);
      // Assert the zone actually took effect, rather than accidentally testing
      // the CI runner's timezone with offset-bearing input strings.
      expect(atBoundary.getTimezoneOffset()).toBe(offset);
      expect(atBoundary.getHours()).toBe(4);
      expect(readingDateFor(beforeBoundary, 4)).toBe(previousDate);
      expect(readingDateFor(atBoundary, 4)).toBe(nextDate);

      let state = createInitialState(beforeBoundary);
      state = setCompletion(state, "gospels", true);
      state = completeNextAdditionalChapter(state, "gospels", 1);
      state = setCompletion(state, "acts", true);
      const originalBackup = serializeBackup(state);
      expect(rolloverIfNeeded(state, beforeBoundary)).toBe(state);

      const rolled = rolloverIfNeeded(state, atBoundary);
      expect(rolled.revision).toBe(state.revision + 1);
      expect(rolled.activeSession.readingDate).toBe(nextDate);
      expect(rolled.history).toEqual([state.activeSession]);
      expect(rolled.activeSession.chapters.gospels).toBe("matthew:3");
      expect(rolled.activeSession.chapters.acts).toBe("acts:2");
      for (const listId of LIST_IDS) {
        expect(rolled.activeSession.completedCounts[listId]).toBe(0);
        if (listId !== "gospels" && listId !== "acts") {
          expect(rolled.cursors[listId]).toBe(state.cursors[listId]);
          expect(rolled.activeSession.chapters[listId]).toBe(
            state.activeSession.chapters[listId],
          );
        }
      }
      expect(serializeBackup(state)).toBe(originalBackup);
      expect(parseBackupJson(serializeBackup(rolled), atBoundary)).toEqual(rolled);
      expect(rolloverIfNeeded(rolled, atBoundary)).toBe(rolled);
      expect(rolloverIfNeeded(rolled, new Date(atBoundary.getTime() + 3_600_000)))
        .toBe(rolled);
    },
  );

  it("keeps both occurrences of a repeated hour in the same reading day", () => {
    vi.stubEnv("TZ", "America/New_York");
    const first = new Date("2026-11-01T01:30:00-04:00");
    const repeated = new Date("2026-11-01T01:30:00-05:00");
    expect(first.getTimezoneOffset()).toBe(240);
    expect(repeated.getTimezoneOffset()).toBe(300);
    expect(readingDateFor(first, 4)).toBe("2026-10-31");
    expect(readingDateFor(repeated, 4)).toBe("2026-10-31");

    const state = setCompletion(createInitialState(first), "acts", true);
    expect(rolloverIfNeeded(state, repeated)).toBe(state);
  });

  it("rolls once when a configured boundary falls in a skipped spring hour", () => {
    vi.stubEnv("TZ", "America/New_York");
    const beforeJump = new Date("2026-03-08T01:59:59.999-05:00");
    const afterJump = new Date(beforeJump.getTime() + 1);
    expect(afterJump.getHours()).toBe(3);
    expect(readingDateFor(beforeJump, 2)).toBe("2026-03-07");
    expect(readingDateFor(afterJump, 2)).toBe("2026-03-08");

    const state = setCompletion(
      createInitialState(beforeJump, { rolloverHour: 2 }),
      "acts",
      true,
    );
    const rolled = rolloverIfNeeded(state, afterJump);
    expect(rolled.history).toEqual([state.activeSession]);
    expect(rolled.activeSession.chapters.acts).toBe("acts:2");
    expect(rolloverIfNeeded(rolled, new Date("2026-03-08T04:00:00-04:00")))
      .toBe(rolled);
  });

  it.each(["America/New_York", "Asia/Kathmandu", "Pacific/Kiritimati"])(
    "honors every configured boundary hour in %s",
    (timezone) => {
      vi.stubEnv("TZ", timezone);
      for (let hour = 0; hour <= 23; hour += 1) {
        const boundary = new Date(2027, 0, 1, hour);
        expect(readingDateFor(new Date(boundary.getTime() - 1), hour))
          .toBe("2026-12-31");
        expect(readingDateFor(boundary, hour)).toBe("2027-01-01");
      }
    },
  );
});
