export const LIST_IDS = [
  "gospels",
  "pentateuch",
  "romansToHebrews",
  "thessaloniansToRevelation",
  "wisdom",
  "psalms",
  "proverbs",
  "history",
  "prophets",
  "acts",
] as const;

export type ListId = (typeof LIST_IDS)[number];
export type ChapterId = `${string}:${number}`;

export interface ChapterReference {
  readonly id: ChapterId;
  readonly book: string;
  readonly chapter: number;
  readonly label: string;
}

export interface ReadingList {
  readonly id: ListId;
  readonly number: number;
  readonly name: string;
  readonly chapters: readonly ChapterReference[];
}

interface BookDefinition {
  readonly name: string;
  readonly chapters: number;
}

function toBookId(name: string): string {
  return name.toLowerCase().replaceAll(" ", "-");
}

function expandBooks(books: readonly BookDefinition[]): ChapterReference[] {
  return books.flatMap(({ name, chapters }) =>
    Array.from({ length: chapters }, (_, index) => {
      const chapter = index + 1;
      return {
        id: `${toBookId(name)}:${chapter}` as ChapterId,
        book: name,
        chapter,
        label: `${name} ${chapter}`,
      };
    }),
  );
}

function readingList(
  id: ListId,
  number: number,
  name: string,
  books: readonly BookDefinition[],
): ReadingList {
  return { id, number, name, chapters: expandBooks(books) };
}

const gospels = readingList("gospels", 1, "Gospels", [
  { name: "Matthew", chapters: 28 },
  { name: "Mark", chapters: 16 },
  { name: "Luke", chapters: 24 },
  { name: "John", chapters: 21 },
]);

const pentateuch = readingList("pentateuch", 2, "Pentateuch", [
  { name: "Genesis", chapters: 50 },
  { name: "Exodus", chapters: 40 },
  { name: "Leviticus", chapters: 27 },
  { name: "Numbers", chapters: 36 },
  { name: "Deuteronomy", chapters: 34 },
]);

const romansToHebrews = readingList(
  "romansToHebrews",
  3,
  "Romans–Hebrews",
  [
    { name: "Romans", chapters: 16 },
    { name: "1 Corinthians", chapters: 16 },
    { name: "2 Corinthians", chapters: 13 },
    { name: "Galatians", chapters: 6 },
    { name: "Ephesians", chapters: 6 },
    { name: "Philippians", chapters: 4 },
    { name: "Colossians", chapters: 4 },
    { name: "Hebrews", chapters: 13 },
  ],
);

const thessaloniansToRevelation = readingList(
  "thessaloniansToRevelation",
  4,
  "1 Thessalonians–Revelation",
  [
    { name: "1 Thessalonians", chapters: 5 },
    { name: "2 Thessalonians", chapters: 3 },
    { name: "1 Timothy", chapters: 6 },
    { name: "2 Timothy", chapters: 4 },
    { name: "Titus", chapters: 3 },
    { name: "Philemon", chapters: 1 },
    { name: "James", chapters: 5 },
    { name: "1 Peter", chapters: 5 },
    { name: "2 Peter", chapters: 3 },
    { name: "1 John", chapters: 5 },
    { name: "2 John", chapters: 1 },
    { name: "3 John", chapters: 1 },
    { name: "Jude", chapters: 1 },
    { name: "Revelation", chapters: 22 },
  ],
);

const wisdom = readingList("wisdom", 5, "Job–Song of Solomon", [
  { name: "Job", chapters: 42 },
  { name: "Ecclesiastes", chapters: 12 },
  { name: "Song of Solomon", chapters: 8 },
]);

const psalms = readingList("psalms", 6, "Psalms", [
  { name: "Psalm", chapters: 150 },
]);

const proverbs = readingList("proverbs", 7, "Proverbs", [
  { name: "Proverbs", chapters: 31 },
]);

const history = readingList("history", 8, "Historical Books", [
  { name: "Joshua", chapters: 24 },
  { name: "Judges", chapters: 21 },
  { name: "Ruth", chapters: 4 },
  { name: "1 Samuel", chapters: 31 },
  { name: "2 Samuel", chapters: 24 },
  { name: "1 Kings", chapters: 22 },
  { name: "2 Kings", chapters: 25 },
  { name: "1 Chronicles", chapters: 29 },
  { name: "2 Chronicles", chapters: 36 },
  { name: "Ezra", chapters: 10 },
  { name: "Nehemiah", chapters: 13 },
  { name: "Esther", chapters: 10 },
]);

const prophets = readingList("prophets", 9, "Prophets", [
  { name: "Isaiah", chapters: 66 },
  { name: "Jeremiah", chapters: 52 },
  { name: "Lamentations", chapters: 5 },
  { name: "Ezekiel", chapters: 48 },
  { name: "Daniel", chapters: 12 },
  { name: "Hosea", chapters: 14 },
  { name: "Joel", chapters: 3 },
  { name: "Amos", chapters: 9 },
  { name: "Obadiah", chapters: 1 },
  { name: "Jonah", chapters: 4 },
  { name: "Micah", chapters: 7 },
  { name: "Nahum", chapters: 3 },
  { name: "Habakkuk", chapters: 3 },
  { name: "Zephaniah", chapters: 3 },
  { name: "Haggai", chapters: 2 },
  { name: "Zechariah", chapters: 14 },
  { name: "Malachi", chapters: 4 },
]);

const acts = readingList("acts", 10, "Acts", [
  { name: "Acts", chapters: 28 },
]);

export const READING_LISTS = [
  gospels,
  pentateuch,
  romansToHebrews,
  thessaloniansToRevelation,
  wisdom,
  psalms,
  proverbs,
  history,
  prophets,
  acts,
] as const satisfies readonly ReadingList[];

export const READING_LIST_BY_ID: Readonly<Record<ListId, ReadingList>> =
  Object.fromEntries(READING_LISTS.map((list) => [list.id, list])) as Record<
    ListId,
    ReadingList
  >;

export function chapterAt(listId: ListId, cursor: number): ChapterReference {
  const chapters = READING_LIST_BY_ID[listId].chapters;
  const chapter = chapters[cursor];
  if (!chapter) {
    throw new RangeError(`Cursor ${cursor} is outside list ${listId}`);
  }
  return chapter;
}

export function cursorForChapter(listId: ListId, chapterId: ChapterId): number {
  const cursor = READING_LIST_BY_ID[listId].chapters.findIndex(
    ({ id }) => id === chapterId,
  );
  if (cursor === -1) {
    throw new RangeError(`${chapterId} is not part of list ${listId}`);
  }
  return cursor;
}
