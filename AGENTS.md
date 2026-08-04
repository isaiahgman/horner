# Horner agent guidance

This repository is a personal, phone-first Bible reading tracker. Preserve its
quiet, self-healing behavior; it is not a calendar, backlog manager, or streak
application.

## Read first

1. Read `/Users/isaiahgathala/projects/context/README.md` for shared machine and
   workspace context.
2. Read `README.md` for setup and deployment constraints.
3. Read `docs/product-spec.md` for product behavior and acceptance criteria.
4. Read `docs/architecture.md` before changing persistence, synchronization,
   security rules, session rollover, or deployment.

Repository-specific decisions belong in this repository. Put only reusable
machine or cross-repository facts in `/Users/isaiahgathala/projects/context/`.
Never store credentials, access tokens, private keys, or personal reading data
in either location.

## Non-negotiable product invariants

- There are ten independent, looping chapter cursors.
- Only completed reading advances a cursor; elapsed dates never do.
- An active session always contains exactly one chapter from every list.
- Checking a chapter must not replace it during the current reading session.
- On rollover, checked lists advance once and unchecked lists stay put.
- Skipped days produce no sessions, backlog, catch-up count, or missed-day
  warning.
- Reading dates use the configurable local-time boundary, defaulting to 4 a.m.
- A fresh installation begins at the verified Day 24 references documented in
  `docs/product-spec.md`.

Changes to chapter sequences, rollover behavior, or state transitions require
focused state-machine tests. Keep the reading engine pure: no React, IndexedDB,
Firebase, browser APIs, or implicit clock access in domain code.

## Persistence and security

- IndexedDB is the immediate local store and must continue working offline.
- Firestore is the durable recovery/synchronization copy after Google sign-in.
- Firebase web configuration is public client configuration, not a secret.
  Authorization belongs in Authentication and `firestore.rules`.
- Do not weaken the UID and verified-owner-email restrictions in Firestore
  rules.
- Preserve validated JSON export/import as an independent recovery path.
- Keep the project on Firebase Spark. Do not attach billing or enable Cloud
  Functions, Storage, point-in-time recovery, phone authentication, or another
  paid Google Cloud service without the user's explicit approval.
- GitHub Pages hosts the PWA. Firebase Hosting is not part of the architecture.

## Working agreement

- Prefer small, direct changes over new infrastructure or abstractions.
- Keep the default home screen centered on the next ten chapters; new metrics,
  reminders, accounts, or social features are out of scope unless requested.
- Run `npm run check` for code changes and `npm run build` for changes that can
  affect production output. Run `npm audit` when dependencies change.
- Run `git diff --check` before committing documentation-only changes.
- Direct commits to `main` are the established workflow for this personal
  repository; a pull request is not required unless the user asks for one.
- Update durable architecture or operational decisions in `docs/architecture.md`
  and product behavior in `docs/product-spec.md`.
