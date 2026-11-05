#!/bin/sh
# P15 investigation-agent red-team driver.
#
# Three phases:
#   0. build     — ALWAYS rebuild dist from src (cycle-A7 F4: phase 1 used
#                  to run against whatever dist/ already existed — break
#                  src, run this script, and it printed green against the
#                  stale build. Freshness is not optional in a suite whose
#                  whole job is proving the CURRENT code discriminates).
#                  Phase 0 also PROVES the unit leg is live on the clean
#                  build (cycle-A8 F3: with a missing/broken test path,
#                  every "caught" verdict was unverifiable).
#   1. probes    — scripts/redteam-investigation.mjs: hostile packets against
#                  the built agent with asserted disclosures (A5/A6/A7/A8).
#   2. mutations — delete each protection from the BUILT agent one at a time
#                  and re-run the probes + the unit tests. EVERY mutation must
#                  be CAUGHT-BEHAVIORALLY (cycle-A8 F3: a mutant that merely
#                  fails to LOAD, or a leg that never ran, used to count as
#                  caught — a broken mutant is not evidence the suite
#                  discriminates). (Cycle-A6 lesson: an A5 test stayed green
#                  with its guard removed — mutate-before-believing.)
#
# Concurrency (cycle-A7 F5 + A8 F5): an exclusive lock dir holds for the
# whole run — a second run ABORTS rather than rebuilding dist or sweeping
# under the first's feet (the PID-suffixed BAK alone never protected the
# SHARED dist target, and the old blind sweep deleted a live run's BAK).
# A lock left by a killed run is taken over only when its PID is dead.
#
# Run from the repo root: sh scripts/redteam.sh
set -eu
cd "$(dirname "$0")/.."

TARGET=dist/src/investigation/agent.js
UNITTEST=dist/test/investigation.test.js
BAK="$TARGET.redteam-bak.$$"
LOCK="dist/.redteam-lock.$$"
fails=0

say() { printf '%s\n' "$*"; }

cleanup() {
  cp "$BAK" "$TARGET" 2>/dev/null || true
  rm -f "$BAK"
  rm -rf "$LOCK"
}

# ── exclusive lock (A8-F5): dist is shared mutable state ──
if ! mkdir "$LOCK" 2>/dev/null; then
  other=$(ls dist/.redteam-lock.* 2>/dev/null | grep -v "/$LOCK\$" | head -n 1 || true)
  opid=${other##*-lock.}
  if [ -n "${opid:-}" ] && kill -0 "$opid" 2>/dev/null; then
    say "redteam: another run (pid $opid) holds $other — refusing to touch shared dist"
    rm -rf "$LOCK"
    exit 1
  fi
  say "note: taking over lock from dead run: $other"
  rm -rf "$other" 2>/dev/null || true
  mkdir "$LOCK"
fi
trap cleanup EXIT INT TERM

say "── phase 0: fresh build (A7-F4: never trust a stale dist) ─"
if ! npm run build >/dev/null 2>&1; then
  say "redteam: BUILD FAILED — refusing to probe a stale dist"
  exit 1
fi
if [ ! -f "$TARGET" ]; then
  say "redteam: build produced no $TARGET"
  exit 1
fi
# Liveness precheck (A8-F3): the mutation verdicts depend on BOTH legs;
# prove they run and pass on the clean build BEFORE believing any CAUGHT.
if [ ! -f "$UNITTEST" ]; then
  say "redteam: unit leg missing ($UNITTEST) — build tests too (npm run build must compile test/)"
  exit 1
fi
uout=$(node --test "$UNITTEST" 2>&1) || {
  say "redteam: unit leg FAILS on the clean build — fix it before mutating"
  exit 1
}
case "$uout" in
  *"# pass "*"0"*) : ;;  # ran with a pass count
  *) say "redteam: unit leg produced no pass summary — leg is not live" ; exit 1 ;;
esac
# Sweep stale BAKs ONLY from dead PIDs (mine is PID-suffixed; a live
# run's BAK is never touched — A8-F5).
for stale in "$TARGET".redteam-bak.*; do
  [ "$stale" = "$TARGET.redteam-bak.*" ] && continue   # glob matched nothing
  spid=${stale##*-bak.}
  case "$spid" in ''|*[!0-9]*) continue ;; esac
  if kill -0 "$spid" 2>/dev/null; then
    say "note: leaving backup of LIVE run $spid: $stale"
  else
    say "note: removing stale backup from a killed run: $stale"
    rm -f "$stale"
  fi
done

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

# Each entry: NAME | sed pattern | sed replacement. Patterns are matched
# by EXACT count against the built agent — the count check is the real
# guard; the grep is only a fast pre-filter. A pattern miss is a SKIP +
# counted failure, NOT a fatal abort (A8-F3: one moved pattern used to
# kill the whole run under set -e and hide the remaining verdicts).
mutate() {
  name="$1"; pat="$2"; rep="$3"
  if ! grep -qF -- "$(printf '%s' "$pat" | head -n1)" "$BAK"; then
    say "SKIP  $name (pattern not found — the protection moved, update this script!)"
    fails=$((fails + 1))
    return
  fi
  if ! RT_PAT="$pat" RT_REP="$rep" python3 - "$BAK" "$TARGET" <<'PYEOF'
import os, sys
src = open(sys.argv[1]).read()
pat = os.environ["RT_PAT"]; rep = os.environ["RT_REP"]
assert src.count(pat) == 1, f"pattern not unique ({src.count(pat)}x): {pat}"
open(sys.argv[2], "w").write(src.replace(pat, rep))
PYEOF
  then
    say "SKIP  $name (pattern not unique / rewrite failed — update this script!)"
    fails=$((fails + 1))
    cp "$BAK" "$TARGET"
    return
  fi
  if cmp -s "$BAK" "$TARGET"; then
    say "SKIP  $name (mutation changed nothing — update this script!)"
    fails=$((fails + 1))
    return
  fi
  # CAUGHT-BEHAVIORALLY (cycle-A8 F3): the leg must have EXECUTED and
  # failed on a check — a crash before any check line is a broken
  # mutant, not evidence, and is reported as such.
  if pout=$(node scripts/redteam-investigation.mjs 2>&1); then
    tout=$(node --test "$UNITTEST" 2>&1) && rc=0 || rc=1
    case "$tout" in
      *#" tests "*)
        case "$tout" in
          *#" fail 0"*) : ;;  # should be unreachable when rc=1
        esac
        if [ $rc -ne 0 ]; then
          case "$tout" in *"fail "[1-9]*) say "CAUGHT  $name (unit leg)"; return; esac
          say "CRASH? $name (unit leg failed without a failing test count)"; fails=$((fails + 1)); cp "$BAK" "$TARGET"; return
        fi
        say "SURVIVED $name  ← the suite does not discriminate this protection!"
        fails=$((fails + 1))
      ;;
      *)
        say "CRASH? $name (unit leg ran no tests — broken mutant is not a catch)"
        fails=$((fails + 1))
      ;;
    esac
  else
    case "$pout" in
      *"PASS "*|*"FAILURE"*) say "CAUGHT  $name (probe leg)"; cp "$BAK" "$TARGET"; return ;;
      *) say "CRASH? $name (probe died before any check line — broken mutant is not a catch)"; fails=$((fails + 1)) ;;
    esac
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
mutate "M7 A8-F1 maxUsd fail-closed on ANY hostile limits input" \
  "const maxUsd = badMaxUsd ? 0 : (maxUsdRaw ?? DEFAULT_MAX_USD);" \
  "const maxUsd = maxUsdSlot.threw ? 0 : (maxUsdRaw ?? DEFAULT_MAX_USD);"
mutate "M8 A8-F1 maxToolCalls fail-closed on ANY hostile limits input" \
  "const maxToolCalls = badMaxCalls ? 0 : (maxToolCallsRaw ?? Math.min(DEFAULT_MAX_TOOL_CALLS, PROBES.length));" \
  "const maxToolCalls = maxToolCallsSlot.threw ? 0 : (maxToolCallsRaw ?? Math.min(DEFAULT_MAX_TOOL_CALLS, PROBES.length));"
mutate "M9 A7-F7 packet descriptor-trap disclosure (pd threw watcher)" \
  "if (d.threw)
            fieldTrap = true;" "void 0;"
mutate "M10 A7-F9 cumulative spend clamp" \
  "if (spendUsd > Number.MAX_SAFE_INTEGER)
            spendUsd = Number.MAX_SAFE_INTEGER;" "void 0;"
mutate "M13 A8-F4 saturation stops probe admission" \
  "if (spendUsd >= Number.MAX_SAFE_INTEGER || spendUsd + next.estimateUsd > maxUsd + 1e-9" \
  "if (spendUsd + next.estimateUsd > maxUsd + 1e-9"
mutate "M14 A8-F2 revoked/trapping facts-handle disclosure" \
  "if (mergeFacts(explicit, factsRaw) || trapPresent(factsRaw))
            fieldTrap = true;" "if (mergeFacts(explicit, factsRaw))
            fieldTrap = true;"
mutate "M15 A8-F6 trap-discards also mark the handle hostile" \
  "return { refs: [], overflow: false, scanExhausted: false, dropped: true, hostile: true };" \
  "return { refs: [], overflow: false, scanExhausted: false, dropped: true, hostile: false };"

say ""
if [ "$fails" -eq 0 ]; then
  say "redteam: ALL MUTATIONS CAUGHT"
else
  say "redteam: $fails PROBLEM(S) — see above"
  exit 1
fi
