import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
} from "../domain/lists.js";
import {
  CURRENT_SCHEMA_VERSION,
  type ListRecord,
  type ReadingSession,
  type ReadingSettings,
  type ReadingState,
} from "../domain/state.js";

export const CLOUD_SCHEMA_VERSION = 1;

export interface CloudCurrentDocument {
  readonly schemaVersion: typeof CLOUD_SCHEMA_VERSION;
  readonly cursorIndexes: readonly number[];
  readonly activeReadingDate: string;
  readonly activeCompletedMask: number;
  readonly rolloverHour: number;
  readonly preferredBibleUrl: string | null;
}

export interface CloudSessionDocument {
  readonly schemaVersion: typeof CLOUD_SCHEMA_VERSION;
  readonly readingDate: string;
  readonly cursorIndexes: readonly number[];
  readonly completedMask: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function completedMask(session: ReadingSession): number {
  return LIST_IDS.reduce(
    (mask, listId, index) => mask | (session.completed[listId] ? 1 << index : 0),
    0,
  );
}

function completionRecord(mask: number): ListRecord<boolean> {
  return Object.fromEntries(
    LIST_IDS.map((listId, index) => [listId, Boolean(mask & (1 << index))]),
  ) as ListRecord<boolean>;
}

function sessionCursorIndexes(session: ReadingSession): number[] {
  return LIST_IDS.map((listId) =>
    cursorForChapter(listId, session.chapters[listId]),
  );
}

function validateCursorIndexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== LIST_IDS.length) {
    throw new Error("Cloud data has an invalid cursor list");
  }
  return value.map((cursor, index) => {
    const listId = LIST_IDS[index];
    if (
      listId === undefined ||
      !Number.isInteger(cursor) ||
      Number(cursor) < 0 ||
      Number(cursor) >= READING_LIST_BY_ID[listId].chapters.length
    ) {
      throw new Error(`Cloud data has an invalid cursor for list ${index + 1}`);
    }
    return Number(cursor);
  });
}

function validateMask(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1023) {
    throw new Error("Cloud data has an invalid completion mask");
  }
  return Number(value);
}

function sessionFromCloud(value: unknown): ReadingSession {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CLOUD_SCHEMA_VERSION ||
    !isDateKey(value.readingDate)
  ) {
    throw new Error("Cloud history contains an unsupported session");
  }
  const indexes = validateCursorIndexes(value.cursorIndexes);
  const mask = validateMask(value.completedMask);
  return {
    readingDate: value.readingDate,
    chapters: Object.fromEntries(
      LIST_IDS.map((listId, index) => [listId, chapterAt(listId, indexes[index]!).id]),
    ) as ListRecord<ReturnType<typeof chapterAt>["id"]>,
    completed: completionRecord(mask),
  };
}

export function encodeCloudCurrent(state: ReadingState): CloudCurrentDocument {
  return {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    cursorIndexes: LIST_IDS.map((listId) => state.cursors[listId]),
    activeReadingDate: state.activeSession.readingDate,
    activeCompletedMask: completedMask(state.activeSession),
    rolloverHour: state.settings.rolloverHour,
    preferredBibleUrl: state.settings.preferredBibleUrl ?? null,
  };
}

export function encodeCloudSession(session: ReadingSession): CloudSessionDocument {
  return {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    readingDate: session.readingDate,
    cursorIndexes: sessionCursorIndexes(session),
    completedMask: completedMask(session),
  };
}

export function decodeCloudState(
  currentValue: unknown,
  sessionValues: readonly unknown[],
): ReadingState {
  if (
    !isRecord(currentValue) ||
    currentValue.schemaVersion !== CLOUD_SCHEMA_VERSION ||
    !isDateKey(currentValue.activeReadingDate)
  ) {
    throw new Error("Cloud state uses an unsupported schema");
  }
  const indexes = validateCursorIndexes(currentValue.cursorIndexes);
  const mask = validateMask(currentValue.activeCompletedMask);
  const rolloverHour = currentValue.rolloverHour;
  if (!Number.isInteger(rolloverHour) || Number(rolloverHour) < 0 || Number(rolloverHour) > 23) {
    throw new Error("Cloud state has an invalid rollover hour");
  }
  if (
    currentValue.preferredBibleUrl !== null &&
    typeof currentValue.preferredBibleUrl !== "string"
  ) {
    throw new Error("Cloud state has an invalid Bible URL");
  }

  const cursors = Object.fromEntries(
    LIST_IDS.map((listId, index) => [listId, indexes[index]!]),
  ) as ListRecord<number>;
  const settings: ReadingSettings =
    typeof currentValue.preferredBibleUrl === "string"
      ? { rolloverHour: Number(rolloverHour), preferredBibleUrl: currentValue.preferredBibleUrl }
      : { rolloverHour: Number(rolloverHour) };
  return {
    version: CURRENT_SCHEMA_VERSION,
    cursors,
    activeSession: {
      readingDate: currentValue.activeReadingDate,
      chapters: Object.fromEntries(
        LIST_IDS.map((listId, index) => [listId, chapterAt(listId, indexes[index]!).id]),
      ) as ListRecord<ReturnType<typeof chapterAt>["id"]>,
      completed: completionRecord(mask),
    },
    history: sessionValues.map(sessionFromCloud).sort((a, b) =>
      a.readingDate.localeCompare(b.readingDate),
    ),
    settings,
  };
}
