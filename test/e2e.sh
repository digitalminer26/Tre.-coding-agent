#!/usr/bin/env bash
# E2E suite — the full product surface against the LIVE 27B.
#
# Drives real processes (a real pty via macOS `script` for interactive
# modes) and asserts on:
#   - exit codes (I3: failures are data, never uncaught)
#   - rendered frames (grep on the raw pty capture; ANSI text is contiguous)
#   - filesystem effects (the agent actually did the work)
#   - session JSONL (persistence, resume, compaction entries)
#
# Usage:  bash test/e2e.sh            (all 14, ~15-25 min on the 27B)
#         bash test/e2e.sh 3 6        (scenarios 3..6 only)
#
# Per-scenario: own temp dir, own watchdog (kills the pty process group on
# stall). Model variance (27B is run-to-run variable) can fail a scenario
# even when the product is fine — the FAIL note says which assertion missed.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="node $ROOT/dist/src/cli/main.js"
MODELS="$ROOT/models.json"
WORK="$(mktemp -d /tmp/e2e-XXXXXX)"
FIRST="${1:-1}"; LAST="${2:-14}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

RESULTS=""
# ── helpers available INSIDE the pty feeder ───────────────────────────
# The feeder functions live in test/e2e-feederlib.sh and are SOURCED by
# the feeder bash (a real file parse). They used to be embedded in a
# double-quoted bash -c string, where quote-state desync silently mangled
# code (e.g. printf "/quit\r" -> printf /quitr) — fixed by sourcing a file.
FEEDER_LIB_FILE="$ROOT/test/e2e-feederlib.sh"

# _kill_watchdog <wpid> — stop a watchdog subshell IMMEDIATELY. A plain
# `kill` (TERM) is deferred by bash until the subshell's foreground `sleep`
# exits, which would block the scenario for the full watchdog window; and
# killing only the subshell orphans the sleep, which later fires its pkill
# at a LATER scenario sharing the tag. So: KILL the sleep child, then KILL
# the subshell (KILL is never deferred).
_kill_watchdog() {
  local wpid=$1
  [ -n "$wpid" ] || return 0
  pkill -KILL -P "$wpid" 2>/dev/null
  kill -KILL "$wpid" 2>/dev/null
  wait "$wpid" 2>/dev/null
  return 0
}

# guarded_run <timeout_s> <workdir> <cmd...> — run a plain (non-TUI) CLI
# command with a watchdog. Output → <workdir>/out.log (out2.log when out.log
# already exists — the kill-mid-run resume writes there, per scenario 11).
# Returns the command's exit code (137 = watchdog fired).
guarded_run() {
  local maxs=$1 D=$2; shift 2
  local out="$D/out.log"
  [ -f "$out" ] && out="$D/out2.log"
  ( sleep "$maxs" && pkill -9 -f "$D/s.jsonl" 2>/dev/null ) &
  local wpid=$!
  "$@" > "$out" 2>&1
  local rc=$?
  _kill_watchdog "$wpid"
  return $rc
}

# run <prompt> [flags...] — one-shot CLI (the guarded_run call sites pass
# this as a function name, not a binary).
run() { $BIN run "$@"; }

pty_feed() {
  local tag=$1 maxs=$2 out=$3 feed=$4; shift 4
  local off="${out%.log}.off" sess="" prev="" a
  for a in "$@"; do
    if [ "$prev" = "--session" ] || [ "$prev" = "--resume" ]; then sess=$a; fi
    prev=$a
  done
  ( sleep "$maxs" && pkill -9 -f "$WORK/$tag" 2>/dev/null ) &
  local wpid=$!
  # shellcheck disable=SC2086
  env OUT="$out" OFF="$off" SESS="$sess" FEED_DEBUG="${FEED_DEBUG:-0}" bash -c "
    source '$FEEDER_LIB_FILE'
    source '$feed'
  " | script -q /dev/null $BIN "$@" > "$out" 2>&1
  local rc=$?
  _kill_watchdog "$wpid"
  # The feeder's verdict wins over the pipeline's: macOS `script` returns 0
  # even for a SIGKILLed child, so the status file is the only trustworthy
  # signal. Missing = watchdog or feeder death → keep the pipeline rc.
  local st=""
  [ -f "${out}.status" ] && st=$(cat "${out}.status" 2>/dev/null)
  case "$st" in
    clean-exit) rc=0 ;;
    stall) rc=99 ;;
    gave-up) rc=1 ;;
  esac
  return $rc
}

record() { # name PASS|FAIL note
  RESULTS="$RESULTS  $1  $2  ${3:-ok}\n"
  log "$2  $1 — ${3:-ok}"
}

# ───────────────────────────── scenarios ─────────────────────────────

scenario_01() { # TUI basic: prompt → write → approval → file → /quit rc=0
  local D="$WORK/01"; mkdir -p "$D"
  cat > "$D/feed.sh" <<'EOF'
echo "FEED $(date +%H:%M:%S) feeder started (SESS=$SESS)" >&2
printf 'Create the file e2e-out.txt with the single line: e2e-one.\r'
echo "FEED $(date +%H:%M:%S) prompt sent" >&2
# The 27B often chains tools (write → verify-read), each gated → loop approvals.
# (No "✓" wait after the loop: the offset has already advanced past the first
# result mark — the file assertion below is the real check.)
i=0
while [ $i -lt 4 ]; do
  approval_or_done 240
  [ $? -eq 0 ] || break
  printf 'y\r'; sleep 8; i=$((i+1))
done
wait_turn_done "$SESS" 180 || true
sleep 3
quit_retry
EOF
  pty_feed 01 480 "$D/out.log" "$D/feed.sh" tui --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc (137=watchdog 480s, 99=stall/nothing-running, other=app)"; return 1; }
  grep -qF "e2e-one" "$D/e2e-out.txt" 2>/dev/null || { echo "file content wrong: $(cat "$D/e2e-out.txt" 2>/dev/null)"; return 1; }
  grep -q '"type":"message"' "$D/s.jsonl" || { echo "no messages in session"; return 1; }
  echo "rc=0, file exact, session persisted ($(grep -c '"type":"message"' "$D/s.jsonl") msgs)"
}

scenario_02() { # TUI resume: --resume, model must know the earlier file
  local D="$WORK/01"; [ -f "$D/s.jsonl" ] || { echo "needs scenario 01's session"; return 1; }
  rm -f "$D/out2.off"
  cat > "$D/feed2.sh" <<'EOF'
start_users=$(grep -c '"role":"user"' "$SESS" 2>/dev/null) || start_users=0
printf 'Append the exact line e2e-two to the file you created earlier.\r'
wait_new_user_msg "$start_users" 120 || exit 6
i=0
while [ $i -lt 4 ]; do
  approval_or_done 240
  [ $? -eq 0 ] || break
  printf 'y\r'; sleep 8; i=$((i+1))
done
wait_turn_done "$SESS" 180 || true
sleep 3
quit_retry
EOF
  pty_feed 01 480 "$D/out2.log" "$D/feed2.sh" tui --resume "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF "e2e-two" "$D/e2e-out.txt" 2>/dev/null || { echo "resume did not reach the earlier file: $(cat "$D/e2e-out.txt" 2>/dev/null)"; return 1; }
  echo "rc=0, model acted on replayed context (appended to earlier file)"
}

scenario_03() { # TUI edit diff: -/+ lines rendered under the edit call
  local D="$WORK/03"; mkdir -p "$D"
  printf 'x = 1\ny = 2\nz = 3\n' > "$D/a.txt"
  cat > "$D/feed.sh" <<'EOF'
printf 'The file a.txt in the working directory contains the lines: x = 1, y = 2, z = 3. Use the edit tool to change "x = 1" to "x = 2". Nothing else.\r'
wait_turn_done "$SESS" 600 || true
sleep 3
quit_retry
EOF
  pty_feed 03 480 "$D/out.log" "$D/feed.sh" tui --yes --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF -- "- x = 1" "$D/out.log" || { echo "diff - line missing from frames"; return 1; }
  grep -qF -- "+ x = 2" "$D/out.log" || { echo "diff + line missing from frames"; return 1; }
  head -1 "$D/a.txt" | grep -qF "x = 2" || { echo "file not edited"; return 1; }
  echo "rc=0, diff rendered, file edited"
}

scenario_04() { # TUI deny: 'n' → isError result (✗) → run continues → rc=0
  # D13 `local` default auto-approves workspace-scoped bash, so the command
  # must reach OUTSIDE the workspace to get an approval prompt at all.
  local D="$WORK/04"; mkdir -p "$D"
  cat > "$D/feed.sh" <<'EOF'
printf 'Run the bash command: cat /etc/hostname\r'
i=0
while [ $i -lt 3 ]; do
  approval_or_done 240
  [ $? -eq 0 ] || break
  printf 'n\r'; sleep 10; i=$((i+1))
done
wait_turn_done "$SESS" 180 || true
sleep 3
quit_retry
EOF
  pty_feed 04 480 "$D/out.log" "$D/feed.sh" tui --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF "✗ bash" "$D/out.log" || grep -q "✗" "$D/out.log" || { echo "no denied tool result (✗) in frames"; return 1; }
  echo "rc=0, denial rendered as ✗ isError result"
}

scenario_05() { # TUI ctrl+c: aborts the running turn, prompt returns, rc=0
  # D13 `local` default auto-approves workspace-scoped bash, so the command
  # must reach OUTSIDE the workspace to get the 'y approve' prompt first.
  local D="$WORK/05"; mkdir -p "$D"
  cat > "$D/feed.sh" <<'EOF'
printf 'Run the bash command: sleep 40 && cat /etc/hostname\r'
if new_since "$OFF" "$OUT" "y approve" 300; then printf 'y\r'; sleep 8; fi
# wait for the sleep tool to actually start running (the tool line renders
# the JSON args; the prompt echo does not contain "command:"). The command
# value keeps its "&& echo done-sleeping" tail, so match without the closing
# quote — the quoted form never matched the real tool line (WS10 e2e re-run).
if wait_pattern "$OUT" '"command":"sleep 40' 300; then # tool line still starts with "sleep 40"
  sleep 3
  printf '\x03'
  new_since "$OFF" "$OUT" "aborted" 120 || exit 7
  wait_idle 60 || true
fi
sleep 3
quit_retry
EOF
  pty_feed 05 480 "$D/out.log" "$D/feed.sh" tui --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF "aborted" "$D/out.log" || { echo "no 'aborted' item in frames"; return 1; }
  echo "rc=0, mid-run abort rendered, session kept"
}

scenario_06() { # TUI history: ↑ re-enters the previous prompt, Enter resubmits
  local D="$WORK/06"; mkdir -p "$D"
  cat > "$D/feed.sh" <<'EOF'
printf 'Reply with exactly the word: alpha\r'
new_since "$OFF" "$OUT" "alpha" 300 || exit 6
wait_turn_done "$SESS" 180 || true
flush_off               # consume everything; only the RESUBMIT may match now
printf '\x1b[A'
sleep 1
printf '\r'
new_since "$OFF" "$OUT" "alpha" 300 || exit 6
wait_turn_done "$SESS" 180 || true
# clear any leftover input (history text if the resubmit was busy-ignored),
# then quit
clear_line 60
quit_retry
EOF
  pty_feed 06 480 "$D/out.log" "$D/feed.sh" tui --yes --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  local n=$(grep -ci "reply with exactly the word: alpha" "$D/s.jsonl" 2>/dev/null)
  [ ${n:-0} -ge 2 ] || { echo "prompt submitted once (n=${n:-0}) — history resubmit missed"; return 1; }
  echo "rc=0, prompt submitted twice via ↑/Enter"
}

scenario_07() { # one-shot run: rc=0, work done, session persisted
  local D="$WORK/07"; mkdir -p "$D"
  guarded_run 360 "$D" run "Create the file one.txt with the single line: one-line. Then stop." \
    --yes --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc: $(tail -3 "$D/out.log")"; return 1; }
  grep -qF "one-line" "$D/one.txt" 2>/dev/null || { echo "file wrong: $(cat "$D/one.txt" 2>/dev/null)"; return 1; }
  grep -q '"type":"message"' "$D/s.jsonl" || { echo "no session"; return 1; }
  echo "rc=0, file exact, session persisted"
}

scenario_08() { # REPL piped: two prompts + EOF → rc=0; then one-shot --resume
  local D="$WORK/08"; mkdir -p "$D"
  ( sleep 480 && pkill -9 -f "$D/s.jsonl" 2>/dev/null ) &
  local wpid=$!
  printf 'Reply with exactly the word: repl-one\nReply with exactly the word: repl-two\n' \
    | $BIN --yes --session "$D/s.jsonl" --cwd "$D" > "$D/out.log" 2>&1
  local rc=$?
  _kill_watchdog "$wpid"
  [ $rc -eq 0 ] || { echo "exit code $rc: $(tail -3 "$D/out.log")"; return 1; }
  grep -qF "repl-one" "$D/out.log" && grep -qF "repl-two" "$D/out.log" || { echo "missing REPL responses"; return 1; }
  local msgs=$(grep -c '"type":"message"' "$D/s.jsonl" 2>/dev/null)
  [ "$msgs" -ge 4 ] || { echo "session has $msgs messages, want ≥4"; return 1; }
  guarded_run 300 "$D" run "Reply with exactly the word: repl-three" --yes --resume "$D/s.jsonl" --cwd "$D"
  rc=$?
  [ $rc -eq 0 ] || { echo "resume exit code $rc"; return 1; }
  grep -qF "repl-three" "$D/out2.log" || { echo "resume run produced no response"; return 1; }
  echo "rc=0 both, $msgs msgs in session, resume works"
}

scenario_09() { # --no-approve: gated bash blocked as isError, run completes
  local D="$WORK/09"; mkdir -p "$D"
  guarded_run 300 "$D" run "Run the bash command: echo blocked-probe" --no-approve \
    --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -q "✗" "$D/out.log" || { echo "no ✗ (blocked result) in output"; return 1; }
  echo "rc=0, gated tool blocked as isError result"
}

scenario_10() { # sandbox: path escape (file outside the workspace) blocked even with --yes
  # The leak check uses a random CANARY file OUTSIDE the workspace, not a
  # grep for "root:": the model KNOWS the standard first line of /etc/passwd
  # from training, so it can "answer" the old prompt from parametric knowledge
  # while both sandboxes block the real file — the old check false-positived
  # on that (2026-09-18: read tool blocked AND Seatbelt returned
  # "Operation not permitted", yet `grep "root:"` matched the model's own
  # recitation). A random canary is unguessable → the leak check is precise.
  # (The /etc denylist itself is pinned at the kernel level by
  # test/sandbox.test.ts: `cat /etc/passwd` must FAIL under the profile.)
  local D="$WORK/10"; mkdir -p "$D"
  local CANARY="CANARY-10-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s\n' "$CANARY" > "$WORK/outside-canary-10.txt"
  guarded_run 300 "$D" run "Read the file $WORK/outside-canary-10.txt and tell me the first line." --yes \
    --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -q "✗\|Operation not permitted" "$D/out.log" || { echo "sandbox escape was not blocked (no ✗ / 'Operation not permitted')"; return 1; }
  grep -qF "$CANARY" "$D/out.log" && { echo "FAIL: canary leaked into output — sandbox bypassed"; return 1; }
  echo "rc=0, escape blocked, canary not leaked"
}

scenario_11() { # kill -9 mid-run → resume replays partial session cleanly
  local D="$WORK/11"; mkdir -p "$D"
  ( sleep 300; pkill -9 -f "$D/s.jsonl" 2>/dev/null ) &
  local wpid=$!
  $BIN run "Run the bash command: sleep 25 && echo slept" --yes \
    --session "$D/s.jsonl" --cwd "$D" > "$D/out.log" 2>&1 &
  local pid=$!
  sleep 25
  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  [ -f "$D/s.jsonl" ] || { echo "no session after kill"; return 1; }
  guarded_run 300 "$D" run "Reply with exactly the word: survived" --yes --resume "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "resume exit code $rc: $(tail -3 "$D/out2.log")"; return 1; }
  grep -qF "survived" "$D/out2.log" || { echo "no response after resume"; return 1; }
  grep -qF "resumed" "$D/out2.log" || { echo "no 'resumed' note on stderr"; return 1; }
  echo "rc=0, killed mid-run, resume replays cleanly"
}

scenario_12() { # TUI compaction: small window → ✂ line + compaction entry
  local D="$WORK/12"; mkdir -p "$D"
  # small-window copy of the real model (client-side trigger only)
  python3 - "$MODELS" "$D/models.json" <<'PY'
import json, sys
src = json.load(open(sys.argv[1]))
m = dict(src["models"][0])
m["id"] = m["id"]  # same served model
m["contextWindow"] = 4096
m["maxTokens"] = 512
json.dump({"default": m["id"], "models": [m]}, open(sys.argv[2], "w"), indent=2)
PY
  # ~12KB each: one read alone blows the 4096 window (with the system prompt)
  python3 - "$D" <<'PY'
import sys
d = sys.argv[1]
for name, marker in (("a.md", "ALPHA-MARKER-0001"), ("b.md", "BETA-MARKER-0002")):
    lines = [f"{marker} is the first line."] + ["filler " * 60 + f" line {i}" for i in range(1, 200)]
    open(f"{d}/{name}", "w").write("\n".join(lines) + "\n")
PY
  cat > "$D/feed.sh" <<'EOF'
printf 'Do these steps one at a time, in order. Step 1: read a.md. Step 2: read b.md. Step 3: create c.md containing the first line of a.md followed by the first line of b.md. Do not batch steps.\r'
# "Wrote" = the write tool's result prefix (one dimColor span, contiguous);
# matches the c.md write specifically (not the earlier reads)
wait_turn_done "$SESS" 440 || true
sleep 3
quit_retry
EOF
  pty_feed 12 480 "$D/out.log" "$D/feed.sh" tui --yes --models "$D/models.json" \
    --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF "✂ compacted" "$D/out.log" || { echo "no ✂ compaction line in frames"; return 1; }
  grep -q '"type":"compaction"' "$D/s.jsonl" || { echo "no compaction entry in session"; return 1; }
  grep -qF "ALPHA-MARKER-0001" "$D/c.md" 2>/dev/null && grep -qF "BETA-MARKER-0002" "$D/c.md" 2>/dev/null \
    || { echo "c.md missing markers: $(head -2 "$D/c.md" 2>/dev/null)"; return 1; }
  echo "rc=0, ✂ rendered, compaction entry persisted, task completed across compaction"
}

scenario_13() { # eval baseline (D9: regression baseline, variance-annotated)
  local D="$WORK/13"; mkdir -p "$D"
  ( cd "$ROOT" && npm run eval > "$D/out.log" 2>&1 ) &
  local pid=$!
  # 900s: eval is per-task budgeted (3 x 180s) plus tsc build headroom (WS10 s13)
  ( sleep 900 && kill -9 "$pid" 2>/dev/null ) &
  local wpid=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  _kill_watchdog "$wpid"
  local passes fails
  passes=$(grep -c "PASS" "$D/out.log" 2>/dev/null)
  fails=$(grep -c "FAIL" "$D/out.log" 2>/dev/null)
  [ $rc -eq 0 ] && [ "$fails" -eq 0 ] || { echo "eval rc=$rc passes=$passes fails=$fails (27B variance?)"; return 1; }
  echo "$passes/$passes tasks PASS"
}

scenario_14() { # TUI pinned layout: input row exactly 4 lines above the bottom
  local D="$WORK/14"; mkdir -p "$D"
  cat > "$D/feed.sh" <<'EOF'
printf 'Reply with exactly: PONG-14\r'
wait_turn_done "$SESS" 440 || true
sleep 3
quit_retry
EOF
  pty_feed 14 480 "$D/out.log" "$D/feed.sh" tui --yes --models "$MODELS" \
    --session "$D/s.jsonl" --cwd "$D"
  local rc=$?
  [ $rc -eq 0 ] || { echo "exit code $rc"; return 1; }
  grep -qF "PONG-14" "$D/out.log" || { echo "no PONG-14 in frames"; return 1; }
  # ANSI-strip (CSI sequences + charset selection + other escapes), then
  # check the LAST 7 lines: hint / ─ separator / you-input / ─ separator /
  # 3 reserved blank. (python3, not sed: macOS sed chokes on \x1b escapes
  # with "illegal byte sequence" and emits nothing.)
  python3 - "$D/out.log" "$D/plain.txt" <<'PY'
import re, sys
raw = open(sys.argv[1], "rb").read().decode("utf-8", "replace")
clean = re.sub(r"\u001b(?:\[[0-9;?]*[a-zA-Z]|\][^\u0007]*\u0007|[@-Z\\-_])", "", raw)
clean = clean.replace("\r", "")
open(sys.argv[2], "w").write(clean)
PY
  # The PTY log is a CONCATENATION of every frame, so `tail -N` cannot be
  # trusted (the previous frame's reserved blanks bleed into the tail).
  # D15: the input row is plain text (no 'you' prefix), so anchor on the
  # LAST hint line (rendered in every frame, --yes means no approval hint).
  # D16: when the input holds a bare "/" command word (the feeder types
  # /quit before submitting it), the completion menu renders BETWEEN the
  # hint and the top separator — skip up to MENU_MAX_LINES (5) menu lines
  # ("> /…" or "  /…") before asserting the pinned block: ─ / input / ─ /
  # 3 reserved blank lines.
  local hintline; hintline=$(grep -n "enter send" "$D/plain.txt" | tail -1 | cut -d: -f1)
  [ -n "$hintline" ] || { echo "no hint line found in frames"; return 1; }
  local i l k base=$((hintline))
  for ((k = 0; k < 5; k++)); do
    l=$(sed -n "$((base+1))p" "$D/plain.txt")
    case "$l" in "> /"* | "  /"*) base=$((base+1));; *) break;; esac
  done
  l=$(sed -n "$((base+1))p" "$D/plain.txt")
  echo "$l" | grep -qE '^─+$' || { echo "top separator wrong: '$l'"; return 1; }
  l=$(sed -n "$((base+2))p" "$D/plain.txt")
  # input row: blank after the prompt was sent, or the /quit quit_retry typed
  [ -z "$l" ] || [ "$l" = " " ] || case "$l" in /*) ;; *) echo "input row wrong: '$l'"; return 1;; esac
  l=$(sed -n "$((base+3))p" "$D/plain.txt")
  echo "$l" | grep -qE '^─+$' || { echo "bottom separator wrong: '$l'"; return 1; }
  local ok=1
  for i in 4 5 6; do
    l=$(sed -n "$((base+i))p" "$D/plain.txt")
    [ -z "$l" ] || [ "$l" = " " ] || { echo "reserved line +$i not blank: '$l'"; ok=0; }
  done
  [ $ok -eq 1 ] || return 1
  echo "rc=0, PONG-14 rendered, pinned block (hint[/menu]/─/input/─/3×blank) at the bottom"
}

# ───────────────────────────── runner ─────────────────────────────

run_one() {
  local i=$1 name ok note
  case "$i" in
    1) name="tui-basic(write+approve)" ;;
    2) name="tui-resume(context replay)" ;;
    3) name="tui-editdiff(-/+ render)" ;;
    4) name="tui-deny(isError result)" ;;
    5) name="tui-ctrl-c-abort" ;;
    6) name="tui-history-resubmit" ;;
    7) name="one-shot-run" ;;
    8) name="repl-piped+resume" ;;
    9) name="no-approve-block" ;;
    10) name="sandbox-escape-block" ;;
    11) name="kill-mid-run+resume" ;;
    12) name="tui-compaction(✂)" ;;
    13) name="eval-baseline" ;;
    14) name="tui-pinned-layout" ;;
    *) echo "unknown scenario $i"; return 1 ;;
  esac
  note="$(scenario_$(printf '%02d' "$i") 2>&1)"; ok=$?
  if [ $ok -eq 0 ]; then record "$name" PASS "$note"; else record "$name" FAIL "$note"; fi
}

log "E2E work dir: $WORK (scenarios $FIRST..$LAST)"
log "dist must be built: running tsc first"
( cd "$ROOT" && npx tsc ) || { echo "tsc failed"; exit 1; }

for ((i = FIRST; i <= LAST; i++)); do
  run_one "$i"
done

echo
echo "════════ E2E SUMMARY ════════"
printf "%b" "$RESULTS"
echo "  frames/sessions: $WORK/<nn>/ (out.log = pty capture, s.jsonl = session)"
