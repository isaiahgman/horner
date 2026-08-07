# Product specification: Horner

## Purpose

Horner is a quiet, phone-first reading companion for Professor Grant Horner's
Ten Lists Bible Reading System. It always answers one question for each list:
"What is the next unread chapter?" It must never describe the reader as behind
or create catch-up work because time passed.

## Core model

- The source of truth is ten independent cursor positions, not a dated plan.
- An active reading session contains exactly one chapter from each list.
- Marking a chapter complete records intent but does not change the visible
  session.
- At the next reading-day boundary, completed lists advance one chapter and
  incomplete lists stay put.
- Each list loops independently after its final chapter.
- Opening the app after several days creates one new session, not empty sessions
  for the skipped dates.
- The reading day changes at 4:00 a.m. local time by default. The hour is
  configurable from 0 through 23.
- A new guest profile, and a new Google-account profile with no guest progress
  to adopt, starts at Day 1: Matthew 1, Genesis 1, Romans 1, 1 Thessalonians 1,
  Job 1, Psalm 1, Proverbs 1, Joshua 1, Isaiah 1, and Acts 1.
- Changing the new-profile default must not reset existing local or cloud
  progress. The original reader's persisted Day 24-era state is claimed by
  that account during the one-time profile migration.

## Primary experience

The default screen shows "Today," a completed count, and ten large rows in list
order. Each row has a checkbox and linked chapter reference. On a phone or
tablet, the link uses YouVersion's ESV HTTPS passage URL so the operating system
can open the installed Bible app, with Bible.com as the automatic fallback. On
a desktop or laptop, it opens the chapter on ESV.org in a new tab. Checking a
row leaves all ten references in place for the entire session. A secondary
focus mode may present the same fixed session one chapter at a time.

History is secondary. It lists only sessions the reader actually had, shows the
completed count, and can reveal the ten results. The home screen must not show
backlogs, streak pressure, missed-day warnings, charts, or productivity scores.

Signed-out reading belongs to a guest profile. Each verified Google account has
a separate local and cloud profile. Signing out switches the visible app back
to the guest profile; it neither displays nor deletes the account profile. An
explicit first sign-in may adopt guest progress only when that account has no
existing account or cloud state.

## MVP scope

1. Ten-chapter session and independent completion controls.
2. Automatic, self-healing reading-day rollover.
3. Offline, installable PWA behavior.
4. Local IndexedDB persistence with schema versioning.
5. Google sign-in and UID-private Firestore synchronization so clearing local
   browser data or changing devices does not erase progress.
6. Recent session history and a safe undo/correction path.
7. JSON export, validated JSON import, and confirmed reset.
8. A best-effort persistent-storage request where supported.

Reminders, notes, social features, streaks, charts, and reading-time estimates
are explicitly deferred.

## Data and architecture

The chapter topology is static application data. The reading engine is pure
TypeScript and has no UI, storage, network, or clock dependency: callers supply
the current time and persist returned state. The UI uses Vite and React;
IndexedDB and Firestore access are isolated behind repository boundaries. No
Bible-text API is necessary because the app stores references only.

State consists of a schema version, ten cursor indexes, one active session,
completed session history, and settings. A session stores its reading-date key,
the exact ten chapter IDs shown, and ten completion flags. IndexedDB and its
write-ahead journal partition this state into one guest scope and one scope per
Firebase UID. Backup import must validate the schema and referential integrity
before replacing only the active profile.

Cloud state is encoded into one compact, atomically replaced document containing
the current state and bounded history. Each record is scoped to the
authenticated user's UID by Firestore Security Rules. Only a verified Google
identity whose UID matches `/users/{uid}` may access that document. A first
explicit sign-in adopts guest progress when no local account or cloud state
exists. Later sign-ins compare monotonic revisions: the newer copy wins, while
divergent copies at the same revision require an explicit device-or-cloud
choice. Version 1 per-session cloud records remain readable only for automatic
migration. Firestore's browser cache is memory-only; IndexedDB remains the
durable offline store.

## Acceptance criteria

- With no guest, account, legacy, or cloud state, a fresh profile shows the ten
  Day 1 references. Adopting a progressed guest profile preserves that progress
  instead of resetting it.
- Existing persisted progress is preserved through the profile migration and
  is not replaced by a new Day 1 state.
- Checking Matthew 24 does not replace it with Matthew 25 in the active session.
- On rollover, a checked Matthew 24 becomes Matthew 25; an unchecked Job 24
  remains Job 24. These chapters illustrate cursor behavior and are not the
  new-profile default.
- Returning Monday after a Friday session makes exactly one Monday session and
  adds no Saturday or Sunday history.
- Acts 28 advances to Acts 1; every other list loops in the same way.
- At the default boundary, 3:59 a.m. belongs to the previous civil date and
  4:00 a.m. belongs to the new civil date.
- Repeated rollover checks within a reading day are idempotent.
- The engine never advances a cursor solely because multiple dates elapsed.
- Every phone and tablet chapter link uses the matching YouVersion ESV passage,
  while desktop and laptop links use the matching ESV.org chapter.
- The ten bundled sequences have the published lengths: 89, 187, 78, 65, 62,
  150, 31, 249, 250, and 28 chapters.
- A first explicit Google sign-in adopts guest progress only when the account
  has no existing local or cloud state; signing in after local data is cleared
  restores that account's cloud state instead.
- Pending guest adoption survives an offline failure or reload. Its first cloud
  write is create-if-absent, so an existing or concurrently created account
  document wins and cannot be overwritten by guest-derived progress. Multiple
  open tabs share a short-lived explicit-sign-in intent so none can seed Day 1
  ahead of the initiating tab's guest adoption.
- Switching accounts loads a distinct UID-scoped local profile. Signing out
  hides the account profile and restores the guest profile without deleting
  either one.
- Returning to a signed-in computer checks the server before allowing another
  reading mutation; newer phone progress replaces its older device copy, and a
  date rollover alone cannot make the older copy win.
- Rapid taps persist in invocation order in the active IndexedDB profile. When
  online they are submitted immediately; when offline, later reconciliation
  uploads the newer durable local revision.
- Guest progress is not silently merged into an existing account; both local
  profiles remain intact. Equal-revision divergence within one account still
  requires an explicit device-or-cloud choice.
- Unauthenticated clients, non-Google identities, unverified identities, and
  one signed-in user attempting to access another user's UID path are denied by
  Firestore Security Rules.

## Canonical source

List membership and ordering follow Professor Grant Horner's published
[Ten Lists Bible Reading System PDF](https://www.masters.edu/wp-content/uploads/2022/06/professor_grant_horners_bible_reading_system.pdf).
