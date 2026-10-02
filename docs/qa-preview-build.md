# Synthetic guest-only QA build

Use the isolated build for larger UI changes or new features. It starts with
synthetic Day 1 guest progress and never initializes Firebase. Production still
uses GitHub Pages, its existing Firebase project, and the normal build.

## Local review

With Node 22 and dependencies installed:

```sh
export QA_COMMIT_SHA="$(git rev-parse HEAD)"
export QA_PR_NUMBER=123
npm run build:qa
npx playwright install chromium
npm run test:qa
npm run preview -- --outDir dist-qa --host 127.0.0.1 --port 4175 --strictPort
```

When metadata is omitted, local builds explicitly show PR 0 and an all-zero
commit. Hosted publication must require a real exact PR/head identity.

`dist-qa` is distinct from production `dist`. The banner and `qa-build.json`
identify the PR and commit; the build fails if any Firebase runtime module,
production configuration, endpoint, or legacy owner email remains. Same-origin
CSP blocks cloud requests. A compile-time QA flag disables Google sign-in and
file import; it cannot be enabled by a URL or browser preference. Ordinary
production mode retains the existing account, migration, backup, and sync flows.

Do not use personal reading data or real backups here. Manually check chapters,
change settings, or reset the synthetic guest to explore the UI. The QA build
cannot exercise the import UI; ordinary production Playwright tests cover
validated import and recovery with synthetic fixtures. No account or cloud sync
is available. Bible links remain intentional external navigation.

Local IndexedDB and write-ahead journals use a `qa-preview:` prefix. The browser
suite checks synthetic reading/reload persistence, disabled sign-in/import,
production-storage isolation, blocked cloud requests, and static bundle markers.
All PRs run these checks inside the existing `Verify proposed changes` job after
the full production unit, rules, build, Chromium, and WebKit checks.

This change is build/test support only. Public seven-day Hosting previews and
the optional `qa-preview` label need a separately reviewed publisher and an
explicitly approved, free, separate QA project and deployment identity. No
service, credential, IAM change, or deployment is created by this build.
