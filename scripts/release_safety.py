#!/usr/bin/env python3
"""Prepare a previously deployed Pages bundle; never execute it or access Firebase."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "isaiahgman/horner"
REPO_ID = 1322404505
PRODUCTION = ".github/workflows/deploy-pages.yml"
ROLLBACK = ".github/workflows/rollback-pages.yml"
SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_ZIP = 8 * 1024 * 1024
MAX_TAR = 16 * 1024 * 1024
MAX_FILES = 256
REQUIRED_JOBS = {"Verify production build", "Deploy Firestore rules", "Deploy GitHub Pages"}
REQUIRED_DATA = {"firestore.rules", "src/data/database.ts", "src/data/cloud-codec.ts",
                 "src/domain/state.ts", "src/domain/backup.ts", "src/domain/lists.ts"}


class Refused(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Refused(message)


def positive(value):
    return type(value) is int and value > 0


def identity(repo):
    return isinstance(repo, dict) and repo.get("id") == REPO_ID and repo.get("full_name") == REPO


def validate_run(run, workflow, run_id, sha):
    require(identity(run.get("repository")) and identity(run.get("head_repository")), "Wrong source repository")
    require(run.get("id") == run_id and positive(run_id) and positive(run.get("run_attempt")), "Wrong source run")
    require(SHA.fullmatch(sha) and run.get("head_sha") == sha, "Expected full source commit SHA does not match")
    require(run.get("head_branch") == "main" and run.get("event") in {"push", "workflow_dispatch"}, "Source must be a main production run")
    require(workflow.get("path") == PRODUCTION and positive(workflow.get("id"))
            and run.get("workflow_id") == workflow["id"] and run.get("path") == PRODUCTION, "Wrong source workflow")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Source production run must have succeeded")


def validate_jobs(result):
    require(type(result.get("total_count")) is int and result["total_count"] == len(result.get("jobs", [])) <= 100, "Incomplete job list")
    for name in REQUIRED_JOBS:
        jobs = [job for job in result["jobs"] if job.get("name") == name]
        require(len(jobs) == 1 and jobs[0].get("status") == "completed" and jobs[0].get("conclusion") == "success", "Source did not pass " + name)


def validate_artifact(artifact, run):
    require(positive(artifact.get("id")) and artifact.get("name") == "github-pages", "Wrong artifact identity")
    require(artifact.get("expired") is False, "Source artifact has expired; use a reviewed forward fix")
    require(positive(artifact.get("size_in_bytes")) and artifact["size_in_bytes"] <= MAX_ZIP, "Artifact is too large")
    source = artifact.get("workflow_run", {})
    require(source.get("id") == run["id"] and source.get("head_sha") == run["head_sha"]
            and source.get("head_branch") == "main" and source.get("repository_id") == REPO_ID
            and source.get("head_repository_id") == REPO_ID, "Artifact provenance mismatch")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", "")), "Artifact has no SHA-256 digest")


def validate_data_boundary(current, previous):
    """Conservative barrier, not a substitute for reviewing compatibility."""
    def files(tree):
        require(tree.get("truncated") is False and isinstance(tree.get("tree"), list), "Incomplete source tree")
        return {entry["path"]: (entry.get("sha"), entry.get("type"), entry.get("mode"))
                for entry in tree["tree"] if entry.get("type") != "tree" and
                (entry["path"] == "firestore.rules" or
                 (entry["path"].startswith(("src/data/", "src/domain/")) and ".test." not in entry["path"]))}
    left, right = files(current), files(previous)
    require(REQUIRED_DATA <= left.keys() and REQUIRED_DATA <= right.keys(), "Missing data boundary files")
    require(left == right, "Data, reading-engine, or rules code changed; use a reviewed forward fix instead of automatic rollback")
    require(all(kind == "blob" and mode == "100644" and SHA.fullmatch(sha or "")
                for sha, kind, mode in left.values()), "Unsafe data boundary tree")


def read_bundle(data, digest):
    require(len(data) <= MAX_ZIP and "sha256:" + hashlib.sha256(data).hexdigest() == digest, "Archive digest mismatch or size exceeded")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) == 1 and entries[0].filename == "artifact.tar", "Expected exactly artifact.tar")
        entry = entries[0]
        require(0 < entry.file_size <= MAX_TAR and not entry.flag_bits & 1, "Invalid tar size or encrypted ZIP")
        require(stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG), "ZIP entry is not a regular file")
        bundle = archive.read(entry)
    names, total = set(), 0
    with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:") as archive:
        for count, entry in enumerate(archive, 1):
            require(count <= MAX_FILES, "Too many files in Pages bundle")
            raw = entry.name
            require("\\" not in raw and not raw.startswith("/") and ".." not in PurePosixPath(raw).parts, "Unsafe tar path")
            name = str(PurePosixPath(raw))
            require(entry.isdir() or entry.isfile(), "Links and special files are prohibited")
            if entry.isdir():
                continue
            require(name not in names and name != "." and not any(part.startswith(".") for part in PurePosixPath(name).parts), "Duplicate or hidden tar file")
            require(PurePosixPath(name).suffix in {".html", ".js", ".css", ".svg", ".png", ".ico", ".webmanifest", ".json", ".txt"}, "Unexpected non-static file")
            total += entry.size
            require(0 <= entry.size <= MAX_TAR and total <= MAX_TAR, "Expanded bundle too large")
            names.add(name)
    require({"index.html", "sw.js", "manifest.webmanifest"} <= names, "Incomplete production PWA bundle")
    # Preserve the exact tar bytes, including PWA assets. Never extract or execute.
    return bundle


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def request(url, token=None, binary=False):
    headers = {"User-Agent": "horner-release-safety", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    with HTTP.open(urllib.request.Request(url, headers=headers), timeout=45) as response:
        data = response.read(MAX_ZIP + 1)
    require(len(data) <= MAX_ZIP, "Response exceeds size limit")
    return data if binary else json.loads(data)


class GitHub:
    def __init__(self):
        self.token = os.environ["GH_TOKEN"]

    def get(self, path):
        require(path.startswith("/") and not path.startswith("//"), "Invalid API path")
        return request("https://api.github.com/repos/" + REPO + path, self.token)

    def archive(self, artifact_id):
        require(positive(artifact_id), "Invalid artifact ID")
        try:
            request(f"https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip", self.token, binary=True)
        except urllib.error.HTTPError as error:
            require(error.code == 302, "Expected artifact redirect")
            url = error.headers["Location"]
            parsed = urllib.parse.urlsplit(url)
            require(parsed.scheme == "https" and parsed.username is None and parsed.port in (None, 443)
                    and parsed.hostname and any(parsed.hostname.endswith(suffix) for suffix in
                    (".blob.core.windows.net", ".actions.githubusercontent.com", ".githubusercontent.com")), "Unexpected artifact host")
            return request(url, binary=True)  # Never forward the GitHub token.
        raise Refused("Missing artifact redirect")


def prepare(api, run_id, sha, current_sha):
    require(SHA.fullmatch(current_sha), "Invalid current workflow commit")
    require(api.get("/git/ref/heads/main").get("object", {}).get("sha") == current_sha, "Main changed; review the new head and dispatch again")
    workflow = api.get("/actions/workflows/deploy-pages.yml")
    run = api.get(f"/actions/runs/{run_id}")
    validate_run(run, workflow, run_id, sha)
    comparison = api.get(f"/compare/{sha}...{current_sha}")
    require(comparison.get("status") in {"ahead", "identical"}, "Source is not an ancestor of current main")
    validate_jobs(api.get(f"/actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100"))
    validate_data_boundary(api.get(f"/git/trees/{current_sha}?recursive=1"), api.get(f"/git/trees/{sha}?recursive=1"))
    result = api.get(f"/actions/runs/{run_id}/artifacts?per_page=100")
    require(type(result.get("total_count")) is int and result["total_count"] == len(result.get("artifacts", [])) <= 100, "Incomplete artifact list")
    matches = [a for a in result["artifacts"] if a.get("name") == "github-pages"]
    require(len(matches) == 1, "Expected one retained production artifact")
    artifact = api.get(f"/actions/artifacts/{matches[0]['id']}")
    validate_artifact(artifact, run)
    bundle = read_bundle(api.archive(artifact["id"]), artifact["digest"])
    return artifact, bundle


def main():
    require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Start a fresh rollback dispatch; job/workflow reruns are not allowed")
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and os.environ.get("GITHUB_REPOSITORY") == REPO
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_WORKFLOW_REF") == f"{REPO}/{ROLLBACK}@refs/heads/main", "Rollback must be manually dispatched from main")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    require(identity(event.get("repository")), "Wrong dispatch repository")
    inputs = event.get("inputs", {})
    require(inputs.get("confirm") == "ROLLBACK" and inputs.get("compatibility_reviewed") == "true", "Confirm rollback and review compatibility first")
    value, sha = inputs.get("run_id", ""), inputs.get("commit_sha", "")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", value) and SHA.fullmatch(sha), "Provide a numeric run ID and full lowercase commit SHA")
    current_sha = os.environ["GITHUB_SHA"]
    require(os.environ.get("GITHUB_WORKFLOW_SHA") == current_sha, "Workflow must match the selected main commit")
    artifact, bundle = prepare(GitHub(), int(value), sha, current_sha)
    stage = Path(tempfile.mkdtemp(prefix="horner-rollback-", dir=os.environ["RUNNER_TEMP"]))
    target = stage / "artifact.tar"
    target.write_bytes(bundle)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"bundle={target}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
        output.write(f"## Selected frontend rollback\n\nSource: [{value}](https://github.com/{REPO}/actions/runs/{value})\n\n"
                     f"App commit: `{sha}`\n\nArtifact: `{artifact['id']}`\n\nZIP digest: `{artifact['digest']}`\n\n"
                     f"Tar digest: `{hashlib.sha256(bundle).hexdigest()}`\n\n"
                     "Only static Pages files are prepared. Firebase rules, documents, and local reading data are not restored. "
                     "The deployment record points to this current workflow commit; the app version is the source commit above.\n")


if __name__ == "__main__":
    try:
        main()
    except (Refused, KeyError, ValueError, OSError, zipfile.BadZipFile, tarfile.TarError) as error:
        print(f"Rollback refused: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
