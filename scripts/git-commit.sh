#!/bin/sh
# git-commit.sh — the gated, single-purpose commit action for this repo.
#
# This is the mechanical core of the git-commit skill. It makes "commit the
# current codebase" a SAFE, repeatable action: it refuses a dirty-but-
# unreviewed surprise, runs the quality gate on EXACTLY what will be
# committed, stages everything, commits, and verifies the commit landed.
#
# The guardrail zone (sandbox/safety/bash/hook/skill) is NOT bypassed here.
# If the staged set touches the zone, the pre-commit hook rejects the commit
# and this script reports that and exits 1. A human commits such a change
# themselves with GUARDRAIL_BYPASS=1 (see scripts/guardrail-check.sh).
#
# Usage:
#   sh scripts/git-commit.sh "<message>"
#   sh scripts/git-commit.sh --message "<message>"
#
# Environment:
#   GATE  - the command run (from the repo root) before staging+commit.
#           Default: "npm test" (quality gate + tsc + full test suite).
#
# Exit codes:
#   0   commit created and verified
#   1   commit failed (incl. guardrail-zone rejection by the pre-commit hook)
#   2   usage error (no message / not a git repo)
#   10  nothing to commit (working tree already clean)
#   11  quality gate failed (nothing staged, nothing committed)

set -u

die() { printf 'git-commit: %s\n' "$1" >&2; exit "${2:-1}"; }

# --- locate repo root (must be inside a git work tree) ----------------------
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not a git repository" 2
cd "$ROOT" || die "cannot cd to repo root: $ROOT"

# --- parse the message ------------------------------------------------------
MSG=""
if [ "$#" -ge 1 ] && [ "$1" = "--message" ]; then
  shift
  [ "$#" -ge 1 ] || die "no commit message (after --message)" 2
  MSG="$1"
elif [ "$#" -ge 1 ]; then
  MSG="$1"
else
  die "usage: sh scripts/git-commit.sh \"<message>\"  (or --message \"<message>\")" 2
fi
[ -n "$MSG" ] || die "empty commit message" 2

# --- pre-flight: is there anything to commit? -------------------------------
if [ -z "$(git status --porcelain)" ]; then
  printf 'git-commit: nothing to commit — working tree is clean at %s\n' \
    "$(git rev-parse --short HEAD)"
  exit 10
fi

# --- the gate: verify EXACTLY what will be committed ------------------------
GATE="${GATE:-npm test}"
printf 'git-commit: running gate: %s\n' "$GATE"
if ! sh -c "$GATE"; then
  printf '\ngit-commit: GATE FAILED — nothing staged, nothing committed.\n' >&2
  printf 'git-commit: fix the failure, then re-run.\n' >&2
  exit 11
fi
printf 'git-commit: gate passed.\n'

# --- stage everything (the full current codebase) ---------------------------
git add -A 2>/dev/null || die "git add -A failed (unmerged paths?)"
STAGED_COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"
printf 'git-commit: staged %s file(s).\n' "$STAGED_COUNT"

# --- commit (the pre-commit guardrail hook runs here) -----------------------
if ! git commit -m "$MSG" 2>&1; then
  printf '\ngit-commit: COMMIT FAILED.\n' >&2
  printf 'git-commit: if this was a guardrail-zone rejection, a human must\n' >&2
  printf 'git-commit: commit it with GUARDRAIL_BYPASS=1 git commit ...\n' >&2
  exit 1
fi

# --- verify the commit actually landed --------------------------------------
HEAD="$(git rev-parse --short HEAD)"
SUBJ="$(git log -1 --pretty=%s)"
[ "$SUBJ" = "$MSG" ] || die "commit landed but subject mismatch: '$SUBJ' != '$MSG'"
printf '\ngit-commit: OK — committed %s (%s file(s))\n' "$HEAD" "$STAGED_COUNT"
printf 'git-commit:   %s\n' "$SUBJ"
exit 0
