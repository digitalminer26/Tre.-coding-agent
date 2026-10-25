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
