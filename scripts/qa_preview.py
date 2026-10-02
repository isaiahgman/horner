#!/usr/bin/env python3
"""Fail-closed QA artifact gate/publisher. Standard library only; never runs PR code."""
import argparse
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "isaiahgman/horner"
REPO_ID = 1322404505
OWNER_ID = 92384661
BUILD_PATH = ".github/workflows/build-qa-preview.yml"
VERIFY_PATH = ".github/workflows/verify-pr.yml"
PUBLISH_PATH = ".github/workflows/publish-qa-preview.yml"
SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILES = 128
PROTECTED = (
    BUILD_PATH, VERIFY_PATH, PUBLISH_PATH, "firebase.qa.json",
    "scripts/qa_preview.py", "scripts/qa_preview_test.py",
    "vite.config.ts", "vite.qa.config.ts", "src/qa-preview.ts", "src/data/cloud-preview.ts",
    "playwright.qa.config.ts", "e2e/qa/preview.e2e.ts",
    "package.json", "package-lock.json",
)
CSP = ("default-src 'self'; connect-src 'self'; script-src 'self'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
       "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; "
       "form-action 'none'; base-uri 'none'; worker-src 'self'; manifest-src 'self'")
HOSTING_CONFIG = {"headers": [{"glob": "**", "headers": {
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control": "no-store",
}}]}
FIXED_FILES = {"index.html", "qa-build.json", "manifest.webmanifest", "icon.svg",
               "sw.js", "favicon.ico", "apple-touch-icon-180x180.png", "pwa-64x64.png",
               "pwa-192x192.png", "pwa-512x512.png", "maskable-icon-512x512.png"}
ASSET_PATH = re.compile(r"(?:assets/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css)|workbox-[A-Za-z0-9_-]+\.js)\Z")
BLOCKED = ("isaiahgathala@gmail.com", "horner-next-ten-isaiah", "isaiahgman.github.io", "331301995758",
           "AIzaSy", "firebaseapp.com", "firebaseio.com", "googleapis.com",
           "accounts.google.com", "apis.google.com", "@firebase", "firebase/auth",
           "firebase/firestore", "__FIREBASE_DEFAULTS__", "sourceMappingURL")
# Inert React diagnostics/XML namespaces and deliberate Bible navigation constants.
# These are not CSP subresource grants. No other external URL literals may ship.
JS_URL_PREFIXES = ("https://react.dev/errors/", "https://www.bible.com/bible/59/",
                   "https://www.esv.org/")
XML_URIS = ("http://www.w3.org/2000/svg", "http://www.w3.org/1998/Math/MathML",
            "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace",
            "http://www.w3.org/1999/xhtml")
JS_DIAGNOSTIC_URLS = ("https://bit.ly/wb-precache", "https://tinyurl.com/y2uuvskb", "http://bit.ly/2kdckMn")
URL_LITERAL = re.compile(r"(?:https?:|wss?:)?//[A-Za-z0-9][^\s\"'`<>\\)]+", re.IGNORECASE)


class Refused(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def positive(value):
    return type(value) is int and value > 0


def identity(repo):
    return (isinstance(repo, dict) and repo.get("id") == REPO_ID
            and repo.get("full_name") == REPO)


def validate_config(config, enabled):
    require(enabled == "true" and config.get("enabled") is True,
            "QA publication is disabled; reviewed configuration and opt-in are required")
    project, site = config.get("QA_PROJECT_ID", ""), config.get("QA_SITE_ID", "")
    for label, value in (("project", project), ("site", site)):
        require(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", value),
                f"Missing or invalid explicit QA {label}")
        require("qa" in value.split("-") and "horner-next-ten-isaiah" not in value,
                f"QA {label} must be explicitly QA-named and cannot be production")
    number = config.get("QA_PROJECT_NUMBER", "")
    require(isinstance(number, str) and re.fullmatch(r"[1-9][0-9]+", number) and number != "331301995758",
            "Missing/production project number")
    provider = config.get("QA_WORKLOAD_IDENTITY_PROVIDER", "")
    require(re.fullmatch(r"projects/" + number + r"/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+", provider),
            "Missing or invalid reviewed workload identity provider")
    account = config.get("QA_SERVICE_ACCOUNT", "")
    require(re.fullmatch(r"[a-z][a-z0-9-]+@" + re.escape(project) + r"\.iam\.gserviceaccount\.com", account),
            "Identity must belong only to the configured QA project")
    return config


def validate_pr(pr, sha):
    require(positive(pr.get("number")), "Invalid PR number")
    require(pr.get("state") == "open" and not pr.get("merged"), "PR is closed or merged")
    require(identity(pr.get("head", {}).get("repo")) and identity(pr.get("base", {}).get("repo")),
            "Fork/cross-repository previews are prohibited")
    require(pr.get("base", {}).get("ref") == "main", "PR must target main")
    require(bool(SHA.fullmatch(sha)) and pr.get("head", {}).get("sha") == sha,
            "PR head changed; refusing stale preview")
    require("qa-preview" in [x.get("name") for x in pr.get("labels", [])],
            "PR is no longer opted in with qa-preview")


def validate_run(run, workflow, sha, number):
    require(identity(run.get("repository")) and identity(run.get("head_repository")),
            "Run did not originate in the allowed repository")
    require(run.get("event") == "pull_request", "Run must be an unprivileged pull_request run")
    require(run.get("head_sha") == sha and SHA.fullmatch(sha), "Run SHA mismatch")
    require(run.get("path") == workflow["path"] and run.get("workflow_id") == workflow["id"],
            "Unexpected workflow identity/path")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "Run has not successfully completed")
    require(positive(run.get("id")) and positive(run.get("run_attempt")), "Invalid run identity")
    require(any(x.get("number") == number for x in run.get("pull_requests", [])),
            "Run is not associated with the opted-in PR")


def validate_artifact(artifact, run, number, sha):
    require(positive(artifact.get("id")), "Invalid artifact ID")
    require(artifact.get("name") == f"qa-preview-{number}-{sha}", "Artifact name mismatch")
    require(artifact.get("expired") is False, "Artifact expired")
    require(positive(artifact.get("size_in_bytes")) and artifact["size_in_bytes"] <= MAX_ARCHIVE,
            "Artifact exceeds archive bound")
    source = artifact.get("workflow_run", {})
    require(source.get("id") == run["id"] and source.get("head_sha") == sha
            and source.get("repository_id") == REPO_ID and source.get("head_repository_id") == REPO_ID,
            "Artifact run/repository/SHA provenance mismatch")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", "")),
            "Artifact lacks an immutable SHA-256 digest")
    require(artifact.get("created_at", "") >= run.get("run_started_at", "z"),
            "Artifact predates this run attempt")


def validate_trees(trusted, proposed):
    require(not trusted.get("truncated") and not proposed.get("truncated"), "Incomplete Git tree")
    def files(tree):
        return {x["path"]: (x.get("sha"), x.get("type"), x.get("mode")) for x in tree["tree"]}
    left, right = files(trusted), files(proposed)
    for path in PROTECTED:
        require(path in left and left[path][1:] == ("blob", "100644") and left[path] == right.get(path),
                f"Security/build file must first be reviewed on main: {path}")


def relative_url(value):
    parsed = urllib.parse.urlsplit(value)
    return not parsed.scheme and not parsed.netloc and not value.startswith("//") and "\\" not in value


class SafeHTML(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        require(tag not in {"iframe", "frame", "object", "embed", "base", "form"},
                f"Disallowed HTML element: {tag}")
        require(not any(k.startswith("on") or k in {"srcdoc", "ping", "srcset"} for k in attrs),
                "Inline/event/network HTML attributes are disallowed")
        for key in ("src", "href", "action", "data", "poster"):
            if key in attrs:
                require(relative_url(attrs[key] or ""), "External/active HTML URL")
        if tag == "script":
            require(bool(attrs.get("src")) and attrs.get("type") == "module", "Only external same-origin module scripts allowed")
        if tag == "meta":
            require(attrs.get("http-equiv", "").lower() != "refresh", "HTML refresh is disallowed")

    handle_startendtag = handle_starttag


def validate_file(name, data):
    require(name in FIXED_FILES or ASSET_PATH.fullmatch(name), f"File not on static allowlist: {name}")
    require(len(data) <= MAX_FILE, "File exceeds size bound")
    lowered = data.lower()
    for token in BLOCKED:
        require(token.lower().encode() not in lowered, f"Forbidden production/cloud/source-map marker in {name}")
    if name.endswith((".png", ".ico")):
        require(data.startswith(b"\x89PNG\r\n\x1a\n") if name.endswith(".png") else data.startswith(b"\x00\x00\x01\x00"),
                "Invalid static image signature")
        return
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise Refused("Text assets must be UTF-8") from error
    require("\x00" not in text, "NUL in text asset")
    for match in URL_LITERAL.finditer(text):
        url = match.group()
        allowed = url in XML_URIS or (name.endswith(".js") and (url.startswith(JS_URL_PREFIXES) or url in JS_DIAGNOSTIC_URLS))
        require(allowed, f"External URL literal in {name}: {url[:80]}")
    if name == "index.html":
        parser = SafeHTML(convert_charrefs=True)
        parser.feed(text)
        parser.close()
        require('<div id="root"' in text or "<div id='root'" in text, "Missing app root")
    if name.endswith(".svg"):
        require(not re.search(r"<(?:script|foreignObject|iframe)|\bon\w+\s*=|<!ENTITY|<!DOCTYPE", text, re.I),
                "Active SVG content")
        for value in re.findall(r'(?:href|src)\s*=\s*[\"\']([^\"\']*)', text, re.I):
            require(value.startswith("#"), "Nonlocal SVG reference")
    if name.endswith(".css"):
        require(not re.search(r"@import|expression\s*\(|-moz-binding", text, re.I), "Active CSS import")
        for value in re.findall(r"url\(\s*([^)]*)\)", text, re.I):
            require(relative_url(value.strip(" \"'")), "External CSS resource")
    if name.endswith(".webmanifest"):
        manifest = json.loads(text)
        require(set(manifest) <= {"name", "short_name", "description", "theme_color", "background_color", "display", "start_url", "scope", "icons", "id", "lang"},
                "Unexpected manifest capability")
        require(all(relative_url(manifest[k]) for k in ("start_url", "scope", "id") if k in manifest), "External manifest scope")
        require(all(relative_url(x["src"]) for x in manifest.get("icons", [])), "External manifest icon")


def validate_files(files, number, sha):
    require(0 < len(files) <= MAX_FILES and sum(map(len, files.values())) <= MAX_TOTAL,
            "Static file count/total bytes exceed bound")
    require("index.html" in files and "qa-build.json" in files, "Missing app/build metadata")
    for name, data in files.items():
        validate_file(name, data)
    require(json.loads(files["qa-build.json"]) == {"schema": 1, "mode": "qa", "commit": sha, "pr": number},
            "QA build metadata does not match current PR/SHA")
    return files


def read_archive(data, number, sha, digest):
    require(len(data) <= MAX_ARCHIVE, "Archive too large")
    require("sha256:" + hashlib.sha256(data).hexdigest() == digest, "Artifact digest mismatch")
    files, total = {}, 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(len(archive.infolist()) <= MAX_FILES, "Too many archive entries")
        for entry in archive.infolist():
            name = entry.filename
            require(not entry.is_dir() and not entry.flag_bits & 1, "Directories/encrypted entries disallowed")
            require(name == str(PurePosixPath(name)) and not name.startswith("/") and "\\" not in name
                    and all(p not in (".", "..") for p in name.split("/")), "Unsafe archive path")
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and not mode & 0o111, "Nonregular/executable archive entry")
            require(name not in files, "Duplicate archive entry")
            require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported compression")
            require(entry.file_size <= MAX_FILE and entry.file_size <= max(1, entry.compress_size) * 1000,
                    "Oversized/high-ratio archive member")
            total += entry.file_size
            require(total <= MAX_TOTAL, "Archive expands beyond bound")
            with archive.open(entry) as stream:
                body = stream.read(MAX_FILE + 1)
            require(len(body) == entry.file_size, "Archive member size mismatch")
            files[name] = body
    return validate_files(files, number, sha)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def request(url, token=None, method="GET", body=None, limit=MAX_ARCHIVE, binary=False):
    headers = {"User-Agent": "horner-qa-publisher", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
        if not binary:
            body = json.dumps(body).encode()
    with HTTP.open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=45) as response:
        data = response.read(limit + 1)
    require(len(data) <= limit, "HTTP response exceeds bound")
    return data if binary else (json.loads(data) if data else {})


class GitHub:
    def __init__(self):
        self.token = os.environ["GH_TOKEN"]

    def get(self, path):
        require(path.startswith("/") and not path.startswith("//"), "Invalid GitHub path")
        return request("https://api.github.com/repos/" + REPO + path, self.token)

    def archive(self, artifact_id):
        try:
            request(f"https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip", self.token, binary=True)
        except urllib.error.HTTPError as error:
            require(error.code == 302, "Expected GitHub artifact redirect")
            url = error.headers["Location"]
            parsed = urllib.parse.urlsplit(url)
            require(parsed.scheme == "https" and parsed.username is None and parsed.port in (None, 443)
                    and parsed.hostname and any(parsed.hostname.endswith(suffix) for suffix in
                    (".blob.core.windows.net", ".actions.githubusercontent.com", ".githubusercontent.com")),
                    "Unexpected artifact download host")
            # Crucially, never forward the GitHub token to the signed storage URL.
            return request(url, binary=True)
        raise Refused("Artifact download did not redirect")


def repository_snapshot(api, sha, number):
    pr = api.get(f"/pulls/{number}")
    validate_pr(pr, sha)
    trusted_sha = os.environ.get("GITHUB_WORKFLOW_SHA", "")
    require(SHA.fullmatch(trusted_sha or ""), "Missing trusted workflow SHA")
    require(os.environ.get("GITHUB_WORKFLOW_REF") == f"{REPO}/{PUBLISH_PATH}@refs/heads/main",
            "Publisher must execute reviewed main workflow")
    validate_trees(api.get(f"/git/trees/{trusted_sha}?recursive=1"), api.get(f"/git/trees/{sha}?recursive=1"))
    return pr


def successful_run(api, path, sha, number, job_name):
    workflow = api.get("/actions/workflows/" + path.rsplit("/", 1)[1])
    require(workflow.get("path") == path, "Unexpected registered workflow path")
    runs = api.get(f"/actions/workflows/{workflow['id']}/runs?event=pull_request&head_sha={sha}&per_page=100")
    require(runs.get("total_count", 101) <= 100, "Too many runs; cannot establish latest run")
    candidates = [r for r in runs["workflow_runs"] if any(p.get("number") == number for p in r.get("pull_requests", []))]
    if not candidates:
        return None
    run = max(candidates, key=lambda r: (r["id"], r["run_attempt"]))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        return None
    validate_run(run, workflow, sha, number)
    jobs = api.get(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
    require(jobs.get("total_count", 101) <= 100, "Incomplete job list")
    required = [j for j in jobs["jobs"] if j.get("name") == job_name]
    require(len(required) == 1 and required[0].get("conclusion") == "success", "Required job did not succeed")
    return run


def eligibility(api, sha, number):
    repository_snapshot(api, sha, number)
    verify = successful_run(api, VERIFY_PATH, sha, number, "Verify proposed changes")
    build = successful_run(api, BUILD_PATH, sha, number, "Build isolated QA preview")
    return build if verify else None


def output(values):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        for key, value in values.items():
            require("\n" not in str(value) and "\r" not in str(value), "Invalid workflow output")
            stream.write(f"{key}={value}\n")


def load_config():
    return validate_config(json.loads((Path(__file__).resolve().parent.parent / "firebase.qa.json").read_text()),
                           os.environ.get("QA_PREVIEWS_ENABLED"))


def gate():
    config = load_config()
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    require(identity(event.get("repository")) and event["repository"].get("default_branch") == "main",
            "Unexpected publisher repository/default branch")
    trigger = event["workflow_run"]
    require(trigger.get("path") in (BUILD_PATH, VERIFY_PATH), "Unexpected triggering workflow")
    require(trigger.get("event") == "pull_request" and trigger.get("conclusion") == "success", "Ineligible trigger")
    sha = trigger.get("head_sha", "")
    require(SHA.fullmatch(sha), "Invalid trigger SHA")
    prs = trigger.get("pull_requests", [])
    require(len(prs) == 1 and positive(prs[0].get("number")), "Trigger must identify exactly one PR")
    number = prs[0]["number"]
    api = GitHub()
    current_pr = api.get(f"/pulls/{number}")
    if current_pr.get("state") != "open" or "qa-preview" not in [label.get("name") for label in current_pr.get("labels", [])]:
        output({"ready": "false"})
        print("PR is not currently opted in; nothing will be published.")
        return
    run = eligibility(api, sha, number)
    if not run:
        output({"ready": "false"})
        print("Waiting for a successful current QA build and Verify proposed changes; the other workflow completion retriggers publication.")
        return
    result = api.get(f"/actions/runs/{run['id']}/artifacts?per_page=100")
    require(result.get("total_count", 101) <= 100, "Incomplete artifact list")
    matches = [a for a in result["artifacts"] if a.get("name") == f"qa-preview-{number}-{sha}"]
    require(len(matches) == 1, "Expected one exact artifact")
    artifact = api.get(f"/actions/artifacts/{matches[0]['id']}")
    validate_artifact(artifact, run, number, sha)
    files = read_archive(api.archive(artifact["id"]), number, sha, artifact["digest"])
    stage = Path(tempfile.mkdtemp(prefix="horner-qa-", dir=os.environ["RUNNER_TEMP"]))
    # Only data is materialized. No archive directory structure is trusted.
    public = stage / "public"
    public.mkdir(mode=0o700)
    for name, data in files.items():
        target = public / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o600)
    state = {"sha": sha, "number": number, "run_id": run["id"], "artifact_id": artifact["id"],
             "digest": artifact["digest"], "files": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}}
    (stage / "state.json").write_text(json.dumps(state))
    output({"ready": "true", "stage": stage, "project": config["QA_PROJECT_ID"],
            "provider": config["QA_WORKLOAD_IDENTITY_PROVIDER"], "service_account": config["QA_SERVICE_ACCOUNT"]})


def publish():
    config = load_config()
    stage = Path(os.environ["QA_STAGE"]).resolve()
    require(stage.parent == Path(os.environ["RUNNER_TEMP"]).resolve() and stage.name.startswith("horner-qa-"), "Invalid staging directory")
    state = json.loads((stage / "state.json").read_text())
    api = GitHub()
    run = eligibility(api, state["sha"], state["number"])
    require(run and run["id"] == state["run_id"], "PR/checks changed before credentialed publication")
    artifact = api.get(f"/actions/artifacts/{state['artifact_id']}")
    validate_artifact(artifact, run, state["number"], state["sha"])
    require(artifact["digest"] == state["digest"], "Artifact changed")
    files = {}
    for name, digest in state["files"].items():
        require(name in FIXED_FILES or ASSET_PATH.fullmatch(name), "Unsafe staged filename")
        path = stage / "public" / name
        require(not path.is_symlink() and path.is_file(), "Invalid staged file")
        data = path.read_bytes()
        require(hashlib.sha256(data).hexdigest() == digest, "Staged file changed")
        files[name] = data
    validate_files(files, state["number"], state["sha"])
    google = os.environ["QA_GOOGLE_ACCESS_TOKEN"]
    site, project = config["QA_SITE_ID"], config["QA_PROJECT_ID"]
    base = "https://firebasehosting.googleapis.com/v1beta1/"
    def hosting(path, method="GET", body=None):
        return request(base + path, google, method, body)
    # Assert ownership rather than accepting a site name that belongs elsewhere.
    site_info = hosting(f"projects/{project}/sites/{site}")
    require(site_info.get("name") in (f"projects/{project}/sites/{site}", f"projects/{config['QA_PROJECT_NUMBER']}/sites/{site}"),
            "Hosting site project ownership mismatch")
    require(site_info.get("defaultUrl") == f"https://{site}.web.app", "Unexpected Hosting site URL")
    channel = f"pr-{state['number']}-{state['sha'][:12]}"
    channel_path = f"sites/{site}/channels/{channel}"
    try:
        existing = hosting(channel_path)
    except urllib.error.HTTPError as error:
        require(error.code == 404, "Cannot verify QA channel")
        existing = None
    if existing:
        require(existing.get("labels", {}).get("commit") == state["sha"]
                and existing.get("labels", {}).get("pr") == str(state["number"]),
                "Channel collision or unrecognized channel owner")
    if not existing:
        existing = hosting(f"sites/{site}/channels?channelId={channel}", "POST", {"ttl": "604800s", "retainedReleaseCount": 1,
                     "labels": {"commit": state["sha"], "pr": str(state["number"])}})
    require(existing.get("name") == channel_path and existing.get("expireTime"), "Missing expiring QA channel")
    expiry = datetime.fromisoformat(existing["expireTime"].replace("Z", "+00:00"))
    require(datetime.now(timezone.utc) < expiry <= datetime.now(timezone.utc) + timedelta(days=7, minutes=1),
            "QA channel must expire within seven days")
    # An immutable PR/SHA channel never has its lifetime extended by duplicate triggers.
    if existing.get("release"):
        print("This exact PR/SHA already has a preview; leaving its original expiry unchanged.")
        return
    version = hosting(f"sites/{site}/versions", "POST", {"config": HOSTING_CONFIG})
    version_name = version.get("name", "")
    require(re.fullmatch(re.escape(f"sites/{site}/versions/") + r"[A-Za-z0-9_-]+", version_name), "Unexpected version identity")
    compressed = {name: gzip.compress(body, mtime=0) for name, body in files.items()}
    hashes = {name: hashlib.sha256(body).hexdigest() for name, body in compressed.items()}
    by_hash = {hashes[name]: body for name, body in compressed.items()}
    upload = hosting(version_name + ":populateFiles", "POST", {"files": {"/" + n: h for n, h in hashes.items()}})
    upload_url = "https://upload-firebasehosting.googleapis.com/upload/" + version_name + "/files"
    require(upload.get("uploadUrl") == upload_url, "Unexpected upload destination")
    for digest in upload.get("uploadRequiredHashes", []):
        require(digest in by_hash, "Unexpected upload hash")
        request(upload_url + "/" + digest, google, "POST", by_hash[digest], binary=True)
    finalized = hosting(version_name + "?updateMask=status", "PATCH", {"status": "FINALIZED"})
    require(finalized.get("status") == "FINALIZED", "Version not finalized")
    # Last possible read before making the static preview visible.
    latest = eligibility(api, state["sha"], state["number"])
    require(latest and latest["id"] == state["run_id"], "PR/checks changed during upload; no release made")
    hosting(channel_path + "/releases?" + urllib.parse.urlencode({"versionName": version_name}), "POST", {})
    channel_info = hosting(channel_path)
    url = channel_info.get("url", "")
    require(re.fullmatch(r"https://" + re.escape(site + "--" + channel + "-") + r"[a-z0-9-]+\.web\.app", url), "Unexpected preview URL")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write(f"QA preview for PR #{state['number']}, commit `{state['sha']}`: {url}\n\n"
                      f"Public synthetic guest data only. Expires: {channel_info['expireTime']}.\n")
    print(f"Published QA preview: {url}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("gate", "publish", "check-dir"))
    parser.add_argument("directory", nargs="?")
    args = parser.parse_args()
    if args.command == "check-dir":
        root = Path(args.directory)
        files = {}
        for path in root.rglob("*"):
            require(not path.is_symlink(), "Symlink in build output")
            if path.is_file():
                files[path.relative_to(root).as_posix()] = path.read_bytes()
        validate_files(files, int(os.environ["QA_PR_NUMBER"]), os.environ["QA_COMMIT_SHA"])
        print(f"Validated {len(files)} bounded static QA files")
    elif args.command == "gate":
        gate()
    else:
        publish()


if __name__ == "__main__":
    try:
        main()
    except (Refused, urllib.error.HTTPError) as error:
        # Do not log request objects, tokens, or untrusted HTTP response bodies.
        print(f"QA preview refused: {error}", file=sys.stderr)
        sys.exit(1)
