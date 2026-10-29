# Spec — Loop hardening: windowed stall guard (H1) + follow-ups (H2–H5)

Status: **H1 approved 2026-09-30, IMPLEMENTED (commit `2a12ca0` — the
windowed guard, `STALL_WINDOW` 8 / 3 failures, is in `src/tools/pipeline.ts`);
H2 + H5 implemented. H3 (loop visibility) IMPLEMENTED 2026-10-20 (D33, §10);
H4 (checkpoint commits) NOT ADOPTED by the D33 ruling (commits stay at the
current threshold — see §5 H4). F1 (progress
detection) IMPLEMENTED 2026-10-20 (D32, §9) — variant B + A3 both landed
together (one turn-level state machine), landing default `progressMode:
"watch"` (pure observation; promotion is a one-line default flip backed by
`/stats_progress`).** All new logic is L3
(independent); no pi prior art (see `docs/03-citation-policy.md`).

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
| C26 loop guard | `agent-loop.ts` | byte-identical tool-call batch (names + stable-JSON args + order) 3× in a row — AND, since the 2026-10-31 audit (loop detection v2), the same pair ALTERNATING (X,Y,X,Y,X…) with unchanged results, plus fresh-result caps (POLL_CAP/CYCLE_CAP) so bounded churn still dies | `loop` |
| Stall guard | `pipeline.ts` | same TOOL failing with a PERMISSION signature 3× within the last 8 calls (windowed, NOT consecutive — H1) | `stall` |
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

### H2 — Same-failure repetition guard (implemented)

After execution and `afterToolCall`, count failures where the same tool,
canonical arguments, and normalized error text recur at least 3 times
within the last 8 calls of that tool. Normalization trims and collapses
whitespace only; error codes, paths, and changing diagnostics remain
significant. Permission-signature errors are excluded (H1 owns those).
On threshold, replace the triggering result in-band with a distinct
repeated-failure message and `details.stall` + `details.repeatFailure`,
then stop with the existing `stopReason "stall"`. As in H1, the triggering
action has already executed. Changed args or diagnostics do not combine.
This strict matching limits false positives from transient failures whose
diagnostics change, while bounding identical churn.

### H3 — Loop visibility (IMPLEMENTED 2026-10-20, D33 — design in §10)

On `loop`/`stall` stop, the stop event and the TUI surface the TRIGGERING
signature (which batch/call repeated, how many times). Today the evidence
is discarded at stop — the next loop incident is diagnosed from holes in
the guards, not from the transcript. Small change: `agent_end` (and the
`tool_execution_end` that carried `details.stall`) already has the data;
it needs to be named and displayed. Full design (persist + display, with
error text) in §10.

### H4 — Checkpoint commits (logged 2026-09-30; NOT adopted — see D33 ruling)

`.tre/skills/self-improve/SKILL.md` is guardrail zone — a human commits
this change with `GUARDRAIL_BYPASS=1`. Allow committing a
**green-but-incomplete** increment (build + full test suite pass, but the
feature is not finished) as an explicitly-marked WIP commit
(`wip: <what> — <what remains>`). The loop's real cost in the 2026-09-30
session was that the finished half of docs/07 item 1 was never committed;
checkpoint commits cap the loss at the last half-hour instead of the whole
session.
**Ruling (user, 2026-10-20, with D33): NOT adopted** — commits stay at the
current threshold (green build + full suite, human-reviewable). The
guardrail-zone protocol is unchanged; if loss-capping is ever wanted, this
design is the starting point.

### H5 — Bounded autonomous retry on the loop guard (implemented)

**Problem.** The loop guard (same tool-call batch 3× in a row) stops the
run with `stopReason "loop"` and the TUI/CLI prints "send another prompt to
continue." That forces a manual message even in the common case where the
model just needs a kick to try a *different* approach. The goal: minimize
user intervention **without** reintroducing the runaway the guard exists to
prevent.

**Design (the two properties that make it safe).** A guard hit is converted
into an autonomous retry only when the retry is (1) **bounded** and
(2) **different**:

- **Bounded** — `maxGuardRetries` (default **1**; `0` restores the old hard
  stop). At the cap the run stops with `stopReason "loop"` exactly as before.
  The worst case is a small, fixed number of extra turns, so a genuinely
  stuck model still terminates (no runaway). The per-cycle turn budget
  independently bounds the run too.
- **Different** — the retry injects an **approach-changing** nudge
  (`GUARD_RETRY_TEXT`: "you are stuck on that action; you MUST pick a
  DIFFERENT tool / arguments / path; do NOT re-issue the same call"), not a
  "keep going" nudge. A blind continue would just re-fire the guard. The
  identical-batch history (`batchHistory`) is RESET for the retry, so the model
  gets a fresh 3-attempt window (the same reset D27 Finding 2 applies when a
  steer lands).

**Scope.** The **`loop` guard only.** `budget` already auto-continues per
cycle (C26) — nothing to gain. `stall` is deliberately left manual: its wall
is *external and deterministic* (the sandbox denies what it denies), so an
autonomous nudge rarely un-sticks it and the real fix is new information only
the user can supply — auto-retrying it would burn the retries and land back
on the user.

**Mechanics.** At the guard site (after the in-band `LOOP_GUARD_TEXT` results
are already in context), if `guardRetries < maxGuardRetries`: increment, reset
`batchHistory`, push the nudge as a user message, emit a `guard_retry` event
(`turn`, `retry`, `maxRetries`), and `continue` (the nudge consumes no turn).
Otherwise stop with `stopReason "loop"`. The nudge rides the context only
(not persisted to the session — the real resume path is a fresh prompt, as
with the budget nudge). The `guard_retry` event is surfaced as an info item
in the TUI and a stderr line in the CLI (mirroring `turn_budget`).

**Exit criteria.** `maxGuardRetries` option + `DEFAULT_MAX_GUARD_RETRIES`
(=1) exported; `guard_retry` event in the contracts table; TUI + CLI surface
it; `test/agent-loop.test.ts`: (a) the default auto-retries once then stops
with `loop` (6 identical turns); (b) `maxGuardRetries 0` = legacy hard stop;
(c) a model that changes approach on the retry recovers and the run
completes with `stopReason "stop"`. `npm run build` + `npm test` green.

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

- **F1 — Progress detection.** DESIGNED 2026-10-20 (D32) — see §9 — and
  IMPLEMENTED the same day (§9 carries the shipped state). Variant B
  (zero-success turns) + variant A3 (same-target edits with no verification)
  landed together; rollout is measure-only → nudge → stop, landing default
  `progressMode: "watch"`.
- **F2 — Loop telemetry (implemented — minimal scope).** The TUI counts
  how often the loop guard's autonomous retry (H5) actually RECOVERED, per
  session (the TUI process — the events are not persisted, so the counters
  reset on restart, like the other tallies): a run in which the guard fired
  counts once in `fired` (one per run, no matter how many retries it spent),
  and a run that fired a retry and ended with a
  clean `stop` counts as one recovered run (one per run, no matter how many
  retries it spent; a run that fired but ended `loop` (retry budget spent) or
  `stall`/`budget`/`length`/`error`/`aborted` did not complete — it is in
  `fired`, not `recovered`).
  Surfaced by `/stats_loop_guard` (one info line: fires, recovered, rate,
  verdict) — deliberately NOT a bottom-line field (the bottom line is
  reserved for high-frequency daily-use items). This is the evidence for the
  stall-detector question: frequent fires with a low recovery rate argue for
  a higher retry budget, H3 visibility, or the stall guard. The spec-literal
  part (counting loop/stall/budget stops in the bottom line, "fighting its
  cage in real time") is deferred.

## 9. F1 — Progress detection (designed 2026-10-20, D32; IMPLEMENTED 2026-10-20)

**Implementation notes (landing shape, 2026-10-20).** Variants B and A3
landed together (one turn-level state machine at the end of the batch body
in `agent-loop.ts` — the spec binds the posture, not the sequence). The
`notExecuted` detail (the "this call never ran" signal A3's reset keys on)
is produced by EVERY never-executed path — the pipeline's validation
rejection and two gate paths, the loop's in-band `failInband` fills, the
loop-guard and length-guard fills, not-found tools, and the bash tool's own
spawn failures (the `catch` around spawn, and a child `error` emitted
BEFORE the `spawn` event — the spawn-success event is the execution
witness; an `error` after it, e.g. a failed kill, stays unmarked) — so the
rule holds across every producer (audit fix: validation rejections, guard
fills, and bash spawn failures were unmarked and could masquerade as
ground contact; the bash.ts change is the reviewed guardrail-zone
exception — additive metadata only, sandbox behavior untouched). The H1/H2
stall-result REPLACEMENTS preserve the marker and their notices follow the
fact ("WAS executed" vs "was NOT executed") — an unmarked stall notice for
a never-run call was the last path that could fake ground contact (fourth
audit pass).
An executed bash
LATER in the same batch cancels a threshold crossed earlier in it:
`[edit x ×4, bash]` measured the edits (audit fix: the stale candidate
once stopped runs in "stop" mode despite the measurement). One
ANNOUNCEMENT
(the `progress_nudge` event) per episode per kind — the event fires in every
mode; ground truth (a success / an executed bash) clears the episode, so a
persisting condition never spams and a later episode re-announces. The TUI
carries the per-kind fired/recovered telemetry (`/stats_progress`) — the
COUNTERS are per-RUN per kind (at most one fired + one recovered per run;
audit fix: they once counted episodes, inflating the promotion data), while
the transcript line lands per fire. The
plain CLI prints the fire only in `nudge`/`stop` modes (watch stays silent
there — the TUI is the shakedown channel) and both render the `progress`
stop. Tests: `test/agent-loop.test.ts` (the exit-criteria cases below plus
target normalization), `test/tui-state.test.ts` (telemetry + the stop item),
`test/cli.test.ts` (exit code 3).

**The gap.** Three guards cover repeats and walls; none covers **thrashing** —
activity that never repeats byte-identically (C26 misses it), never hits a
permission wall (H1 misses it), and never produces varied-error churn (H2's
strict same-error matching misses it):

| Shape | C26 | H1 | H2 | Caught by |
|---|---|---|---|---|
| Edit the same file repeatedly, running nothing | no (args differ) | no (not a permission wall) | no (no failures at all) | **budget, late** |
| Every call failing with *different* errors N turns running | no | no (not permission) | no (error text varies) | **budget, late** |

The unifying principle isn't "repetition" — it's **act–measure–act**: a model
that keeps acting without ever measuring is not making progress, whatever the
arguments look like. F1 detects the missing measurement.

**Why this is the riskiest guard, and the split that defuses it.** Editing one
file five times is *normal* (fixing compile errors one at a time). The
discriminator can't be edit count — it has to be what happened in between.
The two shapes have very different false-positive profiles, so they ship
separately:

- **Variant B — zero-success turns.** Near-zero false positives: legitimate
  iterative work has successes; it is the expected first landing.
- **Variant A3 — same-target edits with no verification.** The genuinely
  risky one; needs the verification definition below and a measure-only
  shakedown before it may nudge.

**Landing order and commit slicing are decided at implementation time** (one
behavior per commit, per the self-improve protocol), adjusted to the code's
actual shape. What this spec binds is the POSTURE — the trigger definitions,
the ladder, the `watch` default — not the sequence.

### Variant B — zero-success turns

**Definition.** A *turn* whose tool batch was non-empty and whose every result
carried `isError: true` counts as a **no-success turn**. `NO_SUCCESS_TURNS`
(default **3**) consecutive such turns trigger. Reset on any turn with at
least one successful call, and on steer delivery (the D27 Finding 2 rule that
already resets `batchHistory`: fresh user input can legitimize repetition).

**Counted from:** the per-batch results the loop already collects
(`agent-loop.ts`, the `results` map — no new plumbing; `isError` is the single
failure representation).

**Edge rules.**
- A turn with **no tool calls** is neutral: neither counted nor reset (a
  model that just talks ends the run with `stop` anyway).
- **Safety-blocked** calls count as failures — being blocked repeatedly *is*
  the signal (the model is trying things the gate refuses).
- **Synthetic in-band guard results** (`LOOP_GUARD_TEXT`, `STALL_TEXT`,
  `ABORTED_CALL_TEXT`) do NOT feed the counter: those paths terminate on their
  own terms and must not double-count as model activity.
- Aborts break the loop before the check; no interaction.

### Variant A3 — same-target edits with no verification

**Definition.** The same normalized target path touched by `write`/`edit`
`UNVERIFIED_EDITS` (default **4**) times with **no executed `bash` call in
between** triggers. Per normalized path; a bash call resets ALL path counters
(ground contact is global — the model measured something).

**Verification definition (the decision that makes this tractable).** A3
deliberately does NOT try to know which commands verify anything. Pattern
matching (`npm test`, `tsc`, `pytest`, …) is fragile across ecosystems and
becomes a maintenance surface — **rejected**. The rule instead encodes the
universal discipline: *any executed bash call counts as a measurement*.
Refinement over the "any successful bash call" framing discussed earlier: a
**failing** `npm test` is precisely a measurement (the model learned the code
is broken), so the reset keys on **execution**, not outcome — every bash call
that actually ran, whatever it returned. Calls blocked by the safety gate
never executed and do not reset.

**Path normalization.** The pipeline attaches `details.progressTarget` for
executed `write`/`edit` calls using the effective path AFTER safety-hook
rewriting. Relative and absolute aliases therefore share a counter even
when `--cwd` differs from process cwd. Executors without this metadata fall
back to `path.resolve` on the original argument. No additional case-folding
or symlink resolution in the detector — a heuristic, not a boundary. `read`
never counts (reading isn't changing).

**Simultaneous detections.** One action is selected per turn (B first).
A3 is evaluated from the outstanding path-counter map, not just this turn's
edits, so an A3 threshold deferred by B can be announced on a later
read-only turn. Any intervening executed bash clears that outstanding state.

### Nudge, then stop (one ladder, both variants)

Mirrors H5's proven shape — bounded, and the retry must be *different*:

1. **Nudge** — a context-only user message (not persisted to the session,
   exactly like `GUARD_RETRY_TEXT`), distinct per kind:
   - `no-success`: the last N turns produced no successful tool call — do NOT
     re-issue similar calls; state what you believe is wrong and what you need
     from the user, or try a fundamentally different approach.
   - `no-verification`: you have edited `<path>` N times without running
     anything — run the project's check, or explain why verification isn't
     applicable here.
2. **Stop** — if the same condition recurs again after the nudge, with no
   intervening ground truth (A: no bash call; B: no successful call), the run
   stops with a new `stopReason: "progress"`.

`maxProgressNudges` (default **1**, mirroring `maxGuardRetries`): at the cap
the stop fires. `0` = hard stop on first hit (no nudge) — the same
"0 restores the legacy behavior" convention as H5.

**Contract additions** (all additive; `docs/02`):
- `StopReason` gains `"progress"` (a distinct value rather than overloading
  `"loop"`: H5's auto-retry is scoped to the identical-batch guard, and a
  reader must not conflate the two).
- New event `progress_nudge`: `{ turn, kind: "no-success" | "no-verification",
  mode, target?, count }` (`target` only for `no-verification`).
- `agent_end` gains `progress?: { kind, count }` when
  `stopReason === "progress"` (mirrors the existing conditional
  `maxTurns`/`maxCycles` on `budget`).

Ripple for the new StopReason (enumerated so it isn't discovered later): the
TUI's `agent_end` mapping (`state.ts` — an error item explaining the
no-progress stop, alongside the existing `loop`/`stall` items) and the CLI's
stderr line.

### Rollout: measure-only → nudge → stop

The risk label says earn the right to interrupt. One knob records where the
ladder stands, all three modes implemented and tested up front:

`progressMode: "watch" | "nudge" | "stop"` — default **`"watch"`** at landing.

- **`watch`** — the event fires with `mode: "watch"` and NOTHING else happens:
  no context injection, no stop. Pure observation.
- **`nudge`** — the context nudge is injected; the stop is disabled.
- **`stop`** — the full ladder.

Promotion is a one-line default flip whose commit message carries the
telemetry that justified it. Variant B's near-zero false-positive rate means
it can likely be promoted to `nudge` well before A3.

**Telemetry (extends the F2 pattern).** TUI-side counters fed by the events
(the events are not persisted; counters reset on restart, like every other
tally): per kind, `fired` (runs in which the condition was detected at least
once) and `recovered` (runs that, after a fire, re-established ground truth —
a bash call for `no-verification`, a successful call for `no-success` — before
ending). Surfaced as `/stats_progress` (one info line per kind: fires,
recovered, rate). This is the data the default flip needs, and the
false-positive audit: a high fire rate with a low recovery rate means the
detector is wrong, not the model.

### Scope & invariants

- **Where:** turn-level state in `agent-loop.ts` (the pipeline is call-scoped
  and cannot see a whole turn). The original landing kept `pipeline.ts`
  untouched; the audit passes added the reviewed minimal exceptions there:
  the `notExecuted` markers on never-executed paths, the `progressTarget`
  metadata, marker-preserving H1/H2 stall replacements, and the
  afterToolCall guard that restores a dropped `notExecuted` (the execution
  fact is authoritative over result rewriting — sixth audit pass). All
  additive metadata + honest wording — no new decisions in the pipeline.
- **Guardrail-zone files** (`sandbox.ts` / `safety.ts` / hook scripts / the
  self-improve skill): untouched. `bash.ts` carries ONE reviewed exception
  from the F1 audit — additive `details.notExecuted` on spawn-failure paths
  (the sandbox behavior, kill paths, and output handling are unchanged).
  The loop still reads only tool names, args, and result details it
  already has.
- **Nothing persisted.** Per-run counters; the nudge rides the context only
  (same rule as the budget and guard-retry nudges).
- **I3 untouched:** F1 never skips a result; the nudge is appended after the
  batch's results are all in context, and the stop happens after the batch
  completed normally.
- **No new CLI flags** at landing — `progressMode` is a `runLoop` option so
  tests pin all three modes; the default is code-owned and promoted by commit.
- Tunables exported for tests/tuning, like `STALL_WINDOW`: `NO_SUCCESS_TURNS`,
  `UNVERIFIED_EDITS`, `MAX_PROGRESS_NUDGES`.

### Exit criteria

**Variant B — acceptance (landing default `watch`):**
- `NO_SUCCESS_TURNS` exported; the state machine matches the edge rules above
  exactly (neutral no-call turns, blocked-calls-count, synthetic results
  excluded, steer resets).
- `test/agent-loop.test.ts`: (a) 3 all-failed turns → one `progress_nudge`
  (`kind: "no-success"`, `mode: "watch"`) and the run CONTINUES; (b) a success
  on turn 2 of 3 → no fire; (c) a steer between failing turns → no fire;
  (d) mixed batch (one ok, one failed) → no fire; (e) `mode: "nudge"` → the
  nudge message is in the next request's context and NOT written to the
  session; (f) `mode: "stop"` → recurrence after the nudge stops with
  `stopReason "progress"` + `progress` on `agent_end`; (g)
  `maxProgressNudges: 0` → stops on the first hit.
- TUI: `/stats_progress` renders fires/recovered/rate; the `progress` stop
  renders an explanatory error item.
- `docs/02` rows for the event, the StopReason value, the `agent_end` field.
- `npm run build` + `npm test` green.

**Variant A3 — acceptance:**
- `UNVERIFIED_EDITS` exported; per-path counters; a bash call (success OR
  failure) resets all counters; a gate-BLOCKED bash call does not; `read`
  never counts; `write` and `edit` to the same path share a counter; `./x` and
  `x` normalize together.
- Tests for each of the above, plus: 4 edits with a failed `npm test` between
  → no fire (the measurement happened); 4 edits with nothing between → fire.
- Lands at `watch` regardless of variant B's promoted mode — A3 is the risky
  one and earns its own shakedown.

### Future improvements (logged — greater autonomy is the direction)

The posture here is deliberately conservative; the goal is to relax it as data
arrives, not to keep it. In rough order of value:

1. **Raise `maxProgressNudges`** once `/stats_progress` shows nudges reliably
   recovering — more autonomous recovery before any stop.
2. **Name the actual check command** in the `no-verification` nudge (from
   `package.json` scripts / a Makefile / the project's own documented command)
   instead of the generic "run the project's check" — a specific instruction
   the model can follow beats a nudge about a concept.
3. **Auto-run the verification**: the harness runs the detected check itself
   and injects the output as ground truth. The maximally autonomous shape —
   it supplies the missing measurement rather than asking for it. Needs its
   own design (approval-mode interaction: a harness-initiated bash call is not
   a model-initiated one, and must not quietly bypass the gate).
4. **Per-project thresholds / mode via `tre.json`** (the durable-config seam
   C36/D22 established) — a long-running build project may want a wider window
   than a docs repo.
5. **Variant A2 (verification classification)** — a pattern list that tells a
   real test run from a `git status`, so "edited 4× but only ran `ls`" can
   fire. Only worth it if A3's permissiveness proves to leave a real gap.
6. **Cross-run progress memory** — a run that resumes a session inherits no
   counters today; if thrashing turns out to span resumes, that needs a
   persisted (and therefore reviewed) shape, not a silent store.

## 10. H3 — Loop visibility design (D33; implemented 2026-10-20)

The problem restated: on a `loop`/`stall` stop the harness knows exactly
what triggered it — the repeated batch signature, the tool, the failure
count, the denial text — and throws the evidence away. Both stop messages
are static strings ("the same tool call(s) 3 times in a row"), so the
operator sees *that* a guard fired but not *what* fired, and a resumed
session is undiagnosable without re-deriving signatures by hand.

Rulings (user, 2026-10-20): **(1) persist** the evidence (not display-only);
**(2) include the error text** on the stall side (the pipeline starts
carrying it); **(3)** commits stay at the **current threshold** — H4's WIP checkpoint
commits are NOT adopted; the existing bar (green build + full suite,
human-reviewable) is the only committable state, so H3 changes nothing in
the self-improve protocol.

### The evidence shape (one contract, three homes)

A discriminated union keyed on which guard fired — exported from
`agent-loop.ts`, reused verbatim by the event, the session entry, and the
display:

```ts
export type GuardEvidence =
  | { guard: "identical-batch";                       // C26 guard → "loop"
      signature: string;                              // batchSignature() output
      repeats: number;                                // the guard constant (3)
      guardRetries: number }                          // H5 retries spent before the stop
  | { guard: "permission-stall";                      // H1 guard → "stall"
      tool: string; denials: number; window: number;  // count / STALL_WINDOW
      errorExcerpt: string }                          // raw denial text, first line, capped
  | { guard: "repeat-failure";                        // H2 guard → "stall"
      tool: string; repeats: number; window: number;
      errorExcerpt: string }                          // normalized error text, capped
```

`errorExcerpt` is capped at 2 000 chars at construction (the persisted
form) — big enough for a real denial or traceback head, small enough that
one entry never dominates the JSONL. Display truncates further (one line,
~160 chars, ellipsis). Note the privacy position: signatures and excerpts
are tool arguments/errors that are ALREADY in the session's message
entries — the new entry adds no disclosure, only naming.

### Home 1 — the event: `agent_end.evidence`

`AgentEvent["agent_end"]` gains an optional `evidence?: GuardEvidence`,
present exactly when `stopReason` is `"loop"` or `"stall"` — the same
conditional-field pattern as `maxTurns`/`maxCycles` on `"budget"`.

Wiring, per guard (all sites verified against `src/` on 2026-10-20):

- **identical-batch** (`agent-loop.ts`, the C26 stop site): `signature`
  and `guardRetries` are already in scope where `stopReason = "loop"` is
  set — assign to a local, attach at `agent_end`. No pipeline involvement.
- **permission-stall / repeat-failure** (`pipeline.ts`): the pipeline owns
  the data (tool name, window, count, the failing result's text) but
  currently propagates only `details: { stall: true }` (plus
  `repeatFailure: true` on H2). It adds a sibling structured field:
  `details: { stall: true, stallEvidence: {...} }`. `details.stall` keeps
  its exact current meaning and shape (the loop's check at
  `agent-loop.ts:786` and the existing tests key off it; `details` is
  already `Record<string, unknown>` — additive is in-contract). The loop
  copies `stallEvidence` onto the local evidence variable at the same
  site where it maps `details.stall` → `stopReason`.

### Home 2 — the session: a `guardStop` entry

```ts
export interface GuardStopEntry {
  type: "guardStop";
  id: string;
  timestamp: number;
  evidence: GuardEvidence;   // same shape as the event's
}
```

- Added to the `SessionEntry` union; `Session.appendGuardStop(evidence)`.
- **Written by the driver** (CLI + TUI) on the `agent_end` that carries
  `evidence` — the same place messages are appended; skipped when no
  session is open. The loop stays session-ignorant (contract C-level
  separation: the loop yields, the driver persists).
- **Replay: ignored, not replayed.** `replayContextWithIds` passes it
  through like `modelChange` — it is harness metadata, not LLM context;
  the model must not see "you were stopped for looping" as a user-visible
  context mutation. Compaction is unaffected (entries are never referenced
  by `firstKeptEntryId`).
- **`SESSION_FORMAT_VERSION` stays 1.** Additive entry types are
  two-way compatible under the current loaders: `loadSession` casts
  blindly, and both replay paths ignore unknown types by fall-through.
  New code reads old files; old code reads new files (the entry is simply
  skipped). Bumping the version would refuse old binaries for zero gain.
- Why a dedicated entry when the in-band guard result text is already
  persisted inside the toolResult message: reconstructing the loop-guard
  trigger today means knowing to re-run `batchSignature` over the last
  three assistant batches and diffing them — that IS the archaeology H3
  exists to end. One greppable line (`"guardStop"`) names the guard, the
  trigger, and the count.

### Home 3 — the display: evidence in the stop lines

`state.ts` (`agent_end`, the `loop`/`stall` branches) and `cli/main.ts`
(the stderr stop lines) keep their guidance text but interpolate the
evidence: loop → the signature's first line (tool + truncated args);
stall → tool name, `denials/window` (or `repeats/window`), and the
excerpt's first line. No evidence (older producers) → the current static
strings, unchanged.

### Explicit non-goals

- No `guard_retry`-event change (it already names the turn/retry counts;
  the signature there is a possible follow-up, not this design).
- No new CLI flags, no config keys.
- No change to guard thresholds or text semantics — evidence is
  observation, not behavior.
- docs/02 gains the `agent_end.evidence` field + the `guardStop` entry row
  WITH the implementation (it documents shipped behavior, not plans —
  same rule D32 applied).

### Exit criteria

1. Unit (loop): a run stopped by the identical-batch guard yields
   `agent_end.evidence = { guard: "identical-batch", signature: <the
   repeated batch>, repeats: 3, guardRetries: <spent> }` — including the
   exhausted-retries path (`maxGuardRetries: 0` → `guardRetries: 0`).
2. Unit (pipeline): both stall guards set `details.stallEvidence` with
   correct tool/count/window and a capped `errorExcerpt`; `details.stall`
   unchanged (existing tests keep passing untouched).
3. Session: `appendGuardStop` round-trips through `loadSession`;
   `replayContext` output is identical with and without guardStop entries;
   a pre-H3 session file loads unchanged; a post-H3 file loads under a
   reader that predates the type (fall-through assertion).
4. Display: TUI `applyEvent` and CLI stderr lines contain the tool name /
   signature excerpt when evidence is present, and the old static string
   when absent.
5. Gate green; suite grows by the above only.


## 10. Audit F-6: the sed loop none of the guards caught (2026-10-28 — WARN RUNG LANDED; windowed STALL still deferred)

> Status: the measurement below stands as written. Its last paragraph
> ("Landed with this audit") records the shipped warn rung; the windowed
> 5-in-12 STALL remains unlanded pending the per-fire FP audit. A
> follow-up code review of the landed rung found two window-state defects
> (distinct texts never expiring; eviction deleting the just-added
> family after 32 tracked families) — both fixed with regression tests
> ("stale distinct text must expire" / "newly-admitted family is not
> evicted" in test/tools.test.ts). A further 3-cycle independent audit
> (gpt-6.1-sol, read-only against compiled dist/) fixed three more:
> pre-execution outcomes (validation/blocked/broken-hook) now consume
> their per-tool call index and H1 slot; guard windows count per-tool
> OUTCOMES allocated at a single completion-order seam (out-of-order
> parallel completions could previously defeat every sliding window via
> negative deltas); and the regression tests themselves were hardened so
> none can pass via a different guard than the one it pins.

**Symptom (observed live).** A session ran the malformed BSD-sed command
`sed -n ",+Np"` 15 times over ~500 tool calls before it ended. The failing
calls differed only in the range digit (`+18p` … `+2p`) and in surrounding
text (an extra `grep` clause each time). Nothing stopped it.

**Why every guard missed it — established by replaying real sessions, not
by reasoning about the code.** Method: 985 session logs, tool calls paired
to results, per-tool counters, guard/synthetic notice results excluded
(they appear in logs AS tool results — naive replay re-keys them as
failures; this artifact polluted the first measurement pass and inflated
counts).

- H2 repeat-failure (exact args + exact error, 3-in-8-of-tool): args
  changed every call; error text changed every call (the digit + the grep
  clause).
- same-error guard (consecutive, exact key): the error key differs by one
  character each time — the streak never survived call 1.
- F1 no-success and the identical-batch guard: each failing turn also
  contained succeeding calls, so neither "all failed" nor "identical batch"
  was ever true.
- H1 permission stall: not a permission failure.

**Hypothesis tested and REFUTED.** The initial diagnosis blamed
`normalizeFailure` preserving digits, and the proposed fix was a
digit-masking "family key" (`/\d+/g` → `#`). Measured against the corpus:

| policy (stop = 5 in a row per tool) | stop events across 985 sessions | catches the sed loop |
|---|---|---|
| CURRENT (exact key, consecutive) | 4 | no |
| family key, consecutive | 4 | **no** |
| family key + stdout exemption, consecutive | 4 | no |

Digit masking changes the raw text of 78.4% of failed calls (1,199/1,529),
but under a CONSECUTIVE counter it adds zero stops and catches nothing —
the masked keys still never sat adjacent, because between every sed
failure there was a different failure or a success. The stdout-exemption
nuance (60/40 split of digit-varying calls) was moot before it mattered:
FAM vs FAM-stdout-exempt differed by one fire across 985 sessions.

**The actual root cause is two-axis, and the fix must be on BOTH:**
1. **Key breadth** — errors of one broken approach differ by digits and
   incidental stdout (`grep` output, counts). Exact keys miss.
2. **Consecutiveness** — a loop interleaves other work (every other call
   succeeds or fails differently), so ANY strictly-consecutive counter
   resets before threshold. The max consecutive same-family bash-failure
   streak inside the loop session was 4; the stall rung wants 5.

| policy (non-consecutive: T same-family failures within W calls of the tool) | fires | catches the sed loop |
|---|---|---|
| exact 3/8 | 53 | yes |
| family 3/8 | 57 | **yes, at bash call ~271 — the loop's first third (sed errors at 264/268/271)** |
| family 4/10 | 33 | yes |

Windowed exact misses the sed cluster (its keys differ by digit); windowed
family catches it. Both axes are necessary; neither alone suffices.

**Direction (specified, NOT landed):** make the same-error guard's
counter a sliding-window count per tool over the family key
(`tool + digit-masked normalized error`), warn at 3-in-8, stall at
5-in-12 — thresholds from the two tables above, tuned so existing
behavior is preserved and the loop-session catch happens within its first
third. Cost of the window: the 3/8 rung roughly triples fire count vs
today's 4 lifetime stops (~50 across 21k turns ≈ 0.2%/turn) — every
sampled fire was a genuine repeated-shape failure (edit `no exact match`
retries, repeated identical tracebacks, a `tail:` loop that fired 7 times
in one session prod never stopped), but the 3-rung's FP surface has not
been audited target-by-target; the audit finding behind the current
consecutive-only design (legitimate per-target probing false-positived a
hard stop) applies to the WARN rung at 3 and needs the same eyeball pass
before stall=5-in-12 ships. Keep the existing consecutive-5 stall
untouched; ADD the window as a third rung. H2 stays exact-args — byte
repeats remain its job.

**Landed with this audit (warn rung only):** `familyFailureKey` + a
third, ADDITIVE rung in the pipeline — SAME_FAMILY_WARN_THRESHOLD
failures of one family within SAME_FAMILY_WINDOW calls of the tool
(default 3/8; "calls" = per-tool OUTCOMES recorded in completion order —
the only order the guard can honestly observe when a parallel batch
finishes out of dispatch order, auditor cycle 2), announced only when
≥2 DISTINCT texts share the family
(byte-identical repeats stay H2's; a single repeating text stays the
consecutive ladder's, including the alternating-identical case pinned
silent by test/tools.test.ts). The consecutive-5 STALL and H2 are
untouched; the windowed STALL rung (5-in-12) is deliberately NOT landed
until the per-fire audit above is done — promote-by-commit convention.
Tests (test/tools.test.ts, "family-window" block): the key contract
(all digit runs mask, including sed's line number — `sed: 1: ",+18p"`
and `sed: 1: ",+2p"` collapse to one family), the sed-loop warn at 3,
success-occupies-a-slot-without-reset, distinct-text suppression, and
window expiry.
