import type { ChapterReference } from "./lists.js";

export interface NavigatorLike {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly userAgentData?: {
    readonly mobile: boolean;
  };
}

export interface BibleLink {
  readonly href: string;
  readonly target?: "_blank";
  readonly rel?: string;
}

const USFM_BOOK_CODES: Readonly<Record<string, string>> = {
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
};

export function isMobileOrTablet(input: NavigatorLike): boolean {
  if (input.userAgentData?.mobile === true) return true;

  const userAgent = input.userAgent;
  if (/Android/i.test(userAgent)) return true;
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) return true;

  // Since iPadOS 13, Safari can identify an iPad as desktop macOS. Real iPads
  // expose multiple touch points; requiring both signals avoids treating a
  // Windows touch laptop or Chromebook as a tablet.
  return /Macintosh/i.test(userAgent) && input.maxTouchPoints > 1;
}

export function bibleLinkFor(
  reference: Pick<ChapterReference, "book" | "chapter">,
  mobile: boolean,
): BibleLink {
  if (!Object.hasOwn(USFM_BOOK_CODES, reference.book)) {
    throw new RangeError(`Unknown Bible book: ${reference.book}`);
  }
  const usfmCode = USFM_BOOK_CODES[reference.book];
  if (usfmCode === undefined) throw new RangeError(`Unknown Bible book: ${reference.book}`);
  if (!Number.isSafeInteger(reference.chapter) || reference.chapter < 1) {
    throw new RangeError(`Invalid Bible chapter: ${reference.chapter}`);
  }

  if (mobile) {
    return {
      href: `https://www.bible.com/bible/59/${usfmCode}.${reference.chapter}.ESV`,
    };
  }

  const passage = encodeURIComponent(`${reference.book} ${reference.chapter}`).replaceAll(
    "%20",
    "+",
  );
  return {
    href: `https://www.esv.org/${passage}/`,
    target: "_blank",
    rel: "noopener noreferrer",
  };
}
