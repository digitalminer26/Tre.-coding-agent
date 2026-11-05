#!/bin/sh
# P15 investigation-agent red-team driver.
#
# Three phases:
#   0. build     — ALWAYS rebuild dist from src (cycle-A7 F4: phase 1 used
#                  to run against whatever dist/ already existed — break
#                  src, run this script, and it printed green against the
#                  stale build. Freshness is not optional in a suite whose
#                  whole job is proving the CURRENT code discriminates).
#   1. probes    — scripts/redteam-investigation.mjs: hostile packets against
#                  the built agent with asserted disclosures (A5/A6/A7).
#   2. mutations — delete each protection from the BUILT agent one at a time
#                  and re-run the probes + the unit tests. EVERY mutation must
#                  be caught. (Cycle-A6 lesson: an A5 test stayed green with
#                  its guard removed — mutate-before-believing.)
#
# Backup hygiene (cycle-A7 F5): the BAK is PID-suffixed, so concurrent runs
# can never snapshot each other's mutants, and a `kill -9` mid-mutation is
# immune by construction — phase 0 rebuilds dist from src on every run, so
# a leftover mutant is overwritten before it could ever be trusted again
# (the old fixed-path BAK turned a killed run into a PERMANENT mutant: the
# next run snapshotted the mutant and its EXIT trap restored it forever).
# A stale `*.redteam-bak.*` may exist after a kill -9; phase 0 removes any
# BAKs it does not own.
#
# Run from the repo root: sh scripts/redteam.sh
set -eu
cd "$(dirname "$0")/.."

TARGET=dist/src/investigation/agent.js
BAK="$TARGET.redteam-bak.$$"
fails=0

say() { printf '%s\n' "$*"; }

say "── phase 0: fresh build (A7-F4: never trust a stale dist) ─"
npm run build >/dev/null
if [ ! -f "$TARGET" ]; then
  say "redteam: build produced no $TARGET"
  exit 1
fi
# Sweep stale BAKs from killed runs (mine is PID-suffixed and restored by trap).
for stale in "$TARGET".redteam-bak.*; do
  [ "$stale" = "$TARGET.redteam-bak.*" ] && continue   # glob matched nothing
  say "note: removing stale backup from a previous killed run: $stale"
  rm -f "$stale"
done

say "── phase 1: probes ─────────────────────────────"
if node scripts/redteam-investigation.mjs; then
  say "redteam: probes green"
else
  say "redteam: PROBES FAILED — do not proceed to mutations"
  rm -f "$BAK"
  exit 1
fi

say ""
say "── phase 2: mutation harness ───────────────────"
cp "$TARGET" "$BAK"
trap 'cp "$BAK" "$TARGET"; rm -f "$BAK"' EXIT INT TERM

# Each entry: NAME | sed pattern | sed replacement. Patterns may span
# lines (matched by exact count against the built agent — the count check
# is the real guard; the grep is only a fast pre-filter).
mutate() {
  name="$1"; pat="$2"; rep="$3"
  if ! grep -qF -- "$(printf '%s' "$pat" | head -n1)" "$BAK"; then
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
    say "SKIP  $name (mutation changed nothing — update this script!)"
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
  "maxUsdRaw === undefined)
        badMaxUsd = true;" "maxUsdRaw === undefined)
        badMaxUsd = false;"
mutate "M4 A5 bad maxToolCalls marker" \
  "maxToolCallsRaw === undefined)
        badMaxCalls = true;" "maxToolCallsRaw === undefined)
        badMaxCalls = false;"
mutate "M11 A7-F3 maxUsd trap marker (disclosure only, fail-closed stands)" \
  "badMaxUsd = true; // cycle-A7 F3: trap != absent (fail-closed, see above)" "badMaxUsd = false;"
mutate "M12 A7-F3 maxToolCalls trap marker (disclosure only)" \
  "if (maxToolCallsSlot.threw)
        badMaxCalls = true;" "if (maxToolCallsSlot.threw)
        badMaxCalls = false;"
mutate "M5 A7-F1 hostile-array detection (arrayTrap always false)" \
  "Array.isArray(v);
        return false;" "void 0;
        return false;"
mutate "M6 A7-F2 dropped-refs marker" \
  "markers.push('refs:dropped');" "void 0;"
mutate "M7 A7-F3 maxUsd trap fail-closed to zero" \
  "const maxUsd = maxUsdSlot.threw ? 0 : (maxUsdRaw ?? DEFAULT_MAX_USD);" \
  "const maxUsd = maxUsdRaw ?? DEFAULT_MAX_USD;"
mutate "M8 A7-F3 maxToolCalls trap fail-closed to zero" \
  "const maxToolCalls = maxToolCallsSlot.threw ? 0 : (maxToolCallsRaw ?? Math.min(DEFAULT_MAX_TOOL_CALLS, PROBES.length));" \
  "const maxToolCalls = maxToolCallsRaw ?? Math.min(DEFAULT_MAX_TOOL_CALLS, PROBES.length);"
mutate "M9 A7-F7 packet descriptor-trap disclosure (pd threw watcher)" \
  "if (d.threw)
            fieldTrap = true;" "void 0;"
mutate "M10 A7-F9 cumulative spend clamp" \
  "if (spendUsd > Number.MAX_SAFE_INTEGER)
            spendUsd = Number.MAX_SAFE_INTEGER;" "void 0;"

say ""
if [ "$fails" -eq 0 ]; then
  say "redteam: ALL MUTATIONS CAUGHT"
else
  say "redteam: $fails PROBLEM(S) — see above"
  exit 1
fi
