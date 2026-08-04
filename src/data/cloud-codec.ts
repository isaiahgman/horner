import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
} from "../domain/lists.js";
import {
  CURRENT_SCHEMA_VERSION,
  MAX_READING_HISTORY_SESSIONS,
  type ListRecord,
  type ReadingSession,
  type ReadingSettings,
  type ReadingState,
} from "../domain/state.js";
import { normalizeReadingState } from "../domain/backup.js";

const LEGACY_CLOUD_SCHEMA_VERSION = 1;
export const CLOUD_SCHEMA_VERSION = 2;
export const MAX_CLOUD_HISTORY_SESSIONS = MAX_READING_HISTORY_SESSIONS;
const MAX_ENCODED_CLOUD_BYTES = 850_000;

export interface CloudCurrentDocument {
  readonly schemaVersion: typeof CLOUD_SCHEMA_VERSION;
  readonly revision: number;
  readonly cursorIndexes: readonly number[];
  readonly activeReadingDate: string;
  readonly activeCompletedMask: number;
  readonly rolloverHour: number;
  readonly preferredBibleUrl: string | null;
  readonly history: readonly string[];
}

export interface CloudSessionDocument {
  readonly schemaVersion: typeof LEGACY_CLOUD_SCHEMA_VERSION;
  readonly readingDate: string;
  readonly cursorIndexes: readonly number[];
  readonly completedMask: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

function validateRevision(value: unknown, legacy: boolean): number {
  if (legacy && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Cloud data has an invalid revision");
  }
  return Number(value);
}

function sessionFromParts(
  readingDate: unknown,
  cursorIndexes: unknown,
  maskValue: unknown,
): ReadingSession {
  if (!isDateKey(readingDate)) {
    throw new Error("Cloud history contains an invalid reading date");
  }
  const indexes = validateCursorIndexes(cursorIndexes);
  const mask = validateMask(maskValue);
  return {
    readingDate,
    chapters: Object.fromEntries(
      LIST_IDS.map((listId, index) => [listId, chapterAt(listId, indexes[index]!).id]),
    ) as ListRecord<ReturnType<typeof chapterAt>["id"]>,
    completed: completionRecord(mask),
  };
}

function legacySessionFromCloud(value: unknown): ReadingSession {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LEGACY_CLOUD_SCHEMA_VERSION
  ) {
    throw new Error("Cloud history contains an unsupported session");
  }
  return sessionFromParts(
    value.readingDate,
    value.cursorIndexes,
    value.completedMask,
  );
}

function encodeCompactSession(session: ReadingSession): string {
  return `${session.readingDate}|${sessionCursorIndexes(session).join(",")}|${completedMask(session)}`;
}

function decodeCompactSession(value: unknown): ReadingSession {
  if (typeof value !== "string") {
    throw new Error("Cloud history contains an invalid compact session");
  }
  const parts = value.split("|");
  if (
    parts.length !== 3 ||
    !/^\d+(,\d+){9}$/.test(parts[1] ?? "") ||
    !/^\d+$/.test(parts[2] ?? "")
  ) {
    throw new Error("Cloud history contains an invalid compact session");
  }
  return sessionFromParts(
    parts[0],
    parts[1]!.split(",").map(Number),
    Number(parts[2]),
  );
}

export function encodeCloudCurrent(state: ReadingState): CloudCurrentDocument {
  if (state.history.length > MAX_CLOUD_HISTORY_SESSIONS) {
    throw new Error("Reading history is too large for the cloud backup");
  }
  const document: CloudCurrentDocument = {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    revision: state.revision,
    cursorIndexes: LIST_IDS.map((listId) => state.cursors[listId]),
    activeReadingDate: state.activeSession.readingDate,
    activeCompletedMask: completedMask(state.activeSession),
    rolloverHour: state.settings.rolloverHour,
    preferredBibleUrl: state.settings.preferredBibleUrl ?? null,
    history: state.history.map(encodeCompactSession),
  };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_ENCODED_CLOUD_BYTES) {
    throw new Error("Reading history is too large for the cloud backup");
  }
  return document;
}

export function encodeCloudSession(session: ReadingSession): CloudSessionDocument {
  return {
    schemaVersion: LEGACY_CLOUD_SCHEMA_VERSION,
    readingDate: session.readingDate,
    cursorIndexes: sessionCursorIndexes(session),
    completedMask: completedMask(session),
  };
}

export function decodeCloudState(
  currentValue: unknown,
  legacySessionValues: readonly unknown[] = [],
): ReadingState {
  if (!isRecord(currentValue)) {
    throw new Error("Cloud state uses an unsupported schema");
  }
  const legacy = currentValue.schemaVersion === LEGACY_CLOUD_SCHEMA_VERSION;
  if (!legacy && currentValue.schemaVersion !== CLOUD_SCHEMA_VERSION) {
    throw new Error("Cloud state uses an unsupported schema");
  }
  if (!isDateKey(currentValue.activeReadingDate)) {
    throw new Error("Cloud state has an invalid active reading date");
  }
  const indexes = validateCursorIndexes(currentValue.cursorIndexes);
  const mask = validateMask(currentValue.activeCompletedMask);
  const revision = validateRevision(currentValue.revision, legacy);
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

  let history: ReadingSession[];
  if (legacy) {
    history = legacySessionValues.map(legacySessionFromCloud);
    history.sort((a, b) => a.readingDate.localeCompare(b.readingDate));
  } else {
    if (!Array.isArray(currentValue.history)) {
      throw new Error("Cloud state has invalid history");
    }
    if (currentValue.history.length > MAX_CLOUD_HISTORY_SESSIONS) {
      throw new Error("Cloud history is too large");
    }
    history = currentValue.history.map(decodeCompactSession);
  }

  const cursors = Object.fromEntries(
    LIST_IDS.map((listId, index) => [listId, indexes[index]!]),
  ) as ListRecord<number>;
  const settings: ReadingSettings =
    typeof currentValue.preferredBibleUrl === "string"
      ? { rolloverHour: Number(rolloverHour), preferredBibleUrl: currentValue.preferredBibleUrl }
      : { rolloverHour: Number(rolloverHour) };
  return normalizeReadingState({
    version: CURRENT_SCHEMA_VERSION,
    revision,
    cursors,
    activeSession: {
      readingDate: currentValue.activeReadingDate,
      chapters: Object.fromEntries(
        LIST_IDS.map((listId, index) => [listId, chapterAt(listId, indexes[index]!).id]),
      ) as ListRecord<ReturnType<typeof chapterAt>["id"]>,
      completed: completionRecord(mask),
    },
    history,
    settings,
  });
}

export function cloudStateNeedsMigration(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === LEGACY_CLOUD_SCHEMA_VERSION;
}
