#!/bin/sh
# build-offline-tarball.sh — build the self-contained offline `tre.` bundle.
#
# Produces tre-coding-agent-<version>-offline.tgz: pre-built dist/ + the full
# prod-only node_modules (40 packages, pure JS + WASM) + install-tre.sh (the
# target-side deploy script). One artifact, any OS, Node >= 20 target.
#
# The .tgz is a build artifact — .tre/deploy-out/ is gitignored; never commit
# it. To ship it to the world, use scripts/release.sh (GitHub Release).
#
# Usage:
#   build-offline-tarball.sh [REPO] [OUT_DIR]
#     REPO     repo with the built tre. (default: ~/projects/Tre.-coding-agent)
#     OUT_DIR  where the .tgz lands   (default: <REPO>/.tre/deploy-out)
#
# The build machine needs: node + npm (any version >= 20), and either a warm
# npm cache (offline build) or network access (fallback). It does NOT touch
# the repo's node_modules, src/, or dist/ (staging happens in a temp dir;
# `npm run build` runs only if dist/ is missing/stale).
set -eu

REPO="${1:-$HOME/projects/Tre.-coding-agent}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALL_SH="$SCRIPT_DIR/install-tre.sh"

if [ ! -f "$REPO/package.json" ]; then
  echo "ERROR: $REPO/package.json not found (pass the repo path as \$1)" >&2
  exit 1
fi
if [ ! -f "$INSTALL_SH" ]; then
  echo "ERROR: install-tre.sh not found next to this script: $INSTALL_SH" >&2
  exit 1
fi
cd "$REPO"

VERSION=$(node -p 'require("./package.json").version')
OUT_DIR="${2:-$REPO/.tre/deploy-out}"
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/tre-coding-agent-$VERSION-offline.tgz"

echo "==> repo:    $REPO"
echo "==> version: $VERSION"
echo "==> out:     $TARBALL"

# --- 1. ensure dist/ exists and is current (dist/ is gitignored, so a fresh
#        clone has none; build if missing, trust it otherwise) ---
if [ ! -f dist/src/cli/main.js ]; then
  echo "==> dist/ missing — running npm run build (tsc)"
  npm run build --silent
fi
NEWEST_SRC=$(find src -name '*.ts' -exec stat -f %m {} \; 2>/dev/null | sort -n | tail -1)
NEWEST_DIST=$(find dist -name '*.js' -exec stat -f %m {} \; 2>/dev/null | sort -n | tail -1)
if [ -n "$NEWEST_SRC" ] && [ -n "$NEWEST_DIST" ] && [ "$NEWEST_SRC" -gt "$NEWEST_DIST" ]; then
  echo "==> src/ newer than dist/ — rebuilding"
  npm run build --silent
fi

# --- 2. staging dir (repo's node_modules is never touched) ---
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/staging" "$STAGE/pkgroot/package"
echo "==> staging: $STAGE"

cp package.json package-lock.json "$STAGE/staging/"
cp -R dist "$STAGE/staging/dist"

# --- 3. prod-only node_modules: try offline first (warm cache), fall back to
#        network, then to a FRESH cache dir. --ignore-scripts skips dep
#        prepare hooks (no tsc needed).
#        The fresh-cache retry covers a CORRUPTED user npm cache — e.g.
#        root-owned files in ~/.npm/_cacache (an npm bug on some machines),
#        which makes BOTH --offline and network installs fail with EPERM
#        before any package is fetched (observed 2026-10-05: the v0.1.4
#        release build died here). A private cache under the staging temp
#        dir is untouched by that corruption; the network fetch still
#        happens, the cache just lives elsewhere. ---
echo "==> installing prod-only node_modules (offline-first)"
if (cd "$STAGE/staging" && npm ci --omit=dev --offline --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
  echo "    installed from local npm cache (no network)"
elif (cd "$STAGE/staging" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
  echo "    installed with network"
else
  echo "    default npm cache failed — retrying with a fresh cache under the staging dir"
  (cd "$STAGE/staging" && npm ci --cache "$STAGE/npm-cache" --omit=dev --ignore-scripts --no-audit --no-fund)
fi
NP=$(ls "$STAGE/staging/node_modules" | grep -cv '^@' )
NS=$(find "$STAGE/staging/node_modules" -maxdepth 1 -type d -name '@*' | wc -l | tr -d ' ')
echo "    prod node_modules: $NP top-level + $NS scoped org dirs"

# --- 4. strip the root "prepare" script from the staged package.json so a
#        later `npm i <this tarball>` never tries to run tsc ---
node -e '
  const fs = require("fs");
  const p = process.argv[1] + "/package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  delete j.scripts.prepare;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$STAGE/staging"

# --- 5. embed the target-side deploy script ---
cp "$INSTALL_SH" "$STAGE/staging/install-tre.sh"
chmod +x "$STAGE/staging/install-tre.sh"

# --- 6. tar with the package/ prefix that `npm i <tarball>` expects ---
cp -R "$STAGE/staging/." "$STAGE/pkgroot/package/"
tar czf "$TARBALL" -C "$STAGE/pkgroot" package

# --- 7. report ---
SIZE=$(stat -f %z "$TARBALL" 2>/dev/null || stat -c %s "$TARBALL")
echo "==> DONE"
echo "    tarball: $TARBALL"
echo "    size:    $SIZE bytes"
echo "    sha256:  $(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
echo
echo "Ship this file to the target (scp/USB/air-gap), then on the target:"
echo "    tar xzf $(basename "$TARBALL") -C ~/.tre/tre --strip-components=1"
echo "    ~/.tre/tre/install-tre.sh          # show the steps"
echo "    ~/.tre/tre/install-tre.sh install  # or run them"
