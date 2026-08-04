# Horner

A local-first reading companion for Professor Grant Horner's Ten Lists Bible
Reading System. Progress belongs to ten independent, looping chapter lists;
calendar time never creates a backlog.

The phone-first PWA starts at Day 24 of the supplied resumed calendar. It saves
immediately to IndexedDB for offline use and, after Google sign-in, synchronizes
an owner-private copy to Cloud Firestore so progress survives cleared browser
data and device changes.

## Development

```sh
npm install
npm run check
npm run dev
```

Production builds are deployable to GitHub Pages with the included workflow.
The hosted files contain no personal reading data. Firestore documents live
under the signed-in user's Firebase UID and the deployed rules deny every other
user. The rules also restrict storage to the owner's verified Google email, so
public visitors cannot read or write the personal cloud document. JSON export
remains available as an independent backup.

## Firebase

The no-cost Firebase Spark project is `horner-next-ten-isaiah`. The public web
configuration is bundled in the PWA by design; authorization is enforced by
Firebase Authentication and [the checked-in Firestore rules](firestore.rules).

There is no service-account key, database password, or private API secret in
this repository. Firebase's browser API key identifies the project but does
not authorize a database read. Firebase manages the signed-in Google session,
and Firestore accepts reads and newer-version writes only when both the UID and
verified owner email match. GitHub Pages contains application code and static
chapter references; personal checkmarks and history remain in the owner-scoped
Firestore document.

Clearing all browser data removes the device's IndexedDB copy, cached app, and
local sign-in session. It does not delete Firestore data. Signing in again with
the owner account restores the durable copy. JSON export is the independent
recovery path and reset downloads a safety backup before changing progress.

```sh
firebase deploy --only auth,firestore --dry-run --project horner-next-ten-isaiah
firebase deploy --only auth,firestore --project horner-next-ten-isaiah
```

Do not attach a Google Cloud billing account or add Functions, paid Google Cloud
services, or phone authentication. The app needs only free Google sign-in and
the single free Firestore database.

See [the product specification](docs/product-spec.md) for the MVP behavior and
acceptance criteria, and [the architecture guide](docs/architecture.md) for the
state flow, persistence model, security boundaries, and operations.
