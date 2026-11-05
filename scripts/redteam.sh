#!/bin/sh
# P15 investigation-agent red-team driver.
#
# Two phases:
#   1. probes   — scripts/redteam-investigation.mjs: hostile packets against
#                 the built agent with asserted disclosures (A5/A6 findings).
#   2. mutations — delete each protection from the BUILT agent one at a time
#                 and re-run the probes + the unit tests. EVERY mutation must
#                 be caught. (Cycle-A6 lesson: an A5 test stayed green with
#                 its guard removed — mutate-before-believing.)
#
# Run from the repo root: sh scripts/redteam.sh
set -eu
cd "$(dirname "$0")/.."

TARGET=dist/src/investigation/agent.js
BAK="$TARGET.redteam-bak"
fails=0

say() { printf '%s\n' "$*"; }

if [ ! -f "$TARGET" ]; then
  say "redteam: no dist build — running npm run build first"
  npm run build >/dev/null
fi

say "── phase 1: probes ─────────────────────────────"
if node scripts/redteam-investigation.mjs; then
  say "redteam: probes green"
else
  say "redteam: PROBES FAILED — do not proceed to mutations"
  exit 1
fi

say ""
say "── phase 2: mutation harness ───────────────────"
cp "$TARGET" "$BAK"
trap 'cp "$BAK" "$TARGET"; rm -f "$BAK"' EXIT

# Each entry: NAME | sed pattern | sed replacement
mutate() {
  name="$1"; pat="$2"; rep="$3"
  if ! grep -qF -- "$pat" "$BAK"; then
    say "SKIP  $name (pattern not found — the protection moved, update this script!)"
    fails=$((fails + 1))
    return
  fi
  RT_PAT="$pat" RT_REP="$rep" python3 - "$BAK" "$TARGET" <<'PYEOF'
import os, sys
src = open(sys.argv[1]).read()
pat = os.environ["RT_PAT"]; rep = os.environ["RT_REP"]
assert src.count(pat) == 1, f"pattern not unique ({src.count(pat)}x): {pat}"
open(sys.argv[2], "w").write(src.replace(pat, rep))
PYEOF
  if cmp -s "$BAK" "$TARGET"; then
    say "SKIP  $name (sed changed nothing — update this script!)"
    fails=$((fails + 1))
    return
  fi
  # A mutation is CAUGHT if the probe suite or the unit tests fail.
  rc=0
  node scripts/redteam-investigation.mjs >/dev/null 2>&1 || rc=1
  if [ $rc -eq 0 ]; then
    node --test dist/test/investigation.test.js >/dev/null 2>&1 || rc=1
  fi
  if [ $rc -ne 0 ]; then
    say "CAUGHT  $name"
  else
    say "SURVIVED $name  ← the suite does not discriminate this protection!"
    fails=$((fails + 1))
  fi
  cp "$BAK" "$TARGET"
}

mutate "M1 A5-R1 overflow disclosure (refsIn.overflow OR)" \
  "refsIn.overflow || refsIn.scanExhausted" "false || refsIn.scanExhausted"
mutate "M2 A6-F1 scan-budget marker" \
  "markers.push('bad-input:scan-budget');" "void 0;"
mutate "M3 A5-F6 bad maxUsd marker" \
  "badMaxUsd = true;" "badMaxUsd = false;"
mutate "M4 A5 bad maxToolCalls marker" \
  "badMaxCalls = true;" "badMaxCalls = false;"

say ""
if [ "$fails" -eq 0 ]; then
  say "redteam: ALL MUTATIONS CAUGHT"
else
  say "redteam: $fails PROBLEM(S) — see above"
  exit 1
fi
