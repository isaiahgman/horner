import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
  type ListId,
} from "./lists.js";
import {
  CURRENT_SCHEMA_VERSION,
  MAX_READING_HISTORY_SESSIONS,
  readingDateFor,
  type ListRecord,
  type ReadingSession,
  type ReadingSettings,
  type ReadingState,
} from "./state.js";

export const MAX_BACKUP_HISTORY_SESSIONS = MAX_READING_HISTORY_SESSIONS;

const MAX_PREFERRED_BIBLE_URL_LENGTH = 2_048;
const LIST_ID_SET = new Set<string>(LIST_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return daysInMonth !== undefined && day <= daysInMonth;
}

function hasExactListKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === LIST_IDS.length &&
    keys.every((key) => LIST_ID_SET.has(key))
  );
}

function normalizeSession(value: unknown, description: string): ReadingSession {
  if (!isRecord(value) || !isRealDateKey(value.readingDate)) {
    throw new Error(`${description} has an invalid reading date`);
  }
  if (
    !isRecord(value.chapters) ||
    !isRecord(value.completed) ||
    !hasExactListKeys(value.chapters) ||
    !hasExactListKeys(value.completed)
  ) {
    throw new Error(`${description} is missing exact chapter or completion data`);
  }

  const chapters = {} as ListRecord<ChapterId>;
  const completed = {} as ListRecord<boolean>;
  for (const listId of LIST_IDS) {
    const chapterId = value.chapters[listId];
    const isCompleted = value.completed[listId];
    if (typeof chapterId !== "string" || typeof isCompleted !== "boolean") {
      throw new Error(`${description} has invalid data for ${listId}`);
    }
    cursorForChapter(listId, chapterId as ChapterId);
    chapters[listId] = chapterId as ChapterId;
    completed[listId] = isCompleted;
  }

  return { readingDate: value.readingDate, chapters, completed };
}

function normalizeCursors(value: unknown): ListRecord<number> {
  if (!isRecord(value) || !hasExactListKeys(value)) {
    throw new Error("Backup cursors must contain exactly the ten reading lists");
  }

  const cursors = {} as ListRecord<number>;
  for (const listId of LIST_IDS) {
    const cursor = value[listId];
    if (
      !Number.isSafeInteger(cursor) ||
      Number(cursor) < 0 ||
      Number(cursor) >= READING_LIST_BY_ID[listId].chapters.length
    ) {
      throw new Error(`The backup has an invalid cursor for ${listId}`);
    }
    cursors[listId] = Number(cursor);
  }
  return cursors;
}

function normalizePreferredBibleUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_PREFERRED_BIBLE_URL_LENGTH) {
    throw new Error("The backup has an invalid preferred Bible URL");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
  } catch {
    throw new Error("The preferred Bible URL must be a valid HTTPS URL");
  }
  return value;
}

function normalizeSettings(value: unknown): ReadingSettings {
  if (!isRecord(value)) throw new Error("Backup settings are missing");
  const rolloverHour = value.rolloverHour;
  if (
    !Number.isSafeInteger(rolloverHour) ||
    Number(rolloverHour) < 0 ||
    Number(rolloverHour) > 23
  ) {
    throw new Error("The backup has an invalid rollover hour");
  }

  const preferredBibleUrl = normalizePreferredBibleUrl(value.preferredBibleUrl);
  return preferredBibleUrl === undefined
    ? { rolloverHour: Number(rolloverHour) }
    : { rolloverHour: Number(rolloverHour), preferredBibleUrl };
}

function normalizeRevision(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("The backup has an invalid revision");
  }
  return Number(value);
}

function nextChapterId(session: ReadingSession, listId: ListId): ChapterId {
  const cursor = cursorForChapter(listId, session.chapters[listId]);
  if (!session.completed[listId]) return chapterAt(listId, cursor).id;
  const listLength = READING_LIST_BY_ID[listId].chapters.length;
  return chapterAt(listId, (cursor + 1) % listLength).id;
}

function validateTimeline(
  history: readonly ReadingSession[],
  activeSession: ReadingSession,
): void {
  const timeline = [...history, activeSession];
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1];
    const current = timeline[index];
    if (!previous || !current) continue;
    if (previous.readingDate >= current.readingDate) {
      throw new Error("Backup sessions must have unique, strictly increasing dates");
    }
    for (const listId of LIST_IDS) {
      if (current.chapters[listId] !== nextChapterId(previous, listId)) {
        throw new Error(`Backup sessions have an invalid ${listId} transition`);
      }
    }
  }
}

export function normalizeReadingState(value: unknown): ReadingState {
  if (!isRecord(value) || value.version !== CURRENT_SCHEMA_VERSION) {
    throw new Error("This backup uses an unsupported schema version");
  }

  const revision = normalizeRevision(value.revision);
  const settings = normalizeSettings(value.settings);
  const cursors = normalizeCursors(value.cursors);
  const activeSession = normalizeSession(value.activeSession, "The active session");
  if (!Array.isArray(value.history)) throw new Error("Backup history is invalid");
  if (value.history.length > MAX_BACKUP_HISTORY_SESSIONS) {
    throw new Error(
      `Backup history exceeds ${MAX_BACKUP_HISTORY_SESSIONS.toLocaleString("en-US")} sessions`,
    );
  }
  const history = value.history.map((session, index) =>
    normalizeSession(session, `History session ${index + 1}`),
  );

  for (const listId of LIST_IDS) {
    if (activeSession.chapters[listId] !== chapterAt(listId, cursors[listId]).id) {
      throw new Error(`The active chapter does not match the ${listId} cursor`);
    }
  }
  validateTimeline(history, activeSession);

  return {
    version: CURRENT_SCHEMA_VERSION,
    revision,
    cursors,
    activeSession,
    history,
    settings,
  };
}

export function parseBackupJson(json: string, now: Date = new Date()): ReadingState {
  const state = normalizeReadingState(JSON.parse(json) as unknown);
  const currentReadingDate = readingDateFor(now, state.settings.rolloverHour);
  if (state.activeSession.readingDate > currentReadingDate) {
    throw new Error("The backup's active reading date is in the future");
  }
  return state;
}

export function serializeBackup(state: ReadingState): string {
  return JSON.stringify(state, null, 2);
}
