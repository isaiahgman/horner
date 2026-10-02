import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import re
import tarfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

SPEC = importlib.util.spec_from_file_location("release_safety", Path(__file__).with_name("release_safety.py"))
safety = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(safety)
SHA = "a" * 40
CURRENT = "b" * 40
REPO = {"id": safety.REPO_ID, "full_name": safety.REPO}
RUN = {"id": 123, "run_attempt": 1, "head_sha": SHA, "repository": REPO,
       "head_repository": REPO, "head_branch": "main", "event": "push",
       "path": safety.PRODUCTION, "workflow_id": 10, "status": "completed", "conclusion": "success"}
WORKFLOW = {"path": safety.PRODUCTION, "id": 10}
JOBS = {"total_count": 3, "jobs": [{"name": name, "status": "completed", "conclusion": "success"} for name in sorted(safety.REQUIRED_JOBS)]}
TREE = {"truncated": False, "tree": [{"path": name, "sha": SHA, "type": "blob", "mode": "100644"} for name in sorted(safety.REQUIRED_DATA)]}
ARTIFACT = {"id": 45, "name": "github-pages", "expired": False, "size_in_bytes": 100,
            "digest": "sha256:" + "c" * 64,
            "workflow_run": {"id": 123, "head_sha": SHA, "head_branch": "main", "repository_id": safety.REPO_ID, "head_repository_id": safety.REPO_ID}}


def tar(entries=None):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name, body, kind in entries or [("./index.html", b"<html></html>", tarfile.REGTYPE),
                                          ("./sw.js", b"// service worker", tarfile.REGTYPE),
                                          ("./manifest.webmanifest", b"{}", tarfile.REGTYPE)]:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.size = len(body) if kind == tarfile.REGTYPE else 0
            archive.addfile(entry, io.BytesIO(body))
    return data.getvalue()


def zipped(bundle=None, name="artifact.tar", extra=False, mode=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo(name)
        if mode is not None:
            info.external_attr = mode << 16
        archive.writestr(info, bundle if bundle is not None else tar())
        if extra:
            archive.writestr("extra", b"bad")
    return data.getvalue()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class ProvenanceTests(unittest.TestCase):
    def test_accepts_successful_main_run(self):
        safety.validate_run(RUN, WORKFLOW, 123, SHA)

    def test_accepts_main_manual_production_run(self):
        safety.validate_run(dict(RUN, event="workflow_dispatch"), WORKFLOW, 123, SHA)

    def test_rejects_wrong_or_unsuccessful_runs(self):
        for key, value in [("head_branch", "feature"), ("event", "pull_request"), ("head_sha", CURRENT),
                           ("path", safety.ROLLBACK), ("workflow_id", 11), ("id", 124),
                           ("status", "in_progress"), ("conclusion", "failure"), ("run_attempt", 0),
                           ("head_repository", {"id": 99, "full_name": safety.REPO}),
                           ("repository", {"id": safety.REPO_ID, "full_name": "other/repo"})]:
            with self.subTest(key=key), self.assertRaises(safety.Refused):
                safety.validate_run(dict(RUN, **{key: value}), WORKFLOW, 123, SHA)

    def test_rejects_wrong_registered_workflow(self):
        with self.assertRaises(safety.Refused):
            safety.validate_run(RUN, dict(WORKFLOW, path=safety.ROLLBACK), 123, SHA)

    def test_requires_exact_full_sha(self):
        with self.assertRaises(safety.Refused):
            safety.validate_run(RUN, WORKFLOW, 123, SHA[:7])

    def test_requires_all_successful_jobs(self):
        safety.validate_jobs(JOBS)
        for name in safety.REQUIRED_JOBS:
            changed = copy.deepcopy(JOBS)
            next(job for job in changed["jobs"] if job["name"] == name)["conclusion"] = "skipped"
            with self.subTest(name=name), self.assertRaises(safety.Refused):
                safety.validate_jobs(changed)

    def test_rejects_incomplete_or_duplicate_jobs(self):
        for result in [dict(JOBS, total_count=4), {"total_count": 4, "jobs": JOBS["jobs"] + [JOBS["jobs"][0]]}]:
            with self.assertRaises(safety.Refused):
                safety.validate_jobs(result)

    def test_accepts_bound_artifact(self):
        safety.validate_artifact(ARTIFACT, RUN)

    def test_rejects_invalid_artifacts(self):
        for key, value in [("id", 0), ("name", "qa-preview"), ("expired", True), ("size_in_bytes", safety.MAX_ZIP + 1),
                           ("size_in_bytes", 0), ("digest", ""), ("digest", "sha256:bad")]:
            with self.subTest(key=key), self.assertRaises(safety.Refused):
                safety.validate_artifact(dict(ARTIFACT, **{key: value}), RUN)

    def test_requires_artifact_source_binding(self):
        for key, value in [("id", 124), ("head_sha", CURRENT), ("head_branch", "feature"), ("repository_id", 99), ("head_repository_id", 99)]:
            changed = copy.deepcopy(ARTIFACT)
            changed["workflow_run"][key] = value
            with self.subTest(key=key), self.assertRaises(safety.Refused):
                safety.validate_artifact(changed, RUN)


class CompatibilityTests(unittest.TestCase):
    def test_same_boundary_allowed(self):
        safety.validate_data_boundary(TREE, TREE)

    def test_ui_and_tests_do_not_block(self):
        changed = copy.deepcopy(TREE)
        changed["tree"] += [{"path": "src/App.tsx", "sha": CURRENT}, {"path": "src/data/database.test.ts", "sha": CURRENT}]
        safety.validate_data_boundary(changed, TREE)

    def test_each_boundary_file_change_blocks(self):
        for item in TREE["tree"]:
            changed = copy.deepcopy(TREE)
            next(entry for entry in changed["tree"] if entry["path"] == item["path"])["sha"] = CURRENT
            with self.subTest(path=item["path"]), self.assertRaises(safety.Refused):
                safety.validate_data_boundary(TREE, changed)

    def test_added_or_removed_data_module_blocks(self):
        changed = copy.deepcopy(TREE)
        changed["tree"].append({"path": "src/data/new-codec.ts", "sha": SHA, "type": "blob", "mode": "100644"})
        with self.assertRaises(safety.Refused):
            safety.validate_data_boundary(changed, TREE)
        with self.assertRaises(safety.Refused):
            safety.validate_data_boundary(TREE, changed)

    def test_missing_required_file_blocks(self):
        with self.assertRaises(safety.Refused):
            safety.validate_data_boundary(TREE, dict(TREE, tree=TREE["tree"][1:]))

    def test_truncated_tree_blocks(self):
        with self.assertRaises(safety.Refused):
            safety.validate_data_boundary(TREE, dict(TREE, truncated=True))

    def test_symlink_boundary_blocks(self):
        changed = copy.deepcopy(TREE)
        changed["tree"][0]["mode"] = "120000"
        with self.assertRaises(safety.Refused):
            safety.validate_data_boundary(changed, changed)


class BundleTests(unittest.TestCase):
    def test_preserves_exact_original_tar(self):
        bundle = tar()
        archive = zipped(bundle)
        self.assertEqual(safety.read_bundle(archive, digest(archive)), bundle)

    def test_rejects_wrong_digest(self):
        with self.assertRaises(safety.Refused):
            safety.read_bundle(zipped(), "sha256:" + "0" * 64)

    def test_rejects_oversized_archive(self):
        archive = zipped()
        with patch.object(safety, "MAX_ZIP", 10), self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))

    def test_rejects_extra_zip_entries_or_name(self):
        for archive in [zipped(extra=True), zipped(name="../artifact.tar"), zipped(name="other.tar")]:
            with self.assertRaises(safety.Refused):
                safety.read_bundle(archive, digest(archive))

    def test_rejects_zip_symlink(self):
        archive = zipped(mode=stat.S_IFLNK | 0o777)
        with self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))

    def test_rejects_path_escape_links_special_and_hidden(self):
        for name, kind in [("../index.html", tarfile.REGTYPE), ("/index.html", tarfile.REGTYPE),
                           ("a\\index.html", tarfile.REGTYPE), (".env", tarfile.REGTYPE),
                           ("script.sh", tarfile.REGTYPE), ("index.html", tarfile.SYMTYPE),
                           ("index.html", tarfile.LNKTYPE), ("index.html", tarfile.FIFOTYPE)]:
            archive = zipped(tar([(name, b"bad", kind)]))
            with self.subTest(name=name, kind=kind), self.assertRaises(safety.Refused):
                safety.read_bundle(archive, digest(archive))

    def test_rejects_duplicate_files(self):
        archive = zipped(tar([("index.html", b"one", tarfile.REGTYPE), ("./index.html", b"two", tarfile.REGTYPE)]))
        with self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))

    def test_rejects_missing_pwa_assets(self):
        archive = zipped(tar([("index.html", b"html", tarfile.REGTYPE)]))
        with self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))

    def test_rejects_too_many_tar_entries(self):
        archive = zipped()
        with patch.object(safety, "MAX_FILES", 2), self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))

    def test_rejects_oversized_tar(self):
        archive = zipped()
        with patch.object(safety, "MAX_TAR", 10), self.assertRaises(safety.Refused):
            safety.read_bundle(archive, digest(archive))


class WorkflowTests(unittest.TestCase):
    def test_both_jobs_refuse_reruns(self):
        workflow = (Path(__file__).parent.parent / ".github/workflows/rollback-pages.yml").read_text()
        for job in ("prepare", "deploy_pages"):
            block = workflow.split("  " + job + ":\n", 1)[1].split("\n  deploy_pages:", 1)[0]
            self.assertRegex(block, r"(?m)^    if: .*github\.run_attempt == 1$")

    def test_script_refuses_rerun_before_reading_event_or_network(self):
        with patch.dict("os.environ", {"GITHUB_RUN_ATTEMPT": "2"}, clear=True), self.assertRaises(safety.Refused):
            safety.main()

    def test_only_pages_deploy_has_write_permissions(self):
        workflow = (Path(__file__).parent.parent / ".github/workflows/rollback-pages.yml").read_text()
        prepare, deploy = workflow.split("  deploy_pages:\n", 1)
        self.assertNotIn(": write", prepare)
        self.assertEqual(re.findall(r"(?m)^      (\S+): write$", deploy), ["pages", "id-token"])
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("firebase-production", workflow)


class PreparationTests(unittest.TestCase):
    def fixture(self):
        archive = zipped()
        artifact = dict(ARTIFACT, digest=digest(archive), size_in_bytes=len(archive))
        responses = {"/git/ref/heads/main": {"object": {"sha": CURRENT}},
                     "/actions/workflows/deploy-pages.yml": WORKFLOW,
                     "/actions/runs/123": RUN, f"/compare/{SHA}...{CURRENT}": {"status": "ahead"},
                     "/actions/runs/123/attempts/1/jobs?per_page=100": JOBS,
                     f"/git/trees/{SHA}?recursive=1": TREE, f"/git/trees/{CURRENT}?recursive=1": TREE,
                     "/actions/runs/123/artifacts?per_page=100": {"total_count": 1, "artifacts": [artifact]},
                     "/actions/artifacts/45": artifact}
        class API:
            def get(self, path):
                return responses[path]
            def archive(self, artifact_id):
                assert artifact_id == 45
                return archive
        return API(), responses

    def test_full_prepare_preserves_bytes(self):
        api, _ = self.fixture()
        artifact, bundle = safety.prepare(api, 123, SHA, CURRENT)
        self.assertEqual(artifact["id"], 45)
        self.assertEqual(bundle, tar())

    def test_refuses_stale_main(self):
        api, responses = self.fixture()
        responses["/git/ref/heads/main"] = {"object": {"sha": "c" * 40}}
        with self.assertRaises(safety.Refused):
            safety.prepare(api, 123, SHA, CURRENT)

    def test_refuses_nonancestor(self):
        api, responses = self.fixture()
        responses[f"/compare/{SHA}...{CURRENT}"] = {"status": "diverged"}
        with self.assertRaises(safety.Refused):
            safety.prepare(api, 123, SHA, CURRENT)

    def test_refuses_missing_or_incomplete_artifact_list(self):
        for result in [{"total_count": 0, "artifacts": []}, {"total_count": 101, "artifacts": []}]:
            api, responses = self.fixture()
            responses["/actions/runs/123/artifacts?per_page=100"] = result
            with self.assertRaises(safety.Refused):
                safety.prepare(api, 123, SHA, CURRENT)

    def test_storage_request_has_no_token(self):
        location = "https://example.blob.core.windows.net/bundle?signature=opaque"
        redirect = urllib.error.HTTPError("https://api.github.com", 302, "redirect", {"Location": location}, None)
        with patch.dict("os.environ", {"GH_TOKEN": "synthetic-test-token"}), patch.object(safety, "request", side_effect=[redirect, b"zip"]) as request:
            self.assertEqual(safety.GitHub().archive(45), b"zip")
            self.assertEqual(request.call_args_list[1].args, (location,))
            self.assertEqual(request.call_args_list[1].kwargs, {"binary": True})

    def test_rejects_unexpected_redirect(self):
        for location in ["http://example.blob.core.windows.net/a", "https://evil.test/a", "https://user@example.blob.core.windows.net/a"]:
            redirect = urllib.error.HTTPError("https://api.github.com", 302, "redirect", {"Location": location}, None)
            with patch.dict("os.environ", {"GH_TOKEN": "synthetic-test-token"}), patch.object(safety, "request", side_effect=redirect), self.assertRaises(safety.Refused):
                safety.GitHub().archive(45)

    def test_no_automatic_redirects(self):
        self.assertIsNone(safety.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))


if __name__ == "__main__":
    unittest.main()
