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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";

import type { ReadingState } from "../domain/state.js";
import {
  decodeCloudState,
  encodeCloudCurrent,
  encodeCloudSession,
} from "./cloud-codec.js";

const firebaseApp = initializeApp({
  projectId: "horner-next-ten-isaiah",
  appId: "1:331301995758:web:7a6ef217d462e0b4dadfff",
  storageBucket: "horner-next-ten-isaiah.firebasestorage.app",
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

function sessionCollection(userId: string) {
  return collection(firestore, "users", userId, "sessions");
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

export async function loadCloudState(userId: string): Promise<ReadingState | undefined> {
  const currentSnapshot = await getDoc(userDocument(userId));
  if (!currentSnapshot.exists()) return undefined;
  const historySnapshot = await getDocs(sessionCollection(userId));
  return decodeCloudState(
    currentSnapshot.data(),
    historySnapshot.docs.map((snapshot) => snapshot.data()),
  );
}

export async function saveCloudState(
  userId: string,
  state: ReadingState,
): Promise<void> {
  const batch = writeBatch(firestore);
  batch.set(userDocument(userId), {
    ...encodeCloudCurrent(state),
    updatedAt: serverTimestamp(),
  });
  const latestSession = state.history.at(-1);
  if (latestSession) {
    batch.set(doc(sessionCollection(userId), latestSession.readingDate), {
      ...encodeCloudSession(latestSession),
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

async function deleteAllCloudSessions(userId: string): Promise<void> {
  const snapshots = await getDocs(sessionCollection(userId));
  for (const snapshot of snapshots.docs) {
    await deleteDoc(snapshot.ref);
  }
}

export async function replaceCloudState(
  userId: string,
  state: ReadingState,
): Promise<void> {
  await deleteAllCloudSessions(userId);
  const sessions = [...state.history];
  while (sessions.length > 0) {
    const chunk = sessions.splice(0, 400);
    const batch = writeBatch(firestore);
    for (const session of chunk) {
      batch.set(doc(sessionCollection(userId), session.readingDate), {
        ...encodeCloudSession(session),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }
  await setDoc(userDocument(userId), {
    ...encodeCloudCurrent(state),
    updatedAt: serverTimestamp(),
  });
}
