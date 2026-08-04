import { describe, expect, it } from "vitest";

import { cursorForChapter, type ChapterId } from "./lists.js";
import {
  MAX_BACKUP_HISTORY_SESSIONS,
  normalizeReadingState,
  parseBackupJson,
  serializeBackup,
} from "./backup.js";
import {
  createInitialState,
  createSession,
  rolloverIfNeeded,
  setCompletion,
  setReadingSettings,
  type ListRecord,
  type ReadingState,
} from "./state.js";

interface MutableSession {
  readingDate: string;
  chapters: ListRecord<ChapterId>;
  completed: ListRecord<boolean>;
}

interface MutableBackup {
  version: number;
  revision?: unknown;
  cursors: ListRecord<number>;
  activeSession: MutableSession;
  history: MutableSession[];
  settings: {
    rolloverHour: unknown;
    preferredBibleUrl?: unknown;
  };
}

const AUGUST_3 = new Date("2026-08-03T12:00:00");
const AUGUST_4 = new Date("2026-08-04T12:00:00");
const AUGUST_5 = new Date("2026-08-05T12:00:00");
const AUGUST_6 = new Date("2026-08-06T12:00:00");

function mutableBackup(state: ReadingState): MutableBackup {
  return JSON.parse(serializeBackup(state)) as MutableBackup;
}

function parseValue(value: MutableBackup, now: Date = AUGUST_6): ReadingState {
  return parseBackupJson(JSON.stringify(value), now);
}

function stateWithTwoHistorySessions(): ReadingState {
  let state = createInitialState(AUGUST_3);
  state = setCompletion(state, "gospels", true);
  state = rolloverIfNeeded(state, AUGUST_4);
  state = setCompletion(state, "acts", true);
  return rolloverIfNeeded(state, AUGUST_5);
}

describe("backup validation", () => {
  it("round-trips a normalized state and accepts a legacy missing revision", () => {
    const state = setReadingSettings(stateWithTwoHistorySessions(), {
      rolloverHour: 4,
      preferredBibleUrl: "https://www.biblegateway.com/passage/",
    });
    expect(parseBackupJson(serializeBackup(state), AUGUST_6)).toEqual(state);

    const legacy = mutableBackup(state);
    delete legacy.revision;
    expect(parseValue(legacy).revision).toBe(0);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null])(
    "rejects invalid revision %j",
    (revision) => {
      const backup = mutableBackup(createInitialState(AUGUST_3));
      backup.revision = revision;
      expect(() => parseValue(backup)).toThrow(/invalid revision/);
    },
  );

  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "0000-01-01",
    "2026-8-03",
  ])("rejects impossible or malformed date %s", (readingDate) => {
    const backup = mutableBackup(createInitialState(AUGUST_3));
    backup.activeSession.readingDate = readingDate;
    expect(() => parseValue(backup)).toThrow(/invalid reading date/);
  });

  it("accepts a real leap day", () => {
    const backup = mutableBackup(createInitialState(AUGUST_3));
    backup.activeSession.readingDate = "2028-02-29";
    expect(parseValue(backup, new Date("2028-03-01T12:00:00")).activeSession.readingDate)
      .toBe("2028-02-29");
  });

  it("rejects an active reading date in the future", () => {
    const future = createInitialState(AUGUST_4);
    expect(() => parseBackupJson(serializeBackup(future), AUGUST_3)).toThrow(
      /in the future/,
    );
  });

  it("requires exact cursor, chapter, and completion records", () => {
    const missingCursor = mutableBackup(createInitialState(AUGUST_3));
    delete (missingCursor.cursors as Partial<ListRecord<number>>).acts;
    expect(() => parseValue(missingCursor)).toThrow(/exactly the ten/);

    const extraCompletion = mutableBackup(createInitialState(AUGUST_3));
    (extraCompletion.activeSession.completed as unknown as Record<string, unknown>).extra = false;
    expect(() => parseValue(extraCompletion)).toThrow(/exact chapter or completion/);

    const invalidCursor = mutableBackup(createInitialState(AUGUST_3));
    invalidCursor.cursors.acts = 28;
    expect(() => parseValue(invalidCursor)).toThrow(/invalid cursor for acts/);

    const wrongListChapter = mutableBackup(createInitialState(AUGUST_3));
    wrongListChapter.activeSession.chapters.gospels = "genesis:24";
    expect(() => parseValue(wrongListChapter)).toThrow(/not part of list gospels/);

    const cursorMismatch = mutableBackup(createInitialState(AUGUST_3));
    cursorMismatch.activeSession.chapters.gospels = "matthew:25";
    expect(() => parseValue(cursorMismatch)).toThrow(/does not match the gospels cursor/);

    const invalidCompletion = mutableBackup(createInitialState(AUGUST_3));
    (invalidCompletion.activeSession.completed as unknown as Record<string, unknown>).gospels = 1;
    expect(() => parseValue(invalidCompletion)).toThrow(/invalid data for gospels/);
  });

  it("requires unique, strictly increasing history before the active session", () => {
    const duplicate = mutableBackup(stateWithTwoHistorySessions());
    duplicate.history[1]!.readingDate = duplicate.history[0]!.readingDate;
    expect(() => parseValue(duplicate)).toThrow(/unique, strictly increasing/);

    const descending = mutableBackup(stateWithTwoHistorySessions());
    descending.history.reverse();
    expect(() => parseValue(descending)).toThrow(/unique, strictly increasing/);

    const equalToActive = mutableBackup(stateWithTwoHistorySessions());
    equalToActive.history.at(-1)!.readingDate = equalToActive.activeSession.readingDate;
    expect(() => parseValue(equalToActive)).toThrow(/unique, strictly increasing/);
  });

  it("rejects a history completion that cannot lead to the next session", () => {
    const backup = mutableBackup(stateWithTwoHistorySessions());
    backup.history[0]!.completed.gospels = false;
    expect(() => parseValue(backup)).toThrow(/invalid gospels transition/);
  });

  it("accepts a looping history transition", () => {
    const initial = createInitialState(AUGUST_3);
    const cursors = {
      ...initial.cursors,
      acts: cursorForChapter("acts", "acts:28"),
    } as ListRecord<number>;
    let state: ReadingState = {
      ...initial,
      cursors,
      activeSession: createSession(initial.activeSession.readingDate, cursors),
    };
    state = setCompletion(state, "acts", true);
    state = rolloverIfNeeded(state, AUGUST_4);
    expect(parseBackupJson(serializeBackup(state), AUGUST_5)).toEqual(state);
  });

  it.each([
    "javascript:alert(1)",
    "http://example.com/read",
    "/relative/path",
    "",
  ])("rejects unsafe preferred Bible URL %j", (preferredBibleUrl) => {
    const backup = mutableBackup(createInitialState(AUGUST_3));
    backup.settings.preferredBibleUrl = preferredBibleUrl;
    expect(() => parseValue(backup)).toThrow(/HTTPS URL/);
  });

  it("rejects a non-string or oversized preferred Bible URL", () => {
    const nonString = mutableBackup(createInitialState(AUGUST_3));
    nonString.settings.preferredBibleUrl = 42;
    expect(() => parseValue(nonString)).toThrow(/invalid preferred Bible URL/);

    const oversized = mutableBackup(createInitialState(AUGUST_3));
    oversized.settings.preferredBibleUrl = `https://example.com/${"a".repeat(2_048)}`;
    expect(() => parseValue(oversized)).toThrow(/invalid preferred Bible URL/);
  });

  it("bounds imported history before normalizing its sessions", () => {
    const backup = mutableBackup(createInitialState(AUGUST_3));
    backup.history = Array.from(
      { length: MAX_BACKUP_HISTORY_SESSIONS + 1 },
      () => backup.activeSession,
    );
    expect(() => normalizeReadingState(backup)).toThrow(/history exceeds 10,000/);
  });

  it("returns fresh normalized records instead of the untrusted input objects", () => {
    const backup = mutableBackup(createInitialState(AUGUST_3));
    const normalized = normalizeReadingState(backup);
    expect(normalized).not.toBe(backup);
    expect(normalized.cursors).not.toBe(backup.cursors);
    expect(normalized.activeSession).not.toBe(backup.activeSession);
    expect(normalized.settings).not.toBe(backup.settings);
  });
});
