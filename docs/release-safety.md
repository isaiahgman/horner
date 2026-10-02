# Small, reversible releases

Horner keeps its existing main deployment: verify, deploy rules, then publish
Pages. There is no mandatory 24-hour delay, automatic rollback, second
production site, or new paid service. For this personal app, small reviewed
changes plus a tested recovery path are more useful than waiting on a candidate
nobody is using. GitHub Pages has one project site per repository; separate
GitHub environments alone do not create blue/green hosting.

## Before merging a release

- Check the exact final commit's PR verification: type checks, unit tests,
  Firestore emulator, production build, Chromium, WebKit, isolated QA build,
  QA tests, and publisher/release-safety tests. Do not substitute a green check
  from an earlier commit. Production separately tests its exact merged commit.
- For a visible change, try the changed flow in the local guest-only QA build.
  The optional hosted preview remains separately opt-in; this workflow does
  not enable it or grant Firebase access.
- For persistence, sync, reading-engine, or rules changes, review both upgrade
  and old-client compatibility. Keep readers and rules backward compatible
  during rollout; do not remove old formats until older installed PWAs are
  accounted for. A schema migration may make an older frontend unsafe.
- Keep an independent JSON export before a risky data change. Store it
  privately; never attach personal reading data to GitHub or CI artifacts.
- Note a successful, actually working production run and its full commit SHA.
  CI success establishes checks passed; it does not prove a release was used
  successfully. Merge one small change at a time, then verify the live result.

## After deploying

Confirm the whole production workflow succeeded. Reopen/focus the online PWA
and check the changed flow. Use a disposable guest profile for synthetic
mutations. The owner can confirm that their existing signed-in state still
looks right and reports cloud protection; do not automate writes to their
reading progress just to smoke-test deployment.

The PWA checks for service-worker updates on focus/visibility, with a 30-second
minimum between checks. The auto-update client can activate a changed worker
and reload; offline or already-open clients may keep old code until they
reconnect/update. A deployment is not an immediate switch of every installed
client. Never clear site data or uninstall the PWA as a release-recovery step:
that can destroy guest or unsynced progress.

## Frontend rollback while the artifact exists

Use **Actions → Roll back production frontend → Run workflow** on **main**.
This is an explicit production action, not a dry run.

1. Pause merges/pushes to main during recovery. Let a running production
   deployment finish and inspect any pending runs. Both workflows share the
   `production` concurrency group and do not interrupt an active run, but a
   later main deployment can supersede the rollback. GitHub concurrency does
   not promise FIFO ordering and can replace a pending run.
2. Pick a previously working **Verify and deploy production** run whose
   `github-pages` artifact is still present. Copy its numeric run ID from its
   URL and full 40-character commit SHA from the run. A PR/QA build cannot be
   used. Avoid **Re-run all jobs** on an old production run: that also deploys
   its old Firestore rules.
3. Review the changes since that release, especially UI code that calls data
   operations and dependency updates. Confirm the old app can read and safely
   write the current data under the current rules. The automated guard is
   deliberately conservative: it requires identical `firestore.rules` and
   all non-test files under `src/data/` and `src/domain/` between the source
   release and the main commit running rollback. It blocks crossings of known
   data/reading-engine changes, but cannot prove compatibility for behavior in
   `App.tsx`, dependencies, or out-of-band Firebase changes. If uncertain, use
   a forward fix. Do not weaken this guard to force an incident rollback.
4. Supply the run ID and SHA, confirm the compatibility/pause checkbox, and
   type `ROLLBACK`. The workflow refuses a stale main dispatch, foreign or
   non-main run, incomplete/failed checks, wrong/expired artifact, changed data
   boundary, missing/mismatched digest, or unsafe archive.
5. Inspect the workflow summary's source run, app SHA, artifact ID, and hashes.
   It deploys the exact retained `artifact.tar`, including all PWA assets,
   without rebuilding or executing old repository/artifact code. It never
   obtains Firebase credentials, publishes rules, or reads/writes user data.
6. If the rollback fails, review the failure and start a **fresh Run workflow**
   dispatch after correcting it. Job/workflow reruns are deliberately skipped
   so an old deployment job cannot bypass fresh compatibility checks.
7. Confirm Pages succeeds and reopen/focus the online PWA. Recheck the changed
   flow and existing progress. Prepare a forward fix or reviewed source revert
   on main before resuming normal releases, or the next main push can restore
   the problem. The deployment's GitHub commit is the current workflow commit;
   the source app SHA is recorded explicitly in the rollback job summary.

Rollback restores frontend files only. It does not reverse a migration, erase
bad writes, recover overwritten Firestore data, or restore IndexedDB. Suspected
data damage needs a separate, reviewed recovery plan using an appropriate
private backup, not repeated frontend rollback attempts.

## When the artifact has expired or the guard refuses

The existing Pages upload action keeps artifacts for **one day**. This change
preserves that default; it does not retroactively retain older bundles.
Expired/deleted artifacts cannot be recovered by this workflow.

Use a small forward fix, or prepare a reviewed revert of the faulty frontend
change on a new branch based on current main. Preserve current Firestore rules
and data formats. Run the complete PR checks against that new commit and merge
through the normal verified pipeline. If reconstructing older source is
necessary, use its committed lockfile and rerun the full checks; this produces
a **new build**, not the exact previously deployed artifact. Do not execute an
old deployment workflow or roll back rules as a shortcut. A data-boundary
change requires an explicit compatibility/migration review before reverting.

## Cost and scope

This adds no subscription, larger runner, release-write permission, Firebase
service, IAM role, secret, billing change, or production-data backup artifact.
Standard GitHub-hosted runner use is free for public repositories, including
Horner. Actions artifact storage is separate and pooled with Packages; GitHub
Free includes 500 MB, so public hosting is not a promise of unlimited free
artifact storage. The production ZIP measured about 290 KiB on 2026-10-02.
Existing production retention stays at one day, and a manually created rollback
copy also expires after one day. Any longer recovery window must first fit the
account's available free storage and spending controls; this change does not
assume or alter those controls.

Native approval/wait timers are available for public repositories on GitHub
Free, but they are optional future choices, not enabled by this PR. A 24-hour
hold is useful only when the candidate is actually exercised, and it delays
urgent fixes too. Keeping a manual frontend recovery command and reviewing
high-risk data changes is the proportionate default here.

References:
- [Manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Actions billing and storage](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Pages artifact packaging and default retention](https://github.com/actions/upload-pages-artifact/blob/fc324d3547104276b827a68afc52ff2a11cc49c9/action.yml)
- [Pages deployment artifact selection](https://github.com/actions/deploy-pages/blob/368f82528645a54fb793d4d04e342629a3f51346/src/internal/api-client.js)
- [Concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
