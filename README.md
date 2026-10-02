# Horner

A local-first, phone-first companion for Professor Grant Horner's Ten Lists
Bible Reading System. Ten independent chapter lists loop at your pace: only
completed reading advances them, so skipped days never create a backlog. The
daily milestone stays at ten chapters; additional same-day reading is counted
separately.

**Live app:** [isaiahgman.github.io/horner](https://isaiahgman.github.io/horner/)

## Start reading

Open the live app in Safari or Chrome. Use **Add to Home Screen** to install the
PWA, which works offline after its first successful load. Reading needs no
account; a verified Google sign-in adds cloud recovery and cross-device sync.
New profiles start at Day 1, while existing progress is preserved.

Chapter links open the ESV in YouVersion on supported phones and tablets, with
Bible.com as the fallback. Desktop and laptop links open ESV.org.

## Your progress

- Reading saves immediately to IndexedDB. Guest progress and each Google
  account have separate local profiles; signing out hides account progress
  without deleting it. First sign-in adopts guest progress only when that
  account has no existing local or cloud copy.
- Signed-in sync checks Firestore on authentication, focus/resume, and reconnect.
  The newer revision wins; different copies at the same revision require your
  choice. Avoid editing the same account on two offline devices at once.
- Clearing browser data removes the local copy. Successfully synced progress
  can be restored by signing in with the same Google account. Guest-only or
  unsynced changes can be lost. Export JSON for an independent backup. Import
  and reset download a safety copy before changing progress.
- Local profiles are not encrypted against someone using the same browser or
  OS profile. Use a separate profile on shared or untrusted devices.

See [sync and recovery details](docs/architecture.md#local-and-cloud-lifecycle).

## Development

Use Node.js 22.12 or newer in the Node 22 LTS line, matching CI. The rules suite also needs Java 21 and Firebase CLI
15.26.0 (`npm install --global firebase-tools@15.26.0`).

```sh
npm install
npm run check
npm run dev
```

Before publishing a code change, also run the production build and browser
suite:

```sh
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run test:e2e:webkit
npm run test:rules # requires Java 21
```

The Playwright suite serves the production bundle locally and uses the real
guest IndexedDB/localStorage persistence path. GitHub Actions repeats these
checks, including the Firestore emulator suite, before Pages deploys. An isolated guest-only
QA build supports synthetic UI review without production Firebase access; see
[local QA preview instructions](docs/qa-preview-build.md). Production still gets
only a brief signed-in cloud smoke test after the gated deployment.

All pull requests, including drafts and stacked PRs, run the same verification
checks in a separate read-only workflow. PR checks use the local Firestore
emulator and do not receive production credentials, upload a Pages artifact,
or deploy the app or rules. Each PR has its own verification queue, separate
from production.

PR verification runs the full browser suite in Chromium with Pixel 7 emulation
and WebKit with iPhone 13 emulation, including PWA cache-reload checks. WebKit
automation is not a substitute for a smoke test in Safari on a physical iPhone.
The WebKit preview uses HTTPS with a disposable local certificate and needs
OpenSSL. The production workflow keeps its existing Chromium browser gate.
Chromium tests browser offline mode; WebKit tests a stopped, isolated origin
because its offline emulation currently rejects service-worker responses.
WebKit airplane-mode and online/offline-event behavior remain unverified.

Pushing `main` runs the complete production pipeline: verification, a
rules-only Firestore deployment, and then GitHub Pages publication. The hosted
files contain no personal reading data. Firestore documents live under the
signed-in user's UID; [Firestore rules](firestore.rules) require a verified
Google identity and prevent access to another account's progress.

## Hosting and security

The Firebase project `horner-next-ten-isaiah` stays on the free Spark plan.
Public Firebase web configuration identifies the project; it does not grant
database access. Never commit service-account keys or other secrets.

Spark has finite, project-wide quotas shared by all readers; exhausting them
can temporarily interrupt cloud sync. Do not attach billing or add paid Google
Cloud services, Functions, or phone authentication. No nightly job is needed:
reading-day rollover happens when the app opens or resumes.

See the [security and quota boundaries](docs/architecture.md#free-tier-and-security-boundaries)
and [production deployment guide](docs/architecture.md#production-deployment)
for credential setup, rotation, and the rules-only bootstrap fallback.

## More detail

- [Product specification](docs/product-spec.md): reading behavior and acceptance criteria
- [Architecture and operations](docs/architecture.md): state flow, persistence, testing, and deployment
