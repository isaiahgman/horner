# Architecture and operations

This document is the implementation map for future development. Product rules
and acceptance criteria remain authoritative in
[the product specification](product-spec.md).

## System shape

The application is a static React and TypeScript PWA hosted on GitHub Pages.
It has no application server, scheduled job, Bible-text API, or paid runtime.
Rollover is evaluated when the app opens or regains focus, so the browser does
not need to remain open overnight.

The layers are deliberately narrow:

| Concern | Location | Responsibility |
| --- | --- | --- |
| Chapter topology | `src/domain/lists.ts` | Ten ordered, independently looping sequences and Day 24 defaults |
| State machine | `src/domain/state.ts` | Reading-date calculation, fixed sessions, cursor advancement, correction, and reset |
| Local persistence | `src/data/database.ts` | Versioned Dexie/IndexedDB state used immediately and offline |
| Cloud codec | `src/data/cloud-codec.ts` | Conversion between local state and normalized Firestore records |
| Cloud sync | `src/data/cloud.ts` | Google sign-in, restore/upload decisions, queued writes, and remote replacement |
| UI | `src/App.tsx` | Phone-first list, focus mode, history, settings, and recovery actions |
| Access control | `firestore.rules` | Owner UID and verified-email enforcement |
| Deployment | `.github/workflows/deploy-pages.yml` | Tested production build and GitHub Pages publication |

Domain code must remain deterministic. Callers supply the current time and
persist the returned state; the engine must not read clocks, browser storage,
network state, or UI state itself.

## State transition

For each launch or focus event:

1. Load the current local state.
2. Calculate the reading-date key using the configured local rollover hour.
3. If the key has not changed, keep the active session exactly as shown.
4. If it changed, archive the prior session, advance each checked cursor once,
   retain each unchecked cursor, and create one new session for the current key.
5. Persist locally, render, and queue the authenticated cloud write.

The number of civil dates between openings is intentionally ignored. This is
why reopening after several days creates one session rather than a chain of
empty missed sessions. No nightly batch job is needed or desired.

## Local and cloud lifecycle

IndexedDB is the primary interaction store: checkbox changes are saved locally
without waiting for a network response. Firestore protects the small state from
browser-data clearing or device replacement.

Cloud data is scoped below the authenticated user:

```text
/users/{uid}
/users/{uid}/sessions/{readingDate}
```

The user document contains current cursors, active-session metadata, settings,
and schema information. Historical sessions are separate compact documents.
Firestore rules require both the matching authenticated UID and the configured
verified Google email.

Synchronization follows these rules:

- If the first sign-in finds no remote state, upload the complete local state.
- If remote state exists, restore it locally; remote is the recovery source at
  sign-in.
- After sign-in, local mutations queue serialized cloud writes so quick taps do
  not race each other.
- Import and reset replace the remote representation rather than merging stale
  history.
- JSON export remains useful even with cloud sync and should stay backward
  compatible through explicit schema versioning.

This is optimized for one reader and light personal use. If multi-device
simultaneous editing becomes a real requirement, design explicit conflict
resolution and test it before changing the current remote-on-sign-in policy.

## Free-tier and security boundaries

The Firebase project is `horner-next-ten-isaiah` and uses one Native-mode
Firestore database in `nam5`, Google Authentication, delete protection, and no
point-in-time recovery. The GitHub Pages origin is the production auth origin.

The Firebase web key in source identifies the public client and is safe to ship;
it does not grant document access. Do not add service-account material or other
secrets to the repository. Treat `firestore.rules` as the authorization
boundary and test access whenever its paths or predicates change.

Remain on the Spark plan. Features that can introduce billing or complicate the
otherwise static architecture require explicit approval. In particular, do not
add Cloud Functions for rollover: elapsed time does not advance this plan, and
the client can calculate the next session when it opens.

## Operations

Local verification:

```sh
npm install
npm run check
npm run build
```

Deploy Authentication and Firestore configuration only when those files
change:

```sh
firebase deploy --only auth,firestore --project horner-next-ten-isaiah
```

Pushing `main` triggers the GitHub Pages workflow. The live application is:

```text
https://isaiahgman.github.io/horner/
```

After a new deployment, verify the Pages workflow succeeded, open the live PWA
on a phone-sized screen, and confirm a signed-in checkbox change reports cloud
protection. For disaster recovery, sign in with the owner Google account or
import a previously exported JSON backup.

## Known limitations

- Rollover occurs on launch/focus, not via background execution at 4 a.m.
- The initial cloud seed requires one Google sign-in from the app.
- Clearing browser data before that first successful sign-in also clears the
  only local copy unless a JSON backup exists.
- The current synchronization policy is designed for personal, primarily
  single-device use rather than concurrent collaboration.
