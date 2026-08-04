import { describe, expect, it } from "vitest";

import {
  chapterAt,
  cursorForChapter,
  LIST_IDS,
  READING_LISTS,
} from "./lists.js";

describe("Horner reading lists", () => {
  it("contains the ten lists in the published order", () => {
    expect(READING_LISTS.map(({ id }) => id)).toEqual(LIST_IDS);
    expect(READING_LISTS.map(({ chapters }) => chapters.length)).toEqual([
      89, 187, 78, 65, 62, 150, 31, 249, 250, 28,
    ]);
  });

  it("starts with the published day-one references", () => {
    expect(READING_LISTS.map(({ chapters }) => chapters[0]?.label)).toEqual([
      "Matthew 1",
      "Genesis 1",
      "Romans 1",
      "1 Thessalonians 1",
      "Job 1",
      "Psalm 1",
      "Proverbs 1",
      "Joshua 1",
      "Isaiah 1",
      "Acts 1",
    ]);
  });

  it("preserves book transitions", () => {
    expect(chapterAt("gospels", 27).label).toBe("Matthew 28");
    expect(chapterAt("gospels", 28).label).toBe("Mark 1");
    expect(chapterAt("romansToHebrews", 15).label).toBe("Romans 16");
    expect(chapterAt("romansToHebrews", 16).label).toBe("1 Corinthians 1");
    expect(chapterAt("history", 23).label).toBe("Joshua 24");
    expect(chapterAt("history", 24).label).toBe("Judges 1");
  });

  it("can resolve every chapter ID back to its cursor", () => {
    for (const list of READING_LISTS) {
      for (const [cursor, chapter] of list.chapters.entries()) {
        expect(cursorForChapter(list.id, chapter.id)).toBe(cursor);
      }
    }
  });
});
