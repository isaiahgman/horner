import { describe, expect, it } from "vitest";

import { READING_LISTS } from "./lists.js";
import { bibleLinkFor, isMobileOrTablet, type NavigatorLike } from "./bible-links.js";

const EXPECTED_USFM_CODES = {
  Genesis: "GEN",
  Exodus: "EXO",
  Leviticus: "LEV",
  Numbers: "NUM",
  Deuteronomy: "DEU",
  Joshua: "JOS",
  Judges: "JDG",
  Ruth: "RUT",
  "1 Samuel": "1SA",
  "2 Samuel": "2SA",
  "1 Kings": "1KI",
  "2 Kings": "2KI",
  "1 Chronicles": "1CH",
  "2 Chronicles": "2CH",
  Ezra: "EZR",
  Nehemiah: "NEH",
  Esther: "EST",
  Job: "JOB",
  Psalm: "PSA",
  Proverbs: "PRO",
  Ecclesiastes: "ECC",
  "Song of Solomon": "SNG",
  Isaiah: "ISA",
  Jeremiah: "JER",
  Lamentations: "LAM",
  Ezekiel: "EZK",
  Daniel: "DAN",
  Hosea: "HOS",
  Joel: "JOL",
  Amos: "AMO",
  Obadiah: "OBA",
  Jonah: "JON",
  Micah: "MIC",
  Nahum: "NAM",
  Habakkuk: "HAB",
  Zephaniah: "ZEP",
  Haggai: "HAG",
  Zechariah: "ZEC",
  Malachi: "MAL",
  Matthew: "MAT",
  Mark: "MRK",
  Luke: "LUK",
  John: "JHN",
  Acts: "ACT",
  Romans: "ROM",
  "1 Corinthians": "1CO",
  "2 Corinthians": "2CO",
  Galatians: "GAL",
  Ephesians: "EPH",
  Philippians: "PHP",
  Colossians: "COL",
  "1 Thessalonians": "1TH",
  "2 Thessalonians": "2TH",
  "1 Timothy": "1TI",
  "2 Timothy": "2TI",
  Titus: "TIT",
  Philemon: "PHM",
  Hebrews: "HEB",
  James: "JAS",
  "1 Peter": "1PE",
  "2 Peter": "2PE",
  "1 John": "1JN",
  "2 John": "2JN",
  "3 John": "3JN",
  Jude: "JUD",
  Revelation: "REV",
} as const;

describe("Bible chapter links", () => {
  it("maps all 66 unique topology books to their canonical USFM codes", () => {
    const topologyBooks = new Set(
      READING_LISTS.flatMap((list) => list.chapters.map((chapter) => chapter.book)),
    );
    expect(topologyBooks.size).toBe(66);
    expect([...topologyBooks].sort()).toEqual(Object.keys(EXPECTED_USFM_CODES).sort());

    for (const [book, code] of Object.entries(EXPECTED_USFM_CODES)) {
      expect(bibleLinkFor({ book, chapter: 1 }, true).href).toBe(
        `https://www.bible.com/bible/59/${code}.1.ESV`,
      );
    }
  });

  it("builds the YouVersion universal link for a numbered book", () => {
    expect(bibleLinkFor({ book: "1 Corinthians", chapter: 8 }, true)).toEqual({
      href: "https://www.bible.com/bible/59/1CO.8.ESV",
    });
  });

  it("builds desktop ESV links for multiword books and Psalm", () => {
    expect(bibleLinkFor({ book: "Song of Solomon", chapter: 8 }, false)).toEqual({
      href: "https://www.esv.org/Song+of+Solomon+8/",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(bibleLinkFor({ book: "Psalm", chapter: 119 }, false).href).toBe(
      "https://www.esv.org/Psalm+119/",
    );
  });

  it("rejects unknown books and invalid chapters", () => {
    expect(() => bibleLinkFor({ book: "Unknown", chapter: 1 }, true)).toThrow(
      /Unknown Bible book/,
    );
    for (const inheritedKey of ["toString", "constructor", "__proto__"]) {
      expect(() => bibleLinkFor({ book: inheritedKey, chapter: 1 }, true)).toThrow(
        /Unknown Bible book/,
      );
    }
    expect(() => bibleLinkFor({ book: "Matthew", chapter: 0 }, false)).toThrow(
      /Invalid Bible chapter/,
    );
    expect(() => bibleLinkFor({ book: "Matthew", chapter: 1.5 }, false)).toThrow(
      /Invalid Bible chapter/,
    );
  });
});

describe("mobile and tablet classification", () => {
  const desktopSafari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

  const cases: readonly {
    readonly name: string;
    readonly input: NavigatorLike;
    readonly expected: boolean;
  }[] = [
    {
      name: "User-Agent Client Hints mobile",
      input: {
        userAgent: desktopSafari,
        maxTouchPoints: 0,
        userAgentData: { mobile: true },
      },
      expected: true,
    },
    {
      name: "Android phone",
      input: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
          "Chrome/131.0 Mobile Safari/537.36",
        maxTouchPoints: 5,
        userAgentData: { mobile: false },
      },
      expected: true,
    },
    {
      name: "Android tablet without Mobile token",
      input: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; SM-X810) AppleWebKit/537.36 " +
          "Chrome/130.0 Safari/537.36",
        maxTouchPoints: 10,
      },
      expected: true,
    },
    {
      name: "iPhone",
      input: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        maxTouchPoints: 5,
      },
      expected: true,
    },
    {
      name: "classic iPad user agent",
      input: {
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) " +
          "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        maxTouchPoints: 5,
      },
      expected: true,
    },
    {
      name: "iPod touch",
      input: {
        userAgent:
          "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        maxTouchPoints: 5,
      },
      expected: true,
    },
    {
      name: "iPadOS desktop user agent",
      input: { userAgent: desktopSafari, maxTouchPoints: 5 },
      expected: true,
    },
    {
      name: "Mac desktop",
      input: { userAgent: desktopSafari, maxTouchPoints: 0 },
      expected: false,
    },
    {
      name: "Windows touch laptop",
      input: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "Chrome/131.0 Safari/537.36",
        maxTouchPoints: 10,
        userAgentData: { mobile: false },
      },
      expected: false,
    },
    {
      name: "touch Chromebook",
      input: {
        userAgent:
          "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36 " +
          "Chrome/130.0 Safari/537.36",
        maxTouchPoints: 10,
      },
      expected: false,
    },
    {
      name: "Linux desktop",
      input: {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        maxTouchPoints: 0,
      },
      expected: false,
    },
    {
      name: "unknown browser",
      input: { userAgent: "", maxTouchPoints: 0 },
      expected: false,
    },
  ];

  for (const testCase of cases) {
    it(`classifies ${testCase.name}`, () => {
      expect(isMobileOrTablet(testCase.input)).toBe(testCase.expected);
    });
  }
});
