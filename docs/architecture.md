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
| Cloud codec | `src/data/cloud-codec.ts` | Validated compact encoding for the atomic Firestore backup and version 1 migration |
| Cloud sync | `src/data/cloud.ts` | Google sign-in, server reconciliation, and Firestore's durable offline write queue |
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
```

The version 2 user document contains a monotonic revision, current cursors,
active-session metadata, settings, and up to 10,000 compact history entries.
Keeping the complete recovery state in one document makes every cloud update
atomic; there is no delete-then-rebuild window. Version 1 session subdocuments
remain read-only during automatic migration. Firestore rules require both the
matching authenticated UID and the configured verified Google email, validate
the document shape, reject deletes, and reject non-increasing version 2 writes.

Synchronization follows these rules:

- If the first sign-in finds no remote state, upload the complete local state.
- If only one copy has the greater revision, keep that copy. If equally revised
  copies differ, ask which one to keep and rebase the selected device copy.
- Submit each local mutation to Firestore immediately. This lets Firestore put
  every change in its persistent offline queue; later taps never wait only in
  volatile JavaScript memory.
- Import and reset receive a new revision and atomically replace the remote
  recovery document. Reset and import also preserve a downloaded pre-change
  safety copy.
- JSON export remains useful even with cloud sync and should stay backward
  compatible through explicit schema versioning.

This is optimized for one reader primarily using one phone. Revision checks
prevent silent stale restoration and catch the common two-copy conflict at
reconciliation. They are not a general collaborative merge algorithm: avoid
editing on multiple offline devices at the same time. If that becomes a real
requirement, introduce operation-level merging and dedicated concurrency tests.

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
npx playwright install chromium
npm run test:e2e
npm audit
```

Deploy Authentication and Firestore configuration only when those files
change:

```sh
firebase deploy --only auth,firestore --dry-run --project horner-next-ten-isaiah
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
  single-device use rather than simultaneous offline editing on multiple
  devices.
- Local Firestore Security Rules emulator tests require Java 21, which is not
  currently installed on the development Mac. Firebase's server-side dry run
  remains the compilation fallback; production denial probes still verify the
  deployed unauthenticated boundary.
