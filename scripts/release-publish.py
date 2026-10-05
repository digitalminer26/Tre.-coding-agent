#!/usr/bin/env python3
"""release-publish.py — publish a GitHub Release with the offline tarball.

Part of scripts/release.sh (step 5). Creates the vX.Y.Z release on the
configured repo (or reuses an existing one for the tag), replaces any asset
with the same name, and uploads the tarball. Stdlib only (urllib) — no deps.

Auth: a GitHub token, in this order:
  1. $GITHUB_TOKEN
  2. the macOS keychain entry for github.com, read via
     `git credential-osxkeychain get` (the same credential `git push` uses)
The token is never printed.

Usage:
  release-publish.py REPO TARBALL [TAG] [NAME]
    REPO    owner/name            (default: $TRE_RELEASE_REPO)
    TARBALL path to the .tgz
    TAG     release tag           (default: v<version from TARBALL's package.json>)
    NAME    release name          (default: "tre. <TAG> — offline bundle")

Exit: 0 on success, 1 on any failure. Idempotent: re-running for the same
tag reuses the release and replaces the asset.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def die(msg):
    print("release-publish: ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def get_token():
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        return tok
    try:
        proc = subprocess.run(
            ["git", "credential-osxkeychain", "get"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in proc.stdout.strip().splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    return None


def api_call(token, method, url, body=None, headers=None):
    """One API call. Returns (status, parsed-json-or-text)."""
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "tre-release-publish",
            **(headers or {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:500]
    except (urllib.error.URLError, OSError) as e:
        die(f"network error calling {url}: {e}")
    try:
        return status, json.loads(raw.decode("utf-8") or "null")
    except json.JSONDecodeError:
        return status, raw.decode("utf-8", "replace")[:500]


def tarball_version(tarball):
    """Read the version from the staged package.json inside the tarball."""
    out = subprocess.run(
        ["tar", "xzOf", tarball, "package/package.json"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        die(f"cannot read package/package.json from {tarball}: {out.stderr.strip()}")
    return json.loads(out.stdout)["version"]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def release_body(repo, tag, asset_name, sha):
    return f"""Self-contained offline bundle of tre. ({tag}).

Contents: pre-built dist/ + full prod-only node_modules (pure JS/WASM, no
native addons) + install-tre.sh (target-side deploy script).

Target machine needs ONLY Node.js >= 20 (>= 22 recommended). No network, no
npm, no GitHub, no build step.

Install:
  curl -LO https://github.com/{repo}/releases/download/{tag}/{asset_name}
  mkdir -p ~/.tre/tre
  tar xzf {asset_name} -C ~/.tre/tre --strip-components=1
  ~/.tre/tre/install-tre.sh install
  tre. --help

sha256: {sha}
"""


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        die("usage: release-publish.py REPO TARBALL [TAG] [NAME]")
    repo = args[0]
    tarball = args[1]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        die(f"bad repo (want owner/name): {repo}")
    if not os.path.isfile(tarball):
        die(f"tarball not found: {tarball}")

    version = tarball_version(tarball)
    tag = args[2] if len(args) > 2 else "v" + version
    name = args[3] if len(args) > 3 else f"tre. {tag} — offline bundle"
    asset_name = os.path.basename(tarball)
    sha = sha256_of(tarball)
    body = release_body(repo, tag, asset_name, sha)

    token = get_token()
    if not token:
        die("no GitHub token: set $GITHUB_TOKEN or store the github.com "
            "credential in the macOS keychain (git push uses the same one)")

    print(f"release-publish: repo={repo} tag={tag} asset={asset_name} ({version})")
    print(f"release-publish: sha256 {sha}")

    status, rel = api_call(token, "GET", f"{API}/repos/{repo}/releases/tags/{tag}")
    if status == 404:
        status, rel = api_call(
            token, "POST", f"{API}/repos/{repo}/releases",
            body=json.dumps({
                "tag_name": tag,
                "target_commitish": "main",
                "name": name,
                "body": body,
                "draft": False,
                "prerelease": False,
            }).encode(),
            headers={"Content-Type": "application/json"},
        )
        if status not in (200, 201):
            die(f"create release (HTTP {status}): {rel}")
        print(f"release-publish: created {rel['html_url']}")
    elif status == 200:
        # Keep the release body current (sha256 + install steps) on re-publish.
        api_call(token, "PATCH", f"{API}/repos/{repo}/releases/{rel['id']}",
                 body=json.dumps({"body": body}).encode(),
                 headers={"Content-Type": "application/json"})
        print(f"release-publish: reusing existing {rel['html_url']} (body refreshed)")
    else:
        die(f"release lookup (HTTP {status}): {rel}")

    # Replace any existing asset with the same name, then upload.
    for a in rel.get("assets", []):
        if a.get("name") == asset_name:
            api_call(token, "DELETE", f"{API}/repos/{repo}/releases/assets/{a['id']}")
            print(f"release-publish: removed old asset {a['name']}")

    # The upload endpoint is on uploads.github.com — use the release's own
    # upload_url (do NOT hand-build an api.github.com URL; it 404s).
    upload_url = rel["upload_url"].replace("{?name,label}", "?name=" + asset_name)
    with open(tarball, "rb") as f:
        data = f.read()
    status, up = api_call(
        token, "POST", upload_url, body=data,
        headers={"Content-Type": "application/octet-stream"},
    )
    if status not in (200, 201):
        die(f"asset upload (HTTP {status}): {up}")
    print(f"release-publish: OK — {up['browser_download_url']} ({up['size']} bytes)")


if __name__ == "__main__":
    main()
