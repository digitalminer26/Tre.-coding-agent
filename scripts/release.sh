#!/bin/sh
# release.sh — one-command release of tre.
#
# Bumps the version in package.json, runs the full quality gate (npm test),
# commits, pushes to origin main, builds the offline tarball, and publishes
# it as a GitHub Release with the tarball as the asset.
#
# Usage:
#   scripts/release.sh X.Y.Z [commit-message]
#     X.Y.Z           new version (must be > the current package.json version)
#     commit-message  defaults to "Bump version to X.Y.Z"
#
# Environment:
#   TRE_RELEASE_REPO  GitHub owner/name (default: digitalminer26/Tre.-coding-agent)
#   TRE_PUSH=0        skip the git push (everything else still runs)
#   TRE_PUBLISH=0     skip the GitHub release (tarball is still built)
#   GITHUB_TOKEN      token for the release API (fallbacks: the machine-level
#                     ~/.tre/github-token file, then the github.com credential
#                     in the macOS keychain — the one git push uses)
#
# Steps: 1 bump  2 npm test  3 commit  4 push  5 build tarball  6 publish.
# The tarball is a build artifact (.tre/deploy-out/, gitignored) — only the
# version bump commit lands in git; the artifact goes to the GitHub Release.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 X.Y.Z [commit-message]" >&2
  exit 2
fi
NEW_VERSION=$1
MSG=${2:-"Bump version to $NEW_VERSION"}
REPO=${TRE_RELEASE_REPO:-digitalminer26/Tre.-coding-agent}

if ! printf '%s\n' "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "release: bad version (want X.Y.Z): $NEW_VERSION" >&2
  exit 2
fi

OLD_VERSION=$(node -p 'require("./package.json").version')
if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  echo "release: package.json is already at $NEW_VERSION (nothing to bump)" >&2
  exit 1
fi
if ! node -e '
  const a = process.argv[1].split(".").map(Number);
  const b = process.argv[2].split(".").map(Number);
  process.exit((a[0] > b[0]) || (a[0] === b[0] && a[1] > b[1]) ||
               (a[0] === b[0] && a[1] === b[1] && a[2] > b[2]) ? 0 : 1);
' "$NEW_VERSION" "$OLD_VERSION"; then
  echo "release: $NEW_VERSION is not greater than current $OLD_VERSION" >&2
  exit 1
fi

# --- 1. bump the version (round-trips the 2-space JSON style) ---
node -e '
  const fs = require("fs");
  const p = "package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$NEW_VERSION"
echo "==> version: $OLD_VERSION -> $NEW_VERSION"

# --- 2. quality gate (quality-check + tsc + full test suite) ---
echo "==> quality gate: npm test"
npm test

# --- 3. commit the bump ---
echo "==> committing: $MSG"
git add package.json
git commit -m "$MSG"

# --- 4. push (plain push first; then the token file; then the keychain) ---
# Push using a token file via a ONE-SHOT credential helper — the token is
# never printed and never written to the git config.
push_with_token_file() {
  git -c credential.helper="!f() { echo username=git; echo \"password=\$(cat '$1')\"; }; f" push origin main
}

if [ "${TRE_PUSH:-1}" = "1" ]; then
  echo "==> pushing to origin main"
  if git push origin main; then
    :
  elif [ -f "$HOME/.tre/github-token" ] && push_with_token_file "$HOME/.tre/github-token"; then
    echo "    (pushed via the machine-level token file ~/.tre/github-token)"
  elif [ -f ".tre/github-token" ] && push_with_token_file ".tre/github-token"; then
    echo "    (pushed via the legacy repo-local token file .tre/github-token)"
  else
    echo "    push failed — retrying with the macOS keychain credential helper"
    git -c credential.helper=osxkeychain push origin main
  fi
else
  echo "==> TRE_PUSH=0 — skipping push"
fi

# --- 5. build the offline tarball ---
echo "==> building offline tarball"
TARBALL=$(sh scripts/build-offline-tarball.sh "$ROOT" | awk '/tarball:/{print $2}')
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "release: build did not produce a tarball" >&2
  exit 1
fi
echo "==> tarball: $TARBALL"

# --- 6. publish the GitHub Release ---
if [ "${TRE_PUBLISH:-1}" = "1" ]; then
  echo "==> publishing to GitHub ($REPO)"
  python3 scripts/release-publish.py "$REPO" "$TARBALL"
else
  echo "==> TRE_PUBLISH=0 — skipping GitHub release (tarball: $TARBALL)"
fi

echo "==> DONE: $NEW_VERSION released"
