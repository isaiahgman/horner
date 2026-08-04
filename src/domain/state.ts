import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LIST_BY_ID,
  type ChapterId,
  type ListId,
} from "./lists.js";

export const CURRENT_SCHEMA_VERSION = 1;
export const DEFAULT_ROLLOVER_HOUR = 4;
export const MAX_READING_HISTORY_SESSIONS = 10_000;

const MAX_PREFERRED_BIBLE_URL_LENGTH = 2_048;

export type ListRecord<Value> = Record<ListId, Value>;

export const DAY_24_STARTING_CHAPTERS: Readonly<ListRecord<ChapterId>> = {
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
};

export interface ReadingSession {
  readonly readingDate: string;
  readonly chapters: Readonly<ListRecord<ChapterId>>;
  readonly completed: Readonly<ListRecord<boolean>>;
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
    completed: listRecord(() => false),
  };
}

export function createInitialState(
  now: Date,
  settings: ReadingSettings = { rolloverHour: DEFAULT_ROLLOVER_HOUR },
): ReadingState {
  const normalizedSettings = normalizeSettings(settings);
  const cursors = listRecord((listId) =>
    cursorForChapter(listId, DAY_24_STARTING_CHAPTERS[listId]),
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
  if (state.activeSession.completed[listId] === completed) {
    return state;
  }
  return {
    ...state,
    revision: nextRevision(state.revision),
    activeSession: {
      ...state.activeSession,
      completed: { ...state.activeSession.completed, [listId]: completed },
    },
  };
}

export function toggleCompletion(state: ReadingState, listId: ListId): ReadingState {
  return setCompletion(state, listId, !state.activeSession.completed[listId]);
}

export function completedCount(session: ReadingSession): number {
  return LIST_IDS.filter((listId) => session.completed[listId]).length;
}

function advanceCompletedCursors(state: ReadingState): ListRecord<number> {
  return listRecord((listId) => {
    if (!state.activeSession.completed[listId]) {
      return state.cursors[listId];
    }
    const listLength = READING_LIST_BY_ID[listId].chapters.length;
    return (state.cursors[listId] + 1) % listLength;
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
  if (completedCount(state.activeSession) > 0) {
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
  if (!previousSession || previousSession.completed[listId] === completed) {
    return state;
  }
  if (state.activeSession.completed[listId]) {
    throw new Error("Cannot change the previous chapter after its successor has progress");
  }

  const previousCursor = cursorForChapter(listId, previousSession.chapters[listId]);
  const listLength = READING_LIST_BY_ID[listId].chapters.length;
  const cursor = completed ? (previousCursor + 1) % listLength : previousCursor;
  const updatedPrevious: ReadingSession = {
    ...previousSession,
    completed: { ...previousSession.completed, [listId]: completed },
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
