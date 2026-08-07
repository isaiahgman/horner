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
- A new installation starts at the supplied resumed calendar's Day 24:
  Matthew 24, Genesis 24, 1 Corinthians 8, James 2, Job 24, Psalm 24,
  Proverbs 24, Joshua 24, Isaiah 24, and Acts 24.

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

## MVP scope

1. Ten-chapter session and independent completion controls.
2. Automatic, self-healing reading-day rollover.
3. Offline, installable PWA behavior.
4. Local IndexedDB persistence with schema versioning.
5. Google sign-in and owner-private Firestore synchronization so clearing local
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
the exact ten chapter IDs shown, and ten completion flags. Backup import must
validate the schema and referential integrity before replacing local data.

Cloud state is encoded into one compact, atomically replaced document containing
the current state and bounded history. Each record is scoped to the
authenticated user's UID and the owner's verified Google email by Firestore
Security Rules. A first sign-in uploads existing local progress when no cloud
state exists. Later sign-ins compare monotonic revisions: the newer copy wins,
while divergent copies at the same revision require an explicit device-or-cloud
choice. Version 1 per-session cloud records remain readable only for automatic
migration.

## Acceptance criteria

- Checking Matthew 24 does not replace it with Matthew 25 in the active session.
- On rollover, a checked Matthew 24 becomes Matthew 25; an unchecked Job 24
  remains Job 24.
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
- A first Google sign-in uploads existing device progress when no cloud state
  exists; signing in after local data is cleared restores the cloud state.
- Returning to a signed-in computer checks the server before allowing another
  reading mutation; newer phone progress replaces its older device copy, and a
  date rollover alone cannot make the older copy win.
- Rapid taps persist in invocation order locally and are submitted immediately
  to Firestore's durable offline queue.
- A newer signed-out device copy is not silently overwritten by an older cloud
  copy, and equal-revision divergence requires an explicit choice.
- Unauthenticated clients and one signed-in user attempting to access another
  user's UID path are denied by Firestore Security Rules.

## Canonical source

List membership and ordering follow Professor Grant Horner's published
[Ten Lists Bible Reading System PDF](https://www.masters.edu/wp-content/uploads/2022/06/professor_grant_horners_bible_reading_system.pdf).
