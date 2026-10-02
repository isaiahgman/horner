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
| State machine | `src/domain/state.ts` | Reading-date calculation, fixed core sessions, contiguous continuation counts, cursor advancement, correction, and reset |
| Local persistence | `src/data/database.ts` | Guest- and UID-scoped Dexie/IndexedDB state used immediately and offline |
| Cloud codec | `src/data/cloud-codec.ts` | Validated compact encoding for the atomic Firestore backup and cloud-schema migration |
| Cloud sync | `src/data/cloud.ts` | Google sign-in, server reconciliation, and a memory-only Firestore cache |
| Reader links | `src/domain/bible-links.ts` | Validated YouVersion/ESV chapter URLs and phone/tablet detection |
| UI | `src/App.tsx` | Phone-first list, focus mode, history, settings, and recovery actions |
| Access control | `firestore.rules` | Verified-Google identity and matching-UID enforcement |
| Deployment | `.github/workflows/deploy-pages.yml` | Verification, Firestore rules deployment, and GitHub Pages publication |

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
2. If the key has not changed, keep the active core session exactly as shown.
3. If it changed, archive the prior session, advance each cursor by that list's
   contiguous completed count, retain each zero-count cursor, and create one new
   zero-count session for the current key.
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

A failed local-profile read is not evidence that the profile is empty. The app
preserves the existing record, shows a retry/reload screen, and withholds reading
and settings controls until the profile can be opened. It does not replace an
unreadable local copy with Day 1 or potentially older cloud progress. A genuinely
missing local record still follows normal new-profile/cloud-recovery startup.

The physical IndexedDB schema advances to version 2 without changing the store
shape. That upgrade prevents an already-installed domain-v1 client from
reopening the database after the current client establishes domain-v2 state.
Legacy v3-prefix journals remain recoverable only while the durable record is
absent or still domain v1; once IndexedDB contains current-domain data, those
legacy journal values are ignored and compare-and-swap cleared regardless of
revision. This one-way barrier prevents a stale tab from erasing additional
chapter counts during the rollout.

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

The version 3 user document contains a monotonic revision, current cursors,
active-session completion counts, settings, and up to 10,000 compact history
entries. Domain/backup schema 2 represents each list with one bounded count
that includes its fixed core chapter; cloud history encodes those counts in a
constant-width compact form. Domain schema 1 and cloud schemas 1 and 2 remain
readable for automatic migration, with their booleans or masks mapped to counts
of zero or one.
Keeping the complete recovery state in one document makes every cloud update
atomic; there is no delete-then-rebuild window. Version 1 session subdocuments
remain read-only during automatic migration. Firestore rules require a verified
Google sign-in whose authenticated UID matches the path, validate the document
shape, reject deletes, and reject stale current-schema writes. Transitional
rules permit schema 2 clients until migration but forbid a version 3 document
from being downgraded, so an older installed client cannot erase additional
reading. One reader cannot list, read, update, or delete another reader's
document.

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

Continuation previews are derived from static list topology and UI batch state;
opening, closing, or revealing a group does not create a revision or write.
Only appending the next contiguous chapter or undoing the current tail changes
state. Counts are capped at 1,023 completed chapters per list in one reading
session. This is well beyond the intended reading use case while bounding
untrusted imports, rendering, and security-rule validation. The compact count
keeps cloud document growth independent of how many additional chapters were
read that day, although each completion remains an ordinary saved mutation.

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

## Build compatibility

Vite 8 uses Rolldown for bundling, Oxc for JavaScript transforms/minification,
and Lightning CSS for CSS minification. Explicit production targets retain the
previous Vite 7 syntax floor: Chrome/Edge 107, Firefox 104, and Safari/iOS 16.0.
This avoids silently raising the Safari floor to Vite 8's default 16.4. Targets
control emitted syntax; they do not polyfill browser APIs or replace testing on
actual supported devices. Automated Chromium and WebKit runs do not establish
compatibility with every supported Safari version or a physical iPhone.

The Firebase Auth and Firestore vendor groups use Rolldown `codeSplitting`
rather than deprecated Rollup `manualChunks`. The production PWA continues to
precache its generated chunks for offline use. Keep Node 22 LTS (22.12 or newer)
and the existing Firebase CLI pin; this migration requires neither Node 26 nor
changes to deployment credentials, permissions, reading data, or sync behavior.

References: [Vite 8 migration](https://vite.dev/guide/migration),
[build targets](https://vite.dev/config/build-options#build-target), and
[Rolldown code splitting](https://rolldown.rs/reference/OutputOptions.codeSplitting).

## Verification environments

The pre-production environment is the locally served production bundle, driven
by Playwright in a real browser. Guest-mode tests exercise the actual IndexedDB
record and localStorage write-ahead journal across reloads; they do not replace
durability with an in-memory fake. The Firestore emulator separately compiles
and exercises Security Rules, and GitHub Actions repeats type checking, unit
tests, emulator tests, the production build, browser flows, accessibility, PWA,
and phone-overflow checks before Pages can deploy.

The isolated [QA build](qa-preview-build.md) supports synthetic UI review for
large UI changes and new features. It excludes Firebase runtime/configuration,
account sign-in, legacy owner migration, and personal backup import. Its
separate IndexedDB/journal namespace also protects production-like local data
when a developer reuses a localhost origin. Normal PR verification checks both
production and QA builds. Hosting publication is a separate, opt-in layer; this
build alone deploys nothing and requires no credentials. The separate
[opt-in publisher](qa-previews.md) is disabled until reviewed QA-only project,
Hosting site, OIDC identity, and owner access approval are configured. Only a
`qa-preview` label requests public seven-day publication; ordinary CI QA checks
do not create an environment.

After CI passes, use production only for a short signed-in smoke test covering
the real Google Auth and Firestore boundary. QA cannot replace that check or
ordinary production import/backup and rules-emulator tests.

## Operations

Local verification:

```sh
npm install
npm run check
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run test:e2e:webkit
npm run test:rules
npm audit
```

### Pull request verification

`.github/workflows/verify-pr.yml` runs on all pull requests, including drafts
and stacked PRs. It repeats the production verification commands with the
same Node, Java, and Firebase CLI versions, but has only `contents: read`
permission, does not retain checkout credentials, and never requests a
production environment or secret. Firestore tests use the `demo-horner`
emulator project. No Pages artifact is uploaded and no deployment job runs.

The full browser suite runs twice: `test:e2e` uses Chromium with Pixel 7
emulation, and `test:e2e:webkit` uses WebKit with iPhone 13 emulation. Both
include persistence, desktop/tablet chapter-link behavior, accessibility, and
service-worker cache-reload checks. This exercises the real WebKit engine with an
emulated phone, not Safari on a physical iPhone. Production verification
continues to use the Chromium suite.

WebKit upgrades loopback HTTP assets under the production
`upgrade-insecure-requests` CSP, so its separate preview serves the unchanged
`dist` bundle over HTTPS. The test-only launcher requires OpenSSL, creates an
ephemeral localhost certificate, and immediately removes the key/certificate
files after loading them into memory. Only the isolated WebKit test config
accepts that self-signed certificate. No certificate enters the repository or
build output, and the production CSP remains enforced.

Chromium retains `context.setOffline(true)` for its offline test. Playwright
1.63 WebKit rejects service-worker responses in that emulation mode, matching
[upstream issue #42775](https://github.com/microsoft/playwright/issues/42775).
The WebKit cache-reload test instead starts its own ephemeral HTTPS origin,
stops that server, confirms a direct network probe fails, and requires a
successful service-worker response plus preserved checked state after reload.
The dedicated origin prevents interference with other tests. This proves
cached operation during an origin outage; it does not verify WebKit
`navigator.onLine`, online/offline events, or physical-iPhone airplane mode.

PR runs have a separate, per-PR concurrency group. A newer revision cancels
obsolete checks for that PR without interrupting another PR or the serialized
production pipeline. Keep these checks aligned with production verification
when changing either workflow.

### Production deployment

Routine production still auto-deploys verified main commits. A separate manual
frontend-only rollback can reuse an unexpired, successfully deployed Pages
artifact without deploying old Firestore rules. It refuses changes across the
reading-engine/persistence/rules boundary and never restores user data. See the
[release and recovery runbook](release-safety.md) for the one-day artifact
window, compatibility review, PWA behavior, and source-revert fallback.

Pushing `main`, or manually dispatching the production workflow from `main`,
runs one serialized pipeline:

```text
verify -> deploy Firestore rules -> deploy GitHub Pages
```

Every run tests the rules in the emulator, builds the production app, and runs
the browser suite before receiving production credentials. The next job uses
the protected `firebase-production` GitHub environment to server-validate and
deploy only `firestore:rules`. That command does not request Authentication,
index, Hosting, Functions, billing, or another Firebase-service deployment.
Pages publishes only after that job succeeds. Production runs are not canceled
in progress, which prevents a newer push from interrupting the pipeline between
the rules and app deployments.

The Firestore job also checks the exact `refs/heads/main` ref before requesting
its environment secret. A manual dispatch from another branch therefore stops
after verification, and its dependent Pages job is skipped.

Bootstrap the credential once in GitHub and Google Cloud:

1. Create a dedicated service account in `horner-next-ten-isaiah` and grant it
   one project-level custom role containing exactly these permissions:

   ```text
   datastore.databases.get
   firebase.projects.get
   firebaserules.releases.create
   firebaserules.releases.list
   firebaserules.releases.update
   firebaserules.rulesets.create
   firebaserules.rulesets.get
   firebaserules.rulesets.list
   firebaserules.rulesets.test
   resourcemanager.projects.get
   serviceusage.services.get
   serviceusage.services.use
   ```

   This role cannot delete rules, enable services, create projects or
   databases, change indexes, or access documents. Firebase CLI 15.26 may
   report missing `datastore.indexes.*` permissions during its preflight, but
   that check is informational and nonblocking for `firestore:rules`; the
   filtered preparation and deployment exclude indexes. Do not add Index
   Admin, Firebase Viewer, Owner, Editor, Billing, or service-agent roles.
2. Create the `firebase-production` GitHub environment, restrict its deployment
   branch to protected `main`, and store the complete JSON key as its
   `FIREBASE_SERVICE_ACCOUNT_JSON` environment secret.
3. Trigger the workflow once and confirm both the rules and Pages deployments.
   Delete every local copy of the JSON key after the secret is stored.

The Google Cloud and GitHub setup is an external, credentialed owner action;
the production workflow cannot bootstrap its own authority. After creating the
protected `firebase-production` environment in the GitHub repository settings,
an authenticated `gcloud` and `gh` session can perform the remaining one-time
setup:

```sh
project_id='horner-next-ten-isaiah'
service_account_id='github-firestore-rules-deployer'
custom_role_id='hornerFirestoreRulesDeployer'
service_account="${service_account_id}@${project_id}.iam.gserviceaccount.com"
credential_dir="$(mktemp -d "${TMPDIR:-/tmp}/horner-firebase-rules-key.XXXXXX")"
credential_file="${credential_dir}/key.json"
chmod 700 "$credential_dir"
umask 077

gcloud iam service-accounts create "$service_account_id" \
  --display-name='Horner Firestore rules deployer' \
  --project="$project_id"

gcloud iam roles create "$custom_role_id" \
  --project="$project_id" \
  --title='Horner Firestore Rules Deployer' \
  --stage=GA \
  --permissions='datastore.databases.get,firebase.projects.get,firebaserules.releases.create,firebaserules.releases.list,firebaserules.releases.update,firebaserules.rulesets.create,firebaserules.rulesets.get,firebaserules.rulesets.list,firebaserules.rulesets.test,resourcemanager.projects.get,serviceusage.services.get,serviceusage.services.use'

gcloud projects add-iam-policy-binding "$project_id" \
  --member="serviceAccount:${service_account}" \
  --role="projects/${project_id}/roles/${custom_role_id}" \
  --condition=None

gcloud iam service-accounts keys create "$credential_file" \
  --iam-account="$service_account" \
  --project="$project_id"

gh secret set FIREBASE_SERVICE_ACCOUNT_JSON \
  --repo isaiahgman/horner \
  --env firebase-production \
  < "$credential_file"

rm -- "$credential_file"
rmdir -- "$credential_dir"
```

For rotation, create a second key for the same restricted service account,
replace `FIREBASE_SERVICE_ACCOUNT_JSON`, verify a successful manual workflow
run, and only then revoke the old key. Rotate immediately if exposure is
suspected. Never place the JSON in repository files, logs, artifacts, or a
repository-level secret. Do not create or use `FIREBASE_TOKEN`; the workflow
uses Google Application Default Credentials from the pinned authentication
action.

The workflow owns routine Firestore rules publication. During the one-time CI
bootstrap, an authenticated owner can publish the current rules with the
checked-in fallback. `firebase login --reauth` is a one-time workstation
prerequisite; repeat it only if the saved login expires or is revoked. The
script stops if its server-side dry run fails and never reads or stores a
credential itself:

```sh
firebase login --reauth
sh scripts/deploy-firestore-rules.sh
```

The live application is:

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
