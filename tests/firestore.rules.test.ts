import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "demo-horner";
const emulatorAddress = process.env.FIRESTORE_EMULATOR_HOST;

let testEnvironment: RulesTestEnvironment;

function googleUserClaims(emailVerified = true) {
  return {
    email: "reader@example.com",
    email_verified: emailVerified,
    firebase: { sign_in_provider: "google.com" },
  };
}

function validDocument(revision = 1, preferredBibleUrl: string | null = null) {
  return {
    schemaVersion: 3,
    revision,
    cursorIndexes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    activeReadingDate: "2026-08-06",
    activeCompletedCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rolloverHour: 4,
    preferredBibleUrl,
    history: [],
    updatedAt: serverTimestamp(),
  };
}

function validVersion2Document(
  revision = 1,
  preferredBibleUrl: string | null = null,
) {
  return {
    schemaVersion: 2,
    revision,
    cursorIndexes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    activeReadingDate: "2026-08-06",
    activeCompletedMask: 0,
    rolloverHour: 4,
    preferredBibleUrl,
    history: [],
    updatedAt: serverTimestamp(),
  };
}

function databaseFor(
  userId: string,
  claims: Record<string, unknown> = googleUserClaims(),
) {
  return testEnvironment.authenticatedContext(userId, claims).firestore();
}

describe.skipIf(!emulatorAddress)("Firestore security rules", () => {
  beforeAll(async () => {
    const [host, portText] = emulatorAddress!.split(":");
    const port = Number(portText);
    if (!host || !Number.isInteger(port)) {
      throw new Error("FIRESTORE_EMULATOR_HOST must contain host:port");
    }

    testEnvironment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host,
        port,
        rules: await readFile(
          fileURLToPath(new URL("../firestore.rules", import.meta.url)),
          "utf8",
        ),
      },
    });
  });

  beforeEach(async () => {
    await testEnvironment.clearFirestore();
  });

  afterAll(async () => {
    await testEnvironment.cleanup();
  });

  it("allows a verified Google user to create and read only their document", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");

    await assertSucceeds(
      setDoc(ownerDocument, validDocument(1, "HTTPS://example.com/read")),
    );
    await assertSucceeds(getDoc(ownerDocument));

    const otherDatabase = databaseFor("reader-b");
    await assertFails(getDoc(doc(otherDatabase, "users", "reader-a")));
    await assertFails(getDocs(collection(otherDatabase, "users")));
    await assertFails(
      setDoc(doc(otherDatabase, "users", "reader-a"), validDocument()),
    );
    await assertSucceeds(
      setDoc(doc(otherDatabase, "users", "reader-b"), validDocument()),
    );
  });

  it("denies unauthenticated, unverified, and non-Google access", async () => {
    const targetPath = ["users", "reader-a"] as const;
    const anonymousDatabase = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonymousDatabase, ...targetPath)));

    const unverifiedDatabase = databaseFor("reader-a", googleUserClaims(false));
    await assertFails(
      setDoc(doc(unverifiedDatabase, ...targetPath), validDocument()),
    );

    const passwordDatabase = databaseFor("reader-a", {
      email: "reader@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "password" },
    });
    await assertFails(
      setDoc(doc(passwordDatabase, ...targetPath), validDocument()),
    );
  });

  it("accepts only strictly newer safe revisions and never permits deletes", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");
    await assertSucceeds(setDoc(ownerDocument, validDocument(4)));

    await assertFails(setDoc(ownerDocument, validDocument(4)));
    await assertFails(setDoc(ownerDocument, validDocument(3)));
    await assertSucceeds(setDoc(ownerDocument, validDocument(5)));
    await assertFails(
      setDoc(ownerDocument, validDocument(9_007_199_254_740_992)),
    );
    await assertFails(deleteDoc(ownerDocument));
  });

  it("allows a same-revision v2-to-v3 migration and rejects every downgrade", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");

    await assertSucceeds(setDoc(ownerDocument, validVersion2Document(4)));
    await assertFails(setDoc(ownerDocument, validVersion2Document(4)));
    await assertSucceeds(setDoc(ownerDocument, validVersion2Document(5)));
    await assertSucceeds(setDoc(ownerDocument, validDocument(5)));
    await assertFails(setDoc(ownerDocument, validDocument(5)));
    await assertFails(setDoc(ownerDocument, validVersion2Document(6)));
    await assertSucceeds(setDoc(ownerDocument, validDocument(6)));
  });

  it("allows only ten bounded integer completed counts in version 3", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");

    await assertSucceeds(setDoc(ownerDocument, {
      ...validDocument(1),
      activeCompletedCounts: Array(10).fill(1_023),
    }));

    const invalidCounts: unknown[][] = [
      [-1, ...Array(9).fill(0)],
      [1_024, ...Array(9).fill(0)],
      [1.5, ...Array(9).fill(0)],
      ["1", ...Array(9).fill(0)],
      Array(9).fill(0),
      Array(11).fill(0),
    ];
    for (const [index, activeCompletedCounts] of invalidCounts.entries()) {
      await testEnvironment.clearFirestore();
      await assertFails(setDoc(ownerDocument, {
        ...validDocument(index + 2),
        activeCompletedCounts,
      }));
    }
  });

  it("rejects oversized history and unknown version 3 fields", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");

    await assertFails(setDoc(ownerDocument, {
      ...validDocument(1),
      history: Array(10_001).fill("entry"),
    }));
    await assertFails(setDoc(ownerDocument, {
      ...validDocument(1),
      history: "not-a-list",
    }));
    await assertFails(setDoc(ownerDocument, {
      ...validDocument(1),
      activeCompletedMask: 0,
    }));
  });

  it("allows only bounded HTTPS preferred Bible URLs", async () => {
    const ownerDatabase = databaseFor("reader-a");
    const ownerDocument = doc(ownerDatabase, "users", "reader-a");

    await assertFails(
      setDoc(ownerDocument, validDocument(1, "http://example.com/read")),
    );
    await assertFails(
      setDoc(
        ownerDocument,
        validDocument(1, `https://example.com/${"a".repeat(2_048)}`),
      ),
    );
    await assertSucceeds(
      setDoc(ownerDocument, validDocument(1, "https://example.com/read")),
    );
  });

  it("keeps legacy sessions owner-readable but immutable", async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore();
      await setDoc(doc(database, "users", "reader-a"), {
        schemaVersion: 1,
      });
      await setDoc(doc(database, "users", "reader-a", "sessions", "2026-08-05"), {
        schemaVersion: 1,
      });
    });

    const ownerDatabase = databaseFor("reader-a");
    const currentDocument = doc(ownerDatabase, "users", "reader-a");
    const sessionDocument = doc(
      ownerDatabase,
      "users",
      "reader-a",
      "sessions",
      "2026-08-05",
    );
    await assertSucceeds(getDoc(sessionDocument));
    await assertFails(updateDoc(sessionDocument, { schemaVersion: 2 }));
    await assertFails(
      getDoc(
        doc(
          databaseFor("reader-b"),
          "users",
          "reader-a",
          "sessions",
          "2026-08-05",
        ),
      ),
    );
    await assertSucceeds(setDoc(currentDocument, validDocument(1)));
  });
});
