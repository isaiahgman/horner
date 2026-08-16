import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
  type ChapterReference,
  type ListId,
} from "./lists.js";

export const CURRENT_SCHEMA_VERSION = 2;
export const DEFAULT_ROLLOVER_HOUR = 4;
export const MAX_READING_HISTORY_SESSIONS = 10_000;
export const MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION = 1_023;

const MAX_PREFERRED_BIBLE_URL_LENGTH = 2_048;

export type ListRecord<Value> = Record<ListId, Value>;

export const DAY_ONE_STARTING_CHAPTERS: Readonly<ListRecord<ChapterId>> = {
  gospels: "matthew:1",
  pentateuch: "genesis:1",
  romansToHebrews: "romans:1",
  thessaloniansToRevelation: "1-thessalonians:1",
  wisdom: "job:1",
  psalms: "psalm:1",
  proverbs: "proverbs:1",
  history: "joshua:1",
  prophets: "isaiah:1",
  acts: "acts:1",
};

export interface ReadingSession {
  readonly readingDate: string;
  readonly chapters: Readonly<ListRecord<ChapterId>>;
  /**
   * Contiguous chapters completed from each session's fixed starting chapter.
   * Zero leaves the core chapter unread, one completes only that chapter, and
   * larger values include additional consecutive chapters from the same list.
   */
  readonly completedCounts: Readonly<ListRecord<number>>;
}

export interface ReadingSettings {
  readonly rolloverHour: number;
  readonly preferredBibleUrl?: string;
}

export interface ReadingState {
  readonly version: typeof CURRENT_SCHEMA_VERSION;
  readonly revision: number;
  readonly cursors: Readonly<ListRecord<number>>;
  readonly activeSession: ReadingSession;
  readonly history: readonly ReadingSession[];
  readonly settings: ReadingSettings;
}

function listRecord<Value>(createValue: (listId: ListId) => Value): ListRecord<Value> {
  return Object.fromEntries(
    LIST_IDS.map((listId) => [listId, createValue(listId)]),
  ) as ListRecord<Value>;
}

function assertRolloverHour(rolloverHour: number): void {
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    throw new RangeError("rolloverHour must be an integer from 0 through 23");
  }
}

function normalizeSettings(settings: ReadingSettings): ReadingSettings {
  assertRolloverHour(settings.rolloverHour);
  const preferredBibleUrl = settings.preferredBibleUrl;
  if (preferredBibleUrl === undefined) {
    return { rolloverHour: settings.rolloverHour };
  }
  if (preferredBibleUrl.length > MAX_PREFERRED_BIBLE_URL_LENGTH) {
    throw new RangeError("preferredBibleUrl is too long");
  }
  try {
    if (new URL(preferredBibleUrl).protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
  } catch {
    throw new TypeError("preferredBibleUrl must be a valid HTTPS URL");
  }
  return { rolloverHour: settings.rolloverHour, preferredBibleUrl };
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("revision must be a nonnegative safe integer");
  }
}

function nextRevision(revision: number): number {
  assertRevision(revision);
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("revision cannot be incremented safely");
  }
  return revision + 1;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function readingDateFor(now: Date, rolloverHour: number): string {
  assertRolloverHour(rolloverHour);
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("now must be a valid Date");
  }

  const shifted = new Date(now);
  shifted.setHours(shifted.getHours() - rolloverHour);
  return localDateKey(shifted);
}

export function createSession(
  readingDate: string,
  cursors: Readonly<ListRecord<number>>,
): ReadingSession {
  return {
    readingDate,
    chapters: listRecord((listId) => chapterAt(listId, cursors[listId]).id),
    completedCounts: listRecord(() => 0),
  };
}

export function createInitialState(
  now: Date,
  settings: ReadingSettings = { rolloverHour: DEFAULT_ROLLOVER_HOUR },
): ReadingState {
  const normalizedSettings = normalizeSettings(settings);
  const cursors = listRecord((listId) =>
    cursorForChapter(listId, DAY_ONE_STARTING_CHAPTERS[listId]),
  );
  return {
    version: CURRENT_SCHEMA_VERSION,
    revision: 0,
    cursors,
    activeSession: createSession(
      readingDateFor(now, normalizedSettings.rolloverHour),
      cursors,
    ),
    history: [],
    settings: normalizedSettings,
  };
}

export function setCompletion(
  state: ReadingState,
  listId: ListId,
  completed: boolean,
): ReadingState {
  const currentCount = state.activeSession.completedCounts[listId];
  if ((currentCount > 0) === completed) {
    return state;
  }
  if (!completed && currentCount > 1) {
    throw new Error(
      "Cannot mark the core chapter unread while additional chapters are completed",
    );
  }
  return {
    ...state,
    revision: nextRevision(state.revision),
    activeSession: {
      ...state.activeSession,
      completedCounts: {
        ...state.activeSession.completedCounts,
        [listId]: completed ? 1 : 0,
      },
    },
  };
}

export function toggleCompletion(state: ReadingState, listId: ListId): ReadingState {
  return setCompletion(state, listId, !coreCompleted(state.activeSession, listId));
}

export function coreCompleted(session: ReadingSession, listId: ListId): boolean {
  return session.completedCounts[listId] > 0;
}

export function completedCount(session: ReadingSession): number {
  return LIST_IDS.filter((listId) => coreCompleted(session, listId)).length;
}

export function totalCompletedCount(session: ReadingSession): number {
  return LIST_IDS.reduce(
    (total, listId) => total + session.completedCounts[listId],
    0,
  );
}

export function additionalCompletedCount(session: ReadingSession): number;
export function additionalCompletedCount(
  session: ReadingSession,
  listId: ListId,
): number;
export function additionalCompletedCount(
  session: ReadingSession,
  listId?: ListId,
): number {
  if (listId !== undefined) {
    return Math.max(0, session.completedCounts[listId] - 1);
  }
  return LIST_IDS.reduce(
    (total, currentListId) =>
      total + Math.max(0, session.completedCounts[currentListId] - 1),
    0,
  );
}

function assertCompletedCount(count: number): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION
  ) {
    throw new RangeError(
      `completed count must be an integer from 0 through ${MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION}`,
    );
  }
}

function assertOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("chapter offset must be a nonnegative safe integer");
  }
}

export function chapterAtOffset(
  session: ReadingSession,
  listId: ListId,
  offset: number,
): ChapterReference {
  assertOffset(offset);
  const startingCursor = cursorForChapter(listId, session.chapters[listId]);
  const listLength = READING_LIST_BY_ID[listId].chapters.length;
  return chapterAt(listId, (startingCursor + (offset % listLength)) % listLength);
}

export function nextAdditionalChapters(
  session: ReadingSession,
  listId: ListId,
  limit = 3,
): readonly ChapterReference[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("chapter preview limit must be a nonnegative safe integer");
  }
  const completed = session.completedCounts[listId];
  if (completed === 0 || completed >= MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION) {
    return [];
  }
  const available = Math.min(
    limit,
    MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION - completed,
  );
  return Array.from({ length: available }, (_, index) =>
    chapterAtOffset(session, listId, completed + index),
  );
}

function setActiveSessionCompletedCount(
  state: ReadingState,
  listId: ListId,
  count: number,
): ReadingState {
  assertCompletedCount(count);
  if (state.activeSession.completedCounts[listId] === count) return state;
  return {
    ...state,
    revision: nextRevision(state.revision),
    activeSession: {
      ...state.activeSession,
      completedCounts: {
        ...state.activeSession.completedCounts,
        [listId]: count,
      },
    },
  };
}

export function completeNextAdditionalChapter(
  state: ReadingState,
  listId: ListId,
  expectedCompletedCount?: number,
): ReadingState {
  const currentCount = state.activeSession.completedCounts[listId];
  if (expectedCompletedCount !== undefined) {
    assertCompletedCount(expectedCompletedCount);
    if (expectedCompletedCount !== currentCount) return state;
  }
  if (currentCount === 0) {
    throw new Error("Complete the core chapter before reading additional chapters");
  }
  if (currentCount === MAX_COMPLETED_CHAPTERS_PER_LIST_PER_SESSION) {
    throw new RangeError("The per-list reading limit has been reached for this session");
  }
  return setActiveSessionCompletedCount(state, listId, currentCount + 1);
}

export function undoLastAdditionalChapter(
  state: ReadingState,
  listId: ListId,
  expectedCompletedCount?: number,
): ReadingState {
  const currentCount = state.activeSession.completedCounts[listId];
  if (expectedCompletedCount !== undefined) {
    assertCompletedCount(expectedCompletedCount);
    if (expectedCompletedCount !== currentCount) return state;
  }
  if (currentCount <= 1) return state;
  return setActiveSessionCompletedCount(state, listId, currentCount - 1);
}

function advanceCompletedCursors(state: ReadingState): ListRecord<number> {
  return listRecord((listId) => {
    const completed = state.activeSession.completedCounts[listId];
    const listLength = READING_LIST_BY_ID[listId].chapters.length;
    return (state.cursors[listId] + (completed % listLength)) % listLength;
  });
}

export function rolloverIfNeeded(state: ReadingState, now: Date): ReadingState {
  const readingDate = readingDateFor(now, state.settings.rolloverHour);
  if (readingDate <= state.activeSession.readingDate) {
    return state;
  }

  const cursors = advanceCompletedCursors(state);
  return {
    ...state,
    revision: nextRevision(state.revision),
    cursors,
    activeSession: createSession(readingDate, cursors),
    history: [...state.history, state.activeSession].slice(
      -MAX_READING_HISTORY_SESSIONS,
    ),
  };
}

export function undoLastRollover(state: ReadingState): ReadingState {
  const previousSession = state.history.at(-1);
  if (!previousSession) {
    return state;
  }
  if (totalCompletedCount(state.activeSession) > 0) {
    throw new Error("Cannot undo a rollover after the new session has progress");
  }

  const cursors = listRecord((listId) =>
    cursorForChapter(listId, previousSession.chapters[listId]),
  );
  return {
    ...state,
    revision: nextRevision(state.revision),
    cursors,
    activeSession: previousSession,
    history: state.history.slice(0, -1),
  };
}

export function setPreviousSessionCompletion(
  state: ReadingState,
  listId: ListId,
  completed: boolean,
): ReadingState {
  const previousSession = state.history.at(-1);
  if (!previousSession) {
    return state;
  }
  const previousCount = previousSession.completedCounts[listId];
  if ((previousCount > 0) === completed) return state;
  if (!completed && previousCount > 1) {
    throw new Error(
      "Cannot mark the core chapter unread while additional chapters are completed",
    );
  }
  return setPreviousSessionCompletedCount(state, listId, completed ? 1 : 0);
}

export function setPreviousSessionCompletedCount(
  state: ReadingState,
  listId: ListId,
  count: number,
): ReadingState {
  assertCompletedCount(count);
  const previousSession = state.history.at(-1);
  if (!previousSession || previousSession.completedCounts[listId] === count) {
    return state;
  }
  if (state.activeSession.completedCounts[listId] > 0) {
    throw new Error("Cannot change the previous chapter after its successor has progress");
  }

  const previousCursor = cursorForChapter(listId, previousSession.chapters[listId]);
  const listLength = READING_LIST_BY_ID[listId].chapters.length;
  const cursor = (previousCursor + (count % listLength)) % listLength;
  const updatedPrevious: ReadingSession = {
    ...previousSession,
    completedCounts: { ...previousSession.completedCounts, [listId]: count },
  };
  return {
    ...state,
    revision: nextRevision(state.revision),
    cursors: { ...state.cursors, [listId]: cursor },
    activeSession: {
      ...state.activeSession,
      chapters: {
        ...state.activeSession.chapters,
        [listId]: chapterAt(listId, cursor).id,
      },
    },
    history: [...state.history.slice(0, -1), updatedPrevious],
  };
}

function sameSettings(left: ReadingSettings, right: ReadingSettings): boolean {
  return (
    left.rolloverHour === right.rolloverHour &&
    left.preferredBibleUrl === right.preferredBibleUrl
  );
}

export function setReadingSettings(
  state: ReadingState,
  settings: ReadingSettings,
): ReadingState {
  const normalizedSettings = normalizeSettings(settings);
  if (sameSettings(state.settings, normalizedSettings)) {
    return state;
  }
  return {
    ...state,
    revision: nextRevision(state.revision),
    settings: normalizedSettings,
  };
}

export function resetReadingState(state: ReadingState, now: Date): ReadingState {
  const fresh = createInitialState(now, state.settings);
  return { ...fresh, revision: nextRevision(state.revision) };
}

export function rebaseReadingState(
  state: ReadingState,
  previousRevision: number,
): ReadingState {
  assertRevision(previousRevision);
  return {
    ...state,
    revision: nextRevision(Math.max(state.revision, previousRevision)),
  };
}
