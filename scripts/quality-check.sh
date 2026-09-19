#!/bin/sh
# quality-check.sh — source-level quality gate for the Tre Coding Agent repo.
#
# Scans TypeScript sources (default: <repo root>/src) and fails (exit 1) on:
#   1. console.log( in code          (console.error / console.warn are fine)
#   2. TODO or FIXME markers
#   3. trailing whitespace at end of line
#   4. import/export/require specifiers referencing node_modules/ or a bare
#      dist/ path (e.g. "./dist/x.js"). Only quoted specifiers are inspected,
#      so comments mentioning dist/ (e.g. in src/cli/main.ts) are NOT flagged.
#   5. tab characters (indent with spaces) — the one extra cheap check.
#   6. dependency freeze — node scripts/check-deps.mjs runs with CWD at the
#      repository root and rejects any package outside its embedded allowlist,
#      plus any drift between package.json and package-lock.json (see that
#      script for the exact rules).
#
# Usage:   scripts/quality-check.sh [dir]
#          dir defaults to $(dirname $(dirname $0))/src
# Exit:    0 = clean, 1 = violations found, 2 = usage error.
#
# Source-level scan plus the dependency-freeze step above (plain node reading
# two JSON files; never runs npm, never installs anything, nothing written to
# dist/). This script itself adds no dependencies (POSIX sh + find + awk).
# Safe to run in parallel with the build agent.
#
# Notes/limits (conservative choices):
#   - Scans *.ts files only.
#   - console.log( is flagged anywhere on a line, including inside string
#     literals (no such case in the current tree).
#   - Multi-line import statements are not supported by check 4 (none exist
#     in the current tree); the `from "spec"` line is what gets inspected.
#   - Filenames containing spaces are not supported (none exist).

set -u

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [dir-to-scan]" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  DIR=$1
else
  DIR=$(dirname "$(dirname "$0")")/src
fi

if [ ! -d "$DIR" ]; then
  echo "quality-check: not a directory: $DIR" >&2
  exit 2
fi

# Check 6 — dependency freeze. The root is resolved from this script's own
# path in the same style as DIR above, so it works no matter where the gate
# is invoked from (npm test already runs with CWD at the repo root). Its
# status is aggregated with the scan below: either one failing fails the gate.
ROOT=$(dirname "$(dirname "$0")")
# Capture the subshell status DIRECTLY — under `if ! cmd`, `$?` is the
# inverted status (0) when cmd failed, so the old form never recorded a
# deps failure (D20 integration fix, caught by a from-elsewhere probe).
(cd "$ROOT" && node scripts/check-deps.mjs)
DEPS_STATUS=$?

SCAN_STATUS=0
FILELIST=$(find "$DIR" -type f -name '*.ts' | sort)

if [ -z "$FILELIST" ]; then
  echo "quality-check: OK — no .ts files under $DIR (nothing to scan)."
  if [ "$DEPS_STATUS" -ne 0 ]; then exit 1; fi
  exit 0
fi

# Single-quote character, passed to awk so the program can live inside shell
# single quotes without quoting acrobatics.
SQ="'"

awk -v sq="$SQ" -v dir="$DIR" '
  function report(reason) {
    cnt++
    printf "%s:%d: %s\n", FILENAME, FNR, reason > "/dev/stderr"
    bad = 1
  }
  function forbidden(spec,  d) {
    # any relative/import path into node_modules is wrong
    if (index(spec, "node_modules") > 0) return 1
    # bare dist/ path: strip leading ./ and ../, then check for dist/ prefix
    d = spec
    while (d ~ /^\.\.\//) sub(/^\.\.\//, "", d)
    while (d ~ /^\.\//)   sub(/^\.\//, "", d)
    if (d ~ /^dist\//) return 1
    return 0
  }
  # pos = position of the matched opening quote (regex consumed it)
  function checkspec(line, pos,  c, spec, p) {
    c = substr(line, pos)  # the quote character itself
    spec = substr(line, pos + 1)
    p = index(spec, c)
    if (p > 0) spec = substr(spec, 1, p - 1)
    if (forbidden(spec))
      report("import path \"" spec "\" — no node_modules/ or bare dist/ imports")
  }
  FNR == 1 { files++ }
  {
    code = $0

    # 1. no console.log(
    if (index(code, "console.log(") > 0)
      report("console.log( — debug output; use console.error/warn")

    # 2. no TODO / FIXME markers
    if (code ~ /TODO|FIXME/)
      report("TODO/FIXME marker — resolve or remove")

    # 3. no trailing whitespace
    if (code ~ /[ \t]+$/)
      report("trailing whitespace at end of line")

    # 5. no tab characters
    if (index(code, "\t") > 0)
      report("tab character — indent with spaces")

    # 4. no node_modules/ or bare dist/ in import/export/require specifiers
    line = code
    sub(/\/\/.*/, "", line)  # ignore // comments
    if (match(line, "from[ \t]*[\"" sq "]"))
      checkspec(line, RSTART + RLENGTH - 1)
    if (match(line, "require[ \t]*\\([ \t]*[\"" sq "]"))
      checkspec(line, RSTART + RLENGTH - 1)
    if (match(line, "import[ \t]*\\([ \t]*[\"" sq "]"))
      checkspec(line, RSTART + RLENGTH - 1)
  }
  END {
    if (bad)
      printf "quality-check: FAILED — %d violation(s) under %s\n", cnt, dir > "/dev/stderr"
    else
      printf "quality-check: OK — %d file(s) scanned under %s, no violations\n", files, dir > "/dev/stderr"
    exit bad ? 1 : 0
  }
' $FILELIST
SCAN_STATUS=$?

if [ "$DEPS_STATUS" -ne 0 ] || [ "$SCAN_STATUS" -ne 0 ]; then
  echo "quality-check: FAILED — dependency freeze and/or source scan failed (see messages above)" >&2
  exit 1
fi
exit 0
