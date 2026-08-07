# Horner

A local-first reading companion for Professor Grant Horner's Ten Lists Bible
Reading System. Progress belongs to ten independent, looping chapter lists;
calendar time never creates a backlog.

**Live app:** [isaiahgman.github.io/horner](https://isaiahgman.github.io/horner/)

The phone-first PWA starts every new reader at Day 1 of all ten lists. It saves
immediately to a separate profile in IndexedDB for offline use and, after Google
sign-in, synchronizes that reader's own copy to Cloud Firestore so progress
survives cleared browser data and device changes. Existing progress created by
the earlier Day 24 version is preserved and migrated instead of being reset.

Chapter links open the ESV in the installed YouVersion Bible app on supported
phones and tablets, falling back to Bible.com when the app is unavailable.
Desktop and laptop links open ESV.org.

## Use on a phone

Open the live app in Safari or Chrome and use the browser's **Add to Home
Screen** action to install it. Reading works without an account. Signing in with
a verified Google account adds cloud recovery and cross-device synchronization.
The installed PWA works offline after its first successful load and checks for
app updates whenever it regains focus or becomes visible.

The browser keeps a separate local profile for the signed-out guest and for
each Google account used on that browser. On a first explicit sign-in, guest
progress is adopted only if that account has no existing local or cloud copy.
That pending adoption survives a temporary outage, and an atomic
create-if-absent check prevents it from replacing an account created elsewhere.
Signing out returns to the guest profile and hides the account's progress from
the app without deleting it.

IndexedDB remains the immediate offline store. When signed in and online, the
app checks Firestore after authentication, on focus or visible resume, and when
connectivity returns. The newer stored revision wins; equally revised but
different copies require an explicit choice. Reconciliation happens before
reading-day rollover, so merely opening an older computer cannot make its copy
override newer phone progress. There is no nightly job: only completed reading
advances a list. The sync policy is intended for sequential personal use;
avoid making changes on two offline devices at the same time.

## Development

```sh
npm install
npm run check
npm run dev
```

Before publishing a code change, also run the production build and browser
suite:

```sh
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:rules # requires Java 21
```

Production builds are deployable to GitHub Pages with the included workflow.
The hosted files contain no personal reading data. Firestore documents live
under the signed-in user's Firebase UID. The deployed rules deny unauthenticated
requests and prevent every account from reading or writing another account's
document. Public visitors may use or fork the application, but that does not
grant access to anyone else's progress. JSON export remains available as an
independent backup.

## Firebase

The no-cost Firebase Spark project is `horner-next-ten-isaiah`. The public web
configuration is bundled in the PWA by design; authorization is enforced by
Firebase Authentication and [the checked-in Firestore rules](firestore.rules).

There is no service-account key, database password, or private API secret in
this repository. Firebase's browser API key identifies the project but does
not authorize a database read. Firebase manages the signed-in Google session,
and Firestore accepts reads and newer-version writes only when the verified
Google identity matches the UID in `/users/{uid}`. GitHub Pages contains
application code and static chapter references; personal checkmarks and history
remain in UID-scoped Firestore documents.

Clearing all browser data removes the device's IndexedDB copy, cached app, and
local sign-in session. It does not delete Firestore data. Signing in again with
the same Google account restores that account's durable copy. JSON export is
the independent recovery path and reset downloads a safety backup before
changing progress.

This design supports many independent readers, not an infinite service.
Firebase Spark has finite, project-wide Authentication and Firestore quotas;
all users share those limits. At the current free Firestore allowance, that
includes 1 GiB of stored data, 50,000 document reads per day, 20,000 writes per
day, 20,000 deletes per day, and 10 GiB of outbound transfer per month. See the
current [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)
and [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
before planning broader public use. Spark prevents a surprise database bill,
but exhausting a shared quota can temporarily interrupt cloud sync.

Local profile separation prevents accidental account mixing in the app; it is
not encryption against someone who can use the same operating-system/browser
profile and inspect site storage with developer tools. Use a separate browser
or OS profile on a shared or untrusted device. Firestore's own browser cache is
memory-only, and its server rules continue to isolate cloud documents.

```sh
firebase deploy --only auth,firestore --dry-run --project horner-next-ten-isaiah
firebase deploy --only auth,firestore --project horner-next-ten-isaiah
```

Do not attach a Google Cloud billing account or add Functions, paid Google Cloud
services, or phone authentication. The app needs only free Google sign-in and
the single free Firestore database. It has no nightly batch job: reading-day
rollover is calculated when the app opens or resumes, and time alone never
advances a chapter.

See [the product specification](docs/product-spec.md) for the MVP behavior and
acceptance criteria, and [the architecture guide](docs/architecture.md) for the
state flow, persistence model, security boundaries, and operations.
