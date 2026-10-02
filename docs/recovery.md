# Reading-data recovery

## What is protected

- IndexedDB and the write-ahead journal preserve the active browser's local
  profiles. Clearing browser data can remove both.
- Google sign-in keeps a current Firestore recovery copy for that account. Sync
  is not a history of independent backups: a valid but unwanted replacement can
  propagate to the cloud.
- An exported JSON file contains the active reading profile: cursors, the active
  session, history, and settings. It does not back up every account in the
  project, Firebase Authentication users, security rules, or project settings.
- Import and reset download a pre-change safety copy. Keep that file until the
  result has been checked; do not rely on an unnoticed download alone.

Database delete protection prevents deleting the database while enabled. It
is not protection from a document overwrite or an application-level mistake.

## No-cost backup practice

Keep dated JSON exports after meaningful reading and before a reset, import,
clearing browser storage, or other risky change. Keep more than the latest file
so an unwanted change does not replace every known-good copy. Keep an independent
private copy outside the browser's storage, and consider a second private
location you control. These are recommendations for the owner, not configured
automation, permission to upload anywhere, or a promise of ongoing backups.

Export from Settings while the intended guest/account profile is open. Check
that the file downloaded and retain it privately; never commit personal exports
to this repository, attach them to public issues, or put them in QA artifacts.
The maximum possible loss is progress since the most recent usable copy.

The Spark plan has no managed scheduled-backup or extended PITR allowance.
[Scheduled backups](https://firebase.google.com/docs/firestore/backups),
[PITR](https://firebase.google.com/docs/firestore/pitr), and
[managed export/import](https://firebase.google.com/docs/firestore/manage-data/export-import)
require billing/Blaze. Do not enable billing or those features without explicit
owner approval. Budget alerts on a paid plan are not a hard spending cap.

Firestore documents a short historical-read window even without extended PITR.
That is an emergency technical recovery option, subject to the available version
time and permissions; it is not a tested backup or a substitute for dated files.

## If progress looks wrong

1. Stop making changes. Do not reset, clear site data, or repeatedly import files
   to experiment. Preserve any downloaded safety copy and original export.
2. If the profile still opens, export its current state under a separate name
   before choosing a recovery source. An older device or file can be useful;
   do not reconnect or overwrite the only independent copy without preserving it.
3. If the app says saved progress could not be opened, use Retry first. The app
   deliberately withholds editing/import/reset controls rather than replacing
   unreadable data. Persistent storage failures need investigation; clearing the
   browser is not a safe repair when it may hold the only unsynced progress.
4. If local data is genuinely absent and the cloud copy is known to be good,
   signing in with the same Google account can restore it. A different account
   or the guest profile is a different data scope.
5. To restore a chosen JSON file into an open profile, use Settings → Import JSON
   backup and keep the downloaded pre-import copy. This replaces that profile;
   if signed in, it also submits the replacement to cloud sync. Confirm the
   intended profile and known-good file before doing this on a real account.
6. Check the active chapter references, completion/additional counts, history,
   and reading-day setting. Reload and check again. Older exports can roll
   forward to today's reading day, and an import receives a newer revision;
   neither alone means progress was lost. Retain the original file unchanged.

## Safe rehearsal and automated evidence

The production browser suite serves the built app locally and uses synthetic,
signed-out profiles. Its recovery test exports a multi-day profile, imports
only that file into a fresh browser context with separate storage, checks the
pre-import safety file's contents, reloads, and compares the re-exported state.
It covers history, additional chapters, cursors, settings, and revision rebasing
in both Chromium and WebKit. Non-local requests are blocked in that test.

Run the existing verification commands in the README. The test is named
`exported reading recovers in a fresh browser and keeps the pre-import safety copy`.
This verifies the file recovery path; it does not prove that an actual cloud
backup is current or rehearse a production Firestore restore.

The [guest-only QA build](qa-preview-build.md) intentionally disables import.
Do not enable it or put real reading data there for a restore drill. Keep any
private-backup validation offline and separate from checked-in test fixtures.
[Frontend rollback](release-safety.md) also does not roll back reading data.
