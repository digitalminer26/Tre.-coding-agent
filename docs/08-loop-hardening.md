# Spec — Loop hardening: windowed stall guard (H1) + follow-ups (H2–H4)

Status: **H1 approved 2026-09-30 (this session); H2–H4 logged, not yet
implemented.** All new logic is L3 (independent); no pi prior art (see
`docs/03-citation-policy.md`).

Scope (H1): `src/tools/pipeline.ts` (stall-guard state machine),
`test/tools.test.ts` (stall-guard cases), `docs/02-contracts.md` (stall
contract bullet), `HANDOFF.md`. No `src/loop/agent-loop.ts` change (the
loop already maps `details.stall` → `stopReason "stall"` — H1 only makes
the pipeline's trigger fire in more cases). No guardrail-zone files
(`pipeline.ts` is NOT in the zone; the zone is `sandbox.ts` / `safety.ts` /
`bash.ts` / hook scripts / the self-improve skill). No `models.json` change.

## Why

The loop issue keeps happening. The 2026-09-30 WIP session (docs/07 item
1, cache visibility) got stuck re-issuing calls that displayed the same
directory over and over, and only the turn budget eventually stopped it —
after wasting the session's remaining budget. The codebase already has
three guards, and the loop walked through the gaps between them:

| Guard | Where | Catches | Stops on |
|---|---|---|---|
| C26 loop guard | `agent-loop.ts` | byte-identical tool-call batch (names + stable-JSON args + order) 3× in a row | `loop` |
| Stall guard | `pipeline.ts` | same TOOL failing with a PERMISSION signature 3× **consecutively** | `stall` |
| Turn budget | `agent-loop.ts` | anything, eventually (per-cycle cap + 3 auto-continuations) | `budget` |

The holes:

1. **Rephrased-but-failing loops that aren't permission failures.** A model
   re-running the same test, re-listing the same directory, or re-reading
   the same file with slightly different args produces a "new" batch every
   time — the loop guard never sees a repeat, and the stall guard never
   sees a permission signature. Only the turn budget catches it, late.
2. **Interleaved successes reset the stall counter.** The stall guard
   requires 3 CONSECUTIVE permission failures of the same tool. A model
   probing a boundary — `ls dir` (denied), `ls other` (ok, **resets**),
   `ls dir` (denied), `ls other` (ok, **resets**) — never reaches
   3-in-a-row. This is the shape of "displaying a particular directory
   over and over": the target call fails repeatedly while legitimate
   sibling calls succeed in between.
3. **No visibility.** When a guard finally fires, the stop event carries
   no evidence of WHAT looped — the trigger signature is discarded.

## Items

### H1 — Windowed stall guard (this increment)

**What.** The permission-stall count survives interleaved successes. A
model that keeps hitting the same deterministic wall — with legitimate
work in between — is still banging on the wall.

**State.** Per tool, per executor instance (as today):

- `failCount` — the number of permission-signature failures of that tool
  within the recent window (as today, but NOT reset by a success or by a
  non-permission failure of the same tool);
- `window` — the last `STALL_WINDOW` (8) tool calls of that tool (any
  outcome: success, permission failure, non-permission failure);
- the "current tool" pointer (the most recent tool with a non-zero
  count) — switching to a different tool moves the pointer (each tool has
  its own count + window; the pointer only decides which tool a new
  failure extends).

**Trigger.** The Nth permission failure of a tool stalls when
`failCount >= STALL_THRESHOLD` (3) — i.e. 3 permission failures within
the last 8 calls of that tool. The 3rd-in-window failure is replaced
in-band with `stallText(tool)` + `details.stall` (I3: every call gets a
result), the call WAS executed (a denial is a harmless no-op), and the
loop stops with `stopReason "stall"` (resumable — unchanged).

**Reset rules (the behavior change, precisely):**

- A SUCCESS of the tool no longer resets `failCount` (this is the fix —
  the probe loop). It does occupy a slot in the window.
- A NON-permission failure of the tool no longer resets `failCount`
  (consistent: the count is "how often did this tool hit the wall
  recently", not "how many wall-hits in a row"). It occupies a slot.
- The window sliding past a failure drops it from `failCount` (a stale
  denial 8+ calls ago must not stall a fresh retry).
- A different tool: its own count/window is untouched (as today — the
  "different tool resets" test's INTENT is preserved: a read chain does
  not inherit a write chain; each tool is counted independently).

**Constants.** `STALL_WINDOW = 8`, `STALL_THRESHOLD = 3` — exported for
tests and tuning. Rationale: 3 is the existing threshold (two identical
retries remain legitimate); 8 is wide enough that a normal retry
discipline (fail → investigate → retry → investigate) never accumulates
3 wall-hits, and narrow enough that a probe loop reaches the threshold
within a handful of turns.

**Edge cases.**

- 3 permission failures spread across 8 calls of the tool → stall on the
  3rd (the new behavior; previously no stall).
- 2 permission failures within 8 calls, then the model moves on (the tool
  is not called again, or is called and succeeds many times) → no stall
  (the count persists but never reaches 3; a run that ends normally is
  unaffected).
- The same tool fails with a permission signature 3× within 8 calls, but
  the 3rd is a DIFFERENT operation that the sandbox happens to deny (e.g.
  two unrelated denials plus a third unrelated denial) → stall. Accepted
  trade-off: permission denials are deterministic (the existing module
  comment says so), and a model that collects 3 denials of one tool in 8
  calls is, in practice, probing. The stop is resumable — a false
  positive costs one nudge, not the work.
- Executor state is per-run (the CLI builds one executor per run) —
  unchanged.

**Display/contract.** `stopReason` stays `stall`; `stallText` is
unchanged (it already says "failed 3 times … with a permission denial" —
still true; the 3 need not be consecutive). `docs/02-contracts.md` stall
bullet updated: "consecutive" → "within the last 8 calls of that tool",
reset rules restated.

### H2 — Same-failure repetition guard (logged, not designed)

Same tool + same args + same normalized error text (non-permission) 3×
within a window → stop (new stopReason or reuse `stall` with a distinct
text — decide in the design pass). Catches "the same test fails
identically" and "the same command errors identically" churn — the
rephrased-variant of the loop guard. Needs care: transient-but-identical
failures (a flaky network) are legitimate retries, so the normalized-text
match must be strict and the threshold conservative.

### H3 — Loop visibility (logged, not designed)

On `loop`/`stall` stop, the stop event and the TUI surface the TRIGGERING
signature (which batch/call repeated, how many times). Today the evidence
is discarded at stop — the next loop incident is diagnosed from holes in
the guards, not from the transcript. Small change: `agent_end` (and the
`tool_execution_end` that carried `details.stall`) already has the data;
it needs to be named and displayed.

### H4 — Checkpoint commits (protocol change, NOT an agent commit)

`.tre/skills/self-improve/SKILL.md` is guardrail zone — a human commits
this change with `GUARDRAIL_BYPASS=1`. Allow committing a
**green-but-incomplete** increment (build + full test suite pass, but the
feature is not finished) as an explicitly-marked WIP commit
(`wip: <what> — <what remains>`). The loop's real cost in the 2026-09-30
session was that the finished half of docs/07 item 1 was never committed;
checkpoint commits cap the loss at the last half-hour instead of the whole
session.

## Exit criteria (H1)

- `STALL_WINDOW` / `STALL_THRESHOLD` exported; the state machine matches
  the reset rules above exactly.
- `test/tools.test.ts`: the existing stall cases are updated where their
  asserted behavior changed (the "success resets" case now asserts the
  WINDOWED behavior: a success interleaved between failures does NOT
  reset; a window slide DOES), plus new cases: (a) probe loop —
  fail/ok/fail/ok/fail → stall on the 5th call; (b) window slide —
  2 failures, then 7 other calls, then a 3rd failure → no stall; (c)
  independent per-tool counts (the "different tool" case's intent);
  (d) 3 failures within 8 of a different tool's success-streak → stall.
- `docs/02-contracts.md` stall bullet restated (window, not consecutive).
- `npm run build` + `npm test` green. No TUI change (H1 is pipeline-only;
  no PTY frame check needed — the stall stop path is unchanged).

## 7. Future items (logged, not designed)

- **F1 — Progress detection.** Notice "the same file edited N times with
  no successful verification in between" or "N turns with zero successful
  calls". The strongest anti-loop signal and the riskiest (false positives
  on legitimately iterative work) — needs its own design pass.
- **F2 — Loop telemetry.** Count loop/stall/budget stops per session in
  the TUI bottom line, so the user sees the agent fighting its cage in
  real time (pairs with H3).
