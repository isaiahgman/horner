import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
} from "./lists.js";
import {
  CURRENT_SCHEMA_VERSION,
  type ListRecord,
  type ReadingSession,
  type ReadingState,
} from "./state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateSession(value: unknown): asserts value is ReadingSession {
  if (!isRecord(value) || !isDateKey(value.readingDate)) {
    throw new Error("A session has an invalid reading date");
  }
  if (!isRecord(value.chapters) || !isRecord(value.completed)) {
    throw new Error("A session is missing chapter or completion data");
  }
  for (const listId of LIST_IDS) {
    const chapterId = value.chapters[listId];
    if (typeof chapterId !== "string" || typeof value.completed[listId] !== "boolean") {
      throw new Error(`A session has invalid data for ${listId}`);
    }
    cursorForChapter(listId, chapterId as ChapterId);
  }
}

export function parseBackupJson(json: string): ReadingState {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.version !== CURRENT_SCHEMA_VERSION) {
    throw new Error("This backup uses an unsupported schema version");
  }
  if (!isRecord(value.settings)) throw new Error("Backup settings are missing");
  const rolloverHour = value.settings.rolloverHour;
  if (!Number.isInteger(rolloverHour) || Number(rolloverHour) < 0 || Number(rolloverHour) > 23) {
    throw new Error("The backup has an invalid rollover hour");
  }
  if (!isRecord(value.cursors)) throw new Error("Backup cursors are missing");

  const cursors = {} as ListRecord<number>;
  for (const listId of LIST_IDS) {
    const cursor = value.cursors[listId];
    if (
      !Number.isInteger(cursor) ||
      Number(cursor) < 0 ||
      Number(cursor) >= READING_LIST_BY_ID[listId].chapters.length
    ) {
      throw new Error(`The backup has an invalid cursor for ${listId}`);
    }
    cursors[listId] = Number(cursor);
  }

  validateSession(value.activeSession);
  if (!Array.isArray(value.history)) throw new Error("Backup history is invalid");
  value.history.forEach(validateSession);
  for (const listId of LIST_IDS) {
    if (value.activeSession.chapters[listId] !== chapterAt(listId, cursors[listId]).id) {
      throw new Error(`The active chapter does not match the ${listId} cursor`);
    }
  }
  return value as unknown as ReadingState;
}

export function serializeBackup(state: ReadingState): string {
  return JSON.stringify(state, null, 2);
}
