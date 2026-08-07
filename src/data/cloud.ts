import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  serverTimestamp,
  setDoc,
  waitForPendingWrites,
} from "firebase/firestore";

import type { ReadingState } from "../domain/state.js";
import {
  cloudStateNeedsMigration,
  decodeCloudState,
  encodeCloudCurrent,
} from "./cloud-codec.js";
import { CloudDataError } from "./cloud-config.js";

export { CLOUD_OWNER_EMAIL, isCloudPermissionError } from "./cloud-config.js";

const firebaseApp = initializeApp({
  projectId: "horner-next-ten-isaiah",
  appId: "1:331301995758:web:7a6ef217d462e0b4dadfff",
  apiKey: "AIzaSyD2KoP1r4Hka3D39hexIbPsJGGf4NxxYfQ",
  authDomain: "horner-next-ten-isaiah.firebaseapp.com",
  messagingSenderId: "331301995758",
});

const authentication = getAuth(firebaseApp);
const firestore = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

function userDocument(userId: string) {
  return doc(firestore, "users", userId);
}

function legacySessionCollection(userId: string) {
  return collection(firestore, "users", userId, "sessions");
}

export interface LoadedCloudState {
  readonly state: ReadingState;
  readonly needsMigration: boolean;
}

export function observeCloudAccount(
  listener: (user: User | null) => void,
): () => void {
  return onAuthStateChanged(authentication, listener);
}

export async function signInToCloud(): Promise<User> {
  const result = await signInWithPopup(authentication, new GoogleAuthProvider());
  return result.user;
}

export async function signOutOfCloud(): Promise<void> {
  await signOut(authentication);
}

export async function loadCloudState(userId: string): Promise<LoadedCloudState | undefined> {
  const currentSnapshot = await getDocFromServer(userDocument(userId));
  if (!currentSnapshot.exists()) return undefined;
  const currentValue = currentSnapshot.data();
  let needsMigration: boolean;
  try {
    needsMigration = cloudStateNeedsMigration(currentValue);
  } catch (error) {
    throw new CloudDataError("Cloud progress uses an unsupported or invalid format.", {
      cause: error,
    });
  }
  const legacySessions = needsMigration
    ? (await getDocsFromServer(legacySessionCollection(userId))).docs.map((snapshot) => snapshot.data())
    : [];
  try {
    return {
      state: decodeCloudState(currentValue, legacySessions),
      needsMigration,
    };
  } catch (error) {
    throw new CloudDataError("Cloud progress uses an unsupported or invalid format.", {
      cause: error,
    });
  }
}

export async function saveCloudState(
  userId: string,
  state: ReadingState,
): Promise<void> {
  await setDoc(userDocument(userId), {
    ...encodeCloudCurrent(state),
    updatedAt: serverTimestamp(),
  });
}

export async function waitForCloudWrites(): Promise<void> {
  await waitForPendingWrites(firestore);
}
