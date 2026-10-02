# Opt-in, isolated QA previews

## Status and boundaries

The checked-in workflow is **disabled for publication**. There is no configured
QA project, site, or identity in this code. Nothing here creates infrastructure, credentials,
billing, or a deployment. `firebase.qa.json` deliberately contains blank IDs and
`enabled: false`; the repository variable `QA_PREVIEWS_ENABLED` must also be
exactly `true` before publication is possible. An initial setup PR cannot preview
itself: the security files must first receive review and land on `main`.

Production remains the existing GitHub Pages app and its existing Firebase
project. The production workflow, `.firebaserc`, `firebase.json`, Firestore
rules, and production credentials are unchanged. The named `Verify proposed
changes` gate retains all production checks and additionally tests QA build
isolation and publisher safety without deploying anything.
QA never copies account or reading data from production. This is an explicitly
separate Firebase **Spark** project containing only a Hosting site; no billing,
Firestore, Authentication, Functions, Storage, or other paid service is needed.

A preview is public to anyone with its URL. Noindex headers reduce indexing but
are not authentication. Use only synthetic guest progress. Do not enter real
personal information, credentials, or backups. Google sign-in and JSON import
are disabled, all Firebase runtime modules and production config are excluded
from the QA bundle, and the app marks itself as QA with PR/commit information.
Its local persistence namespace and distinct Hosting origin separate it from
production. Bible links remain deliberate external navigation; ordinary app
resources and requests are limited to the preview origin by CSP.

## Local use

Use Node 22 and Python 3.12 or newer. These commands require no cloud credentials:

```sh
npm ci
export QA_COMMIT_SHA="$(git rev-parse HEAD)"
export QA_PR_NUMBER=123 # use the PR number you are testing
npm run build:qa
npx playwright install chromium
npm run test:qa
python3 -I -m unittest discover -s scripts -p 'qa*_test.py'
python3 scripts/qa_preview.py check-dir dist-qa
npm run preview -- --outDir dist-qa --host 127.0.0.1 --port 4175 --strictPort
```

`dist-qa` is separate from the production `dist`. `qa-build.json` binds each
bundle to the full head SHA and numeric PR. Browser checks cover the synthetic
preview and its no-production-network boundary. The Python tests run in normal PR verification even without a preview label and
exercise the publisher without network calls; they do not claim a live Firebase deployment
has been tested. Changes still need the normal `npm run check`, production
build, browser suites, and rules-emulator checks.

## How a preview becomes publishable

1. On a same-repository open PR targeting `main`, add `qa-preview`. Drafts are
   supported; forks are refused. The label is an owner's affirmative opt-in to
   publicly serve the proposed UI. Review its code accordingly.
2. `Build QA preview` checks out the **exact PR head SHA**, builds `dist-qa`, runs
   the QA browser suite and static checks, then uploads one immutable artifact
   named `qa-preview-<PR>-<full-SHA>`. The build has read-only repository access,
   no OIDC, no environment, no secrets, and no saved checkout credentials.
   Its queue is distinct from production. Remove the label or close the PR to
   cancel a still-running build; a new commit cancels the obsolete build.
3. `Publish QA preview` runs only as `workflow_run` from reviewed `main`. It
   checks out its own immutable `github.workflow_sha`, never a PR. Completion
   of either QA build or normal PR verification can trigger it, so publication
   does not depend on which one finishes first. Publication is serialized with
   `queue: max`, retaining up to 100 pending runs rather than replacing another
   PR's pending event. A full queue can still reject new runs; an owner may
   rerun the rejected publisher after checking current eligibility.
4. Before authentication, the trusted Python gate requires the PR to remain
   open, same-repository, labeled, and at that exact SHA. The newest applicable
   `Verify pull request` run must succeed, with its `Verify proposed changes`
   job successful; the newest QA build and its exact build job must also
   succeed. A later failed/running check cannot be masked by an older success.
5. The gate compares Git blob identity/mode for reviewed security/build files
   against `main`'s publisher snapshot. The protected list includes both QA
   workflows, normal PR verification, publisher/validator/tests, QA Vite and
   base Vite configs, QA runtime/cloud stub, QA browser config/tests, package
   scripts/lockfile, and QA project configuration. Changes to those files must
   land after review before hosted previews can run; local QA is still useful.
6. Artifact ID, originating run, repository IDs, exact head SHA, run attempt
   timestamp, name, expiration, size, and GitHub's SHA-256 digest are verified.
   Only one matching artifact is accepted. The downloaded ZIP is treated as
   untrusted data, never executed or added to the Python/module search path.
   GitHub's token is not forwarded to the signed artifact-storage URL.
7. Extraction is bounded to 128 files, 8 MiB compressed, 16 MiB total expanded,
   and 4 MiB per file. Static filenames/extensions are allowlisted. Traversal,
   absolute/duplicate paths, symlinks, executable files, encrypted entries,
   high-ratio ZIP bombs, server/config/source files, source maps, cloud markers,
   and external resource URLs are rejected. Inert library diagnostics/XML
   namespaces and Bible navigation literals have a narrow exception in JS.
8. Only then does the pinned Google auth action request a short-lived,
   QA-project-only OIDC access token. The publisher executes **no npm, Firebase
   CLI, PR scripts, PR configuration, or artifact JavaScript**. Python's standard
   library sends the validated bytes directly to the Firebase Hosting REST API.
   There are no deployment hooks, framework adapters, functions, or rewrites.
9. Project/site ownership, unchanged staged-file digests, current PR opt-in,
   security files, and passing checks are rechecked before publication. A final
   check immediately before release catches changes during upload. GitHub and
   Firebase do not offer an atomic cross-service label-and-release transaction;
   an owner change after that final read is an unavoidable small race.
10. The publisher creates `pr-<PR>-<12-char-SHA>` with full SHA and PR ownership
    labels. A prefix collision is refused. Its lifetime is seven days, previous
    releases retained are limited to one, and reruns do not extend a published
    channel's lifetime. The verified URL and full commit appear in the publisher
    run summary. No automatic PR comments or production promotion occur.

The publisher's HTTP CSP uses `default-src 'self'`, `connect-src 'self'`,
`script-src 'self'`, and same-origin workers. Objects, frames, embedding, forms,
and base URL changes are forbidden. Additional headers disable framing,
referrers, MIME sniffing, indexing, sensitive browser features, and HTTP caching.
Local inline styles and data images remain allowed for the existing app.

The standard-library REST publisher is intentionally explicit about provenance,
archive bounds, destination validation, and release-time rechecks. Avoid replacing
it with a credentialed `npm`/Firebase CLI invocation over PR-owned files: that
would introduce executable config, dependency hooks, or framework adapters into
the trusted step. Offline tests cover accepted and rejected inputs, actual gzip
upload bytes, channel collisions, stale/unlabeled/closed PRs during upload, and
token separation; these are not evidence of live service/IAM activation.

This is isolation for a reviewed synthetic QA build, not a promise to make
arbitrary hostile application code harmless. CSP does not prevent every form
of top-level navigation, social engineering, or user-directed data entry.
Treat the label as approval to expose the proposed UI publicly. Do not use this
preview for sensitive data or grant it account access.

## One-time enablement, after explicit access approval

Creating projects, persistent IAM/OIDC access, environment permissions, or
account security settings requires the owner's separate approval. Do not run
bootstrap commands or broaden production access as an incidental PR step.
Do not add a key or reuse `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_TOKEN`, a
production service account, production site, or production project.

After approval, an owner should:

1. Create a dedicated, unbilled Firebase **Spark** QA project and its default
   Hosting site. Choose IDs containing a distinct `qa` hyphen-delimited segment,
   such as `horner-isolated-qa` if available. Verify the Spark plan and that no
   billing account is attached. Enable only APIs needed for Hosting and OIDC
   service-account impersonation. Keep this separate from production IAM.
2. Create a QA service account with a custom QA-project role containing only
   `firebasehosting.sites.get` and `firebasehosting.sites.update`. These allow the
   site's versions/channels/releases; they do not grant Firestore, Auth, rules,
   project creation, billing, site creation/deletion, Owner, Editor, or IAM
   administration. Firebase's permission granularity can allow writes to the
   QA site's live channel too, so the trusted publisher is responsible for using
   only preview-channel releases. Never grant this role in production.
   Verify these permissions against a disposable preview at activation; stop
   and review any missing permission rather than granting broad admin roles.
3. Create an OIDC Workload Identity pool/provider **in the QA project**, using
   issuer `https://token.actions.githubusercontent.com`. Map `google.subject`
   to `assertion.sub`, and map any repository attributes used by the principal
   binding. Scope impersonation of that single QA service account to this
   repository's identity, with `roles/iam.workloadIdentityUser` only. Do not grant
   the entire pool access; no service-account key is needed.
4. Require all of the following claims in the provider attribute condition
   (actual immutable GitHub IDs verified on 2026-10-02):

   ```text
   assertion.repository_id == '1322404505' &&
   assertion.repository_owner_id == '92384661' &&
   assertion.repository == 'isaiahgman/horner' &&
   assertion.workflow_ref == 'isaiahgman/horner/.github/workflows/publish-qa-preview.yml@refs/heads/main' &&
   assertion.ref == 'refs/heads/main' &&
   assertion.event_name == 'workflow_run' &&
   assertion.sub == 'repo:isaiahgman/horner:environment:firebase-qa'
   ```

   Do not trust the repository name or a branch claim alone. The workflow path,
   default-branch ref, environment subject, event, numeric owner ID, and numeric
   repository ID prevent a PR build or an unrelated workflow from using this
   identity. Confirm the emitted claims during setup and fail closed if they do
   not match. Keep main protected and review modifications to this trust chain.
5. Create the dedicated GitHub environment `firebase-qa`, restricted to `main`,
   with owner review if desired. It must contain no production secrets. Record
   the exact approved QA project ID, numeric project number, site ID, provider
   resource name, and QA service-account email in a reviewed `firebase.qa.json`
   change, with `enabled: true`. No aliases or fallback projects are accepted.
6. Only after those reviewed changes land and access is verified, set the
   repository variable `QA_PREVIEWS_ENABLED=true`. Label a harmless same-repo
   PR whose protected files match main. Confirm both verification workflows
   succeed, then confirm the published URL's QA banner, full commit metadata,
   disabled sign-in/import, guest persistence, HTTP CSP, and zero production
   network requests. Publication has not been live-tested before this setup.

References: [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[Hosting REST deployment](https://firebase.google.com/docs/hosting/api-deploy),
[Hosting IAM permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasehosting),
[Google's GitHub Actions OIDC action](https://github.com/google-github-actions/auth),
and [deployment-pipeline federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

## Expiry, revocation, and failure handling

- Remove `qa-preview` to stop future publishing for that PR, or set the repository
  variable to `false` to disable all future publications. The label is checked
  again before release. These switches do **not** revoke an already published
  URL or clear a visitor's browser/service-worker cache.
- Firebase deactivates expired preview URLs and schedules associated resource
  deletion, normally within 24 hours. No separate cleanup credential/job is
  installed. For immediate revocation, an authorized owner can delete the exact
  QA preview channel in the QA Hosting console. Never target the production
  project or a live channel. See [channel management and expiry](https://firebase.google.com/docs/hosting/manage-hosting-resources).
- The seven-day URL lifetime is not a remote wipe. Previously opened offline
  content and synthetic local guest progress can remain in a visitor's browser.
- A stale SHA, removed label, fork, altered security file, missing/failed current
  check, missing artifact digest, or invalid archive fails closed before a
  release. A green builder alone is not sufficient. If checks are merely not
  finished, the other workflow's completion retries the gate automatically.
- GitHub's workflow-run event and artifact listings are eventually consistent;
  a transient read failure safely refuses publication. Rerun the publisher from
  its Actions page after confirming the current checks, label, and artifacts.
- A failure after version upload but before release may leave an unreleased QA
  version; it does not publish the app. Review QA Hosting storage if repeated
  failures or high preview volume consume the finite Spark quota. Stay on Spark;
  reduced availability is preferable to silently enabling billing.
- For a PR changing protected safety files or dependencies, run local QA, review
  and merge those infrastructure changes separately, then rebase the intended
  application preview PR onto reviewed main. Never relax the validator simply
  to get a URL.
