#!/usr/bin/env python3
"""release-publish.py — publish a GitHub Release with the offline tarball.

Part of scripts/release.sh (step 5). Creates the vX.Y.Z release on the
configured repo (or reuses an existing one for the tag), replaces any asset
with the same name, and uploads the tarball. Stdlib only (urllib) — no deps.

Auth: a GitHub token, in this order:
  1. $GITHUB_TOKEN
  2. ~/.tre/github-token (the machine-level token file — where tre.'s
     release tooling keeps it; the repo-local .tre/github-token is a
     legacy location, still honored as a fallback)
  3. the macOS keychain entry for github.com, read via
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
    # Machine-level token file (the 2026-10-05 config-consistency cleanup):
    # ~/.tre/github-token is where the release tooling keeps the token. The
    # repo-local .tre/github-token is a LEGACY location, still honored as a
    # fallback for machines that have not migrated yet.
    for p in (
        os.path.join(os.path.expanduser("~"), ".tre", "github-token"),
        os.path.join(os.getcwd(), ".tre", "github-token"),
    ):
        try:
            with open(p) as f:
                tok = f.read().strip()
        except OSError:
            continue
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


def release_body(repo, tag, asset_name, installer_name, sha):
    return f"""Self-contained offline bundle of tre. ({tag}).

One-command install (requires Node.js >= 20):
  curl -fsSL https://github.com/{repo}/releases/download/{tag}/{installer_name} | sh

The installer downloads this release's bundle and performs the deployment.

Manual bundle install:

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
    installer_name = f"install-tre-{version}.sh"
    sha = sha256_of(tarball)
    body = release_body(repo, tag, asset_name, installer_name, sha)
    installer_path = os.path.join(os.path.dirname(os.path.abspath(tarball)), installer_name)
    with open(installer_path, "w", encoding="utf-8") as installer:
        installer.write(f'''#!/bin/sh
# One-command installer for tre. {tag}. Requires Node.js >= 20.
set -eu
REPO={repo!r}
TAG={tag!r}
ASSET={asset_name!r}
BASE="https://github.com/$REPO/releases/download/$TAG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
command -v node >/dev/null 2>&1 || {{ echo "ERROR: Node.js >= 20 is required" >&2; exit 1; }}
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 20 ] || {{ echo "ERROR: Node.js >= 20 is required (found $(node --version))" >&2; exit 1; }}
if command -v curl >/dev/null 2>&1; then curl -fL "$BASE/$ASSET" -o "$TMP/$ASSET"
elif command -v wget >/dev/null 2>&1; then wget -O "$TMP/$ASSET" "$BASE/$ASSET"
else echo "ERROR: curl or wget is required to download the bundle" >&2; exit 1; fi
DEST="$HOME/.tre/tre"
mkdir -p "$DEST"
tar xzf "$TMP/$ASSET" -C "$DEST" --strip-components=1
"$DEST/install-tre.sh" install
''')
    os.chmod(installer_path, 0o755)

    token = get_token()
    if not token:
        die("no GitHub token: set $GITHUB_TOKEN, write ~/.tre/github-token "
            "(legacy: .tre/github-token), or store the github.com credential "
            "in the macOS keychain (git push uses the same one)")

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

    # Replace any existing assets with the same names, then upload.
    for a in rel.get("assets", []):
        if a.get("name") in (asset_name, installer_name):
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

    with open(installer_path, "rb") as f:
        installer_data = f.read()
    upload_url = rel["upload_url"].replace("{?name,label}", "?name=" + installer_name)
    status, up = api_call(
        token, "POST", upload_url, body=installer_data,
        headers={"Content-Type": "application/x-sh"},
    )
    if status not in (200, 201):
        die(f"installer upload (HTTP {status}): {up}")
    print(f"release-publish: OK — {up['browser_download_url']} ({up['size']} bytes)")


if __name__ == "__main__":
    main()
