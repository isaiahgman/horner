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
| Chapter topology | `src/domain/lists.ts` | Ten ordered, independently looping sequences and Day 1 defaults |
| State machine | `src/domain/state.ts` | Reading-date calculation, fixed sessions, cursor advancement, correction, and reset |
| Local persistence | `src/data/database.ts` | Guest- and UID-scoped Dexie/IndexedDB state used immediately and offline |
| Cloud codec | `src/data/cloud-codec.ts` | Validated compact encoding for the atomic Firestore backup and version 1 migration |
| Cloud sync | `src/data/cloud.ts` | Google sign-in, server reconciliation, and a memory-only Firestore cache |
| Reader links | `src/domain/bible-links.ts` | Validated YouVersion/ESV chapter URLs and phone/tablet detection |
| UI | `src/App.tsx` | Phone-first list, focus mode, history, settings, and recovery actions |
| Access control | `firestore.rules` | Verified-Google identity and matching-UID enforcement |
| Deployment | `.github/workflows/deploy-pages.yml` | Tested production build and GitHub Pages publication |

Domain code must remain deterministic. Callers supply the current time and
persist the returned state; the engine must not read clocks, browser storage,
network state, or UI state itself.

## State transition

At launch, the app holds interaction until Firebase restores the local
authentication session and selects a storage profile. A signed-out browser
loads the guest profile. A verified Google identity loads `user:{uid}`; other
identities are signed out. Both paths load their selected device state without
rolling it over first. An authenticated online profile reads its own server
document, compares the two stored copies, selects the newer copy, and only then
rolls the selected state forward. This order prevents an old computer from
appearing newer merely because it was opened on a later date.

Signing out changes the visible profile back to the guest scope. It does not
delete the UID-scoped device state, so signing in again can resume it; it also
does not leave that account's progress visible in the application. A one-time,
owner-specific migration may claim the pre-profile `primary` device record for
the original account only. That preserves the existing Day 24-era reader state
without making Day 24 the default for any new profile.

For the selected state:

1. Calculate the reading-date key using the configured local rollover hour.
2. If the key has not changed, keep the active session exactly as shown.
3. If it changed, archive the prior session, advance each checked cursor once,
   retain each unchecked cursor, and create one new session for the current key.
4. Persist in the active IndexedDB profile, render, and attempt an authenticated
   cloud write when the selected state changed. If offline, later
   reconciliation uploads the durable local revision.

The number of civil dates between openings is intentionally ignored. This is
why reopening after several days creates one session rather than a chain of
empty missed sessions. No nightly batch job is needed or desired.

## Local and cloud lifecycle

IndexedDB is the primary interaction store: checkbox changes are saved locally
without waiting for a network response. The store has one `guest` record and a
separate `user:{uid}` record for each account used on that browser. A compact,
synchronous localStorage write-ahead journal uses the same scope partition and
closes the small page-close window before IndexedDB commits; it is
revision-checked, replayed at startup when newer, and removed after the matching
IndexedDB write succeeds. Import, reset, and ordinary mutations replace only
the active profile. Firestore protects account state from clearing all browser
data or replacing the device.

The pre-profile `primary` IndexedDB record and version 2 journal are not treated
as guest data. The original reader's verified account can claim an unchanged
legacy snapshot into its UID scope. The claim is transactional for IndexedDB,
rechecks an opaque snapshot token, and removes the contributing journal only
after the scoped copy is durable. Other users cannot claim this legacy record;
with no guest state to adopt, their new profile starts at Day 1.

Cloud data is scoped below the authenticated user:

```text
/users/{uid}
```

The version 2 user document contains a monotonic revision, current cursors,
active-session metadata, settings, and up to 10,000 compact history entries.
Keeping the complete recovery state in one document makes every cloud update
atomic; there is no delete-then-rebuild window. Version 1 session subdocuments
remain read-only during automatic migration. Firestore rules require a verified
Google sign-in whose authenticated UID matches the path, validate the document
shape, reject deletes, and reject non-increasing version 2 writes. One reader
cannot list, read, update, or delete another reader's document.

Firestore is initialized with a memory-only cache. The UID-scoped application
IndexedDB store remains the durable offline copy, while Firebase document data
cannot linger in a separate persistent Firestore cache after account sign-out.

Synchronization follows these rules:

- If an explicit first sign-in finds no local account or remote state, adopt the
  guest state and upload it. A UID-scoped pending-adoption record preserves
  that intent across an outage or reload. The first cloud write is a
  create-if-absent transaction, so a concurrently created remote profile wins;
  the pending record is cleared only after a committed create or after an
  existing remote copy has been selected and stored locally. Ordinary cloud
  writes are suppressed while this marker exists; local reading remains
  available, and reconciliation uses the latest scoped device revision. A
  short-lived, token-checked localStorage intent is staged before the Google
  popup so another open tab makes the same adoption decision; it contains no
  reading data and expires after ten minutes.
- Compare stored copies before applying a reading-day rollover. If only one
  copy has the greater revision, keep that copy. If equally revised copies
  differ, ask which one to keep and rebase the selected device copy.
- Reconcile after authentication and whenever an authenticated app regains
  focus, becomes visible, or returns online. Reconciliation is single-flight,
  blocks reading mutations while it is selecting a copy, waits for this
  page session's queued writes, and ignores results from an obsolete
  authentication generation.
- Submit each local mutation to Firestore immediately when authenticated.
  Firestore's queue is memory-only; the scoped IndexedDB write is the durable
  offline copy. On reconnect or a later launch, reconciliation uploads a newer
  device revision that did not reach the server.
- Treat authentication as separate from successful protection: the interface
  reports syncing or unavailable until a server reconciliation or write
  succeeds. Invalid cloud data is never mislabeled as offline or overwritten
  automatically.
- Import and reset receive a new revision and atomically replace the remote
  recovery document. Reset and import also preserve a downloaded pre-change
  safety copy.
- JSON export remains useful even with cloud sync and should stay backward
  compatible through explicit schema versioning.

Each account is optimized for one reader primarily using one phone. The same
deployment can serve many independent accounts, but profiles never collaborate
or merge with one another. Within one account, revision checks prevent silent
stale restoration and catch the common two-copy conflict at reconciliation.
They are not a general collaborative merge algorithm: avoid editing the same
account on multiple offline devices at the same time. If that becomes a real
requirement, introduce operation-level merging and dedicated concurrency tests.

## Free-tier and security boundaries

The Firebase project is `horner-next-ten-isaiah` and uses one Native-mode
Firestore database in `nam5`, Google Authentication, delete protection, and no
point-in-time recovery. The GitHub Pages origin is the production auth origin.
Google is the only supported identity provider; both the client and rules
require a verified Google identity, and the rules authorize only that user's
matching `/users/{uid}` path.

The Firebase web key in source identifies the public client and is safe to ship;
it does not grant document access. Do not add service-account material or other
secrets to the repository. Treat `firestore.rules` as the authorization
boundary and test access whenever its paths or predicates change.

Security review on 2026-08-06 confirmed that the source value matches the
active Firebase-created browser key, its allowlist contains only
Firebase-related APIs, and the Generative Language API is absent. GitHub
secret-scanning alert #1 for that value is resolved as a false positive. If the
same public client configuration is flagged again, re-check its live API
restrictions and the Firestore denial tests; do not rotate or rewrite history
solely to obscure a value that must be present in the browser bundle. This is
consistent with [Firebase's API-key guidance](https://firebase.google.com/docs/projects/api-keys).

The UID rule protects the integrity and confidentiality of one user's cloud
document from every other visitor, including another authenticated user. It
does not make the public service unbounded. Spark quotas are shared by the whole
project. As of 2026-08-06, the free Firestore allowance is 1 GiB stored, 50,000
document reads and 20,000 writes per day, 20,000 deletes per day, and 10 GiB of
outbound transfer per month. Authentication also has service limits and abuse
controls. The data model can represent many readers, but neither capacity nor
availability is infinite. Current limits are authoritative at
[Firestore quotas](https://firebase.google.com/docs/firestore/quotas) and
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

A malicious signed-in reader still cannot alter anyone else's progress, but
could attempt enough valid operations against their own document to consume a
shared quota and temporarily interrupt cloud sync for everyone. Spark prevents
surprise usage billing. If public adoption or abuse makes this material, stage
Firebase App Check in monitoring mode and test it before enforcement; App Check
supplements rather than replaces Authentication and Security Rules.

Profile partitioning prevents accidental account mixing in the application. It
is not encryption from someone who controls the same operating-system/browser
profile or opens developer tools: UID-scoped IndexedDB records intentionally
remain on that browser for offline return. Use separate browser or OS profiles
on a shared or untrusted machine. This local limitation does not bypass the
server's UID isolation.

Chapter links use ordinary HTTPS URLs rather than custom app schemes. On phones
and tablets, Bible.com passage URLs participate in YouVersion's iOS Universal
Links and Android App Links, which lets the operating system open the installed
Bible app and leaves the same URL as a browser fallback. Desktop and laptop
links use ESV.org in a new tab. Native handoff remains an operating-system and
user preference; the PWA must not try to detect whether another app is
installed.

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
npm run test:rules
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
protection. The registered PWA checks for a new service worker when the app
regains focus or becomes visible; the auto-update client activates the new
worker and reloads an already-running client. For disaster recovery, sign in
with the same Google account that owns the cloud copy or import a previously
exported JSON backup.

The public repository remains readable and forkable, but that does not grant
write or deployment access to the original. The 2026-08-06 access audit found
only the repository owner with direct access, with no pending invitations,
deploy keys, or webhooks. Classic protection on `main` is enforced for
administrators, blocks force pushes and branch deletion, and deliberately does
not require pull requests or status checks so the established direct,
fast-forward commit workflow still works. Keep Actions permissions minimal and
third-party actions pinned to full commit SHAs. Repository ownership still
depends on the GitHub account: maintain two-factor authentication or a passkey
and offline recovery codes. Branch protection cannot prevent the authenticated
owner, or someone who compromises that account, from deleting the repository
itself; the secured account and independent local clone are the final recovery
boundaries.

## Known limitations

- Rollover occurs on launch/focus, not via background execution at 4 a.m.
- The initial cloud seed for each account requires one Google sign-in from the
  app.
- Clearing browser data before that first successful sign-in also clears the
  only local copy unless a JSON backup exists.
- Signed-out guest data has no cloud recovery and remains specific to that
  browser until it is adopted by a new account or exported.
- Local account profiles are hidden by sign-out but are not encrypted from
  another person controlling the same browser profile or developer tools.
- The synchronization policy for each account is designed for personal,
  primarily single-device use rather than simultaneous offline editing on
  multiple devices.
- Firestore rules tests require Java 21. The Pages workflow provisions Java and
  runs `npm run test:rules`; if the development Mac lacks Java 21, the Firebase
  server-side dry run remains the local compilation fallback.
- The project-wide Spark quotas cap total public usage. App Check is not yet
  enforced, so monitor usage before promoting the app to a large audience.
