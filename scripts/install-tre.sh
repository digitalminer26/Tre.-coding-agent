#!/bin/sh
# install-tre.sh — make `tre.` fully deployable from this offline bundle.
#
# This script is INSIDE the offline tarball (package root). It shows the exact
# commands to extract the bundle and every step needed to get a working `tre.`
# on this machine — and can run them for you.
#
# Usage:
#   ./install-tre.sh                show the extract command + all steps (no action)
#   ./install-tre.sh install [DIR]  actually deploy: extract to DIR (default
#                                   ~/.tre/tre) and put `tre.` on PATH
#
# Requirements: a Node.js runtime (>= 20; >= 22 recommended). No network, no
# npm, no GitHub, no build step — everything is in the tarball.
set -eu

ME=$(basename "$0")
TARBALL_HINT="tre-coding-agent-*-offline.tgz"

show() {
  cat <<'EOF'
========================================================================
 tre. offline deployment — required steps
========================================================================
 This bundle is self-contained: pre-built dist/ + the full prod
 node_modules (40 packages, pure JS + WASM, no native addons).
 The target machine needs ONLY a Node.js runtime (>= 20; >= 22
 recommended). No network, no npm, no GitHub, no build.

 STEP 1 — extract the tarball
 ------------------------------------------------------------------------
   tar xzf <this-tarball> -C <dest> --strip-components=1

   Example (dest = ~/.tre/tre):
     mkdir -p ~/.tre/tre          # tar does not create parent dirs
     tar xzf tre-coding-agent-X.Y.Z-offline.tgz -C ~/.tre/tre \
         --strip-components=1

   --strip-components=1 drops the leading "package/" directory so the
   result is <dest>/{dist,node_modules,package.json,install-tre.sh}.

 STEP 2 — make the entrypoint executable
 ------------------------------------------------------------------------
     chmod +x <dest>/dist/src/cli/main.js

 STEP 3 — put `tre.` on your PATH
 ------------------------------------------------------------------------
     mkdir -p ~/.local/bin
     ln -sf <dest>/dist/src/cli/main.js ~/.local/bin/tre.
     # make sure ~/.local/bin is on PATH (the install command does this
     # automatically for your shell rc; if you did the steps by hand):
     echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc     # or ~/.profile
     # then in THIS shell (a new terminal picks it up on its own):
     export PATH="$HOME/.local/bin:$PATH"

 STEP 4 — point it at an LLM endpoint (per-machine config)
 ------------------------------------------------------------------------
   tre. finds models.json by walking up from the launch dir, then
   ~/.tre/models.json. Create one (template: models.json.example in the
   repo) with at least:
     { "default": "<model-id>",
       "models": [ { "id": "<model-id>",
                     "baseUrl": "http://<host>:<port>/v1",
                     "api": "openai-completions" } ] }
   With NO models.json, `tre.` prints a step-by-step setup guide and
   exits — that is the built-in onboarding.

 STEP 5 — verify
 ------------------------------------------------------------------------
     tre. --help                      # prints usage, exit 0
     tre. run "say hello"             # one-shot against your endpoint

 Uninstall: rm -rf <dest> and remove the ~/.local/bin/tre. symlink.
========================================================================
EOF
}

install() {
  DEST="${1:-$HOME/.tre/tre}"
  echo "==> deploying tre. offline bundle to: $DEST"

  # --- prerequisite: node ---
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found. Install Node.js >= 20 (>= 22 recommended) first." >&2
    echo "       This bundle has no Node runtime of its own." >&2
    exit 1
  fi
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  echo "==> node $(node --version) detected"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "ERROR: Node >= 20 required (found $(node --version))." >&2
    exit 1
  fi
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "note: Node >= 22 recommended (ink declares engines >= 22);"
    echo "      Node 20 works (EBADENGINE warnings only)."
  fi

  # --- locate this bundle's source tarball (or the already-extracted tree) ---
  # This script runs from an EXTRACTED copy (step 1 already done by the
  # caller, or we are being run from the tarball's own extraction). The
  # extracted tree IS this directory:
  HERE=$(cd "$(dirname "$0")" && pwd)
  if [ ! -f "$HERE/dist/src/cli/main.js" ]; then
    echo "ERROR: $HERE/dist/src/cli/main.js not found." >&2
    echo "       Run this script from the EXTRACTED bundle (step 1 first):" >&2
    echo "         tar xzf $TARBALL_HINT -C $DEST --strip-components=1" >&2
    echo "         $DEST/$ME install" >&2
    exit 1
  fi

  # --- if the caller passed a different DEST, move the tree there ---
  if [ "$HERE" != "$DEST" ]; then
    echo "==> moving extracted tree: $HERE -> $DEST"
    mkdir -p "$(dirname "$DEST")"
    if [ -e "$DEST" ]; then
      echo "==> removing existing $DEST (previous install)"
      rm -rf "$DEST"
    fi
    mv "$HERE" "$DEST"
  fi

  chmod +x "$DEST/dist/src/cli/main.js"

  # --- PATH symlink ---
  BINDIR="$HOME/.local/bin"
  mkdir -p "$BINDIR"
  ln -sf "$DEST/dist/src/cli/main.js" "$BINDIR/tre."
  echo "==> symlink: $BINDIR/tre. -> $DEST/dist/src/cli/main.js"
  case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *)
      # Pick the user's interactive shell rc. $SHELL (the login shell) is
      # inherited even when this script is launched via `sh`, so it beats
      # the ZSH_VERSION/BASH_VERSION check — those are empty under `sh`,
      # which would misfile the line into ~/.profile (unread by zsh).
      RC=""
      case "${SHELL:-}" in
        *zsh*)  RC="$HOME/.zshrc" ;;
        *bash*) RC="$HOME/.bashrc" ;;
        *)
          if [ -n "${ZSH_VERSION:-}" ]; then
            RC="$HOME/.zshrc"
          elif [ -n "${BASH_VERSION:-}" ]; then
            RC="$HOME/.bashrc"
          else
            RC="$HOME/.profile"
          fi
          ;;
      esac
      if [ -f "$RC" ] && grep -F "$BINDIR" "$RC" >/dev/null 2>&1; then
        echo "note: $RC already mentions $BINDIR — if 'tre.' is still not"
        echo "      found, check that line reads: export PATH=\"$BINDIR:\$PATH\""
      else
        printf '\nexport PATH="%s:$PATH"\n' "$BINDIR" >> "$RC"
        echo "==> added: export PATH=\"$BINDIR:\$PATH\"  (to $RC)"
      fi
      echo "==> for THIS shell:  export PATH=\"$BINDIR:\$PATH\""
      ;;
  esac

  # --- smoke test ---
  echo "==> smoke test: tre. --help"
  "$BINDIR/tre." --help >/dev/null 2>&1 || "$DEST/dist/src/cli/main.js" --help >/dev/null
  echo "==> OK. Run:  tre. --help"
  echo "==> Next: create a models.json (see step 4 above) or run 'tre.'"
  echo "          with no config to get the built-in setup guide."
}

case "${1:-show}" in
  show|"") show ;;
  install) install "${2:-}" ;;
  *) echo "usage: $ME [show | install [DEST]]" >&2; exit 2 ;;
esac
