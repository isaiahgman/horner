"""Offline adversarial tests. No GitHub/Google connection or credentials required."""
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

import qa_preview as qa

COMMIT = "a" * 40
REPOSITORY = {"id": qa.REPO_ID, "full_name": qa.REPO}
WORKFLOW = {"id": 456, "path": qa.BUILD_PATH}
PR = {"number": 12, "state": "open", "merged": False, "labels": [{"name": "qa-preview"}],
      "head": {"sha": COMMIT, "repo": REPOSITORY}, "base": {"ref": "main", "repo": REPOSITORY}}
RUN = {"id": 987, "run_attempt": 1, "repository": REPOSITORY, "head_repository": REPOSITORY,
       "event": "pull_request", "head_sha": COMMIT, "path": qa.BUILD_PATH, "workflow_id": 456,
       "status": "completed", "conclusion": "success", "pull_requests": [{"number": 12}],
       "run_started_at": "2026-10-02T00:00:00Z"}
ARTIFACT = {"id": 111, "name": f"qa-preview-12-{COMMIT}", "expired": False,
            "size_in_bytes": 1000, "digest": "sha256:" + "b" * 64, "created_at": "2026-10-02T00:01:00Z",
            "workflow_run": {"id": 987, "head_sha": COMMIT, "repository_id": qa.REPO_ID, "head_repository_id": qa.REPO_ID}}
CONFIG = {"enabled": True, "QA_PROJECT_ID": "horner-isolated-qa", "QA_PROJECT_NUMBER": "123456789",
          "QA_SITE_ID": "horner-isolated-qa", "QA_SERVICE_ACCOUNT": "qa-publisher@horner-isolated-qa.iam.gserviceaccount.com",
          "QA_WORKLOAD_IDENTITY_PROVIDER": "projects/123456789/locations/global/workloadIdentityPools/qa/providers/github"}
FILES = {"index.html": b'<!doctype html><html><head><script type="module" src="./assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>',
         "assets/app-abc123.js": b'console.log("synthetic QA")',
         "qa-build.json": json.dumps({"schema": 1, "mode": "qa", "commit": COMMIT, "pr": 12}).encode()}


def archive(files=None, extras=()):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, content in (files or FILES).items():
            bundle.writestr(name, content)
        for name, content, mode in extras:
            entry = zipfile.ZipInfo(name)
            entry.external_attr = mode << 16
            bundle.writestr(entry, content)
    return buffer.getvalue()


def read(data):
    return qa.read_archive(data, 12, COMMIT, "sha256:" + hashlib.sha256(data).hexdigest())


class ProvenanceTests(unittest.TestCase):
    def test_valid_pr_run_and_artifact(self):
        qa.validate_pr(PR, COMMIT)
        qa.validate_run(RUN, WORKFLOW, COMMIT, 12)
        qa.validate_artifact(ARTIFACT, RUN, 12, COMMIT)

    def test_closed_merged_unlabeled_rebased_and_fork_prs(self):
        mutations = [("state", "closed"), ("merged", True), ("labels", []), ("number", True),
                     ("head", {"repo": REPOSITORY, "sha": "b" * 40}),
                     ("head", {"repo": {"id": 999, "full_name": "attacker/horner"}, "sha": COMMIT}),
                     ("base", {"repo": REPOSITORY, "ref": "elsewhere"})]
        for key, value in mutations:
            with self.subTest(key=key, value=value), self.assertRaises(qa.Refused):
                qa.validate_pr({**PR, key: value}, COMMIT)

    def test_sha_must_be_exact_lowercase_40_hex(self):
        for sha in ("main", "a" * 12, "A" * 40, COMMIT + "\n", "x" * 40):
            with self.subTest(sha=sha), self.assertRaises(qa.Refused):
                qa.validate_pr(PR, sha)

    def test_reject_wrong_run_provenance(self):
        mutations = {"event": "pull_request_target", "path": ".github/workflows/evil.yml",
                     "workflow_id": 100, "head_sha": "b" * 40, "status": "in_progress",
                     "conclusion": "skipped", "pull_requests": [{"number": 13}], "run_attempt": 0,
                     "head_repository": {"id": 999, "full_name": qa.REPO}, "repository": {}}
        for key, value in mutations.items():
            with self.subTest(key=key), self.assertRaises(qa.Refused):
                qa.validate_run({**RUN, key: value}, WORKFLOW, COMMIT, 12)

    def test_reject_wrong_artifact_provenance(self):
        mutations = {"id": -1, "name": "qa-preview-12-old", "expired": True,
                     "size_in_bytes": qa.MAX_ARCHIVE + 1, "digest": "", "created_at": "2026-10-01T00:00:00Z"}
        for key, value in mutations.items():
            with self.subTest(key=key), self.assertRaises(qa.Refused):
                qa.validate_artifact({**ARTIFACT, key: value}, RUN, 12, COMMIT)
        for key, value in {"id": 1, "head_sha": "b" * 40, "repository_id": 1, "head_repository_id": 2}.items():
            item = copy.deepcopy(ARTIFACT)
            item["workflow_run"][key] = value
            with self.subTest(key=key), self.assertRaises(qa.Refused):
                qa.validate_artifact(item, RUN, 12, COMMIT)

    def test_security_files_match_main_byte_identity(self):
        tree = {"truncated": False, "tree": [{"path": path, "sha": COMMIT, "type": "blob", "mode": "100644"} for path in qa.PROTECTED]}
        qa.validate_trees(tree, copy.deepcopy(tree))
        for index in range(len(tree["tree"])):
            changed = copy.deepcopy(tree)
            changed["tree"][index]["sha"] = "b" * 40
            with self.subTest(path=changed["tree"][index]["path"]), self.assertRaises(qa.Refused):
                qa.validate_trees(tree, changed)
        with self.assertRaises(qa.Refused):
            qa.validate_trees(tree, {"tree": []})
        with self.assertRaises(qa.Refused):
            qa.validate_trees(tree, {**tree, "truncated": True})

    def test_latest_check_must_succeed_not_old_green(self):
        class API:
            def get(self, path):
                if path.endswith(".yml"):
                    return WORKFLOW
                return {"total_count": 2, "workflow_runs": [RUN, {**RUN, "id": 988, "conclusion": "failure"}]}
        self.assertIsNone(qa.successful_run(API(), qa.BUILD_PATH, COMMIT, 12, "Build isolated QA preview"))

    def test_required_job_cannot_be_skipped_inside_green_run(self):
        class API:
            def get(self, path):
                if path.endswith(".yml"):
                    return WORKFLOW
                if "/jobs?" in path:
                    return {"total_count": 1, "jobs": [{"name": "Build isolated QA preview", "conclusion": "skipped"}]}
                return {"total_count": 1, "workflow_runs": [RUN]}
        with self.assertRaises(qa.Refused):
            qa.successful_run(API(), qa.BUILD_PATH, COMMIT, 12, "Build isolated QA preview")


class ConfigTests(unittest.TestCase):
    def test_disabled_configuration_makes_no_network_calls(self):
        with patch.dict(os.environ, {"QA_PREVIEWS_ENABLED": "false"}), patch.object(qa, "request") as network:
            with self.assertRaises(qa.Refused):
                qa.gate()
            network.assert_not_called()

    def test_valid_config_and_double_opt_in(self):
        self.assertEqual(CONFIG, qa.validate_config(CONFIG, "true"))
        for switch in (None, "false", "TRUE", "1"):
            with self.subTest(switch=switch), self.assertRaises(qa.Refused):
                qa.validate_config(CONFIG, switch)
        with self.assertRaises(qa.Refused):
            qa.validate_config({**CONFIG, "enabled": False}, "true")

    def test_no_production_fallback_or_cross_project_identity(self):
        for key, values in {
            "QA_PROJECT_ID": ["", "horner-next-ten-isaiah", "production"],
            "QA_SITE_ID": ["", "horner-next-ten-isaiah", "site/../../prod"],
            "QA_PROJECT_NUMBER": ["", "331301995758"],
            "QA_WORKLOAD_IDENTITY_PROVIDER": ["", CONFIG["QA_WORKLOAD_IDENTITY_PROVIDER"].replace("123456789", "999999999")],
            "QA_SERVICE_ACCOUNT": ["", "prod@horner-next-ten-isaiah.iam.gserviceaccount.com"],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(qa.Refused):
                    qa.validate_config({**CONFIG, key: value}, "true")

    def test_http_headers_enforce_boundaries_without_redirects_or_rewrites(self):
        self.assertEqual(set(qa.HOSTING_CONFIG), {"headers"})
        headers = qa.HOSTING_CONFIG["headers"][0]["headers"]
        for rule in ("default-src 'self'", "connect-src 'self'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"):
            self.assertIn(rule, headers["Content-Security-Policy"])
        self.assertNotIn("https:", headers["Content-Security-Policy"])
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")


class ArtifactTests(unittest.TestCase):
    def test_valid_static_archive(self):
        self.assertEqual(read(archive()), FILES)

    def test_digest_mismatch(self):
        with self.assertRaises(qa.Refused):
            qa.read_archive(archive(), 12, COMMIT, "sha256:" + "0" * 64)

    def test_refuses_wrong_metadata_or_missing_index(self):
        for files in ({k: v for k, v in FILES.items() if k != "index.html"},
                      {**FILES, "qa-build.json": b'{"schema":1,"mode":"production"}'},
                      {**FILES, "qa-build.json": json.dumps({"schema": 1, "mode": "qa", "commit": "b" * 40, "pr": 12}).encode()}):
            with self.assertRaises(qa.Refused):
                read(archive(files))

    def test_refuses_paths_configuration_maps_sources_and_executables(self):
        for name in ("../index.html", "/index.html", "assets/../index.html", "assets\\evil.js", "./index.html",
                     ".npmrc", ".firebaserc", "firebase.json", "package.json", "assets/app.js.map", "src/App.tsx", "run.sh"):
            with self.subTest(name=name), self.assertRaises(qa.Refused):
                read(archive(extras=[(name, b"x", stat.S_IFREG | 0o644)]))

    def test_refuses_symlink_fifo_and_executable_files(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o644, stat.S_IFREG | 0o755):
            with self.subTest(mode=mode), self.assertRaises(qa.Refused):
                read(archive(extras=[("assets/evil.js", b"/etc/passwd", mode)]))

    def test_refuses_duplicate_names(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            data = archive(extras=[("index.html", b"bad", stat.S_IFREG | 0o644)])
        with self.assertRaises(qa.Refused):
            read(data)

    def test_refuses_large_archive_file_count_and_expansion(self):
        with patch.object(qa, "MAX_ARCHIVE", 4), self.assertRaises(qa.Refused):
            read(archive())
        with patch.object(qa, "MAX_FILES", 2), self.assertRaises(qa.Refused):
            read(archive())
        with patch.object(qa, "MAX_TOTAL", 4), self.assertRaises(qa.Refused):
            read(archive())
        with patch.object(qa, "MAX_FILE", 4), self.assertRaises(qa.Refused):
            read(archive())
        with self.assertRaises(qa.Refused):
            read(archive({**FILES, "assets/bomb.js": b"A" * (3 * 1024 * 1024)}))

    def test_rejects_all_production_and_cloud_markers(self):
        for marker in qa.BLOCKED:
            with self.subTest(marker=marker), self.assertRaises(qa.Refused):
                qa.validate_file("assets/evil.js", f'const x="{marker}"'.encode())

    def test_rejects_external_resources_in_every_text_format(self):
        for name, text in (
            ("index.html", '<div id="root"></div><img src="https://evil.example/leak">'),
            ("index.html", '<div id="root"></div><script type="module" src="&#104;ttps://evil.example/leak"></script>'),
            ("assets/evil.css", 'a{background:url(//evil.example/leak)}'),
            ("assets/evil.js", 'fetch("https://evil.example/leak")'),
            ("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.example/leak"/></svg>'),
            ("manifest.webmanifest", '{"start_url":"https://evil.example/"}'),
        ):
            with self.subTest(name=name), self.assertRaises(qa.Refused):
                qa.validate_file(name, text.encode())

    def test_rejects_active_html_svg_and_css(self):
        for fragment in ('<iframe src="./a"></iframe>', '<form></form>', '<base href="./">',
                         '<script>alert(1)</script>', '<img src="a" onerror="alert(1)">',
                         '<meta http-equiv="refresh" content="0; url=./a">', '<a href="javascript:alert(1)">go</a>'):
            with self.subTest(fragment=fragment), self.assertRaises(qa.Refused):
                qa.validate_file("index.html", ('<div id="root"></div>' + fragment).encode())
        with self.assertRaises(qa.Refused):
            qa.validate_file("icon.svg", b'<svg><script>alert(1)</script></svg>')
        with self.assertRaises(qa.Refused):
            qa.validate_file("assets/evil.css", b'@import "./style.css";')

    def test_bible_navigation_and_inert_diagnostics_are_not_resource_grants(self):
        qa.validate_file("assets/app.js", b'const a="https://www.esv.org/";const b="https://react.dev/errors/";const c="http://www.w3.org/2000/svg";')
        with self.assertRaises(qa.Refused):
            qa.validate_file("index.html", b'<div id="root"></div><script type="module" src="https://react.dev/errors/"></script>')

    def test_no_archive_auth_forwarding(self):
        redirect = urllib.error.HTTPError("https://api.github.com", 302, "Found", {"Location": "https://example.blob.core.windows.net/file?secret=x"}, None)
        with patch.dict(os.environ, {"GH_TOKEN": "test-token"}), patch.object(qa, "request", side_effect=[redirect, b"zip"]) as call:
            self.assertEqual(qa.GitHub().archive(123), b"zip")
            self.assertEqual(call.call_args_list[0].args[1], "test-token")
            self.assertEqual(len(call.call_args_list[1].args), 1)

    def test_reject_unexpected_artifact_redirect(self):
        for url in ("http://x.blob.core.windows.net/", "https://evil.example/file", "https://evilblob.core.windows.net/", "https://name@x.blob.core.windows.net/"):
            redirect = urllib.error.HTTPError("https://api.github.com", 302, "Found", {"Location": url}, None)
            with self.subTest(url=url), patch.dict(os.environ, {"GH_TOKEN": "test-token"}), patch.object(qa, "request", side_effect=redirect), self.assertRaises(qa.Refused):
                qa.GitHub().archive(123)


class DeploymentTests(unittest.TestCase):
    def test_publisher_only_releases_expected_channel_after_final_recheck(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp) / "horner-qa-test"
            (stage / "public" / "assets").mkdir(parents=True)
            for name, body in FILES.items():
                (stage / "public" / name).write_bytes(body)
            state = {"sha": COMMIT, "number": 12, "run_id": RUN["id"], "artifact_id": ARTIFACT["id"],
                     "digest": ARTIFACT["digest"], "files": {n: hashlib.sha256(b).hexdigest() for n, b in FILES.items()}}
            (stage / "state.json").write_text(json.dumps(state))
            channel = f"sites/horner-isolated-qa/channels/pr-12-{COMMIT[:12]}"
            version = "sites/horner-isolated-qa/versions/newversion"
            channel_info = {"name": channel, "expireTime": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
                            "url": f"https://horner-isolated-qa--pr-12-{COMMIT[:12]}-random.web.app"}
            calls = []
            def fake_request(url, token=None, method="GET", body=None, **kwargs):
                calls.append((url, method, body))
                if "/projects/horner-isolated-qa/sites/" in url:
                    return {"name": "projects/123456789/sites/horner-isolated-qa", "defaultUrl": "https://horner-isolated-qa.web.app"}
                if url.endswith(channel):
                    if len([c for c in calls if c[0].endswith(channel)]) == 1:
                        raise urllib.error.HTTPError(url, 404, "Missing", {}, None)
                    return channel_info
                if "/channels?channelId=" in url:
                    self.assertEqual(body["ttl"], "604800s")
                    return channel_info
                if url.endswith("/versions"):
                    self.assertEqual(body, {"config": qa.HOSTING_CONFIG})
                    return {"name": version}
                if url.endswith(":populateFiles"):
                    self.assertEqual(set(body["files"]), {"/" + n for n in FILES})
                    return {"uploadUrl": "https://upload-firebasehosting.googleapis.com/upload/" + version + "/files", "uploadRequiredHashes": []}
                if url.endswith("?updateMask=status"):
                    return {"status": "FINALIZED"}
                if "/releases?versionName=" in url:
                    return {}
                self.fail("Unexpected endpoint " + url)
            env = {"QA_STAGE": str(stage), "RUNNER_TEMP": temp, "QA_GOOGLE_ACCESS_TOKEN": "test-google-token", "GITHUB_STEP_SUMMARY": str(Path(temp) / "summary")}
            with patch.dict(os.environ, env), patch.object(qa, "load_config", return_value=CONFIG), patch.object(qa, "GitHub") as github, patch.object(qa, "eligibility", return_value=RUN) as gate, patch.object(qa, "request", side_effect=fake_request):
                github.return_value.get.return_value = ARTIFACT
                qa.publish()
                self.assertEqual(gate.call_count, 2)
            releases = [url for url, method, _ in calls if "/releases?" in url]
            self.assertEqual(len(releases), 1)
            self.assertIn(channel + "/releases?", releases[0])
            self.assertFalse(any("/channels/live" in url for url, _, _ in calls))
            self.assertIn(COMMIT, (Path(temp) / "summary").read_text())


class UploadAndRaceTests(unittest.TestCase):
    def exercise(self, mutation=None):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp) / 'horner-qa-review'
            (stage / 'public' / 'assets').mkdir(parents=True)
            for name, body in FILES.items():
                (stage / 'public' / name).write_bytes(body)
            state = {'sha':COMMIT,'number':12,'run_id':RUN['id'],'artifact_id':ARTIFACT['id'],'digest':ARTIFACT['digest'],'files':{n:hashlib.sha256(b).hexdigest() for n,b in FILES.items()}}
            (stage/'state.json').write_text(json.dumps(state))
            if mutation == 'stage_tampered':
                (stage/'public'/'assets'/'app-abc123.js').write_bytes(b'changed')
            channel = f'sites/horner-isolated-qa/channels/pr-12-{COMMIT[:12]}'
            version = 'sites/horner-isolated-qa/versions/newversion'
            channel_info = {'name':channel,'labels':{'commit':COMMIT,'pr':'12'},'expireTime':(datetime.now(timezone.utc)+timedelta(days=7)).isoformat(),'url':f'https://horner-isolated-qa--pr-12-{COMMIT[:12]}-random.web.app'}
            calls = []
            upload_bodies = []
            by_hash = {hashlib.sha256(gzip.compress(b,mtime=0)).hexdigest():b for b in FILES.values()}
            def request(url,token=None,method='GET',body=None,**kwargs):
                calls.append((url,token,method,body))
                self.assertEqual(token,'fake-google-token')
                if '/projects/horner-isolated-qa/sites/' in url:
                    return {'name':'projects/123456789/sites/horner-isolated-qa','defaultUrl':'https://horner-isolated-qa.web.app'}
                if url.endswith(channel):
                    if len([c for c in calls if c[0].endswith(channel)]) == 1:
                        if mutation == 'existing': return {**channel_info,'release':{'name':'existing'}}
                        if mutation == 'collision': return {**channel_info,'labels':{'commit':'b'*40,'pr':'12'}}
                        raise urllib.error.HTTPError(url,404,'missing',{},None)
                    return channel_info
                if '/channels?channelId=' in url: return channel_info
                if url.endswith('/versions'): return {'name':version}
                if url.endswith(':populateFiles'):
                    return {'uploadUrl':('https://evil.example/upload' if mutation == 'wrong_upload_url' else 'https://upload-firebasehosting.googleapis.com/upload/'+version+'/files'), 'uploadRequiredHashes':(['0'*64] if mutation == 'wrong_upload_hash' else list(by_hash))}
                if '/upload/' in url:
                    self.assertEqual(method,'POST')
                    self.assertTrue(kwargs.get('binary'))
                    digest = url.rsplit('/',1)[1]
                    self.assertEqual(hashlib.sha256(body).hexdigest(),digest)
                    self.assertEqual(gzip.decompress(body),by_hash[digest])
                    upload_bodies.append(body)
                    return b''
                if url.endswith('?updateMask=status'): return {'status':'FINALIZED'}
                if '/releases?versionName=' in url: return {}
                self.fail('Unexpected destination '+url)
            call_no = 0
            def eligible(*args):
                nonlocal call_no
                call_no += 1
                if call_no == 2:
                    if mutation == 'new_run': return {**RUN,'id':RUN['id']+1}
                    if mutation == 'running_check': return None
                    if mutation in ('unlabeled','closed','new_head'):
                        pr=copy.deepcopy(PR)
                        if mutation == 'unlabeled': pr['labels']=[]
                        if mutation == 'closed': pr['state']='closed'
                        if mutation == 'new_head': pr['head']['sha']='b'*40
                        qa.validate_pr(pr,COMMIT)
                return RUN
            env={'QA_STAGE':str(stage),'RUNNER_TEMP':temp,'QA_GOOGLE_ACCESS_TOKEN':'fake-google-token','GITHUB_STEP_SUMMARY':str(Path(temp)/'summary')}
            rejected = mutation not in (None,'existing')
            with patch.dict(os.environ,env),patch.object(qa,'load_config',return_value=CONFIG),patch.object(qa,'GitHub') as github,patch.object(qa,'eligibility',side_effect=eligible),patch.object(qa,'request',side_effect=request):
                github.return_value.get.return_value=ARTIFACT
                if rejected:
                    with self.assertRaises(qa.Refused): qa.publish()
                else: qa.publish()
            releases=[c for c in calls if '/releases?' in c[0]]
            self.assertEqual(len(releases),0 if rejected or mutation=='existing' else 1)
            if mutation is None: self.assertEqual(len(upload_bodies),len(by_hash))
            if mutation in ('stage_tampered',): self.assertEqual(calls,[])
            if mutation=='existing': self.assertFalse(any(c[2]!='GET' for c in calls))
            if mutation in ('wrong_upload_url','wrong_upload_hash'): self.assertEqual(upload_bodies,[])

    def test_upload_bytes_and_exact_channel(self): self.exercise()
    def test_stale_or_unlabeled_during_upload_refuses_release(self):
        for condition in ('new_run','running_check','unlabeled','closed','new_head'):
            with self.subTest(condition=condition): self.exercise(condition)
    def test_unsafe_upload_destination_hash_or_stage(self):
        for condition in ('stage_tampered','wrong_upload_url','wrong_upload_hash'):
            with self.subTest(condition=condition): self.exercise(condition)
    def test_existing_channel_and_collision(self):
        for condition in ('existing','collision'):
            with self.subTest(condition=condition): self.exercise(condition)


class WorkflowTests(unittest.TestCase):
    def test_credentials_are_only_in_default_branch_publisher_after_gate(self):
        root = Path(__file__).resolve().parent.parent
        build = (root / qa.BUILD_PATH).read_text()
        publish = (root / qa.PUBLISH_PATH).read_text()
        self.assertNotIn("pull_request_target:", build + publish)
        self.assertNotIn("secrets.", build + publish)
        self.assertNotIn("id-token:", build)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha }}", build)
        self.assertIn("ref: ${{ github.workflow_sha }}", publish)
        self.assertIn("persist-credentials: false", build)
        self.assertIn("persist-credentials: false", publish)
        self.assertLess(publish.index("scripts/qa_preview.py gate"), publish.index("uses: google-github-actions/auth@"))
        verify = (root / qa.VERIFY_PATH).read_text()
        self.assertIn("name: Verify proposed changes", verify)
        self.assertIn("python3 -I -m unittest discover", verify)
        self.assertIn("scripts/qa_preview.py check-dir dist-qa", verify)
        self.assertIn("queue: max", publish)
        self.assertIn("cancel-in-progress: false", publish)
        self.assertNotIn("npm ci", publish)
        self.assertNotIn("firebase deploy", publish)
        self.assertIn("QA_PREVIEWS_ENABLED == 'true'", publish)
        self.assertIn("steps.gate.outputs.ready == 'true'", publish)
        import re
        for action in re.findall(r"uses: ([^\s]+)", build + publish):
            self.assertRegex(action, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
