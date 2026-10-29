## 2026-10-29 — Telegram round-4 (F1+F2) + batch-shape guards (audited; cycle 1 fixed)

**Audit cycle 1 (auditor gpt-6.1-sol, `audit-c2.md`): FINDINGS — 3 reproduced
bugs, all in the batch-shape guards (Telegram F1/F2 PASSED stress probes;
date-only edits verified behavior-neutral).** Fixed in this follow-up:
1. Synthetic skip records no longer pad the guard history — digest and
   failure flag are built from the EXECUTED subset only (padding with exact
   duplicates previously changed the stable digest and rescued loops; skip
   `failed=true` previously exempted real cycles). Skips still ride the
   transcript as in-band errors.
2. Results/end events are emitted in strict model CALL ORDER — one loop over
   the original `calls` array (executed results and skip notices interleaved
   correctly: `[a, dup-b, c]` → ends `a,b,c`, executed `a,c`).
3. `DUPLICATE_CALL_TEXT` is execution-neutral ("appears earlier in this
   response … consult that call's result") — it no longer claims the
   original "already ran" when that occurrence was itself trimmed
   (over-cap) or stall-skipped.
Mixed-batch terminate semantics unchanged (executed members only); an
all-skip batch never terminates. 4 regression tests (padding 0/1/3, cycle
exemption, interleaved order, notice neutrality incl. the over-cap planBatch
case); docs/02 C6 contract updated to match. Suite **1443 pass / 14 skip /
0 fail**. Cycle-2 audit follows.

**Telegram round-4 (src/telegram/driver.ts, src/cli/main.ts, src/telegram/README.md, docs/02-contracts.md C37).** Fixes the two Medium findings from the round-3 audit (coordination dir: `.tre/implement-audit/telegram-round4/`, gitignored): **F1** — the idle-turn success path keeps `activeSteer` attached through `telegramBridge.send()` (typed guidance during the bot reply no longer falls into a detached queue) and detaches in `finally`, draining undrained steer into the driver's deferred buffer for the follow-up turn. **F2** — `withTurn<T>` returns `Promise<T | undefined>`: a reserved-but-unstarted body checks `stopped` after awaiting its predecessor, decrements pendingTurns, releases the mutex, and returns `undefined` without running (one-shot worker path treats it as cancelled, exit 130); `stop()` is now a lifecycle-level cancellation reserved bodies cannot bypass. Tests: explicit F2 barrier test + an end-to-end F1 gated typed-guidance integration test (replacing the former basic idle-reply test); mutation probes pinned both fixes (old code fails exactly at the new assertions). Orchestrator-implemented c0 deviation logged in plan.md (worker-c0 hit its wall-clock cap with a clean tree).

**Batch-shape guards (src/loop/agent-loop.ts, docs/02-contracts.md C6).** From the Qwen runaway-tool-call audit (`qwen-duplicate-audit.md`, same coord dir): one response carried 163 tool calls (66 copies of one git command) and the loop executed every member concurrently with no ceiling. Added `MAX_BATCH_CALLS = 32` (cap on executed calls per response — extras get in-band error results with `details.notExecuted`, never run), `MAX_PARALLEL_CALLS = 8` (concurrency cap — oversized parallel groups run in ordered chunks), and `planBatch()` — a pure planner collapsing intra-batch EXACT duplicates (same tool + stable-JSON args; first occurrence runs, repeats get `DUPLICATE_CALL_TEXT`; trimming applies AFTER dedup). Every call ID still yields exactly one `tool_execution_end`; cross-turn loop/cycle guards sign the EXECUTED subset only. 4 new tests; 2 existing stall tests updated to distinct args. Suite: 1439 pass / 14 skip / 0 fail.

**Machine config (NOT in repo):** `~/.tre/tre/models.json` — moved `reasoning_effort`/`repeat_penalty` out of the nested `options` (llama.cpp reads them top-level) and set `parallel_tool_calls: false` for both Qwen entries; backup `~/.tre/tre/models.json.bak-qwen-params-20261029-155127`.

**Audit:** the round-4 implement-audit cycles were never completed against the implementation (c1 audited the baseline). An independent auditor cycle (gpt-6.1-sol) is run against this committed diff; verdict in `.tre/implement-audit/telegram-round4/audit-c1.md`.

**Date hygiene (this commit):** all mislabelled future dates ("2026-11-02/05/27/28/29" → true dates `10-27`/`10-28`/`10-29`) corrected across `src/`, `test/`, and `docs/` comments — see the note in the 2026-10-28 streak-guard entry.

---

**Same-error streak guard — final form + sequential stall-skip (2026-10-28,
third round).** *(Date-correction note, 2026-10-29: this entry and the
guard/audit comments across `src/` and `test/` were originally misdated
"2026-11-27 / 2026-11-05 / 2026-11-28" — the sessions drifted into future
dates. True dates derived from git: the loop-v2 audit chain (`a2fd742`/
`9d5b061`/`8d4f3ab`) 2026-10-27; the streak-guard rounds (`d35241e` →
`11a5d68`) 2026-10-28. `d35241e`'s commit MESSAGE still carries the bad
"2026-11-27" — history left unwritten; this note is the correction.)* The first `same-error-stall` cut (3 windowed hits, hard stop)
failed its own audit on four counts: the reset branch was unreachable dead
code inside the error-only `if` (successes never reset the streak); a
generic error across independent targets hard-stalled legitimate probing;
the CLI/TUI/prompt claimed "the repeat was not re-executed" when every
guard fires AFTER its triggering call executed; and parallel batches
dispatched everything before any guard spoke. Fixed in three parts,
superseding the 2026-10-28 entry it replaces: **(1)** `tools/pipeline.ts` —
the guard is now a CONSECUTIVE streak: one `{errorText, streak}` record per
tool, deleted by ANY other outcome (success, permission denial, different
error — no per-errorText map, no stale state), and a LADDER: warn in-band
at 3 in a row (real error returned VERBATIM + appended approach-changing
notice, run continues), hard stall at 5 (`guard: "same-error-stall"`,
`repeats` = the true streak, `consecutive: true`; exact byte-identical
repeats still belong to H2). **(2)** `loop/agent-loop.ts` — sequential
batches skip every call AFTER one returns `details.stall` (synthetic
`notExecuted` in-band result recorded with the SYNTHETIC_FILL_DIGEST so the
cycle guard treats skips as exempt fills); parallel batches still run all
(the honest limit: calls are in flight before results exist — documented in
the module header, pinned by a test). `agent_end.evidence.skipped` counts
prevented calls; CLI + TUI banners gained the honest skipped-note and lost
the false "not re-executed" claims (a guard never prevents a dispatched
call; only the sequential skip prevents queued ones). **(3)** the system
prompt's repeated-failure discipline now says the harness stops the run as
stalled — never promises refusal. Tests: 7 streak (warn@3/run-continues,
stall@5, success-reset, different-error-reset, independent-targets-defer,
H2-owns-exact-repeats, permission-resets) + 2 stall-skip (sequential skips
later calls + evidence.skipped; parallel runs all — pinned limit) + TUI
skip-note + prompt honesty; suite **1406 pass / 0 fail / 14 skip
(live-only)**. A follow-up audit found and fixed two bookkeeping defects in
that redesign: **(a)** the warn rung returned before H1's window push, so
warned calls never occupied window slots and stale permission denials
stayed counted (H1 then fired on a call whose real last-8 history held one
denial) — H1 bookkeeping now runs in a dedicated step BEFORE any verdict
return; **(b)** the pre-execution returns (validation failure, blocked
gate, broken hook) skipped the streak reset, so a malformed call between
two identical failures let the streak climb across unrelated work — all
three now break the streak through one `breakSameErrorStreak` helper. The
prompt's "third repeat earns a warning" claim was also scoped (exact
repeats still hard-stop via H2 at 3). Regression tests pin both sequences.
A second audit pass caught two more: **(c)** the `progressTarget` attach
sat at the very end of the executor, so the warn rung (whose result the
loop keeps) returned before it — a hook-rewritten edit path lost its
effective target and F1's unverified-edit scan split counts across the
effective and model paths; the attach moved to step 4b (after result
hooks, before any guard verdict). **(d)** the prompt still promised the
3-in-a-row warning to exact repeats; it now states the warning is for
VARYING-argument streaks and that an identical re-issue can stop with no
warning. Suite **1409 pass / 0 fail / 14 skip (live-only)**. Residuals: parallel
dispatch cannot be guarded pre-execution (inherent to Promise.all); F1
`progressMode` still defaults to `"watch"` — promotion to `nudge` is a
one-line flip backed by `/stats_progress`.

**Slot affinity (`bb19f48`): inert on current servers — annotated, do not
re-arm the flag expecting a pin (2026-10-29).** The commit claimed
llama-server pins a session to a slot by hash of the OpenAI `user` field.
Verified against the live lab box (fork @ upstream `34517d5`, 2026-10-28,
`--parallel 2`): `get_available_slot()` routes `id_slot` → LCP similarity
(`-sps`) → LRU and there is NO top-level `user` parsing anywhere in
tools/server, src, or include (hash-of-`user` routing existed only in old
llama.cpp and was replaced upstream). The wire/dispatcher/main plumbing is
sound (tsc clean, dist built, tests pin the injection) and harmless, but a
no-op on any server that doesn't parse `user`; the flag is intentionally
UNSET on both lab `models.json` entries. What actually keeps the lab cache
warm: server-side `-sps 0.8` + LCP routing (pod logs: `f_sim_best 0.94–0.99`
into one slot; ledgers 94–95% hit). Known residual miss (LCP math, not
eviction): a turn that nearly doubles the prompt scores < 0.80 and routes to
the other slot — a hash pin wouldn't prevent that either. **ACTION, only if
a real pin is ever wanted (multi-writer against one endpoint becomes
routine): fork-patch llama.cpp** — parse the request's top-level `user` in
`server_task`, hash to `id_slot` (the `selected slot by id` path already
works in this build, live-verified), rebuild via the llama-fork-build flow,
then set `slotAffinity: true` on the lab entries. Cost note: a pinned busy
slot DEFERS (head-of-line blocks) rather than evicting.

# Current project status (2026-10-25)

**D34 — D26 compaction CLOSED (2026-10-25).** The carried
open item below is resolved: the lossless fit policy is implemented
(`planCompaction` `{preserveLastUser, shrinkToFit}`; `compactContext`
`strictFit` bound/floor ladder with the real rule-notice measured before a
prompt fold, fold output capped at the headroom over its kept tail,
fold-after-demonstration, `priorityLastUser` transcripts, abort-terminal /
error-preserves-candidate; `compactNow` strict on the auto trigger, legacy
best-effort on manual `/compact`). Suite **1354 pass / 0 fail / 14 skip
(live-only)**; property sweep `scripts/audit-d26-repro.mjs` 168/168 against
the real `compactContext`. Contract + audit repros: docs/06 "D26"; decision
row: PLAN D34. Residual: fit is enforced on the calibrated chars/token
estimate (same tokenizer caveat as the trigger).

**M4 close-out (2026-10-21, `dfefd84`).** The post-remediation
review filed M4 and it is now FIXED: the write/edit branch of
`makeSafetyHooks` runs the same sensitive-path check `read` has (M1
helpers: case-folded patterns, realpath resolution, realpath-vs-realpath-root
ws/sys split) — sys-sensitive → blocked in every mode, ws-sensitive →
prompt in `ask`. A new `.tre`-anchored PATH pattern covers the machine
endpoint catalogs: `~/.tre/models.json` matches, a workspace
`models.json` never does. 8 regression tests (`test/safety-m4.test.ts`),
including the filed extra-root takeover repro and the symlink-into-extra-root
case (the sandbox passes it; only the sensitive check stops it). Bonus
finding pinned: the path sandbox refuses cross-root symlink writes (each
root is realpath-checked independently), so a workspace link INTO an extra
root never reaches the sensitive layer. Guardrail-zone file (safety.ts)
landed via the human `GUARDRAIL_BYPASS=1` path. Residual: same
TOCTOU/indirection caveats as M1 (inherent, documented in AUDIT.md).
Suite **1338 pass / 0 fail / 14 skip** (supersedes the 1330 count below).

**Audit remediation (2026-10-21): every M/L finding in AUDIT.md is FIXED.**
M2 `f59cd83` — both Telegram bridges enforce a chat allowlist at parse time
(shared `parseTelegramPollOutput`/`telegramAllowedChatIds` in
`src/telegram/paths.ts`; fail-closed). M1 `299ce1a` — the sensitive-path
gate closes all three verified bypasses: `read` classifies the
realpath-resolved target, pattern tests case-fold (macOS FS), bash tokens
are quote-stripped, and the ws/sys split compares realpath-vs-realpath (a
workspace under a symlinked path still PROMPTS — the macOS `/var` tmpdir
case). M3 `f398df9` — new `src/config/secret-mode.ts` hardens every known
secret file to 0600 at startup with a stderr warning (live machine: 3 files
tightened); price-cache write 0644→0600. L1–L4 — `read` stats before
materializing (64 MB cap + FIFO/socket/device refusal), listings cap at
2000 entries naming the total, truncation temp files 0600 + 7-day prune,
`env`/`printenv` out of `READONLY_VERBS` (`bash printenv` no longer passes
`no` mode). L5/L6 — pipeline `toolTimeoutMs` seam (default 30s for file
tools; bash/subtask/MCP exempt), pattern list gains `telegram.json`,
`tokenomics.json`, `.bashrc`/`.zshrc`/`.profile`. 29 new regression tests
pin the audit's own repros (suite 1330/0/14); the M1/L4 repros were
re-verified against built `dist/`. Guardrail-zone commits (safety.ts) used
the human-directed `GUARDRAIL_BYPASS=1` path. Residuals documented in
AUDIT.md per finding (TOCTOU swap, abandoned-write, agent can no longer
write its own bot-token config — intended).

**Open-items session (2026-10-21): model-prices v2 + docs-truth pass.**
`3dcf842` — the OpenRouter price cache goes **v2**: `ModelPrice` gains
optional `cacheRead`/`cacheWrite`/`cacheWrite1h` (6-decimal precision — real
cache-read rates go to $0.005/M; 2-decimal display rounding would destroy
them) and `overrides` long-context tiers (`minPromptTokens`, sorted
ascending; unsorted input handled, invalid optionals dropped with the base
price kept). `PriceCache` is `v: 1 | 2` — v1 files stay READABLE (no cache
rates), so a version bump never strands an offline host. The consumer loop
is closed end-to-end: tokenomics' `resolve_price`/`pick_tier`/
`cache_read_rate` already consume these fields. +8 tests; suite 1294/0/14.
Also this session: `90ef262` corrected stale H3/H4 status claims (docs/08
header + the HANDOFF docs/07 summary now record H3 as shipped with D33 and
H4 as formally not adopted); the PLAN D32 row's stale "Designed, NOT yet
implemented" tail and docs/08 §7's stale F1 entry were corrected to point
at the shipped state; the two stray `models.json*.bak` files were deleted;
the telegram-waiting delegation plan was stamped DONE (its fix shipped —
`src/telegram/paths.ts` resolves the helper across both skill roots).
Tokenomics L8 (container ran as root) was VERIFIED and FIXED: the image
now runs as uid 65534, the ledger volume was chowned, redeployed and
verified live (see `tokenomics/AUDIT.md`).

**F1 follow-up audit fixes.** Effective execution paths now travel from the
pipeline via `details.progressTarget` after safety-hook rewriting, fixing
relative/absolute alias counters when `--cwd` differs from process cwd. A3
checks the outstanding map each tool turn, so a simultaneous B detection
cannot lose a deferred A3 hit on a later read-only turn (an executed bash
still cancels it). Regression tests cover both, plus actual length-guard
and unknown-tool results replayed into the TUI: neither falsely recovers A3.
THIRD-PASS FIX: the real bash tool's spawn failures (the spawn `catch` and
a child `error` before the `spawn` event) now carry `details.notExecuted` —
a shell that never started is not a measurement, so it neither resets A3
nor recovers a fired episode. This is the reviewed guardrail-zone exception
(additive metadata only in bash.ts; sandbox behavior untouched), noted in
docs/08 §9. Regression tests: bash-kill.test.ts (spawn failure marked; a
running-but-failing command unmarked) and agent-loop.test.ts (loop + TUI
probes with the real bash tool). FOURTH-PASS FIX: the H1/H2 stall-result
replacements dropped `notExecuted` (the third identical bash spawn failure
arrived at the TUI as a plain stall notice and falsely recovered A3).
Both replacements now carry the marker through and their notices say
"WAS executed"/"was NOT executed" per the fact. Regression: agent-loop.test.ts
real-executor probe (3 spawn failures through makeToolExecutor + TUI
replay). FIFTH-PASS HYGIENE: stallText(tool, executed) is parameterized
(the notExecuted variant was a fragile string splice over its own prefix),
the H1 replacement got its regression test (marker preserved + honest
wording; the executed-denial test now also asserts NO marker), and docs/08
§9 "Scope & invariants" was amended to record the reviewed pipeline.ts and
bash.ts exceptions the audit passes actually shipped (it previously said
"nothing in pipeline.ts" / "no bash.ts" — self-contradictory vs the notes).
SIXTH-PASS FIX: an afterToolCall replacement that DROPS `details` could
still erase `notExecuted` (the documented redaction shape turned a real
bash spawn failure into apparent ground contact — false A3 reset / false
TUI recovery). The pipeline now captures the execution fact before the
hook and restores it after; the AfterToolCall type documents it as
authoritative. Regressions: tools.test.ts (hook dropping details) +
agent-loop.test.ts (real bash + redaction hook, loop AND TUI sides).
Verification: `npm test` (quality gate + tsc + full suite), 1305 total,
1291 passed, 0 failed, 14 skipped; `git diff --check` clean.

**F1 progress detection — IMPLEMENTED (2026-10-20, D32; docs/08 §9).**
The act–measure–act guards: variant **B** (`no-success` — 3 consecutive
turns whose whole batch failed; reset on any success or steer) and variant
**A3** (`no-verification` — 4 `write`/`edit`s of the same normalized path
with no EXECUTED `bash` between; a failing test IS the measurement; a
gate-blocked call never ran and neither counts nor resets — EVERY
never-executed path now tags `details.notExecuted`: the pipeline's
validation rejection + two gate paths, the loop's `failInband`, the
loop/length-guard fills, and not-found tools).
Turn-level state machine at the end of the batch body in `agent-loop.ts`
(every guard path continues/breaks first, so synthetic results never feed
it; an executed bash LATER in the same batch cancels a threshold crossed
earlier in it). One ladder per kind, one ANNOUNCEMENT per episode: the
`progress_nudge` event fires in EVERY mode (the observation channel);
`progressMode` (default **`"watch"`** — event only, nothing else) decides
the effect; `"nudge"` injects a context-only message; `"stop"` stops on
recurrence with the new resumable `stopReason: "progress"` (exit 3) +
`progress` on `agent_end`. `maxProgressNudges` default 1, 0 = hard stop
(the H5 convention). Telemetry: TUI per-kind fired/recovered — the
COUNTERS are per-RUN per kind (at most one fired + one recovered per run)
(`/stats_progress`, resets on restart like every tally — the data the
default flip needs); the plain CLI prints fires only in nudge/stop modes;
both render the progress stop as an explanatory line. Nothing persisted;
I3 untouched; no guardrail-zone files. docs/02: the StopReason value, the
event row, the `agent_end.progress` field, the F1 contract bullet.
AUDITED + FIXED (2026-10-20): four findings — stale same-batch A3
detection stopped runs despite a measurement; validation rejections and
loop/length-guard fills lacked `notExecuted` (false ground contact, incl.
a TUI false recovery); telemetry counted episodes instead of runs.
Regression tests pin all four: +5 tests (loop 4, TUI 1), 1 TUI test
rewritten (it had pinned the episode-counting behavior), 1 tools test
extended. Suite 1295 / 0 / 14. Next: run daily, flip
variant B's default to `nudge` when `/stats_progress` earns it (one-line
commit with the telemetry in the message).

**H3 loop visibility — IMPLEMENTED (2026-10-20, D33; docs/08 §10).**
Guard stops (`loop`/`stall`) now name their trigger instead of discarding
it. One `GuardEvidence` union (`identical-batch` → signature/repeats/
guardRetries spent; `permission-stall` & `repeat-failure` → tool/count/
window/errorExcerpt, excerpt one line capped at 2000) with three homes:
`agent_end.evidence?` (pipeline feeds the stall variants via additive
`details.stallEvidence`; `details.stall` untouched), a driver-written
session `guardStop` entry (replay-ignored like `modelChange`, never a
compaction anchor, `SESSION_FORMAT_VERSION` stays 1 — verified two-way
compatible), and the TUI/CLI stop lines appending a clamped one-line
`guardEvidenceNote` (static strings remain the no-evidence fallback; H2
repeat-failure stalls get their own wording, not the sandbox-wall text).
Rulings honored: persist, error text included, no H4 (commits stay at the
current threshold). docs/02 gained the `agent_end.evidence` row + the D33
section. +18 tests (loop 5, pipeline 3, session 3, TUI 3, CLI 4); suite
1253 / 0 / 14. Next: D32 (F1 progress detection, docs/08 §9) implements
the same way.

**H3 loop visibility — designed earlier today (2026-10-20, D33; docs commit
`4359bb0`, superseded by the implementation above — see docs/08 §10 for the
design and its rulings, incl. H4's non-adoption).**

**F1 progress detection — design record (designed 2026-10-20, D32;
implemented 2026-10-20 in `ecd893e`, watch default; this section restated
by the 2026-10-21 truth pass `4174829`).** The shipped state is docs/08 §9
+ the D32 rows in PLAN. The paragraph below is the DESIGN RECORD as written
at design time (2026-10-20) — kept verbatim; where it says "designed / NOT
yet implemented", read it as history. (The IMPLEMENTED status, the
follow-up audit fixes, and the suite counts are the section above — this
entry exists once, not twice.)
`docs/08-loop-hardening.md` gains §9: the design pass on the last logged
loop-hardening item. Unifying principle **act–measure–act** (thrashing that
never repeats byte-identically / never hits a permission wall / never produces
same-error churn is missed by C26/H1/H2 — only the budget catches it, late).
Rulings (user, 2026-10-20): **(1)** split — **variant B** (zero-success
turns: 3 consecutive turns whose whole batch is `isError`; reset on any success
or steer), then **variant A3** (same-target `write`/`edit` 4× with no executed
`bash` in between; verification = ANY bash call that ran — a failing `npm test`
counts as the measurement; the A2 pattern-list rejected as fragile). Landing
order + commit slicing are decided at implementation time — the spec binds the
posture, not the sequence. **(2)**
one ladder: context-only nudge, then recurrence → new `stopReason "progress"`
(distinct value; H5 auto-retry stays scoped to the identical-batch guard);
`maxProgressNudges` default 1. **(3)** rollout **measure-only**: `progressMode`
default `"watch"` (event fires, nothing else), promote to `nudge` then `stop`
via a one-line default flip backed by `/stats_progress` telemetry (fires /
recovered / rate per kind, the F2 pattern). Future-improvement log recorded in
§9 (autonomy is the direction: raise the nudge budget, name the real check
command, auto-run the verification, per-project thresholds via tre.json).
Scope: `agent-loop.ts` turn-level state, no guardrail-zone files, nothing
persisted, I3 untouched, no new CLI flags at landing. PLAN decision log gains
the D32 row; docs/02 will gain the contract rows WITH the implementation
(they describe shipped behavior, not the plan). Docs-only increment — no code
or test change; gate unchanged (1235 / 0 / 14).


---

**Archive.** Entries through 2026-10-19 (MCP tier-1/2 landing log, D28, releases,
the WS10-era history) live in `HANDOFF-archive.md` — closed history, appended
nothing since the 2026-10-23 split. This file keeps the current-status block;
older entries move there at split time.
