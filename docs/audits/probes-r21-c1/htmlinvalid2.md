# Spec — Orchestrated multi-agent flow: schemas & contracts

**Status: P0 CLOSED (§14) — schema ground truth; implementation is
starting (P1).** This document is the *ground truth* for the orchestrator
workstream: every
artifact the system reads or writes is defined here as a schema, and the
development ledgers (below) reference schema sections by id. The rule of
development: **code follows a documented schema; a schema change is made
here first** (edit → bump the Change Ledger → then implement). This is the
same discipline the repo already uses for `docs/02` (event contracts) and
`docs/05` (extra-roots spec).

## 0. Purpose & principles

An **orchestrator** process supervises **N worker** `tre.` sessions
(target: two workers with on-demand observer/recovery inference; the dual-GPU
host may support three concurrent inference slots, subject to measurement).
The orchestrator owns **getting approved tasks to verified acceptance**:
observe → evaluate → diagnose → recover → verify, escalating only when
necessary. Premature turn endings and recoverable errors should not require
the human to supply routine continuation nudges. Single-worker self-healing
is the first useful milestone; multi-worker scheduling follows.

The deterministic control plane owns lifecycle, permissions, budgets, and
durable actions. An event-triggered observer/recovery agent judges ambiguous
failures and conducts authorized investigation through that control plane.
It need not consume an inference slot continuously. Worker and observer
capacity, context memory, and aggregate throughput must be measured rather
than inferred from slot count. Herdr is optional and not a prerequisite.

Standing principles (settled in design discussion, 2026-10-30):

1. **Session JSONL is the bus.** All inter-component communication flows
   through append-only, entry-id'd JSONL. No new transport, no parsing of
   model prose by the supervisor. (→ S1)
2. **Reflexes vs. cortex.** Behaviors fully visible inside one worker
   process stay as in-run guards (identical-batch, cycle, family-window,
   F1). The orchestrator only does what a reflex cannot: cross-run memory,
   model/slot swaps, task rewriting, human escalation, cross-stream
   patterns. Do not duplicate guards outside.
3. **Files over processes.** Every queue, state, and handoff is a file on
   disk; everything after a worker exit survives restarts. The contract is
   files so scaling a worker to a k8s Job later is a runner swap, not a
   redesign.
4. **Viewers, never forks.** All observation UIs are projections over the
   same normalized entries (the `state.ts` reducer semantics); no viewer
   re-implements interpretation.
5. **One Telegram consumer.** Human ⇄ *orchestrator* rides Telegram;
   orchestrator ⇄ worker steering rides the steer-file seam (→ S2). The bot
   is never wired worker-side in this system.
6. **Self-healing within authority; exception-based human attention.**
   Upfront policy authorizes continuation, diagnostics, and bounded repair.
   An uncertain diagnosis triggers investigation, not immediate escalation.
   New authority, consequential intent ambiguity, unreconcilable effects,
   an external blocker requiring human action, or exhausted recovery budgets
   justify escalation. Never bypass approvals or weaken acceptance checks.
7. **Acceptance, not activity.** A normal run end is not task completion;
   a successful resume is not recovery success. Require task-relevant
   progress and acceptance evidence. Control logic does not parse model
   prose as protocol; model judgments are validated structured advisory
   records, never independent grants of execution authority.

## 1. Schema index & Change Ledger

Schema ids used by implementation ledgers:

| id | artifact | section |
|----|----------------------------------------|---------|
| S1 | Worker session entries (relied-upon subset) | §2 |
| S2 | Steer-file format | §3 |
| S3 | Task graph (DAG) file | §4 |
| S4 | Worker workspace (worktree + dirs) layout | §5 |
| S5 | Supervisor decision-log entries | §6 |
| S6 | Episode state file | §7 |
| S7 | Fleet projection inputs (observation envelope) | §8 |
| P0 | Pinned wire contracts (identity, envelope, records, policy) | §14 |

**Change Ledger** (append one row per schema edit; implementation commits
cite the row). **Ledger normativity (v12, owner decision D0-b):** the
ledger is a CITATION-ONLY index — a row names the date, the sections
touched, the driving audit/decision, and identifiers (finding ids,
decision ids, artifact paths); it MUST NOT restate substantive rules
(field lists, enums, formulas, precedence, or vector values). The section
body is the sole normative text; where a pre-v12 row's paraphrase
disagrees with its section body, the body governs and the row is treated
as a historical pointer, never as a rule source. New rows are written
against this rule (terra cycles 8–9 each produced ledger-vs-body
contradictions — c8-M16/c9-M10/c9-M16 — and restatement is their only
mechanism).

| date | schema | change | driver |
|------|--------|----------------------------------------------|----------|
| 2026-10-30 | — | initial draft of S1–S7 | design discussion |
| 2026-10-30 | §12 | added build-vs-buy prior-art appendix (herdr evaluation) | internet research |
| 2026-10-30 | §2 §3 §7 §8 §9 §10 | stress-test rounds 2–4: dropped the `steer`-entry-ack premise (no such entry type exists — steer persists as a plain user message); S1 pins `progress_nudge` as a to-be-persisted contract and the toolResult-detail warn fields; S2 gains request-scoped dedup rules; §7 gains ownership-fence + reconciliation rules; §9 budgets span attempts; Q1/Q3/Q4/Q5 decided, Q2 half-decided, Q6 reopened, Q8 reframed | adversarial stress tests |
| 2026-10-30 | §13 | NEW normative recovery/durability section: append-torn-tail bug (repro: resumed append after a torn tail makes the session permanently unloadable) → tail repair is an L1 precondition; recovery invariants I1–I7; recovery test matrix as L1/L2 acceptance | round-4 stress test + repro on built code |
| 2026-10-30 | §11 | rewritten as the **compartment build plan (P0–P13)** after the plan sanity check; corrections folded in: missing terminal evidence is `unknown` never `crashed` + run/attempt identity precedes classification (P2); file steering split plumbing vs durable delivery (P3a/P3b); tailer is observation-only, never repairs (§13.1 repair stays with the exclusive writer); ownership fence + lost-supervisor reconcile is its own compartment (P7) before auto-scheduling; budget accounting is a standalone ledger consumed by classifiers, not owned by them (P8, I7); graph.json desired-vs-derived authority pinned at P0; milestone M1 = P0–P9 observe-only, autonomy enabled only in reviewed increments A1–A6. Old linear L0–L9 sequence retained below as a mapping | plan sanity check |
| 2026-10-30 | §0 §3 §9 §11 §13 | Accepted self-healing-first rescope supersedes observe-only M1 and old A1–A6 ordering: M0 foundations → M1 autonomous single-worker recovery → M2 shared multi-worker supervision → M3 broader autonomy/polish. Added explicit acceptance (P14), investigation/recovery (P15), upfront authority, aggregate recovery budgets, exception-based escalation, and productivity evaluation. Full S3/S5 wire shapes remain P0 work; unscoped supervised steering must not pass trivially. | user-approved design discussion |
| 2026-10-30 | §2 §3 §4 §6 §14 | **P0 contract closure:** new §14 pins runId/attemptId identity (§14.1), steer-file line schema + validation + envelope `steering:{requestId,source}` (§14.2, replacing the P0-pending scope placeholder), the four `decisions.jsonl` record kinds `decision-intent`/`decision-outcome`/`acceptance`/`diagnosis` (§14.3, S5 action enum extended to `backoff-retry`/`investigate`/`repair`/`accept-finish`), task revision (§14.4), derived ownership (§14.5), `progressNudge` entry shape closing Q2b (§14.6), `runEnd` reason set (§2), episode/task policy + recovery-budget shapes (§14.7), and the `workerState` closed set (§14.8). S3 gains structured `acceptance` + `policy` + derived-vs-desired authority rule; S1 pins toolResult detail fields and adds the two new entry types as contracts (implementation at P1/P2) | P0 (implementation kickoff) |
| 2026-10-30 | §14.6 | **Amend at P1 start:** `progressNudge.mode` corrected to the real `ProgressMode` (`watch\|nudge\|stop` — the first pin's `warn\|stop` never existed), and `turn`/`count`/`target` added for event parity (stats attribution). Driver persists every fire, every mode | P1 implementation |
| 2026-10-30 | §2 §13.4 §11 | **P2 implemented:** `runEnd {runId, reason}` terminal entry is driver-appended at agent_end (`RunEndEntry`, `appendRunEnd`, `driverRunEndReason`; `runTurn` allocates the per-invocation runId). Q6 closed; P2 row flipped to done | P2 implementation |
| 2026-11-01 | §14.2 §2 §11 | **P3a implemented:** the steering path carries provenance end-to-end — `SteeringQueue.push(string \| SteerEntry)` / `drain(): (string \| SteerEntry)[]` (agent-loop.ts; the widened drain keeps existing string-returning mocks valid), the `steer` event gains `steering?: SteeringMeta`, `MessageEntry` gains optional `steering`, and the `runTurn` persist tap writes it. Plain-string pushes (TTY and every legacy caller) normalize to `{requestId:"", source:"tty"}` — delivered text and persisted `.content` byte-identical. Telegram driver routes envelopes (`source:"telegram"`, optional `requestId`) through its handoff buffer; the TUI busy-branch telegram steer pushes the same envelopes. P3a row flipped to done | P3a implementation |
| 2026-11-01 | §4 §5 §6 §7 §14.3 §13.1 §11 | **P4 implemented:** `src/episode/journal.ts` ships the episode journal primitives — typed `EpisodeGraph` (S3, `tre-graph/1` incl. §14.7 policy/recoveryBudget/authority shapes and derived `status`/`result`), `EpisodeState` (S6, `tre-episode-state/1`), and all five §14.3 record kinds (`decision-intent`, `decision-outcome`, `acceptance`, `diagnosis`, plus the §14.1 `attempt` record) with envelope + kind-schema validation via the zero-dep validator. Graph/state go through atomic-rename writes (tmp+fsync+rename — concurrent readers never see partial JSON); `DecisionJournal` appends validate before write and fsync before returning (sync-before-ack) with §13.1 torn-tail repair on open (truncate partial tail / terminate newline-lost record; mid-file corruption throws, never silently skipped) and duplicate-id reporting; `createEpisodeLayout` builds the S4 scaffold (`~/.tre/episodes/<id>/{prompts,events,sessions,wt}` + seeded graph.json, Q3); I2 reconcile projections `openIntents`/`latestAttempt`/`unresolvedSpawns`. Primitives only — an enforced test keeps every other module out of these files until the supervisor (P6+) lands. 16 tests; P4 row flipped to done | P4 implementation |
| 2026-11-02 | §2 §13.1 §13.2 §14.8 §11 §7 | **P5 implemented:** `src/fleet/tail.ts` ships the read-only ingestion & fleet-projection primitives — `JsonlTailer` (offset-persistent cursor with the held partial **persisted in the state file**: a torn line is never duplicated or redelivered across polls or restarts; §13.1-aware reconcile — truncation or same-size in-place rewrite (64-byte head fingerprint + mtime) triggers a full rescan with `resume` flag and content-fingerprint ids; invalid-UTF8 lines are counted-and-dropped without poisoning the cursor; **observation-only — never repairs the watched file**, §13.1 repair stays with the exclusive writer); `projectSessionReplay` (deterministic id-sorted replay + entry-id dedup, first-wins, duplicate counts, carry-forward — §13.2 I6 offsets are an optimization, never delivery authority); §14.8 `classifyWorkerState` over a frozen closed set (`WORKER_STATES`) with rule order dead→stopped→ephemeral tool/approval/thinking→pending toolCall→warned and a `classifiedFrom` audit trail — I3 pinned: silence NEVER classifies `thinking`, `dead` requires a supervisor-written `crashed` terminal or caller-CONFIRMED process loss; `projectWorkerEnvelope` emits the S7 `tre.observe.v1` doc (monotonic revision, atomic tmp+fsync+rename); `FleetObserver` emits the per-episode `tre-fleet/1` envelope stream (per-worker seq recovered from the stream, `emitDecision` interleaves §8 supervisor decisions, envelope-level `stale` at `staleAfterMs` default 300000, live-worker marker staleness). Two enforced compartment guards: nothing outside `src/fleet/` imports the module and `src/fleet/` imports only `node:` builtins. 22 tests; P5 row flipped to done | P5 implementation |

| 2026-11-02 | §3 §13.1 §13.3 §14.2 §11 | **P3b implemented:** `src/steer/file-queue.ts` ships `FileSteeringQueue` (implements the 2-method `SteeringQueue` seam over a supervisor-appended JSONL at `--steer-file <path>`, file created empty at startup, one consumer per file — §13.2 I1). Incremental `scanJsonl` cursor: complete lines only; a torn tail is held (base64 partial) and joined on the next append, **never repaired** (§13.1 repair stays with the exclusive writer); reconcile-to-0 + same-call rescan on shrink, head-fingerprint divergence at ANY size (the 64-byte prefix is checked against the buffer already read — a replacement larger than the offset still moves the head; a P3b test caught the size+mtime-gated version missing exactly that), or disappearance after content. §14.2 validation table: malformed lines skipped+counted (non-object / missing-or-non-string `id`/`text` / unknown `priority` — never down-defaulted), managed-mode `attemptId` mismatch skipped+counted with warn-once and never acked, unmanaged mode ignores `attemptId`; transcript dedup by requestId — recorded+same-text is an acked no-op, recorded+different-text is `conflictRejected` (warn-once, not injected, not acked), and a pending-injection guard settles handed-off-but-unrecorded same-text redelivery so a rescan never mistakes it for a conflict. §13.3 crash eligibility: the persisted offset (`<path>.offset.json`, tmp+fsync+rename) never advances past the **START** of a line whose injection is unrecorded (row 1 → a crash restart re-reads and redelivers the whole line); a recorded line advances it and a re-read dedups to a no-op with zero duplicate transcript insertions (row 2); corrupt state = no state (full rescan, deduped). The persisted offset is ALWAYS a line boundary: saveState clamps it back over any held partial (the partial's bytes sit immediately before the scanned offset — persisting it un-clamped would lose the in-flight line on restart; the partial needs no persistence of its own — it is re-read from the file), and the head fingerprint (offset-independent, first 64 bytes) IS persisted, so a same-size in-place replacement across a restart is caught rather than sliced from mid-line (self-audit follow-ups: both were defects in the first cut, pinned by two new tests). Provenance: envelope `requestId` = line id, `source` default `"file"`; pushed (shared-driver) items drain before file lines; close writes a stats line (lines/injected/malformed/scope_mismatch/dedup_acked/conflict_rejected). CLI: `--steer-file` requires a session file (the transcript is the dedup authority) and composes into every run path (one-shot, REPL, TUI via a per-run factory so run N+1 sees appends during run N); absent flag = byte-identical behavior. Enforced guards: nothing outside `src/cli/` imports the module; `src/steer/` imports only node: builtins + type-only repo types. 18 tests (incl. 2 self-audit follow-ups: held-partial offset clamp across restart, persisted head fingerprint vs same-size replacement); full suite 1555 pass | P3b implementation |

| 2026-11-02 | §8 §13.1 §14.8 | **P5 implement-audit on 46cee06** — verdict PASS (spec-faithful; §13.1/§13.2/§14.8/S7 verified by probe: torn-write storm 133/133 exact-once, restart storms, I6 deep-equality). Three findings fixed: (1) `FleetObserver` (refresh / seq-recovery / `emitDecision`) had zero test coverage — 6 new tests pin seq-ordered append, high-water-mark recovery (torn tails carry NO seq: the mark is the last PARSED line, and reuse over an undeliverable torn envelope is safe; a complete high-seq line does bump it), decision interleaving with `workerState:"unknown"` (I3), and on-demand `events/` creation; (2) `parseFleetEnvelope` accepted unknown `source.kind` values carrying plausible fields — the kind union is now a checked closed set alongside the per-kind discriminator checks; (3) the tailer's offset-state write and `emitDecision` crashed `ENOENT` against a bare episode dir — `writeJsonSynced` now ensures its own parent dir (outputs only, never watched files) and both observer write paths mkdir `events/`. Header comment corrected: the persisted offset DOES cover the held partial (persisted base64 alongside it). 28 tests total | P5 audit follow-up |
| 2026-10-31 | §14.3 | **Implement-audit cycle 2 on 2feb04a** (auditor claude-haiku-5.5): both cycle-1 recommendations verified RESOLVED (plus an independent 20,000-doc probe with unicode-escaped keys: 0 FP / 0 FN). Three cosmetic findings on the fuzz test fixed: duplicated header comment (my splice artifact), a no-op `void JSON.stringify`, and a dead `=== undefined` branch replaced with REAL independent verification — a sentinel value prepended as the duplicate key, asserted absent after JSON.parse's last-wins collapse, proving constructed duplicates are genuine ambiguity not malformed docs | audit p4-audit-followup c2 |
| 2026-10-31 | §13.1 §14.3 | **Implement-audit cycle 1 on 612564a** (auditor claude-haiku-5.5; gpt-6.1-sol/gpt-6-astra hit provider 429s): previous tail-repair finding RESOLVED (verified by probe, gate green). Two recommendations fixed: (1) the offline scanner fuzz is now pinned in-repo — 1200 seeded-LCG documents (600 valid + 600 constructed duplicates, all adversarial strings built through `JSON.stringify`, not double-escaped literals) plus the adversarial case table, via a new `@internal` export of `duplicateKeyIn`; (2) the tail guard's input contract (raw, complete-but-unterminated JSON) is pinned directly, since the guard itself stays reachable only through the race `open()` closes | audit p4-audit-followup c1 |
| 2026-10-31 | §13.1 §14.3 | **P4 audit of d5447d8:** the duplicate-key boundary is now also enforced inside the tail repair, so an unterminated record that repeats a key is never terminated into the journal (defense in depth; `open()` already rejects it through `read()`, which is the externally observable guarantee). Confirmed a fail-closed behavior, not a bug: pretty-printed multi-line records are rejected as corrupt, and the writer always emits one line because `JSON.stringify` escapes embedded newlines. Scanner fuzzed against 600 generated documents and targeted adversarial cases (escaped backslashes, braces/colons in strings, duplicates in nested arrays, whitespace before colons) with no false positives or negatives | P4 audit d5447d8 |
| 2026-10-31 | §4–§7 §13.1 §14.1 §14.3 | **P4 post-commit audit (7a52bb7):** four residual issues found by review of the committed code and fixed — (1) `read()`'s `malformed` field was unobservable dead API (both increment sites throw), removed from the return type so the fail-closed contract is explicit: corrupt records are THROWN, never skipped-and-counted, because a silently dropped decision corrupts I2 reconcile; (2) `DecisionJournal.open()` discarded its own repair result, so an episode whose only record was a torn fragment became indistinguishable from one that never wrote — `open` now records it and `tornTailRepaired` exposes it; (3) `JSON.parse` is last-wins, so a line repeating `kind`/`id`/`actionId` validated as a record the author never wrote — `duplicateKeyIn` now rejects repeated keys on every JSON boundary (journal lines and graph/state reads), with escaped-unicode keys (`"a"` vs `"\u0061"`) normalized to the same key and benign same-name strings inside different objects still accepted; (4) a legacy corruption test asserted only rejection, not the no-mutation contract in its own name — now asserts the file is byte-identical after a failed open. Durability claims re-verified as correctly scoped: `writeJsonAtomic` does tmp+fsync+rename with no directory fsync, which is exactly the "process-death durability, not power-failure" bound §13.1 R3 states — no overclaim. 3 new regressions + 1 strengthened | P4 post-commit audit |
| 2026-10-31 | §4–§7 §13.1 §14.1 §14.3 | **P4 spark-1.3 audit series (4 cycles, meta/muse-spark-1.3-contributor):** cycle 1 clean; cycle 2 found and fixed 7 — terminated blank/whitespace JSONL lines now fail closed (only an unterminated whitespace tail is torn), `latestAttempt` takes optional episode scope, intent closure keyed `(episodeId,taskId,actionId)` (cross-task actionId reuse can never close), `validateShape` rejects circular input as `EpisodeSchemaError` instead of overflowing the stack, `append` serializes first so unserializable records (BigInt etc.) reject pre-I/O with the queue unpoisoned, `writeJsonAtomic` GCs crash-leaked `.tmp-*` siblings older than 60 s, partial `createEpisodeLayout` scaffold documented caller-reconciled (graph.json presence is the commit marker; retry idempotent); cycle 3 found and fixed 3 minor — poisoned-instance rejection is `EpisodeSchemaError`, cycle guard made ancestry-scoped (diamond-shared nodes valid, true cycles reject), tmp sweep requires the canonical-UUID name shape; cycle 4 CLEAN signoff. 19 new regressions across the series | P4 spark audit series |
| 2026-11-01 | §4–§7 §13.1 §14.1 §14.3 §11 | **P4 audit hardening:** complete runtime validation of known graph/policy/authority/budget, state-map, and record fields (unknown additive keys preserved); exact JSON snapshots validated before filesystem mutation; closed-kind own-property lookup; nullable spawn outcomes; latest-per-attempt spawn projection. Episode IDs must be one safe ASCII component (`[A-Za-z0-9][A-Za-z0-9._-]*`) and scaffold identity must match the graph. Journal open validates history before private tail repair: terminated malformed lines and schema-invalid records fail without mutation; only an unterminated unparsable final line is discardable. Appends serialize per instance and fsync before return; any I/O failure poisons the instance until validated reopening. Exclusive ownership across instances/processes remains the P7 caller contract, not an OS lock supplied by P4. | P4 audit fixes |
| 2026-10-31 | §5 §11.1 §14.1 §14.5 | **P6 implemented:** `src/worktree/provision.ts` — see the P6 row for the full contract (provisioning ONLY: open/ensure/open/remove/prune, branch pin + HEAD verification, conservative gates, provenance for AttemptRecord). Audit series (deepseek-v4.1-flash-1017 read-only, `docs/audits/audit-p3b-p6c{1..4}.txt`): cycle 1 — 2 CONFIRMED-WRONG + 3 RISK, all fixed (no-mutation-on-refusal via probe-before-mkdir on the nearest existing ancestor; bare-foreign detection via `--git-common-dir`; real `--` positional separator for dash-prefixed revs; probe negatives classified — exit 1 + search-exhausted wording only, everything else git-failed; branch-in-use pre-gate). Cycle 2 — 1 CONFIRMED-WRONG (renamed linked worktree escaped registry-path containment): fixed by REPLACING containment with the stricter authority rule — anchor resolving to OUR common git dir is refused unconditionally. Cycle 3 REJECT: 2 more — broken-gitlink stderr `not a git repository: (null)` conflated with search-exhausted (tightened markers: full parenthesized wording; gitlink corpse → git-failed); nearestExisting could anchor on a regular file (`.git` gitfile) → ENOTDIR (now directory-only). Cycle 4: **ACCEPT — no findings**; residual TOCTOU risks accepted for P6 under the §14.5 caller fence (git rejects concurrent duplicates; failures surface safe-state). 34 tests on real git repos; full suite green | P6 implementation + audit series |

| 2026-10-31 | §5 §11.1 §14.1 §14.5 | **P6 REOPENED by an INDEPENDENT audit (cycle 5) — the cycle-4 ACCEPT was NOT independent:** cycles 1–4 were run by the same model family that implemented P6 (deepseek-v4.1-flash-1017), so the sign-off shared the implementer's blind spots. A fresh audit on 603611d by two different families (anthropic/claude-haiku-5.5; meta/muse-spark-1.3-contributor, `docs/audits/audit-p6-indep-{claude,spark}.txt`) both returned **REJECT**, converging on the same defects — three of them proven empirically with a live probe harness, not by inspection. FIXED: **(C5, correctness)** `ensureTaskWorktree`'s preexisting-registration path returned `baseCommit: <requested base>` beside `head: <registry head>` with NO relation check, so a retried attempt with a moved base (or a repo mutated between attempts) was handed back as success with false provenance — a false §14.1 AttemptRecord and a wrong P12 merge anchor; now the registration's HEAD must be the base or descend from it (`merge-base --is-ancestor base head`, direction pinned by test) or `branch-conflict`. **(C8, data loss — the serious one)** the `deleteBranch` proof `rev-list base..branch` is trivially EMPTY when the caller passes the branch's own tip as `baseCommit`, so the gate "proved" loss-free deletion and then discarded real commits — reproduced: one unmerged commit on `agent/e/t`, `removeTaskWorktree({baseCommit: tip, deleteBranch: true})` deleted the branch. The proof now requires base to be an INDEPENDENT pin — reachable from some ref OTHER than the branch being deleted (`for-each-ref --contains`), i.e. the branch must not be the base's only owner — plus the ancestor check; the old test that codified "base == branch tip is provably loss-free" was corrected rather than kept green. **(C1, contract)** `prune()` returned `{refusedForeign}` instead of throwing, so `await prune(); proceed` callers believed cleanup succeeded while it had been blocked, and the declared `prune-refused` code was dead — now it throws. **(C6)** `listWorktrees` ignored git's `locked` line, so a locked worktree surfaced as a bare `git-failed` after the dirty gate, and a locked-and-vanished entry got a "call prune()" message prune cannot complete — `locked` is now parsed, `remove` refuses with the new `locked` code (force remains the explicit override) and the stale message names `worktree unlock`. **(C2)** `nearestExisting` walked up on ANY `statSync` error including EACCES, skipping an unreadable ancestor in a gate whose contract is fail-closed — now only ENOENT/ENOTDIR walk up, everything else is `git-failed`. **(C4)** the post-creation HEAD check went through the generic probe classifier, which maps exit 1 to "not found" for probes that cannot legitimately answer that and suppresses stderr, producing "HEAD null does not match"; it now calls `git()` so the real stderr surfaces. **(C3, documented residual)** `pathsEqual` is string equality while only `wtRoot` is realpath'd, so a case-insensitive or `/tmp`->`/private/tmp` aliasing spelling misses the registry entry — fail-CLOSED only (`path-exists`/`not-registered`/foreign-in-prune), never a wrong worktree; the comment claiming both sides were canonical was false and is corrected. 3 new regressions (C8 base==tip deletion refused with the work still on disk; C5 moved-base retry refused while same-pin retry still converges; C6 locked refusal) + 2 tests corrected; suite 1597 pass / 0 fail / 14 skip | P6 independent audit (cycle 5) |
| 2026-11-01 | §5 §11.1 | **P6 ds-audit series (cycles 1-5, deepseek-v4.1-flash-1017, `docs/audits/audit-p6-ds-c{1..5}.txt`) on 673d4a1..fa2e88c. Process: every auditor CONFIRMED claim was re-verified by EXPERIMENT before acting; two claims were DISPROVEN on git 2.54 and pinned with regression tests instead of being "fixed" — (a) tag-shadowing of the `worktree add <branch>` commit-ish (it is branch-oriented; the proposed refs/heads/ qualification would itself have created a detached-worktree defect), (b) unlocked recreated-dir entries escaping `prunable` (git checks `<path>/.git`, not `<path>`). CONFIRMED+FIXED — c1: a same-named TAG shadowed the branch in the deleteBranch proof (refs/tags/ precedes refs/heads/ in rev-parse; gate proved against the tag while `branch -D` deleted the real advanced branch — fixed by `refs/heads/`-qualifying every proof operand); single `--force` cannot remove a LOCKED worktree (git requires `-f -f`, verified) and force now overrides the lock; locked entries are NEVER marked prunable by git, so locked+vanished directories masqueraded as live in ensure/open/remove and prune silently returned `removed:[]` (now `entryGone` checks the `<path>/.git` gitfile; prune refuses locked stale with unlock+prune guidance, convergence tested); `isDescendantOf` masked real git failures as branch-conflict (now propagates git-failed); locked refusal reordered after the foreign check so a locked FOREIGN entry is never advertised force-discardable. c2: the branch-users pre-gate gave circular branch-in-use for stale users (now stale/live split, actionable guidance; proven git cannot host two live checkouts of one branch, so the stale split is the reachable state); locked liveness compared dir existence not the gitfile (a deleted-then-recreated plain dir was returned as a live worktree). c3: `open()` with wtRoot as a regular FILE leaked raw EEXIST past the typed contract (now `bad-wt-root`); ensure()'s accept-locked-live-entry decision documented with the submodule-migration hazard and the §14.5 ownership rationale. c4: check-ref-format-only bad ids (`a..b`, `t1.lock`) had no reaching test (SAFE_COMPONENT accepts them); a plain FILE at the task path produced raw git-failed on ensure and a silent `noop:true` on remove (now typed `path-exists` / `not-registered`). c5: a DANGLING SYMLINK at the task path read as absent (stat follows links; git itself refuses it) — `pathOccupied` is now lstat-based and fails CLOSED on stat errors; and the §11.1 P6 row — the designated full contract — still described the REJECTED `base..branch`-only proof and omitted `bad-wt-root`/`locked` from the error union: corrected in place (row now lists the full typed union, the independent-pin proof with its ref-shadowing rationale, and the mutation-sweep status). Mutation sweep (c4, re-checked c5): all ten data-loss guards fail a test when reverted; one accepted untested tripwire: the post-creation `head !== baseSha` race guard (documented). Residuals: the series ran with a same-family auditor (mitigation that made it viable: the implementer disproved 2/3 audit cycles worth of claims experimentally before acting — never fix from an unverified audit claim); TOCTOU accepted under the §14.5 caller fence. Suite 1611 pass / 0 fail / 14 skip (51 worktree tests) | P6 ds-audit series c1-c5 |
| 2026-11-01 | §11.1 | **P7 implemented, then REJECTED by an independent audit (cycle 1):** `src/runner/attempt.ts` (807 lines, 19 tests, suite 1630 pass / 0 fail) ships the attempt runner primitives — intent-before-act (I2), attemptId allocation from records+hint+caller (§14.1), SIGTERM→SIGKILL process-group stop, ownership fences, `reconcile()` spawn/park/running, `confirmStopped()` with required evidence, S6 hint writes, plus the P4 guard widened to bless `src/runner/` and a new P7 guard blocking external consumers. Audit `docs/audits/audit-p7-report.md` (two independent families — anthropic/claude-haiku-5.5, meta/muse-spark-1.3-contributor — plus a 10-probe live-process harness in `docs/audits/p7-probes/`) returned **REJECT** on 8 empirically reproduced defects, four breaking stated contracts: the liveness gate keys to the single-attempt state.json hint, so **a task cannot be retried a third time in one process** (probe13) and a restart costs one evidence-bearing manual confirm per historical attempt — each falsifying the log it recovers from (F1/F2); `stop()` reports `stopped:true, escalated:false` while a TERM-ignoring grandchild survives in the group and keeps writing the session (probe8, I1) (F3); the fence joins on `taskId` instead of the (session, worktree) pair, so a foreign task's unresolved or spawned-ok record on the same session is invisible after restart (probe5, §14.5) (F4); concurrent `run()` calls both pass the async fence before either registers its child — two workers with the SAME attemptId, one untracked and unstoppable (probe10, I1) (F5). Also: `confirmStopped` on an older attempt repoints the hint backwards and deletes a LIVE attempt's pid (F6); the default spawner emits `--attempt-id` (no such CLI flag) and `--resume --session` (mutually exclusive) under `stdio:"ignore"`, so every attempt is recorded `"ok"` for a worker that never ran (F7); `close(true)` plus non-normalized roots admits a second writer over a live worker (F8). Suite was green only because tests never exercise concurrency, attempt history, group lifetime, cross-task claims, or hint staleness. **The P7 row is not `done`**; P9 must not wire this until the report's ordered remediation (9 items) lands and is mutation-swept | P7 audit cycle 1 (REJECT) |
| 2026-10-31 | §11.1 | **P7 remediation against `docs/audits/audit-p7-working-tree.md` (all 9 findings + dead code):** the working-tree audit found the module did not compile (blocker) — fixed, with the ESM-safe executable check (`accessSync(X_OK)` via named `constants` import). Rewrote the ownership core: `confirmStopped` decides ownership by SPAWN GENERATION (a newer tuple's live claim survives confirmation of an older one, across reopen); session paths are canonicalized at `run()`/`resume()` entry (`..`-traversal spelling = same identity); **group liveness via `kill(-pgid,0)`** — `stop()` returns `groupStatus` and leader death alone never releases ownership (`reconcile()` parks and `run()`/`confirmStopped()` refuse while the group is alive OR its liveness is undeterminable, EPERM — I3: silence is not evidence); resolved `'failed'` outcomes are negative evidence (never block reconcile/spawn); single-flight `AttemptRunner.open()` (concurrent opens for one episode yield ONE journal writer); `validateSpawnSpec` refuses `--attempt-id` and `--resume`+`--session` and the default `treWorkerSpawner` emits XOR `--session`/`--resume` argv with attempt identity via ENV; the S6 hint advances to a legitimately newer attempt but refuses a stale rewind; removed the empty `newestPerSession` stub and unused `reservations` tripwire. Tests: 19 -> 27, each finding has a named regression test; the F5 group fixture was replaced (TERM-ignoring busy-loop leader with no children — the old `trap; sleep & sleep` fixture was genuinely flaky: foreground `sleep` dies to group-wide TERM and the leader exits naturally, racing `escalated` to false — confirmed by probe). `npx tsc` clean; runner suite 27/27 on 8 consecutive runs; full suite **1638 pass / 0 fail** (14 skipped). **Still NOT accepted:** the audit's own standard applies — independent re-audit (fresh family + live probes) must confirm before the P7 row goes `done` or P9 wires it | P7 remediation (re-audit pending) |
| 2026-11-02 | §11.1 §13.2 | **P7 ACCEPTED — R4–R8 adversarial re-audit cycle closes the acceptance gap.** Five further independent review rounds on the working tree (reports `.tre/audit-r5-review.md`…`.tre/audit-r8-review.md`, each round REJECT→fix→re-review, plus the earlier committed cycle `0bce050`): **R4** F15–F19 (confirmation provenance, evidence gates); **R5** F16-parallel + refresh/queue races (fix: single serialized writer queue + snapshot revalidation); **R6** R6-1 own-child-exit bypassed independent live/inconclusive hint evidence (fix: per-pid EXIT exclusion in the analyze probe, `prior-attempt-running`/`prior-attempt-unresolved` checks in the spawn fence), R6-2 `confirmStopped` honored an arbitrary supplied session (fix: journal-bound session check, mismatch = `bad-input`), R6-3 external-state-writer atomicity (fix: explicit CONTRACT comment — writes serialized only within this runner's queue, external writers must stop the runner first; cross-process lock consciously declined); **R7** refresh-first ordering regression + wrong-session coverage (6/6 adversarial repros); **R8** **PASS, no actionable findings**, R7-1 confirmed mutation-verified (15/15 isolated; fails when the serialization is removed). Acceptance judgment: R5–R8 reproduced real defects adversarially (not rubber-stamped) and ended clean with repro harnesses green against shipped dist — this satisfies the "independent re-audit + live probes" bar; **the P7 row flips to `done` and P9 may wire the runner.** Final: `src/runner/attempt.ts` ~2,090 lines, 103 runner tests, full suite **1711 tests / 1697 pass / 0 fail** (14 skipped), quality gate green. Accepted-by-design limits pinned in `.tre/remaining-items-review.md` (external-writer best-effort detection; the final hint revalidation window cannot close its own read→append interval — acknowledged, bounded by the queue contract) | P7 R4–R8 re-audit cycle (PASS) |
| 2026-11-03 | §14.3 §11 | **P14 contract drafted (docs/13):** the acceptance-evaluator compartment spec — pure evaluate() over evidence sets (gates/artifacts/claims/blockers) bound to an artifact identity (§1 staleness anchor: sha + dirty + dirtyDigest); EV1–EV12 evidence rules (claims are advice, never set a verdict; deterministic passes never model-funded; a gate FAIL is incomplete never blocked; unknown is the floor, never a weapon); total precedence for the verdict function; §5.1 isStale() for stored assessments (revision + artifact identity). §14.3 acceptance record amended additively: criteria[].advisory, staleEvidenceRefs, artifact identity. Contract-first row per §11.2 — module landed in src/acceptance/ against this spec: **as-built** `evaluate()` / `isStale()` / `sameArtifact()` / `toAcceptanceRecord()`, 50 tests (AC1–AC9 named, mutation-style per EV12 conjunct, fuzz-lite fail-closed, P8-pattern compartment guards); audit cycle `.tre/audit-p14-r1.md`: R1 fixed the conjunction-vs-blocker precedence (docs/13 §4 R1-amendment: unmet-required evidence outranks blocked, EV9) + three hygiene/fail-closed defects; R2 fresh probes vs dist fixed null-input throw (AC5) and a current-FAIL-of-unlisted-gate complete-leak (EV12 "no current FAIL anywhere") + pinned last-write-wins claim funding; R2 remainder clean. Final: 53 acceptance tests (AC1–AC9 named, EV12 mutation matrix, fuzz-lite fail-closed, P8-pattern compartment guards), full suite **1844 / 1830 / 0-fail** (14 skipped), quality gate green. **F1–F7 fix cycle (2026-11-03, independent review `.tre/audit-p14-review.md`, all seven closed):** F1 artifact evidence absent/non-boolean `exists` is UNKNOWN (uncertain), never satisfied — only `exists===true`+digest satisfies (EV4 strict); F2 all four evidence arrays must be arrays — non-array is bad-input, never silently empty; F3 claims bind to `claim.at` — unbound/stale claims fund and flip NOTHING (EV6 currentness enforceable); F4 AC1 floor unconditional — claims-only spec caps at uncertain, complete needs ≥1 current non-model evidence; F5 full output validation (claim output fields validated, `toAcceptanceRecord` validates the complete §14.3 shape and throws, P4 schema+types carry the amended fields); F6 judge-declared incomplete is a CONCRETE finding outranking missing-evidence (incomplete wins); F7 empty-sha stored artifact never live. docs/13 §8 is the amendment record; suite grew to 75 acceptance tests | P14 fix cycle F1–F7 |
| 2026-11-03 | §14.3 §11 | **P14 cycle-2 fix round (audit `.tre/audit-p14-cycle2.md` on `efd1866`, all five closed; docs/13 §9 record):** C2-F1 the F4 evidence floor gates only completion eligibility — concrete negative findings (current FAIL, observed `exists:false` artifact) precede it, restoring `incomplete`/`verdict:artifact-missing` for proven-missing artifacts; C2-F2 claims-only classification corrected — a required DETERMINISTIC criterion is an evidence requirement (EV7), such specs take normal evidence rules (current FAIL → incomplete, EV3 unmasked); C2-F3 schema parity at every emission point — claim intake requires non-empty `judge` (empty → dropped advice, funds nothing), non-empty `dirtyDigest` when present, converter refuses out-of-[0,1]/non-finite `confidence` (deliberately stricter than journal `num`), and §14.3 acceptance `artifact` is **no longer nullable** (`artifact:null` rejected; absent = no identity); C2-F4 `isStale` validates both revisions (positive integers per §14.4) — malformed revision (0/-1/1.5/undefined) is never live; C2-F5 records corrected: the F1–F7 review was same-session (not independent/fresh-family) and the '75 acceptance tests' count was wrong (68 at rebuild). New durable round-trip regression: real DecisionJournal append→read identity + `artifact:null` fails closed on reopen. Suite: 78 acceptance tests, full **1869 / 1855 / 0-fail** (14 skipped). Audit acceptance remains OPEN pending a cross-model review round | P14 cycle-2 C2-F1–F5 |
| 2026-11-03 | §14.3 §11 | **P14 cycle-3 follow-ups (docs/13 §10):** C3-F1 the C2-F4 regression was one-sided (valid stored + malformed current — `!==` already caught it); now covers the audit repro of MATCHING malformed revisions on both sides and fails against pre-fix source. C3-F2 (contract change, user-approved): concrete negative findings now outrank the CLAIMS-ONLY CAP too, not just the evidence floor — a claims-only spec whose judge explicitly calls a REQUIRED criterion incomplete is `incomplete`/`verdict:criterion-incomplete` (F6's principle: presence of a finding outranks absence of evidence of any kind). Boundaries pinned: positive claims still cap at uncertain; judged-incomplete on an OPTIONAL criterion keeps the cap. 4 new tests (82 acceptance); full suite see HANDOFF. Audit acceptance remains OPEN pending a cross-model review round | P14 cycle-3 C3-F1–F2 |
| 2026-11-03 | §14.3 §11 | **P14 CROSS-MODEL AUDIT — acceptance CLOSED (docs/13 §11):** two auditor workers on independent model families (adversarial probe hunter + contract-vs-code traceability, read-only vs HEAD `64d3db9` + built dist, artifacts `.tre/delegation/p14-xmodel-audit/`). Auditor A: PASS — 8192-combo independent-model differential on the §4 precedence ladder (verdict + firing branch + exclusivity) with 0 mismatches, ~120 identity/claim/converter/P4-parity probes, no contract violation. Auditor B: FINDINGS 5 Major + 4 Minor — ALL docs/records/tests, none in verdict logic: F-1 §header/§8 "independent" wording corrected to same-session (C2-F5 conformance); F-2 HANDOFF 87→90; F-3 EV1 `staleGates` → `staleEvidenceRefs`; F-4 §2 "unique gate ids" rewritten to the code+EV2 semantics (contradictions bad-input, duplicate same-value counts once) + pinning test; F-5 new evaluator-side C2-F3 regression (empty dirtyDigest through evaluate/sameArtifact/isStale); F-6 EV5/EV6 advisory wording now matches code (last model-judgment, identity-independent display); F-7 EV6 last-write-wins ordering rule stated + both orders pinned; F-8 converter hardened (declared identity shape only — extra caller keys dropped, artifact/modelAdvisory cloned, dead branch removed) + §7.4 documented + regression; F-9 this roadmap row flipped to done. 6 new tests (96 acceptance); full suite **1887 / 1873 / 0-fail** (14 skipped) | P14 cross-model audit |
| 2026-11-04 | §14.3 §11 §12 | **P14 THIRD-FAMILY AUDIT (user-requested, `gpt-6.1-sol`, HEAD `87851dd`; docs/13 §12 record):** independent adversarial worker, 5 probes / 5,876 checks, dist freshness verified by in-memory recompile — verdict FINDINGS, all reproduced against HEAD before fixing: S-F1 (Major, real logic) EV6 claim replacement was conditional not total — later below-bar positive retained an earlier funding (optimistic complete from sub-bar confidence), later below-bar negative retained a stale finding; loop rewritten to select-and-apply the last naming claim exclusively. S-F2 (Major) AC5 never-throw escaped value-hostile objects (throwing getters / hostile+revoked Proxies / broken iterators, 17 throws) — `evaluate` is now a structural try/catch fence over `evaluateInner`. S-F3 (Major) sparse string arrays defeated `every()` and escaped the converter as journal-invalid records — `denseStringArray` requires index existence. S-F4 (Major) regression in the §11 F-8 fix: `{...modelAdvisory}` cloned to `{}` for inherited/own-non-enumerable VALID fields — explicit declared-field copy. S-F5 (Major) §7.4 TypeError fence leaked Error/RangeError through guard `String()` interpolation — converter wrapper normalizes. S-F6 (Minor) F-8 converter-side key-drop was unpinned — direct corrupt-assessment test. 8 named S-* regressions (104 acceptance); all five sol probes re-run on the fix: previously-failing probes PASS. Full suite **1895 / 1881 / 0-fail** (14 skipped). P14 acceptance RE-CLOSED on three-family evidence; roadmap row unchanged (done) | P14 third-family audit S-F1–F6 |
| 2026-11-03 | §11 | **P14 cycle-3 audit follow-up (C3-F3, user-approved):** the audit of C3-F2 found asymmetric confidence bars — ANY judge `incomplete` (confidence 0 included) set the finding rung while `complete` required confidence ≥ `semanticMinConfidence`; C3-F2 made negatives verdict-setting on claims-only specs, so confidence-0 could flip `uncertain`→`incomplete`. Fixed: negatives held to the SAME bar (absent confidence = 0); below-bar incomplete still never passes the criterion (conservative direction unchanged, remainingWork still names it) — it just is not a finding. EV5 row now carries the C3-F2 exception AND the C3-F3 bar in contract text; 5 new tests, mutation-checked (ungating fails exactly the gating tests). Suite: 90 acceptance, full **1881 / 1867 / 0-fail** (14 skipped). Audit acceptance remains OPEN pending a cross-model review round | P14 cycle-3 C3-F3 |
| 2026-11-04 | §6 §14.3 §11.1 | **P11 implemented (contract `docs/15`):** `src/executor/exec.ts` (~1,070 lines) ships `executeRecoveryAction(plan, ctx, ports)` — consumes ONE P10 PlanRecommendation as HOSTILE input (every property read inside one fence, E5 never-throws), performs exactly the action it names through injected ports (journal/runner/gate/steer/dispatch — structural mirrors of P4/P7/P8/P3b/P15, pinned 1:1 by drift-guard tests against the REAL planner exports), and journals a §14.3 `decision-intent` BEFORE the act and a `decision-outcome` after it (E2 log-then-act: intent-append failure = zero port calls; E4 ack = delivery only, `progress` always `"none"`; E6 lost outcome → `outcomeDurable:false`, never re-run). §2 revalidation: closed-table fence (action/decision/rung/sideEffect/strategy template, `notAPermission:true` provenance, authority-inversion refusal, model-swap `swap:model:<id>:v1` recomputed from the plan's own model — a strategy naming a different model is refused as a repeat-budget bypass); `hold` → `held` sentinel. §3: missing port = refusal that journals nothing; `merge` always `merge-unwired`; `accept-finish` record-only. §4 dedup: FNV-1a actionId over canonical plan snapshot + `executionSeq` (deterministic across clones; seq is the ONLY disambiguator); open intent refuses re-issue, acked-done refused, `no-effect:`-marked outcome re-opens replay with DISTINCT journal ids (`#i/#o${seq}r<n>` suffixes by per-actionId counts). §5: reconcile running/park short-circuit the spawn; backoff delay lands between intent and gate; gate check→reserve with verbatim denials + no-effect outcome. Self-containment: the module imports NOTHING (P10 pattern). As-built fixes found by the test suite: (a) `kill`/`merge` are exempt from the strategy-template match (the planner table has no entries for them — every kill/merge plan was previously refused `plan-invalid:strategy` before its port check could run); (b) `ctx.now` is validated on the SINGLE observed read (a malformed raw value used to fall back to local 0 and pass); (c) `ctx.attemptId` format-checked with SAFE_ID like episodeId/taskId; `plan.ts` gains two additive `export`s (`ACTION_DECISION`/`ACTION_RUNG`) for the drift guard; the planner-test fixture path resolves under both `tsx` and compiled `dist` runs. 78 executor tests. **Four adversarial audit rounds (docs/audits/audit-p11-executor*.md):** R1 (gate reads: hostile denials array, getter-guarded check results, records frozen before append); R2 (revoked-proxy gate result refused before journal write; kill/merge smuggled strategyId omitted from the intent); R3 CRITICAL (an act that THREW AFTER delivering its effect journaled `no-effect:` and was REPLAYED — a reproduced double-spawn; now `effectStarted` gates the marker and post-effect failures journal `act-unknown:`, plus fence-safe post-delivery result reads and a bounded rationale); R4 (unconfirmed `stop` is UNKNOWN not no-effect — reproduced double kill command; the rationale budget moved to plan-time refusal so a record can never understate what was obeyed). The cross-round invariant is pinned as a table in docs/15 §4 step 7: `no-effect:` is written only when nothing-happened is PROVABLE. Full suite **2096 / 2082 pass / 0-fail** (14 skipped). P11 row flipped to done | P11 implementation + audit R1-R4 |
| 2026-11-05 | §5 §14 §11.1 | **P12 implemented + audited (contract `docs/16`, cycles 1–4, findings F1–F10 / F1–F10 / C3-F1–C3-F9 / F1–F5 all closed):** `src/integration/merge.ts` ships `integrateTestedCandidate(req, ports)` — the §5 merge-action contract as a module, initially unwired (the executor keeps `merge-unwired`; P9 injects this module as the merge port). Candidate via `git merge-tree --write-tree` (real merge algorithm in the object store, working tree untouched; ANY conflict aborts before a commit object, before the gate, before any journal write — never auto-resolved, `--rerere` never consulted); trusted gate bound to the EXACT candidate sha with a per-call deadline floor (hung-runner `gate-timeout` is a documented negative, never a hang); CAS advance of `refs/heads/<episodeBranch>` only (literal `main` refused per Q5) with the full no-effect-provability table (docs/15 §4 step 7): clean numeric CAS rejection + observable head = the ONLY provable `no-effect:`; landed-then-moved, unreadable head, and ANY unreported CAS exit (kill/timeout — ABA included, `close:aba`) are `act-unknown:`; §14.3 acceptance record appended only on `merged`. Dedup: sha256 actionId (128-bit, cycle-2 F5 — the 32-bit FNV mirror of the executor collides by birthday at ~65k identities) over the canonical request snapshot; sticky terminals (`already-executed` acked / `not-replayable` act-unknown) scanned per-actionId, exempted when the journal TAIL is an open intent for the actionId (cycle-4 F1: a tail intent closes ONLY on observed reality — the recovery probe runs first and performs no side effect unless reality proves closure; no fall-through to re-execution exists). Repo identity pinned by realpath + case-folded compare (darwin/win32), bare repo (`context:repoRoot-bare`) / non-bare `.git` dir / plain dir / foreign repo each with its OWN documented refusal; `isAbsolute` platform gate (POSIX-identical). Compartment: imports only `node:child_process`/`node:crypto`/`node:fs`/`node:path`, fixed-argv git plumbing, nothing outside `src/integration/` imports it. Audit provenance: cycles 1–3 adversarial (Haiku 5.5 on the merged diff, `.tre/p12-cycle{1,2,3}.out`), cycle 4 same-session audit with revert-discrimination on every fix (each fix reverted individually → exactly its own tests fail). 58 module tests (real git repos + PATH shims for the kill sites), full suite **2140 pass / 0 fail / 14 skipped**. P12 row flipped to done | P12 implementation + audit cycles 1-4 |
| 2026-11-05 | §9 §14.3 §11.1 | **P15 implemented (contract `docs/17`):** `src/investigation/agent.ts` ships `investigate(packet, ports, options)` — the producer of the §14.3 `diagnosis` record P10 already consumes (advice only, no authority transfer — docs/11 §0.7). Closed priority rule table: approval-boundary > environment-blocker > transient-endpoint > gate-defect (task-defect) > premature-stop > unknown, with the confirmed (≥0.7) / tentative (0.6–0.65) split — a TEXT-derived or signal-only match NEVER reaches the planner bar without probe confirmation ("an uncertain diagnosis triggers investigation, not immediate escalation"). Deterministic text derivation: fixed substring table over bounded `errors[].text` + `signalDetail` (lowercased `includes`, no regexes on caller data), generic connect-failure words derive `endpointUnreachable` only with endpoint context; every derivation is a visible `text:<factKey>` marker. Probe loop: 4-probe closed table (`probe-endpoint`/`probe-env`/`probe-gate-rerun`/`probe-worker-tail` with charged estimates), class-first selection then table order, each probe AT MOST ONCE, charge-first budget (`spendUsd + estimate > maxUsd` ⇒ skip WITHOUT counting; zero limits ⇒ zero port calls), reported `usd` replaces that probe's estimate only. Confirmation upgrades: `endpointReachable` ⇒ transient 0.95/0.9; `workerClaimedComplete` ⇒ premature-stop 0.8; probe-supplied EXPLICIT facts take their rule's explicit confidence. JudgePort advisory ceiling (INV-2): consulted ONLY while the class is `unknown`, `confidence` clamped to `JUDGE_CONFIDENCE_CAP 0.69 < CONFIDENCE_BAR 0.7` (including a reported 1.0; missing/NaN reads as 0), closed-class output required, never overwrites a deterministic classification, adds no facts/actions/refs, model cost NOT charged to `spendUsd`. Hostile-input fence everywhere (the P10/P11 pattern): own-data descriptors only (accessors never invoked, inherited props never read, `isPlainObj` prototype check), arrays copied under once-observed re-verified length, `Object.prototype` pollution mid-run invisible, Proxy packets with all-traps-throw still yield a valid record. Probe results merge ONLY the §3.2 closed boolean fact set (INV-4: a probe CANNOT inject causeClass/proposedActions/refs — pinned by a test smuggling `escalate` and `rm -rf /` in a result). Evidence refs copied verbatim, markers are the module's own observations (`rule:`/`text:`/`probe::ran|failed|skipped-budget`/`judge:advisory`/`investigation:exhausted`/`packet:stale`) — never invented. `now` REQUIRED (no Date() — INV-6 determinism; a throwing/NaN clock fails closed to ts 0). Output frozen end-to-end and self-checked against a §14.3 mirror before return (INV-7; belt degrades to a minimal honest `unknown` record on an internal check failure, never an invalid one). Compartment: the module imports NOTHING — not even `node:` (INV-9, stricter than P10; guarded); nothing outside `src/investigation/` imports it until P9 wires `dispatch.investigate` (docs/17 §8); mirrored closed sets (cause classes, actions, signal kinds, worker states, rungs, strategy ids) drift-pinned 1:1 against the real journal/planner exports — and the module follows the planner's comment convention of naming "the episode journal module" rather than its path (the P7 journal-ownership grep otherwise fires). 45 tests, full suite **2185 pass / 0 fail / 14 skipped**. P15 row flipped to done | P15 implementation |
| 2026-11-05 | §11.1 docs/17 | **P15 BLACK-BOX AUDIT FIXES (cycle A4):** a hostile-probe round against the shipped module found 6 findings, all closed in `src/investigation/agent.ts` + `docs/17`: **R1** fence traps — `tools: null` passed the old `!== undefined` guard and crashed on `.run`, and port/limits reads INVOKED getter traps; port methods are now resolved ONCE through a guarded binder (`resolvePortMethod`, `this`-bound), `isPlainObj` survives throwing `getPrototypeOf`, errors-array/refs copies survive per-index descriptor traps, and a revoked-proxy packet (throws at `[[GetPrototypeOf]]`, survives `typeof` on this V8) is disclosed `bad-input:packet` — throwing `limits` getter ⇒ `bad-input:limits` (a throwing getter is NOT silent-"missing"). **R2** a fractional `maxToolCalls` (2.5) admitted an extra probe — budgets now FLOOR to the integer (INV-3 exact). **R3** a probe reporting negative `usd` refunded below the charge — negative/non-finite reports are REJECTED, the estimate stands, spend never decreases below actual (no-refund contract). **R4** evidence-ref composition evicted the record's OWN markers under a 200-ref packet flood — markers (rule/text/probe/judge/bad-input/exhaustion) are now reserved BEFORE packet refs, overflow disclosed with `refs:truncated` pushed before the fill so the disclosure can't be crowded out; `judge:advisory` moved into the reserved set. Docs/17 corrected: §0 rule 5 (disclosure taxonomy: absent/wrong-type = dropped silently; hostile-present = `bad-input:*` marker), §1 fence note, §2 composition order (markers-first, was documented packet-first — the code and doc disagreed), §3.3 unit definition (one error text or signalDetail; endpoint-context = same-unit hit), §4 judge cap note. 9 new adversarial tests (revoked proxy, trap proxies, throwing getters ×3, fractional budget, negative usd, 200-ref and exactly-64 floods, marker reservation) — investigation suite 54; full suite **2194 pass / 0 fail / 14 skipped**; a 12-case black-box re-probe (`.tre/p15-reprobe.mjs`) runs zero crashes and zero invalid records | P15 audit A4 remediation |
| 2026-11-06 | §11.1 P13 docs/19 | **P13 escalation channel shipped + loop-audited (M1 slice, contract docs/19):** `6b79584` `src/escalation/channel.ts` (pure record/queue: content-derived ids, durable-append-before-deliver, open-set mirror, delivery ledger vs maxRedeliver cap seeded from every escalation line — survives resolve+restart — closed fail-closed disclosure vocabulary incl. throwing-descriptor markers) + the ONE orchestrator-owned consumer `src/telegram/escalation.ts` (2000-char renderer, closed /resolve grammar); 87 tests. **Audit-arc note (for the doctrine):** the commit text said "entering 5-cycle implement-audit" — the arc that actually ran was a BOUNDED three-way loop (implementer + native auditor + `gpt-5.5-xhigh` third party) with the stopping condition "all parties agree no blockers remain"; it ended at loop 3 with no unresolved blocker, and a later W13 refusal audit (`docs/audits/w13-refusal-audit.md`) + F4b round-2 (`44db0a1`) closed the findings that surfaced after. **Process rule now explicit: a "5-cycle" label is not a stop condition; the agreed no-blocker consensus is — record the actual round count in the ledger, not the planned one.** |
| 2026-11-06 | §11.1 P13 | **P13 loop-audit cycles 1–2 closed (`56addb1`, `971165b`):** concurrent raises defeated the INV-5 cap (serialize raise/resolve per channel — dedup+reservation BEFORE the append under a promise-chain mutex); mutex covers the state segment only (a hung deliver no longer wedges resolve/raise — send runs off-queue after the durable append); truncated-replay unverifiable delivery count fails CLOSED `delivery:unverifiable-count`; dispatcher rationale copy via fenced indexed scan (a revoked-proxy Array.isArray threw); renderer evidence copied by bounded indexed try-loop (a per-index trapping proxy threw at the phone-facing call); wrong-type scalars disclosed `bad-input:<field>`; marker slots reserved before rationale entries (`actionId:clipped` can no longer be evicted). 9 regression tests |
| 2026-11-07 | §11.1 P9/M1 host layer | **Host supervise observation stack W2–W10 (the acceptance-side identity measurement under P9/M1):** `075a5d0`–`a7594e0` (2026-11-07). Identity = HEAD sha + write-tree real-index digest + config-pinned diff streamed through sha256 (constant memory, digest withheld on any cut-short stream — timeouts/signals fail closed) + untracked content bound (status -z, per-file sha256, lstat-no-follow, symlink retarget via readlink) under a unified GIT_ENV whose argv pins beat hostile repo config; group-kill on every shell exit path; truncated observations fail CLOSED to a deterministic dirty-unknown digest; `fileDigest` streamed at constant memory (a whole-file readFile made a present 1.5GiB artifact read as MISSING → false incomplete verdict); full-loop checks on a real worktree (re-observes before accepting, never stamps stale digest, worker process group reaped); honest fallback labels with digest-level distinguishability pins. Each W-round was an independent audit round (self + fresh reviewer) with mutation-verified tests — this stack is what later rounds R2–R7 attacked |
| 2026-11-07 | §11.1 P13 docs/19 | **W13 refusal audit + F4b closed (`e0c0e08` area, `44db0a1`):** `*:disabled` refusals disclose `escalation:refused:<name>` (never a false "dispatched"); audit F1 — a REFUSED send used to burn the maxRedeliver budget (probe-proven) — fixed via the durable-correction-line shape: `deliveryRefused` line refunds one reservation (mirror + lifetime ledger, one refund per refusal, complete-window-only ledger refund, replay clamps ≥0); send THROWS stay burned (may have reached the human). F4b (round-2): every log-bound identifier is a closed token — `describeErr` accepts `Error#name` only through `/^[A-Za-z0-9:._-]{1,64}$/` (a newline-bearing name forged a false dispatched-log line; repro in the audit doc), port channel names outside the pattern are dropped + disclosed `bad-input:channel` |
| 2026-11-07 | §11.1 P16 docs/19 | **P16 arc closed — park reachable end-to-end (`61fc548`, `bfd0199`, `c6ec744`, `0db94a8`):** parkTask test seam + escalationDeliver wiring into the supervisor; identity audit findings closed (assume-unchanged/skip-worktree/exclude/filters/escape); B-F1 not-delivered disclosure, B-F2 durable park question, W1-M7 corrupt-state park door. **W12-F1:** `park()` returns the same `{channel}` delivery record as `escalate()` (the dispatcher silently voided it — the host could never tell "human asked" from "journalled only"); **W12-F2:** escalate+park disclosures treat a `:disabled` channel as a documented refusal-to-send, not "dispatched"; suite 2423 pass / 0 fail |
| 2026-11-07 | §11.1 P17 | **P17 shipped (`58542d5`):** `tre.-episode` — the activation entry point (`src/host/activate.ts`), first sanctioned `runHostEpisode` caller outside tests, closed stop-reason exit map, optional `--telegram` escalation delivery through the host; closed import-set pin; 14 new tests; 2453 pass / 0 fail / 14 skip |
| 2026-11-08 | §11.1 P18 | **P18 3-cycle audit arc closed (`bda9d1f`):** attested Telegram sends (real helper grammar), serialized lease takeover with mtime-bounded empty-lease recovery, descriptor-strict correction bindings refunded once per target append, hardened activation logging + seed immutability; 21 named regression tests; 2497 / 0 / 14 |
| 2026-11-08 | §11.1 P19 | **P19 shipped (`58c588f`):** leases and the graph commit marker published staged+linked (complete-or-absent, no-replace link, P18-A3 identity judging of the winner, token-gated takeover via rename under the lock, ambiguous fresh content refused to the mtime abandon bound, orphaned tmps swept); 7 named race tests; 136 host/episode/journal tests green |
| 2026-11-08 | §11.1 P20 | **P20 lease-identity hardening, audit cycles 1–8 closed (`5ab10ea`–`466c003`):** fenced takeover-lock steal (owner stamp + post-mkdir re-verification + release on every path); pid-aware stale-tmp sweep (live owner never touched); strict-JSON lease parsing (truncated/out-of-range pid = AMBIGUOUS under the abandon bound, never an instant takeover); c3: stamp-conditional release + post-swap lock-ownership fence (delayed-reclaim thief walks away, at most one admission), whole-body token equality on release, pid-aware graph-stage sweep; c4: failed takeover self-releases, strict post-swap ownership, post-swap stamp EIO stands; c5 doc'd the self-disarm availability cost; c6: conditional takeover swap (move-not-destroy) + lock-aware publish + unified retried release, swap-window crash cost disclosed; c7 (R4): reconcile crashed-mover `.reclaim-` artifacts restore-if-vacant, preserve a failed restore's source, classify mid-swap occupants honestly, pre-move liveness re-verify; c8 (R5): unlink a recovery source ONLY on a proven supersede, dead-stamped fresh lock cleared without the age bound, own-pid artifact skip narrowed to same-incarnation mtime≥procStart, pre-move re-verify refuses a live same-pid holder; +6 mutation-sensitive tests; 2522 pass twice |
| 2026-11-09 | §11.1 P20 | **P20c10/c11 closed canonical-identity + unreadable-lease gaps (`3e1c09a`, `cf4ff04`, `6d05146`):** lease recovery keyed by canonical episode identity, activation fails closed on unresolvable identity or uninspectable ownership (symlink/realpath/readdir regressions); unreadable lease fails activation closed instead of guessing empty (closes the aged-live-claim takeover); c11a made the live-stage regression deterministic (gate opens on B's proven sweep decision, lease-owner-judged outcomes) after the cf4ff04 audit reproduced its sleep-race flakiness ON HEALTHY code — mutation matrix re-verified against exact failing assertions |
| 2026-11-09 | §11.1 P12 | **P12 audit cycle 3 + the P9/M2 predecessor wiring shipped (`738b8e9`):** `--no-replace-objects` pinned on every ancestor/CAS git call (a forged `replace-objects` ref could otherwise fool integration), host no-effect outcomes treated as replayable act-unknown, and the merge-port wiring (episodeBranch CLI, seq bump, gate-adapter fixes) with forgery/shim tests |
| 2026-11-10 | §11.1 host supervise (P9/M1 surface) | **Supervise observation stack, external audit rounds R3–R6 closed (GPT Sol, fresh adversarial context per round; doctrine: findings independently verified before fixing, mutation-sensitive regression proof, full-suite ×2):** **R3-F2 + R4-B1 + R5-B1/B2 (`f554faf`, suite 2596/2582/0/14):** the ACCEPTANCE-side observation trusted the repo's own conversion settings on a stat-cached index — a `.gitattributes` filter whose clean driver maps any bytes to the committed blob forged a clean identity (`sameArtifact` passed, gate stamped on forged bytes) → fixed by the fresh-index observation stack (`buildFreshObservationIndex`: read-tree HEAD into a throwaway index, `GIT_ATTR_SOURCE`/`-c core.fsmonitor=false`, status+diff on that shared fresh index so stat-cache refresh cannot hide the R4 conversion trick; bare-`{sha}` returned ONLY from a clean neutralized fresh scan, every other outcome carries a real-index `write-tree`+`diff-files` digest; R3-F2: `ArtifactIdentity.unobservable` — two unobservable identities NEVER compare equal); **R5-B1:** repo-local `submodule.<n>.ignore=all` hid modified child bytes from both status paths → `--ignore-submodules=none` on the COMMAND LINE of all three status paths (cmd-line beats per-submodule config; quiet+exit 0 on uninitialized submodules); **R5-B2:** the fresh-index scan compares HEAD vs WORKTREE, so a staged-only divergence with the worktree restored read CLEAN (porcelain empty, bare `{sha}` minted before the write-tree digest) → the clean return is now gated on the integration gate's own real-index check (`diff-index --cached --quiet --ignore-submodules=none --no-ext-diff HEAD --`: exit 0 clean / 1 dirty-path / ≥128-or-truncated unobservable; byte-identical to the gate's shape, acceptance fails closed on disagreement) + the R4 filter-mapped fix. **R6-B1/B2/B3 (`b091386`, suite 2604/2590/0/14 ×2 runs):** **B1:** `core.fsmonitor` is a repo-config-selected EXECUTABLE run by every index-touching command — the R5 staged check (and every other real-index read after the fresh scan) ran UNPINNED, letting a helper that rewrites a tracked file and answers "no changes" mint clean identities; fix: `-c core.fsmonitor=false -c core.untrackedCache=false` pinned on the command line of EVERY `runObservedGit` invocation (grep pins the invariant). **B2:** the parent describes a submodule child only in aggregate — two distinct child content states digested IDENTICALLY, evidence stamped at child state S1 stayed "current" over S2; fix: the dirty digest now folds each populated child's HEAD sha + a raw recursive worktree walk (sorted, `.git` skipped at every level, symlinks bound as target strings, files streamed sha256+size, 20000-entry cap, any unreadable ⇒ partial ⇒ unobservable; unpopulated children fold a stable `child-unpopulated:<path>` marker). **B3:** the child's own index can hide content the parent's porcelain never shows (assume-unchanged `h` / skip-worktree `S` / staged-only divergence inside the child ⇒ bare `{sha}` over modified child bytes); fix: `submoduleBlindnessCheck` on the clean branch — recursively (depth cap 3, EXCEEDING the cap fails CLOSED `submodule-depth-exceeded`) every populated child must show an all-`H` `ls-files -v` tag set and a staged index matching its own HEAD; any flag, divergence, unreadable child, or truncation ⇒ dirty+unobservable, never bare `{sha}`. All three independently verified by probes against pre-fix dist BEFORE fixing; mutation proofs on post-fix dist: disabling each fix individually fails exactly its 1–2 round-6 tests and nothing else (5/8 failing across the three mutants, 3/8 pass each time); 8 named `audit-round6.test.ts` regressions incl. honest controls (healthy clean submodule still returns bare `{sha}`) |
| 2026-11-10 | §11.1 host supervise (P9/M1 surface) | **Supervise observation stack, round-7 audit blockers closed (R7-B1/B2/B3 — the round-6 submodule fold was still blind to CHILD worktree/index subtleties; same doctrine: probes against pre-fix dist first, mutation-sensitive regressions, full-suite ×2):** **B1:** an ignored untracked file INSIDE a child (child `.gitignore` / child info/exclude) is invisible to every parent channel — porcelain, the child's all-`H` flags, and the R6-B3 staged check all read byte-equal clean, so the bare `{sha}` minted over a hidden payload (pre-fix probe: `*.bak` rule + `x.bak` → clean). Fix: `submoduleBlindnessCheck` now also runs exclude-BLIND `ls-files --others -z` on every populated child (W11-A3's rule applied to the child; `runObservedGit` already nulls `core.excludesFile`); any entry ⇒ `child-excluded-content:<p>` dirty+unobservable (paths bind only by marker — presence is the finding, plain untracked child content already forces the dirty path via the walk). **B2:** exec-bit changes moved NOTHING — the child walk hashed content only (a bare `chmod` left the fold untouched), the child's own INDEX was never digested (a staged 100644→100755 touched only the gitlink sha the parent already ignored), and `core.fileMode=false` — poisoned in the child or the parent — made git status/write-tree/diff ALL blind to the bit (probes t5/t6: parent write-tree, status AND `diff --binary` unchanged over a chmod; a poisoned child config hid the chmod from the parent's aggregate scan too). Fix (three channels, all config-proof): `-c core.fileMode=true` added to the `runObservedGit` pin list — command-line config propagates into the submodule child scan the parent's status spawns (probe t5: `M sub` reported over a child config of false; flipping the setting itself moves the digest via the layout-digest binding of `core.fileMode`), `walkChildEntries` binds the lstat exec bit (0/1 — no git config path) beside size+content-hash per file, and each populated child's `ls-files -s -z` (mode+blob index content) streams (`hashStdout`) into the fold; child staged states now digest distinctly (pre-fold: two staged payloads collided). **B3 (round-6 check re-verified):** staged-only child divergence (child index≠HEAD, worktree==HEAD bytes) never observes clean and distinct staged payloads get distinct digests (child-index fold); NOTE the round-7 probe found git 2.54's parent status DOES surface this as `M child` even with `--ignore-submodules=none` (it walks the child index) — the R6 child staged check stays the version-independent closure, and the reset-control must use `git reset HEAD` (`checkout -- a` restores FROM the divergent index and keeps the state dirty — the round-6-era probe's own bug). All three independently verified against pre-fix dist (`.tre/review-probes/r7-verify-blockers.mjs`: 4 pass / 2 fail pre-fix → 9/9 post-fix incl. poisoned-config variants); 10 named `audit-round7.test.ts` regressions incl. honest controls (plain repo, healthy child, AND poisoned `core.fileMode=false` with honest bits all still return bare `{sha}`; exec-bit changes under poisoned config in parent AND child move the identity; nested info/exclude payload caught via the child's REAL gitdir `.git/modules/<name>`). Full suite **2613/2599/0/14 ×2 runs** |
| 2026-11-12 | §11.1 P9/M3 (docs/20 D4, docs/18 §4) | **M3 parked small items shipped: worktree auto-removal at accepted `done` + the steer model-swap allowlist.** **D4 lift (docs/20 §13.4 superseded):** the scheduler now calls `worktrees.release(taskId)` ONLY when a task's fate is an ACCEPTED `done` (acceptance verdict `complete` — failed/parked/unaccepted worktrees stay as evidence until episode cleanup); the host maps it to an UNFORCED P6 `removeTaskWorktree` (dirty / locked / foreign-branch / stale registration ⇒ KEPT, returned `{kept:code}`; task branches are NEVER deleted — P12 territory). The act is disclosure-only: it runs AFTER the fate is recorded, can never change it, and every outcome (released / kept / release-threw) is one new closed `sched-worktree` journal record with a unique per-episode actionId (the closed SCHED_JOURNAL_KINDS set grows by one). **Swap allowlist (docs/18 §4):** the steering `model:<id>` override was a swap-target rewrite with NO authority check — it rewrote plan.model/strategyId after the planner and could name a model outside `authority.models`, smuggling an unapproved swap past elSwap to the reserve gate with the human's intent laundered. The override is now validated AT THE POLL against the pool (same rule as ledger `model-not-approved`: an empty/absent pool approves none); a refusal journals `steer model:<id> refused — model-not-approved` and the planner's own target survives. The executor gate check stays the backstop. +5 scheduler release tests (done-only, kept, threw, unaccepted, mirror pin), +3 compose allowlist tests (refused+journaled, approved-still-lands, empty-pool=none); compose cfgBase authority now declares its models pool. Gate: quality-check OK, tsc clean, full suite **2716 / 2702 pass / 0 fail / 14 skipped** | P9/M3 parked items |
| 2026-11-12 | §5, §11.1 P9/M3 fix | **M3 audit fix: release path destroyed status-invisible content (blocker).** The conservative dirty gate (`status --porcelain -uall`) reads EMPTY over ignore-matched files and assume-unchanged modifications, and the shipped unforced `removeTaskWorktree` deleted both while claiming preservation (audit probe reproduced against pre-fix dist). Gate now runs `status --porcelain=1 --ignored=traditional -uall` (per-file `!!`; any ignored file → new refusal code `hidden-content`, ordinary changes stay `dirty`) PLUS an `ls-files -v` all-`H` check (any assume-unchanged/skip-worktree/disclaiming flag → `hidden-content`); empty index vacuously clean, failed ls-files propagates as kept; `force` remains the explicit operator discard. Disclosed residue: ignored dirs holding only empty subdirs, sparse-checkout skip-worktree content (unsupported for agent worktrees). **Outcome honesty:** a `{kept}` return was journaled `released` (detail carried the code) — now outcome is `kept:<code>`, `released` only on actual removal; host release carries the provisioner message as bounded detail. **Refusal ids:** two refused steer overrides in one poll shared `steer-<seq>-unapproved` — now `steer-<seq>-refused-<model>`. +6 tests (4 real-git provisioner regressions incl. all-H clean control, scheduler kept-outcome test rewritten + new kept-with-detail test, 1 compose id-collision); ALL new content/outcome tests fail pre-fix (mutation-checked by stashing src/). Gate: quality-check OK, tsc clean, full suite **2722 / 2708 pass / 0 fail / 14 skipped** | P9/M3 audit fix |
| 2026-11-12 | §5, §11.1 P9/M3 fix 2 (Haiku 5.5 round) | **Second hostile audit of the M3 fix (`anthropic/claude-haiku-5.5` via OpenRouter, full source access, verdict DO-NOT-SHIP-as-stated: 1 blocker + 4 major + 2 minor) — all fixed.** **F1 (blocker):** the gate's own `status`/`ls-files` calls ran with repo config in force — `core.fsmonitor=true` + a lying `.git/hooks/fsmonitor` (answers "ok", empty token list) + a pre-set `fsmonitor-valid` bit make status report CLEAN over modified files, so the hardened gate deleted the payload it was built to preserve (same class as the supervise stack's R6-B1, which already pinned `-c core.fsmonitor=false` — the release gate never got the pin). Fix: `-c core.fsmonitor=false` on ALL THREE index-reading gate git invocations (status, `ls-files -v`, `ls-files -s`; the branch-deletion checks that follow touch no index, so the bit is irrelevant there); regression installs a lying hook + valid bit and asserts the gate still refuses `dirty` (mutation-checked against stashed src; honest carve-out below — on git 2.54 it does NOT fail pre-fix). **F2 (major):** the `ls-files -v` all-`H` check VACUOUSLY PASSED on an EMPTY index (a corrupt/truncated index lists nothing; all-H over nothing = "clean") — an empty tag set now refuses as new code `index-blind` (fail-closed; `force` still the explicit operator discard). Regression forges an empty-tree root commit (canonical empty tree via `commit-tree` — `mktree` blocks on stdin under execFile) and proves the pre-fix remove SUCCEEDED (mutation-checked). **F3 (major):** submodule entries (mode 160000 gitlinks) made unforced `git worktree remove`/`rm -rf` behavior git-version-dependent (old git errors "working trees containing submodules cannot be moved or removed", newer git may destroy the checkout-with-submodules tree); the gate now scans `ls-files -s` and refuses `has-submodules` explicitly — protection no longer rests on git's incidental error (regression adds a 160000 entry; fails pre-fix). **F5 (major):** host `releaseWorktree` returned `undefined` when no provisioner was registered AND when `removeTaskWorktree` hit its no-registration noop — the scheduler journaled these as `released` although nothing was removed; the contract now returns `{noop:true,detail}` and the scheduler journals outcome `noop` (never `released`). Noop-journal regression added. **F6:** the round-1 refusal id `steer-<seq>-refused-<model>` still collided when the SAME model was refused twice in one poll (possible: two steer texts each with a `model:` line) — now sequence-disambiguated; the collision regression refuses the same model twice AND two different models (fails pre-fix). **F7 (minor):** tautological `assert.equal(repo !== "", true)` in two remove tests replaced with `existsSync(wt.path)` (actually proves the tree left disk). All F-code regressions mutation-checked against stashed `src/` (fail without the fix, pass with it; the F2 test proven to PASS AT REMOVAL pre-fix). Honest carve-out (per the HANDOFF §F1 mutation-run): the F1 lying-hook regression PASSES against pre-fix dist on git 2.54 — there `git worktree remove` runs its own dirty check that catches the edit, so the pin defends against git versions lacking that internal check rather than repairing a loss reproducible on 2.54 (same stance as F3: protection must not rest on git's incident). "Fails pre-fix" claims above hold on stashed-src for F3/F5/F6; F1's claim is superseded by this carve-out. Gate: tsc clean, provisioner+scheduler+compose suites 211/211 (audit m3fix2 re-count: 212 — one test was uncounted) | P9/M3 fix 2 |
| 2026-11-13 | §5, §11.1 P9/M3 fix 3 (Sol round 3, m3fix2) | **Third hostile audit of the M3 fix (GPT Sol via OpenRouter, verdict FAIL on `89d6dbc`: 2 blockers + 1 minor; both reproduced against pre-fix dist, `.tre/review-probes/m3f2-loss.mjs`) — all closed by porting the supervise stack's fresh-index doctrine into the leaf release gate.** **B1:** a `.gitattributes` filter whose clean driver maps any bytes to the committed blob poisoned the real-index stat cache — pinned status EMPTY, tags all H, unforced remove destroyed a same-length payload. Fix: gate status runs on a THROWAWAY fresh index (`GIT_INDEX_FILE` tmp + `read-tree HEAD` — no stat cache; git-failed on unborn HEAD), every configured filter driver pinned to identity (`=cat`; EMPTY for `process` — a dead `cat` filter server is a false-clean oracle on 2.54), `core.attributesFile=/dev/null` + PINNED_NEUTRALIZING_CONFIG, `GIT_ATTR_SOURCE=<empty tree>`, and ANY effective `info/attributes` rule (which overrides GIT_ATTR_SOURCE) refuses `hidden-content` fail-closed (git attr.c byte-accurate tokenizer). **B2:** `core.fileMode=false` hid a bare chmod 0755 (status empty, tags H, remove destroyed the mode change) — `core.fileMode=true` pinned on the fresh-index status proof (the real-index `ls-files` tag gates read staged BITS fileMode cannot conceal; fsmonitor pin only there — Sol round-4 claim audit corrected this row's earlier "every index-reading call" wording). Gate order: real-index tag gates (flags/index-blind/gitlinks — index BITS a throwaway index lacks) run BEFORE the fresh-index status proof, so assume-unchanged keeps its `hidden-content` classification. **M1:** fixed the docs-vs-HANDOFF mutation-claim inconsistency this audit flagged (F1's honest carve-out now in the fix-2 row; 211→212 count pinned) and rewrote the bogus F6 comment in compose.ts (underscore IS inside `[A-Za-z0-9._-]`; collision-freedom is separator POSITION). +4 provisioner regressions (filter payload-loss refusal + byte preservation + clean-filtered control; fileMode chmod refusal; committed-.gitattributes no-over-refuse; info/attributes refusal + inert-comment control), ALL mutation-checked against a `git archive HEAD` pre-fix build (exact Missing-expected-rejection failures pre-fix); provisioner suite 62/62. In-test discovery pinned: `--git-path info/attributes` resolves to the COMMON git dir (check-attr probe: per-worktree admin-dir attributes are never consulted) | P9/M3 fix 3 |
| 2026-11-13 | §5, §11.1 P9/M3 fix 4 (Sol round 4, m3fix3) | **Fourth hostile audit of the M3 fix (GPT Sol via OpenRouter, verdict FAIL on `0c0caaf`: 1 blocker + claim-audit note; blocker reproduced by the auditor, `.tre/review-probes/m3f3-env-loss.mjs`).** **B1:** an ambient `GIT_WORK_TREE` (inherited launch env) re-routed EVERY provisioner git call — tag gates, fresh-index status proof, and git's own removal check — at a DIFFERENT checkout: with the redirect to a clean main repo, an unforced remove destroyed a linked task tree holding an info/exclude-ignored unique payload (`!! unique.bak`). Fix: `gitEnv()` rebuilds a clean environment PER CALL — the WHOLE `GIT_*` namespace stripped (fail-closed by construction against future git env vars; no deny-list), `GIT_CONFIG_SYSTEM=/dev/null` baseline, fresh-index calls layer their own pins on top; verified all FIVE execFileAsync sites (git, gitVerify, gitWithEnv, probeExit0, filter-enumeration probe) pass `env: gitEnv(...)` — routing from `cwd` alone **(round-5 correction: env-complete only — file-based `config.worktree` routing beats this; solved in the fix-5 row below)**. Regression (ambient GIT_WORK_TREE+GIT_DIR → refuses `hidden-content`, payload bytes intact; cleared redirect + removed payload still removes — no over-refusal), mutation-checked BOTH ways (a verified gitEnv→raw-env passthrough build fails the test at the rejects-assertion — the round-3-era "unit test isn't a mutation proxy" note was WRONG, the first patch script had silently failed to apply; the auditor's repro destroys the payload on the passthrough build, exit 0, and is refused by the fixed build, exit 1). **Claim audit fixed:** round-3 wording "core.fileMode=true on every index-reading gate call" overstated the code — the real-index `ls-files` tag gates carry the fsmonitor pin only, which is correct-by-design (tag gates read staged BITS fileMode cannot conceal; the worktree-bit comparison lives in the pinned fresh-index status proof) — wording corrected here and in the fix-3 row, code unchanged. Provisioner suite 63/63; full suite **2731/2717/0/14 ×2 runs** (one intermediate run showed one unrelated failure that never reproduced; noted for honesty) | P9/M3 fix 4 |
| 2026-11-14 | §5, §11.1 P9/M3 fix 5 (Sol round 5, m3fix5) | **Fifth hostile audit of the M3 fix (GPT Sol via OpenRouter, verdict FAIL on `29f661d`: 1 blocker, reproduced by the auditor, `.tre/review-probes/m3f5-loss.mjs`).** **B1:** a worktree's OWN **file-based config** re-routes checkout resolution THROUGH the cwd — `extensions.worktreeConfig=true` arms `.git/worktrees/<id>/config.worktree`, whose `core.worktree=<clean main repo>` is consumed at repository SETUP and **beats `-c core.worktree=`** (git 2.54; env stripping cannot reach it). The gate's status read the redirect target (clean) while the registered tree held an info/exclude-ignored unique payload, and git's own removal check was fooled identically — unforced remove destroyed tree+payload. Fix, two layers: **(a) load-bearing `assertHonestRouting()`** — before ANY content gate, BOTH paths incl. force: unpinned `rev-parse --show-toplevel` from the worktree, realpath-compared to the registered path; mismatch/empty/uncanonicalizable refuses NEW code `routing-poisoned` (force does not authorize operating through poisoned routing). **(b) belt — the top-level `--work-tree=` option** (the only CLI construct that beats config.worktree; verified it keeps the admin index via `rev-parse --git-path index`) added to the four work-tree-resolving gate calls (`ls-files -v`/`-s`, `read-tree`, status). Probes this round established the belt alone is NOT enough: `worktree remove` runs at repoRoot and `--work-tree=` on the remove call did NOT re-arm git's fooled check — hence refuse-at-the-guard, not pin-the-removal. +4 regressions (poison refuses both paths, payload byte-intact; git-level fooled-view witness `""` vs pinned `?? unique.bak`; clean-tree removal through the pins — no over-refusal; force+poison refuses), **mutation-checked against a HEAD-built pre-fix module** (`.tre/review-probes/m3f5-e1-witness.mjs`: PRE-FIX `worktreeRemoved=true` payload destroyed / POST-FIX `routing-poisoned` payload intact; the auditor's own repro now throws `routing-poisoned`). Accepted residue stated: a poisoned worktree is never auto-removed — kept until an operator repairs config or removes manually. Round-4 claim "routing from `cwd` alone" corrected here and in HANDOFF (env-complete, config-blind). Provisioner suite 67/67; full suite **2735/2721/0/14** | P9/M3 fix 5 |
| 2026-11-14 | §5, §11.1 P9/M3 fix 6 (Sol round 6, m3fix6) | **Sixth hostile audit (GPT Sol via OpenRouter, verdict PASS WITH MINORS on `cf31da1`: 0 blockers — the round-5 routing guard survived direct attack (no equal-realpath/different-content bypass; symlink aliases, case/trailing-sep variants, force+locked ordering all held; post-guard config race classified inside the accepted terminal-task TOCTOU). 4 minors, all claim/test fidelity — closed here.** **(1)** a routing resolution that FAILS (worktree-local `core.bare=true` kills `rev-parse --show-toplevel`, exit 128 — probe-verified) leaked the generic `git-failed` code while the claim promised `routing-poisoned`; the guard's catch now translates any resolution failure (not just mismatch/empty) to `routing-poisoned` — unobservable routing IS the poisoned condition (fail-closed, both paths). **(2)** the "symlinked registered path" test created no symlink (duplicated the mismatch test under force) — replaced by a REAL-symlink pair: `core.worktree` → symlink alias resolving back to the registered dir is HONEST (guard realpath-compares, no false routing refusal; the dirty gate keeps the payload) and `core.worktree` → symlink alias to the MAIN repo refuses `routing-poisoned` under force, payload intact. **(3)** the pinned-view witness hardcoded its own `--work-tree=` and mutation (routeArgs→[]) left all 67 tests green — the belt layer had ZERO test necessity. `routeArgs` is now exported; the witness asserts the shipped function's exact argv shape, runs the pinned status THROUGH it, and source-binds the 4 gate callsites (`routeArgs(entry.path)` in a git/gitWithEnv line — count asserted). **(4)** HANDOFF round-5 "2735 pass" corrected to "2735 total / 2721 pass". Sol's suggested deterministic poison-after-guard regression was NOT added: concurrent poisoning during release is inside the accepted TOCTOU precondition (no supported production contract to test), and the source-binding + shipped-argv witness close the demonstrated mutation gap without asserting a race as behavior. **Round-7 re-verification (m3fix7, Sol, PASS WITH MINORS, 0 blockers on `644dabc`): all three runtime closures independently mutation-confirmed (guard no-op fails tests 64/65/67/68; routeArgs→[] fails the witness at the argv assertions; catch-bypass restores `git-failed`), malformed-entry probes (prunable-but-present payload dir, redirected gitfiles, missing gitdir) all refused with payloads intact.** One new minor from that round closed here: the stale-registration message claimed "directory is gone" where the condition is a GONE GITFILE (a prunable-but-present payload directory reads imprecisely) — wording fixed at every message occurrence (six sites: three checks × LOCKED/plain variants) + the prune() doc + the `stale-registration` code comment + the release() doc line (grep of src/ for "directory is gone"/"VANISHED" now zero hits); the witness's source-binding claim narrowed to what a body mutation can actually flip (argv-shape + pinned-status first; the callsite count is a wiring pin). Provisioner suite 68/68; full suite **2736 total / 2722 pass / 0 fail / 14 skipped** | P9/M3 fix 6 |
| 2026-11-14 | §5, §11.1 P9/M3 close (Sol rounds 8–9, m3fix8/m3fix9) | **AUDIT LOOP CLOSED — round 9 clean PASS** (round 7's minor, recorded in the fix-6 row, was closed in `edff65c`+`7e25b53`). Round 8 (m3fix8b, PASS WITH MINORS on `7e25b53`: text-only scope AST-confirmed; six wording sites re-probed 12 ways — ensure/open/remove × LOCKED/plain × present-payload/missing-dir — all refuse honestly with actionable guidance, payloads survive; witness closure independently reproduced; guard no-op still fails exactly 64/65/67/68) filed 1 minor: HANDOFF attributed the round-7 verdict to `cf31da1` instead of `644dabc` — one-line fix `a0b6a8b`. Round 9 (m3fix9, **PASS, 0 blockers / 0 minors** on `a0b6a8b`): one-line diff scope confirmed, EVERY base-ref in rounds 5–9 cross-verified against the audit logs' opening tool output and git blob hashes, dist rebuild byte-identical, 68/68, and the auditor recorded the convergence statement: **"converged — no unprobed runtime defect class identified"** (bounded by the accepted force-discard, terminal-task TOCTOU, and poisoned-tree-residue decisions — not a claim of universal correctness). Trajectory rounds 5→9: blocker → blocker → 4 minors → 1 minor → 1 minor → **0**. Rounds 7–9 found zero runtime-behavior defects; both residual minors were doc fidelity. Provisioner suite 68/68; full suite **2736 total / 2722 pass / 0 fail / 14 skipped** | P9/M3 rounds 7–9 close |
| 2026-11-15 | §11.1/§11.4, docs/20 §11 P9/M2 acceptance close (Sol rounds c6–c9, m2c6–m2c9) | **M2 ACCEPTANCE CLOSED — round 9 (m2c9) clean PASS (0/0) on `6cfbd74`; auditor certification: "M2 acceptance: CLOSED — all m2c6/c7/c8 minors verified with counter-proofs."** Close-out of the two open items from the 2026-11-12 row. **(1)** the un-re-audited c5f fix entered the acceptance loop as round c6; **(2)** the §11.4 exit-evidence benchmark was built (`f4bb4c7`): `test/m2-acceptance-bench.test.ts` — 6 tests through REAL `runSchedulerEpisode`: {1,2,3}-worker fixed 6-task workload with barrier-gated overlap, observer fairness under contention (W=3 bound), single-slot comparison, parked-independence. Round c6 (Sol, PASS WITH MINORS on `f4bb4c7`: 0 blockers, 5 acceptance-evidence minors — teardown had no necessity test; `force:true` chmod-000 cleanup gap; benchmark sequential at every scale; fairness case created no contention; parked case asserted no quiescence class and no hang guard). All 5 closed (`2ab6dda`) with self-proofs: peak-overlap asserts (1/2/3 in logs), sentinel-sweep teardown-necessity pin (scratch revert FAILS the sweep, rest of file green), contention assert maxWaiting≥2, single-slot comparison test, parked case asserts `stopped=quiesced-blocked` raced against a 10s guard. Round c7 (Sol, PASS WITH MINORS: 0 blockers): M1/M2/M3/M5 closures counter-proof-verified; **M4's closure structurally failed its own counter-proof** (removing the rendezvous did not fail the fairness test — contention arises naturally at maxParallel=3, so rendezvous-necessity was unprovable); plus DOC minor — docs/20 §11.3 promised a "0/1 observer slot" comparison while the ObserverQueue ctor (`schedule.ts:267–268`) binds one slot unconditionally (no zero-slot mode exists; multi-slot is post-M2). Closed (`edaa31a`) by moving the necessity to the assertion that CAN bear it: fairness asserts `peakInside===1` discipline; the comparison test REQUESTS `observerSlots:3` and asserts the D1 clamp serializes (scratch mutant `slots=Math.min(slots,3)` drives it to fail with `peakInside=3` — auditor re-ran and confirmed in c8). Round c8 (Sol, PASS WITH MINORS, 1 item): the retired zero-slot phrase survived in prose (doc §11.3 replacement + a stale comment claiming the clamp mutant fails the fairness test — it fails the comparison test). Closed across `c201827`/`b76695f`/`6cfbd74` — §11.3 rewritten to the shipped binding-one-slot design (multi-slot explicitly out of acceptance scope), header/comment de-quoted so the auditor's own grep repro returns no match. **Round c9 (Sol): PASS, 0/0** — repro clean at HEAD, doc/ctor/test agreement confirmed, counter-proof attribution correct, 6/6, tree clean. Trajectory c6→c9: 5 minors → 2 → 1 → **0**. Acceptance benchmark 6/6; full suite **2743 total / 2729 pass / 0 fail / 14 skipped**; quality-check OK. Residual (accepted, stated): observer queue serves 1 by design; a hang guard of 10s bounds the parked-quiescence test; necessity proofs live in the comparison test (fairness test's own peakInside is discipline, not mutant proof). | P9/M2 acceptance closed |
| 2026-11-13 | §10 Q5, §11.4 M3, §14.7 integration policy | **M3 scoping started: contract at DRAFT v4 `docs/21-p9-m3-promotion-rollback-fleet-budget.md` (docs/16 contract-first pattern) — UNREVIEWED PROPOSAL after three rounds (v1 self-audit; round-2 review of v2; confirming-round audit of v3), no module touched, NOT yet at sign-off.** Scopes the two named M3 deferrals (docs/18 §10, docs/20 §14 "staging/rollback + fleet budget layer") as independent slices: **A** promotion (episode branch→`main`) + rollback as a NEW leaf `src/integration/promote.ts` (D1: P12 stays "never main"); CANDIDATE-FIRST sequence — merge-tree→commit-tree builds candidate `C` (with `Tre-Promotion:` trailer) in the OBJECT STORE only, the gate binds to `C` itself (v1 gated the episode tip while advancing an untested merge commit — v1 self-audit blocker), CAS `--no-deref update-ref refs/heads/main C M` (`M == E` ⇒ `already-merged` no-op before commit construction, v4) with the docs/15 §4 step-7 no-effect-provability table (v3: plain `update-ref` FOLLOWS a symbolic main — reproduced on git 2.54 — so `--no-deref` + symref refusal + checked-out-main refusal are contractual); moved-`M` ⇒ operator re-issue with bumped `executionSeq`, stale gate evidence never reused. Rollback v2 (v1's `revert -m 1` REJECTED — porcelain runs in the worktree and writes merge state into the git dir; probe-verified): journal+parentage+trailer PROVENANCE checklist before any ref touch, object-store inverse merge (`merge-tree --merge-base=<C>`) producing a gated rollback commit; `rewind` only while main HEAD == the promotion sha (D3). Q5 human gate v1: promotion/rollback via explicit TTY-confirmed operator CLI act only; `promoteToMain:"auto"` honored by nothing (D2); explicit threat model — `grantedBy` is attestation, no claim rests on caller honesty. Promotion sources restricted to `refs/heads/agent/**` (D8) — **SUPERSEDED: round-2 found `agent/**` is P6's TASK namespace and P12 keeps episode branches out of it (`merge.ts:25–27`); D8 rewritten in v3 to the real P12 episode-branch rule**; unborn main refuses (D9). **B** fleet budget layer: machine-level USD-only cap file (D4), capacity-file all-or-nothing validation; pure projection in new `src/budget/fleet.ts` composing UNCHANGED per-episode `projectLedger` semantics (no record-format change; no fs in the core); admission is an explicit inequality incl. the candidate estimate, denial at ADMISSION ONLY (`fleet-budget-exhausted`, running attempts never interrupted), A6 unknown-spend never grants headroom; THREE-STATE cap file — ABSENT unconfigured / BROKEN-or-STALE **fails CLOSED on new admission** (D5 revised: v1's silent fail-open would disable a configured cap) / unreadable/poisoned episode ledger or nonzero unknownSpend ⇒ `fleet-indeterminate` and FLEET-WIDE USD denial (v3: v2's per-episode-refuse + "lower-bound Σ" REJECTED round-2 — a lower bound is not a cap check, it admitted other episodes against unknown spend; turns/wallclock unaffected); the cap is declared **SOFT admission-only governor — NO numerical overshoot bound is claimed in v3** (round-2 R2-M2: BOTH formulas withdrawn — concurrent admission estimates can each overshoot by estimation error, and in-flight attempts aren't counted at all; "sum episode caps under target" is NOT an account budget — only provider-side account limits hard-cap USD), cross-episode reservation transaction rejected for v1 (D6 twice-revised). Explicitly out of docs/21 with reasons (§0): model-swap allowlist / worktree release / P12 wiring (shipped+audited), richer P13 views (M4 plane), fresh-session handoff + broader decomposition (need §11.4 operating evidence / own contract round), P3b enabling. D1–D9 carry proposed resolutions (docs/21 §4), D7 proposes slice A first; each slice audits to convergence per the m3fix/M2-acceptance precedent with host wiring a separate increment. v1 self-audit (2 blockers + 5 majors + 1 minor) and **round-2 adversarial review of v2 (2 blockers + 4 majors + 1 minor — every finding verified vs `src/` or reproduced on the lab git; the symref CAS was reproduced on git 2.54)** dispositions tabled at docs/21 foot; cited surfaces re-read vs `src/` (name/signature scan only — ledger path corrected to `<episodePath>/events/budget.jsonl`); round-2 also fixed discovery (v2 enumerated `~/.tre/episodes` only — `--episodes-root` episodes spent invisibly outside the cap; v3 requires an operator-declared `episodeRoots` registry, missing declared root fails closed). Confirming-round audit of v3 (1 blocker — the CURRENT episode's own root could be unregistered — + 4 majors + 1 minor) fixed in v4: current-root registration gate (`fleet-root-unregistered`, canonicalized compare), directory-based discovery with layout-marker new-vs-missing ledger distinction, discriminated `EpisodeInput`/`FleetPolicyInput` projection types, `M == E` `already-merged` no-op (commit-tree drops duplicate parents, reproduced on git 2.54), recorded-reservation redelivery as zero-estimate coverage. **Next: one FRESH CONFIRMING adversarial round on v4, then D1–D9 sign-off, then slice A implementation** | M3 scoping (docs/21 draft v4) |

| 2026-11-15 | §10 Q5, §11.4 M3, §14.7 | **M3 scoping: docs/21 advanced v4→v5→v6 through two more adversarial rounds (no module touched).** v5 (confirming round on v4, 2 blockers + 4 majors + 1 minor): v4's layout-marker new-vs-missing heuristic REJECTED every legitimate first admission (host creates the episode layout before any ledger exists, `supervise.ts:2781`) and fleet discovery via `BudgetLedger.open` MUTATED foreign ledgers (`repairTail` truncates+fsyncs, `ledger.ts:1581,1674`) — replaced by an explicit durable init protocol + read-only `BudgetLedger.inspect`; `RootDiscovery[]` required projection input; redelivery coverage on the FULL P8 reservation identity; dedup/recovery pinned BEFORE the `M == E` shortcut; sticky `refused(already-executed)` terminal replay. v6 (cycle-1 confirming round on v5, auditor gpt-6.1-terra, 4 blockers + 7 majors + 4 minors, all verified vs `src/` + git 2.54 byte-dumps): init evidence becomes a SIDECAR marker `events/budget-init.json` (atomic rename; the v5 in-file header was rejected by the UNCHANGED owner reader — not a `LedgerRecord`, `ledger.ts:354-365` — and conflated never-init with deleted-with-spend; ledger line format stays byte-unchanged, legacy ledgers need an explicit operator `adopt:true`); worktree-probe grammar re-pinned to REAL `worktree list --porcelain -z` bytes (`branch refs/heads/main\0\0` — v5's separator spec fails on every normal repo); five-state EOF-tail classification replaces the `tornTail` boolean with cut/ambiguous ⇒ consult indeterminate (omitted tail may be a live append); recovery paths read main+journal only (moved/deleted branch cannot strand an open intent); `recovered` landings are terminal `merged` records; rollback provenance adds `merge-base --is-ancestor C main` + `already-rolled-back` no-op; §2.2 coverage closed to set-equality rules (i)–(iv) with the single current-episode exception. **Loop status: cycle-2 fresh audit of v6 in flight; D1–D9 sign-off bar = two more confirming rounds with no blocker/major** | M3 scoping (docs/21 draft v6) |
| 2026-11-15 | §10 Q5, §11.4 M3, §14.7 | **M3 scoping: docs/21 advanced v6→v7→v8 through cycles 2–3 of the confirming round (auditor gpt-6.1-terra, detached `~/.tre/audits/m3v6c2-*`/`m3v7c3-*`; no module touched).** v7 (cycle 2 on v6: 2 blockers + 6 majors + 3 minors): coverage gained its missing DIRECTION (every enumerated episode must appear as exactly one input — B1: inputs {A} vs enumeration {A,B} passed while B's spend vanished); the marker/ledger crash window's "self-heal" was a fiction (a crashed process has no queued write; the restarted owner passes the fleet gate BEFORE reserving — B2 permanent freeze) replaced by DURABLE ORDERING (complete-ledger fsync before marker link; zero-byte ledger = proof of zero spend ⇒ `init-pending` zero term); `CurrentEpisode` param added to `projectFleet`/`fleetSummary` (the exception was unrepresentable); repeat rollback became journal-keyed lifecycle `refused(already-executed)` (tree equality retained only as the empty-difference no-op — after promote→revert→reintroduce the old actionId must NOT roll back independently-gated new work); marker publication moved rename→`link()` (rename clobbered concurrent adoption evidence); adoption bound to its validated ledger (first-record identity); `unterminated-kept` settled-finality claim withdrawn (a writer may still append legal bytes) — ANY population cut/ambiguous ⇒ WHOLE consult indeterminate, whitespace-EOF UNSETTLED never `blank-suffix`. v8 (cycle 3 on v7: 3 blockers + 5 majors + 3 minors): the ledger's DIRECTORY ENTRY fsynced before marker link (file fsync persists content not entries — the deletion-detection proof hardened, B1); adoption marker gains `adoptedSha256` prefix digest verified on every consult (first-record + length cannot stop a same-first-record rewrite omitting later spend, B2); coverage rule (vi) REQUIRES exactly one input matching `current` (complete-empty enumeration + `[]` = refusal, never zero-Σ admit, B3); `initEpisode` classification marker-FIRST (valid marker + absent ledger refuses — init never mints a zero ledger over a deletion) while publication stays ledger-first (M1); logical `actionId` (pins/seq EXCLUDED) separated from execution identity `actionId#r<n>` with durable max+1 suffix allocation (M2); rollback precedence table 0a own-record recovery → 0b promotion lifecycle (sticky `already-executed` in BOTH modes, BEFORE the ancestor test so a rewind cannot mask it) → 0c provenance/ancestor (revert-scoped) → 0d empty-difference no-op (M3); the §3 release bar reconciled line-for-line with the body (four residual contradictions, M4); `O_EXCL`/fsync/link failure state machine (M5). **Loop status: cycle-4 fresh adversarial audit of v8 IN FLIGHT (`~/.tre/audits/m3v8c4-terra-*`); D1–D9 sign-off bar unchanged (two more confirming rounds with no blocker/major — cycles 2 AND 3 both filed blockers, so the count has not started)** | M3 scoping (docs/21 draft v8) |
| 2026-11-15 | §10 Q5, §11.4 M3, §14.7 | **M3 scoping: docs/21 advanced v8→v9 through cycle 4 of the confirming round (auditor gpt-6.1-terra, detached `~/.tre/audits/m3v8c4-*`; 3 blockers + 7 majors + 4 minors; no module touched).** Cycle 4 attacked the seams v8 introduced: (B1) the `O_EXCL` loser published a marker on a winner's ledger whose fsync chain NOBODY established → durability is now PER-PUBLISHER (loser opens+fsyncs the existing zero-byte file and fsyncs `events/` before linking); (B2) the valid-marker retry was a no-op that could succeed on a marker whose link dir-fsync had FAILED → ANY success return (fresh or retry) now means the full chain is durable (retry revalidates AND re-establishes); (B3) rewind recovery reused the revert descendant test — vacuously true PRE-CAS (`M` is an ancestor of `C` before any rewind lands) → rewind landing proven by TIP IDENTITY (`main == M` exactly, disclosed ABA residue; crash-before-CAS ⇒ `intent-open`, never an ack). Majors: §3's "not-ancestor for BOTH modes" pin contradicted §1.2's revert-only scoping (provenance pins SPLIT per mode; rewind currency = `expectedMainTip == candidateSha` ⇒ `rewind-blocked`); discovery summary row now splits marker-absent/ledger-present by ledger BYTES matching the crash table; failure machine separates the link's EXPECTED `EEXIST` from fatal errors and dropped the impossible "no classification change" promise; new 0a′ cross-identity guard — unresolved rollback intents indexed by PROMOTION actionId before any new identity executes; `executionSeq` demoted to OPTIONAL EXPECTATION with journal-allocated `r` (intent-append = atomic claim, `refused(execution-seq-mismatch)` added to the union); redelivery semantics stated (pins never participate in identity; acked ⇒ sticky regardless of new pins; each `r` attests its own intent record); adoption inherits the FULL durability ordering (pre-link ledger+dir fsyncs), `firstRecordTs` pinned diagnostic-only; minors: header three/two path count, step-3 snapshot exclusions restated, the claimed-but-absent §3 rewind pins genuinely added. **Loop status: cycle-5 fresh adversarial audit of v9 IN FLIGHT (`~/.tre/audits/m3v9c5-terra-*`, kick `m3v9c5-terra-kick.sh`); trajectory c1 4B/7M → c2 2B/6M → c3 3B/5M → c4 3B/7M/4m — sign-off bar unchanged, count has never started** | M3 scoping (docs/21 draft v9) |
| 2026-11-15 | §14.3, §14.9, new §14.10 | **G1 audit-finding record DRAFTED (owner goal: automate the audit-fix loop, HANDOFF 2026-11-15; the loop's classification hinge). New §14.10 defines `kind:"audit-finding"` for the S5 decision log — closed `class` (code-defect / spec-gap / spec-ambiguity / residual-risk-accepted, exactly HANDOFF G1's set), `severity`, `verdictBasis` (repro outranks evidence-only outranks opinion; opinion alone cannot hold a sign-off), bounded single-line `claim`, mandatory `repro` for non-minor code-defects (`finding-intake-invalid` otherwise — a claim the next cycle cannot re-run wastes a cycle), ≥1 `evidenceRefs` (orchestrator echoes are not evidence — D-round forensics rule), append-only disposition transitions (orchestrator vs owner attribution; duplicate rejections cite the surviving id). STATUS: DRAFT, owner review open, NOT implemented — post-P0 additive wire shape per the §14.9 rule (row before code, per that rule itself); no module touched. Explicitly out of §14.10: routing (post-G2), norm state (G2), convergence stop rule (G3), cycle budget (G4), partitioning (G5). §14.9 checklist gains a drafted row for §14.10. | G1 finding-record schema (draft) |
| 2026-11-15 | §14.10 (rewritten v2) | **G1 OWNER REVIEW ROUND 1 FOLDED — §14.10 draft v2 (owner decisions R1–R8, recorded verbatim in new §14.10.4).** R1-B: class SPLIT into routed `route:code-fix|human-review` x domain `surface:code|test|doc|spec` (the vocabulary the live R5 round actually classified in); `surface:spec`+`route:code-fix` invalid at intake. R2-A: new second kind `audit-finding-update` fully specified (findingId, to, dispositionBy, authority, supersedes; no `from` — derivable under S5 single-writer; update-on-closed refused; one supersede encoding replaces the old companion-record half-mechanism). R3: emission authority — auditors append findings only via supervisor intake (id minted there, R7: fresh conforming ULID, collision-refused, caller ids test-only per F55/F56); supervisor is sole appender of updates; `dispositionBy:owner` requires a TTY-confirmed-channel reference (D2 precedent) in `authority` — closes implementer-downgrades-own-blocker. R4: minors never auto-hold sign-off, owner decides escalations; `accepted-fix` binds to repro re-run green (semantics pinned here; consumer enforces). R5-A: bounded `claim` + REQUIRED `findingRef` -> episode `findings/` (S4 layout amendment in-place). R6: `affectedNorm` now object `{doc,anchor,sha256|null}`, digest mandated-or-not deferred to G2, at-most-one-norm-per-finding. R8: opinion-holds-sign-off rule MOVED to G3 (enforcement) — §14.10 supplies `verdictBasis` only. `residual-risk-accepted` demoted from finding class to `closed-residual` DISPOSITION (authority REQUIRED). Still DRAFT, NOT implemented, no module touched. | G1 finding-record schema (draft v2, owner round-1 folded) |
| 2026-11-18 | §14.10.3, §14.11.2, §14.12.2, §14.12.3, §14.13.4a, §14.14.4 | v12 owner decisions D0-b, D1-a, D2-b, D3-a, D4-a folded (draft v11→v12) | owner decisions D0–D4 |
| 2026-11-18 | §14.10.3, §14.11.2, §14.12.2, §14.12.3, §14.13.4a, §14.14.4 | v12 self-audit findings 1–7 folded (draft v12→v13) | self-audit of v12, findings 1–7 |
| 2026-11-18 | §14.11.2, §14.12.2, §14.12.3, §14.13.4a | v13 self-audit findings 1–5 + owner decision D5-a folded (draft v13→v14); two v13 auditor findings withdrawn on re-reading, recorded in the audit trail | self-audit of v13, findings 1–5; owner D5-a |
| 2026-11-18 | §14.10.3, §14.11.2, §14.12.2, §14.12.3, §14.13.4a, §14.14.5 | **TERRA AUDIT ARC cycle 10 (auditor gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c10-terra-*`): CHANGES REQUESTED — 2 BLOCKER + 7 MAJOR on draft v15 (9 findings; arc verdict "not adoptable as-is, fixable without revisiting owner decisions"); all folded into v16.** C10-B1 the v15 bound-displacement demanded a correction of the SAME statement identity while the correction graph only accepts a NEW identity pointing at its target via `correctionOf` (the same-identity/different-value case is its unresolved-unknown conflict) — the advertised $20→$2 displacement was unimplementable → displacement requires a correction with its OWN statement identity on the same stream naming the bound-setter in `correctionOf` (at-most-once, no contradiction), plus five executable displacement vectors (displacement, held-correction, correction-of-correction, second-conflicting-correction, post-release correction) (14.13.4a). C10-B2 the admission sentence still used `observedLowerBoundUsd` (disagreeing with the effective-bound contradiction branch) and a pre-terminal `spend-reconciliation` could be read as replacing the hold below it (releasing headroom while leaves run) → ONE replay-defined formula `heldUsd = max(residualCapUsd, Σ effectiveLowerBoundUsd)` shared by admission, hold, exposure note and release; an accepted adjustment below the live hold NEVER reduces it while leaves are open (takes effect only at unit release); post-release lifecycle pinned: release is one durable once-only event, later corrections never reopen the unit, exceedance is new spend charged at once (14.13.4a). C10-M3 the v15 normative group-plan conformance vector was not a valid canonical line (noncanonical spacing, raw TAB inside a JSON string; escaped form omitted the spaces so decode ≠ digest input) → REPLACED with a checked canonical vector: member line `{"a":"x\"y\\z` + the two-character TAB escape + NFC `é` + `"}` + newline, 20 exact bytes, hex `7b2261223a22785c22795c5c7a5c74c3a9227d0a`, sha256 `b66d0493…667e0`, the canonical 31-char containing string spelled out, NFC + control-character cases covered (14.11.2). C10-M4 the new round-trip inequality (noncanonical stored encoding, EQUAL digests) had no per-kind fault-field rule → third detection mode bound into `group-plan-mismatch` fields (recomputedDigest == reportedDigest is its signature; evidence = the record itself; re-emit forbidden, fail closed needs-owner) (14.11.2, 14.12.3). C10-M5 retry lineage kept superseded attempts in `callUniverse` but never in `issuedSet`/`provenNoCall` — a fully-evidenced crash+retry could never reach coverage → coverage computed over the LINEAGE PROJECTION `logicalOps` with clause (d) requiring every superseded attempt to belong to a valid settled lineage; three coverage vectors (retry-true, two-charges-unknown, unlineaged-false) (14.13.4a). C10-M6 "MATCHED iff receipt AND actId" contradicted the drain's act-identity skip and the same-act/new-receipt conformance vector (the entry matched forever-nowhere) → ONE rule: matching is by act identity alone, soundness carried by the append invariant (at most one queue entry per act identity for all time; append returns the existing entry+original receipt); receipt drift = new `queue-receipt-divergence` fault kind, act consumed once, boundary UNCLEAN (14.12.2 step 5(c), 14.12.3). C10-M7 a tail window finalizing with neither outcome (B→O conversion or frozen chain) left the deferral obligation with no admissible settlement — terminal outcome after the tail boundary was malformed everywhere → carried-forward obligation + FORWARD SETTLEMENT: after tail finalization a terminal outcome appends against the original chain settling forward (discharges the loop record, clears the note at the NEXT boundary, never alters the recorded UNCLEAN boundary); owner dispositions across a finalized window pinned; stall/cap/owner-action replay vector (14.14.5). C10-M8 `providerAccountId` is REQUIRED on every owner reconciliation record naming usage but was absent from the closed `spend-reconciliation` payload (a conforming owner could not authorize one) → added to payload AND record with explicit null placement (required for dispatch-attributable spend, null-only for elapsed/cycle overhead), mismatch refused, reconstruction conformance test (14.10.3, 14.13.4a). C10-M9 a second `channel-open` reusing a `channelId` demanded a history-integrity-fault the CLOSED enum could not represent → new `channel-id-collision` kind with identity tuple, required fields (evidenceRefs name both channel-open records), drain refusal + needs-owner, entry condition (f) added (14.12.2, 14.12.3). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v16, terra c10 folded) |
| 2026-11-18 | §14.12.2, §14.12.3, §14.12.4b, §14.13.4a, §14.14.5 | **TERRA AUDIT ARC cycle 11 (auditor gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c11-terra-*`): CHANGES REQUESTED — 2 BLOCKER + 6 MAJOR on draft v16 (8 findings, numbered 1–8; arc verdict "not adoptable as-is, fixable without revisiting owner decisions"); all 8 folded into v17.** C11-B1 the post-release correction arithmetic was false: "$30 released, correction to $25 ⇒ released Σ $7 ABOVE the corrected picture, charged as new spend" — $32 released vs $27 corrected is $5 BELOW, and a decrease is never new spend (adjacent lifecycle rule disagrees with the vector) → post-release accounting is ONE replay-defined formula `charged(P) = max(releasedTotal, correctedTotal(P))` with increments computed against the current charged total (never re-charging an exceedance), normative vectors V-e1 (increase-then-partial-decrease) + V-e2 (decrease-only: no spend, no refund) (14.13.4a). C11-B2 "refund applies against the released total" named no carrier, producer, or validation (the sole refund-carrying record `spend-reconciliation` is a one-time resolution — its chain, required fields, and floor rule forbid it) → the ONLY refund route is a superseding `spend-reconciliation` naming the chain tip in `supersedesReconciliation`, passing full validation (providerRecovery evidence, TTY act, floor rule restated for released units); released unit never reopened, append-only preserved (14.13.4a). C11-M3 correction sequence coverage was undefined for both identities (S5+S6+S7, S8 `correctionOf:"S5"`: v15 said the corrected statement "leaves the set" while its seq "stays CLAIMED by the correcting record" yet S8 carries its OWN seq — one effective statement in two sequence positions; claim only 5 ⇒ apparent gap at 8, claim only 8 ⇒ seq 5 erased; same ambiguity compounds for S11⇒S8) → raw-stream SEQUENCE OCCUPANCY and EFFECTIVE-VALUE placement are SEPARATE: every accepted RAW statement (corrections included) permanently occupies its own `statementSeq` (replacement never vacates/moves/double-books a position); replacement affects VALUE ordering only — the correcting value enters at the correction's OWN seq sort position; the gap check runs over the RAW OCCUPANCY set (a correction can neither hide a gap nor create a phantom one); normative fixtures: contiguous stream with correction (occupancy {5,6,7,8}, final cumulative $2) + held-correction-of-held-correction (S11⇒S8 with S5 absent: both held, whole chain re-plays in one deterministic fold when S5 lands) (14.13.4a). C11-M4 displacing the maximum bound erased a still-valid observation: leaf with uncorrected S1=$18, S2=$20, valid S3 corrects S2⇒$2 — "replace the bound with the corrected cumulative" loses the $18 and release at $2 passes with S1 still in the graph → the correction graph replaces the TARGETED OBSERVATION, then the bound is recomputed as the maximum across ALL effective observations (uncorrected siblings survive); executable competing-observation vector (S1 $18, S2 $20, S2⇒$2 ⇒ bound $18, release at $2 forbidden) (14.13.4a). C11-M5 the release's "one durable event" has no kind, fields, producer, or §14.12.4b inventory entry (replay cannot distinguish "released once at $32" from "not yet released" in the crash window) → new `residual-unit-release` record `{ envelope, residualDispositionId, unitId, coveredLeafRecordIds[], releasedUsd (sole source of the frozen releasedTotal), evidenceRefs[] }`; append-if-absent keyed by `(residualDispositionId, unitId)` (different bytes ⇒ `counter-divergence` fault, identical ⇒ idempotent); fsync BEFORE any boundary consuming the headroom (consuming without the record ⇒ fail-closed history-integrity fault); replay state = record presence, never a boundary-derived cache (14.12.4b, 14.13.4a). C11-M6 step 5(c) contradicts itself twice (matched iff receipt AND actId vs "matching is by act identity alone") and the at-most-one-entry invariant has no pre-append detection: a second entry for act A (new receipt R2′) sits in the queue while entry 1 drains, R2 vs R2′ never compared, boundary CLEAN (fault kind names the drain comparison as its detection point — bypassable) → matching is by act identity alone (receipts never compared at drain; receipt drift = `queue-receipt-divergence`), and a PRE-DRAIN FULL SCAN over every durable entry (P1-matched and drained included, per channel) runs before ANY drain, ordered by seq, first failure wins: duplicate act identity ⇒ `queue-receipt-divergence` (fields extended to carry both entries' receipts + record ids); the single MATCHED vocabulary is SPLIT into THREE pinned predicates evaluated per entry over the whole queue on every recovery — P1 transport match (act identity only; receipt equality structural at append), P2 integrity (receipt + byte-identical payload vs the matched act; drift detected at the pre-drain scan, never first-drain skip), P3 effect completion (matched act without effect record = class B effect owed, c8-B1 — fails the emptiness test, never "unmatched"); counterexample pinned: two same-act entries with drifting receipts, first drained then crash — the scan visits both regardless of drained state (14.12.2 step 5(c), 14.12.3). C11-M7 the c10 collision fix (channel-id-collision) makes `(channelId, actId)` non-unique — an entry of channel B drains against channel A's fence/receipt/act context (cross-wired drain, wrong channel charged) → queue-entry identity is the TRIPLE `(channelOpenRecordId, channelId, actId)`: the queue-receipt entry now carries `channelOpenRecordId` (required, envelope-carried), entry append and drain both match all three fields, and a fault on a channel-open record names the duplicate's entries via `affectedRecordId` = its record id (14.12.2 step 5(c), 14.12.3, 14.12.4b). C11-M8 forward settlement said a late terminal outcome settles "against the ORIGINAL chain" naming the last-active deferral while the binding rule requires the ACTIVE tail and refuses non-tail citations (after `grant-new-window` the old tail is not active — a delayed drain's forward settlement was simultaneously legal and malformed; the reset head itself violates the v9 linearity rule with `deferralOf:null`) → ONE replay-defined receipt-level state machine spanning chain generations: generation = segment delimited by reset heads, active generation contains the chain tip, reset supersedes every unfinalized fact of prior generations; explicit reset-head exemption (`deferralOf:null` valid IFF no prior deferral exists OR `resetOfLoopId` naming a `deferral-loop` whose `grant-new-window` disposition authorizes this record, at most one reset head per loop record — a second refused `deferral-branch`); stale-direction invalidation (terminal-outcome appends and pending drain directions validate `viaDeferralId` against the ACTIVE tail at append time; superseded-generation citation refused as `stale-deferral-lineage` validation error, prefix stays clean); the three receipt-level transitions (forward settlement, `waive-receipt`, `grant-new-window`) serialized one-per-S5-critical-section, first-admitted wins, later directives validated post-transition and refused if stale; normative race vectors (reset-vs-settlement both orders, waiver-vs-directed-drain both orders, second loop after reset with per-generation laundering counters) (14.14.5). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v17, terra c11 folded) |
| 2026-11-18 | §14.10.3, §14.12.2, §14.12.3, §14.12.4b, §14.13.4a | **TERRA AUDIT ARC cycle 13 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c13-terra-*`, against v19): CHANGES REQUESTED — 2 BLOCKER + 4 MAJOR (6 findings) on draft v19; all folded into v20.** C13-B1 the v19 monotonicity rule contradicted the contiguous fixtures and compared CAND to raw cumulatives → monotonicity over POST-replacement candidates (non-decreasing CAND); the fixtures that required values now resolve to unresolved unknown; the (viii) vector's claimed contradiction was an arithmetic error and is withdrawn (value $17) (14.13.4a). C13-B2 delta-only `baseline:0` streams had no value → the baseline is a sequenced synthetic cumulative 0; CAND(baseline)=Σ deltas (vector (ix) $5) (14.13.4a). C13-M3 the reconciliation interval was contradictory ("may not raise above the bound" vs "≥ the bound") → `effectiveLowerBound ≤ accepted ≤ hw`, refusal never clamping, floor-exact legal (14.13.4a). C13-M4 the release record did not freeze per-leaf-component values → `terms[]` with validated sum; disagreement is `disproven-authority` (14.12.4b, 14.13.4a). C13-M5 voided entries still formed duplicate pairs → excluded from every scan; retirement disposes their faults (14.10.3, 14.12.2). C13-M6 duplicate-entries and act-drift gave one entry several identities → one identity per DRIFTING entry (reference = owner-act receipt, else first-appended entry) (14.12.3). | TERRA AUDIT ARC cycle 13 (2 BLOCKER + 4 MAJOR on draft v19) |
| 2026-11-19 | §14.10.3, §14.12.2, §14.12.3, §14.13.4a | **TERRA AUDIT ARC cycle 14 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c14-terra-*`, against v20): CHANGES REQUESTED — 1 BLOCKER + 3 MAJOR (4 findings) on draft v20; all folded into v21.** C14-B1 a correction replacing a DELTA under a surviving covering cumulative was applied and double-counted (vector (viii) “$17”) → coverage rule: a delta-target correction is applied ONLY when no effective cumulative with seq > target’s seq survives; otherwise correction unapplied, component UNRESOLVED UNKNOWN, restated cover (vector (viii-b): correction targeting the covering cumulative resolves) is the only route (14.13.4a). C14-M2 the pre-drain scan hard-coded “the SECOND entry is the fault” while §14.12.3 re-derives the reference from the owner-act once it lands → the scan delegates to the §14.12.3 drift algorithm (v20 text was the no-act special case), and reference change never deletes a recorded fault (append-only; disposition-scoped closure) (14.12.2, 14.12.3). C14-M3 retirement could not dispose an already-DRAINED drifting entry’s fault → retirement disposes every fault of the retired channel’s duplicate triples (drained included; drained fact never un-run), residual side effects dispositioned individually, unenumerable residuals refuse retirement → needs-owner (14.10.3). C14-M4 sequenced `baseline:0` collided with real statements and pre-baseline deltas were undefined → baseline occupies its own seq; collision is a malformed append; at most one baseline; a delta before the baseline inside an anchorless stream is malformed, under a surviving cover it is covered as usual (14.13.4a). | TERRA AUDIT ARC cycle 14 (1 BLOCKER + 3 MAJOR on draft v20) |
| 2026-11-19 | §14.13.4a, §14.12.3, §14.10.3 | **TERRA AUDIT ARC cycle 15 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c15-terra-*`, against v21): CHANGES REQUESTED — 1 BLOCKER + 4 MAJOR on draft v21 (all four v21 fixes rated INCOMPLETE); all folded into v22.** C15-B1 the v21 restated-cover vector (viii-b) contradicted the coverage rule (S5 is itself a surviving cover ⇒ rule says still unknown; vector said $15) → RESTATED-COVER ABSORPTION: one deterministic graph rule — the correction is never re-admitted from any position; the unknown resolves IFF the LAST effective cumulative with seq > target seq AGREES with the corrected composition (C.value equals CAND(C) evaluated with the target delta’s value replaced by the correction’s); agreement is evidence, not a contribution; a cover of a different value leaves the unknown (vector (xii) pins it); pure function of the raw-record set, replay-stable (14.13.4a). C15-M2 retirement (§14.10.3) closed faults by weaker affectedRecordId-is-an-entry-of text while §14.12.3 required ALL entries → ONE closure predicate (ALL-affected-entries-belong-to-the-retired-channel) in both sections; cross-channel faults impossible by the within-channel matching invariant EXCEPT via already-drained foreign entries, which take the deterministic individual-disposition exit; closure owned by the first satisfying retirement, idempotent per fault identity (14.10.3, 14.12.3). C15-M3 the v21 drained-residual rule demanded the retirement disposition name-and-disposition each residual fault — the CLOSED payload has no such field → THREE-WAY exclusive-and-total fault closure: (a) all-channel faults close with the retirement; (b) mixed-channel and execution-side-effect faults must be closed by their OWN prior history-integrity-disposition before the retirement validates (refusal = clean prefix, deterministic validation order on replay, no new payload field); (c) unenumerable residuals refuse retirement → needs-owner (14.10.3). C15-M4 baseline collision was malformed-append/prefix-stays-clean while the general collision rule says component unknown → moved APPEND-TIME to FOLD-TIME: append validation is structural only; a baseline collision is the general unknown with both records retained, IDENTICAL in both arrival orders (vector (x)); two baselines = the same fold collision, same-identity redelivery dedups per step 1; C15-M5 pre-baseline malformed-at-append depended on future effective covers → pre-baseline deltas are FOLD STATUS (unanchored addend ⇒ unknown via the ordinary step-5 mechanism; a later cover replays the same raw set deterministically; never a retroactive mutation of history) (vector (xi)); vector (viii) wording fixed (unknown from S4’s arrival, not keeps $12) (14.13.4a). | TERRA AUDIT ARC cycle 15 (1 BLOCKER + 4 MAJOR on draft v21) |
| 2026-11-19 | §14.13.4a, §14.12.3 | **TERRA AUDIT ARC cycle 16 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c16-terra-*`, against v22): CHANGES REQUESTED — 1 BLOCKER + 5 MAJOR on draft v22 (all five v22 fixes rated INCOMPLETE); all folded into v23.** C16-B1 the v22 agreement equation `C.value = CAND(C) with the target replaced` agreed TAUTOLOGICALLY (the cover was both evidence and input; substitution cancels for any cover above the target, so the (xii) rejection could never fire) → INDEPENDENTLY ANCHORED COMPOSITION COMP(C): Σ counted once per contribution below the cover, corrected contributions AT CHAIN-TIP VALUE; V = last cumulative/baseline strictly below the lowest blocked chain position, and V-without-anchor makes agreement INCOMPUTABLE (component stays unknown; never defaulted to 0); COMP never reads the cover's own value; vectors (viii-b)/(xii) restated via COMP (14.13.4a). C16-M2 corrections of corrections under a surviving cover had no defined effective-set result → CHAIN NORMALIZATION before coverage/absorption: one synthetic tip contribution at the original delta's own seq (latest raw correction value), raw records retained, graph membership unchanged; vector (xiii) pins chain + restated cover ($16) (14.13.4a). C16-M3 the no-cover branch collided with the coverage rule (applied tip vs stay-unknown) → exclusive branches: absorption governs only while a blocked chain exists; when the last cover above the chain is removed the tip is APPLIED and takes the step-2 anchor rule; with no surviving cumulative the component is unknown via step 2 — one named rule, same fail-closed result (14.13.4a). C16-M4 the ALL-entries predicate read an undefined affected-entry set (recorded evidence is frozen, drift re-derives) and v22's drained-foreign-entry exception contradicted the triple `(channelOpenRecordId, channelId, actId)` → exception WITHDRAWN: duplicate groups are keyed by the full triple so every fault is single-channel by construction; affected set = fresh pre-drain-scan replay of the CURRENT log at decision time (creation and closure replay the same scan and cannot disagree); retirement-before/after-reference-change is decided by the current enumeration (14.10.3, 14.12.3). C16-M5 step 2's “stream that BEGINS with deltas” contradicted vector (xi) → anchoring restated over the EFFECTIVE SET: a delta is anchored iff an effective cumulative exists above its own seq; component with no effective cumulative is the unanchored case; arrival-order phasing WITHDRAWN (14.13.4a step 2). C16-M6 two distinct baselines at DIFFERENT seqs was misdeclared “the same fold collision” → baseline identity = (streamKey, providerStatementId); distinct baselines at different seqs: lower marker redundant, value rule unchanged, but fold raises a baseline-cardinality needs-owner flag (non-closable-clean; value computed, trust withheld); vector (xiv) (14.13.4a). | TERRA AUDIT ARC cycle 16 (1 BLOCKER + 5 MAJOR on draft v22) |
| 2026-11-18 | §14.12.3, §14.12.4b, tooling | **c27 consistency audit (v34, read-only, against commit `819dcd8`) and the mechanical gate (option D of the v33 assessment): 1 MAJOR finding — **C27-F1**: the v33 fold's span replacement swallowed the v32 sentence "A closed fault is never reopened by an unsupported read, and no later validation rewrites it." (present in `3a89fb9`, absent in `819dcd8` — a patch-induced deletion, the exact defect class the audit arc kept finding in prose). Restored verbatim from `3a89fb9`; the v33 D6 rule is unaffected by the restoration (D6 ADMITS closed boundaries at capable gates; it never reopened faults). Registered `scripts/contract-check.mjs` — a pure-stdlib-node consistency gate over this contract, wired into quality-check.sh as step 8: C1 status-line uniformity, C2 version propagation, C3 ledger mechanics (termination + newest-row DECISIONS-REQUIRED: 0), C4 faultKind↔identity-tuple closure, C5 decision-enum two-site agreement, C6 undecided-authority idiom ban, C7 kind-shaped-term ratchet, C8 pinned-clause registry (12 clauses from folds v29–v34 must survive every edit; C27-F1 is the first casualty-then-pinned). Each check proven to fire by fault injection against a copy of this file. No contract semantics changed beyond the restoration; no new record kind. DECISIONS-REQUIRED: 0** |
| 2026-11-18 | §14.12.3, §14.12.4b | **OWNER DECISION D6 recorded (option A, version-capable consumer):** shared admission/retirement of a closed `fold-summary-unsupported-version` boundary requires the deciding shared gate to replay with a reader at a version ≥ the boundary's `foldSummaryVersion` — the gate's own replay verification IS the authoritative validation (no new record kind; recomputation is the sole authority); a gate below the version fails closed and never admits on the explanation alone; §14.12.4b registration clause: a future foldSummary version bump must restate D6 sufficiency or register a durable validation-record kind in the same revision, else out of contract. Closes the C25-B1 DECISIONS-REQUIRED item. DECISIONS-REQUIRED: 0 | Owner decision D6 — shared admission (v33) |
| 2026-11-18 | §14.12.3, §14.12.4b | **v31 audit (read-only, commit `36885ac`): CHANGES REQUESTED — 1 BLOCKER + 5 MAJOR (v32 consistency fixes, C25-B1..B5, plus the terminator). Fixes: C25-B1 unsupported-version closure narrowed to rules the schema can express (no new record kind; shared admission for closed unsupported-version boundaries is an owner decision, fail closed meanwhile); C25-B2 intake dedup of closed faults; C25-B3 restored blob inert until the disposition (crash-safe); C25-B4 boundary set bounded to its own prefix; C25-B5 digest-null wording vs canonical boundaryId; dangling F5 cross-reference corrected.** DECISIONS-REQUIRED: 1 (shared admission of closed unsupported-version boundaries, C25-B1) | TERRA v31 audit consistency pass |
| 2026-11-18 | §14.12.3, §14.12.4b | **v30 internal review (read-only, against commit `c207ac2`): CHANGES REQUESTED — 6 findings (1 BLOCKER-class restored-bytes/prefix ambiguity, 4 MAJOR, 1 MINOR); folded into v31 as C24-F1..F6.** C24-F1 restored bytes never change a historical boundary's classification (evaluated at each boundary's own prefix position). C24-F2 the stale named-handling text is replaced by the canonical per-kind rule. C24-F3 explanation text and restored policy bytes are separate payloads. C24-F4 unsupported-version disposition closes the FAULT only; admission/retirement need an authoritative validation; a closed fault is never reopened. C24-F5 missing-blob payload is canonical and detector-order independent (boundaryId null for sub-form (a)). C24-F6 ledger row delimiters corrected. DECISIONS-REQUIRED: 0 | TERRA internal review of v30 (6 findings) |
| 2026-11-18 | §14.12.3, §14.12.4b, §14.13.4a | **TERRA AUDIT ARC cycle 23 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c23-terra-*`, against v29, commit `997cb9c`): CHANGES REQUESTED — 1 BLOCKER + 5 MAJOR + 1 MINOR; the auditor again did NOT complete the second surface (self-declared FAIL), so the per-row, inventory, unknown-propagation, authority and crash matrices remain OPEN.** Folded into v30: C23-F1 missing-revision identity (§14.12.3 per-kind fields, sub-forms a/b); C23-F2 R2 post-activation branch removed as unreachable (§14.12.4b R2); C23-F3 R3 disposition bound to the existing closed decision set (§14.12.4b R3); C23-F4 durable-fault vs reader-local split (§14.12.3 enum, §14.12.4b intake); C23-F5/F7 sixth pipeline stage absorbed into P4 and the c22 row corrected to cite the body (§14.13.4a); C23-F6 no-observation NULL state for effectiveLowerBoundUsd (§14.13.4a). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 23 (1 BLOCKER + 5 MAJOR + 1 MINOR on draft v29) |
| 2026-11-18 | §14.12.4b, §14.13.4a | **TERRA AUDIT ARC cycle 22 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c22-terra-*`, against v28, commit `598d46f`): CHANGES REQUESTED — 1 BLOCKER + 4 MAJOR (the auditor rated all four c21 fixes INCOMPLETE); all five folded into v29.** C22-B1 the v28 activation test had no defined result when no activation revision A exists in the prefix and no bootstrap/upgrade ordering for a first v28 writer → activation-revision resolution modes R1 (A present: the strict-earlier test as written) / R2 (no A: per-boundary content classification of the cited policy, §14.12.4b R2 paragraph) / R3 (digest unresolvable or ambiguous ⇒ `policy-digest-mismatch`-family fault, see C22-M4), and the upgrade-bootstrap ordering clause (the activation revision is durable BEFORE the writer appends its first post-activation boundary; a writer that cannot establish it appends none) (14.12.4b). C22-M1 the withdrawn presence-only sentence ("the presence of the field IS the activation marker") remained normative prose contradicting the policy-history rule → WITHDRAWN in place (struck, never merely qualified), the discriminator stated once (14.12.4b). C22-M2 two colliding numbered-step systems (enclosing fold rules 1–5 vs the inner pipeline (0)–(4)) → distinct identifiers: enclosing fold rules F1–F5, pipeline stages P0–P4, with an explicit two-systems clause and every cross-reference naming its system (14.13.4a). C22-M3 held-correction vector (b) asserted "the bound stays $20" over prefix {S2} where the prefix contains NO effective observation (the $20 was imported from the absent S1) → WITHDRAWN, vector split into (b-1) absent-target hold ⇒ vacuous bound (an empty maximum derives neither $20 nor $0-as-evidence; heldUsd carried by the residualCapUsd term) and (b-2) the prefix that legitimately shows a held correction over a live bound MUST contain the bound-setter (S1 $20 @1 with a held correction-of-future C; forward-only replay, never retroactive) (14.13.4a). C22-M4 a committed boundary with `foldSummaryVersion` above the reader's maximum had "unreadable, needs-owner" with no representable fault kind → named `fold-summary-unsupported-version` (never `disproven-authority` — an unsupported version disproves no authority) plus the null/unresolvable-digest form of `policy-digest-mismatch` for the missing/unresolvable activation inputs; writers of this contract version emit `foldSummaryVersion: 1` (14.12.4b, 14.12.3). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 22 (1 BLOCKER + 4 MAJOR on draft v28) |
| 2026-11-18 | §14.13.4a, §14.12.4b | **TERRA AUDIT ARC cycle 21 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c21-terra-*`, against v27): CHANGES REQUESTED — 1 BLOCKER + 3 MAJOR (all four v27 fixes rated INCOMPLETE); all four folded into v28.** C21-B1 the v27 legacy rule inferred "committed pre-v26" from the field's ABSENCE alone, so a post-activation v27-writer line that omits `foldSummary` is byte-identical to a genuine pre-v26 legacy line and would be misclassified legacy instead of refused → LEGACY exemption KEYED ON IMMUTABLE DEPLOYMENT HISTORY, not presence alone: exemption is a log-position test over the `policyDigest` chain (the first `policy-revision` record whose policy bytes implement the `foldSummary` rule — the activation revision A; boundary `policyDigest` echoes resolve to exactly one policy record in the prefix): boundary without `foldSummary` under a pre-A policy ⇒ LEGACY (verified under its own rules); without the field under policy A-or-later ⇒ post-activation malformed writer ⇒ refusal at append and refused on replay (byte-distinguishable from legacy by `policyDigest`) (14.12.4b). C21-M2 the v20 fixture (ii) still carried raw positions {5,8,11} with interior gaps 6–7/9–10, stating the value of the unproven successor while the dense gate the fixture teaches made the stream UNKNOWN before the graph ran → RENUMBERED DENSE (S1 cum $8 @1 → S2 corr-S1 $2 @2 → S3 corr-S2 $11 @3, occupancy {1,2,3} at every stage; staged held-state taught by prefixes {S3}, {S2,S3}, {S1,S2,S3} instead of by gaps); pipeline steps made explicit (0) PARSE — every form-valid raw record occupies its own seq at acceptance even while HELD — then (1) collect, (2) graph resolution (held = graph status, never occupancy removal), (3) GAP-CHECK, (4) ORDER/VALUE, so graph resolution never outruns the gate (14.13.4a). C21-M3 the v15 bound-displacement vectors (a)/(c) carried raw positions {5,8}/{5,8,11} with interior gaps, printing "release is legal" on streams the step-3 gate folds UNKNOWN → RENUMBERED DENSE (S1 cum $20 @1, S2 corr-S1 $2 @2, occupancy {1,2}; (c) S3 corr-S2 @3, {1,2,3}); displacement vs release SEPARATED: displacement rewrites the BOUND, release additionally requires the full clean terminal fold (dense prefix, terminal evidence for every leaf, no open contradiction — vector (d) given the same dense treatment reading twice-UNKNOWN: contradiction AND gap) (14.13.4a). C21-M4 the §14.12.4b `usage-recovered` inventory field list omitted `providerAccountId` while §14.13.4a requires it on every usage record to identify the stream → added to the inventory field list (REQUIRED); recovery stream placement pinned: `usage-recovered` names `(providerAccountId, dispatchOf(targetId))` exactly like a provider `usage-late-arrived` on that stream and folds under the same dense occupancy rules (never bypasses the gate), sharing the single identity/dedup rule; stale duplicate "producer:" line corrected (14.12.4b, 14.13.4a). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 21 (1 BLOCKER + 3 MAJOR on draft v27) |
| 2026-11-18 | §14.13.4a, §14.12.4b | **TERRA AUDIT ARC cycle 20 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c20-terra-*`, against v26): CHANGES REQUESTED — 4 MAJOR (all four v26 fixes rated INCOMPLETE); all four folded into v27.** C20-M1 vectors (xiii) and (xviii) claimed values while their apparent raw occupancy violated the dense-sequence gate the vectors themselves rely on → both SEQs RENUMBERED DENSE with explicit `@seq`s and contiguous occupancy stated, plus a NUMBERING AND DENSITY CONVENTION for the whole vector set (explicit `@seq` wins; otherwise label number = statementSeq; value-claiming vectors must be dense; deliberate gap fixtures state their gap and claim the unknown) and a full (v)–(xxv) rescan under the gate (14.13.4a). C20-M2 the v26 `foldSummary` field had no compatibility rule for boundary records written before v26 → `foldSummaryVersion: 1` REQUIRED on every writer's foldSummary (absence = malformed ⇒ refusal; version greater than the reader implements ⇒ fail closed per the §14.12.4 v5-c3 analogue, needs-owner, never silently skipped) (14.12.4b). C20-M3 `warnings[]` had no total order and no pinned replay-comparison prefix → sort key pinned lexicographic by `(warning, streamKey, markerIdentities[0].statementSeq)`; replay comparison prefix pinned: `streamKey` for `baseline-cardinality`, `(warning, streamKey)` for `reconciliation-floor-divergence` (14.12.4b). C20-M4 the v26 `max(R, tip)` precedence was stated over the whole reconciliation but R (the raw fold) is per-component and the elapsed component has no provider-statement fold → precedence SCOPED to the spend component; the elapsed component's raw fold defined independently (raw elapsed from the endpoint rule, never max()-ed against the tip); `recoveredElapsed < acceptedTipElapsed` ordering given its own named precedence (advisory `reconciliation-floor-divergence` warning; never a silent overwrite of the accepted tip elapsed) (14.13.4a). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 20 (4 MAJOR on draft v26) |
| 2026-11-18 | §14.13.4a, §14.12.3, §14.12.4b | **TERRA AUDIT ARC cycle 19 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c19-terra-*`, against v25): CHANGES REQUESTED — 2 BLOCKER + 3 MAJOR (all five v25 fixes rated INCOMPLETE / not fully verified); all five folded into v26.** C19-B1 delta-correction placement had TWO normative definitions (the coverage rule entered the corrected value AT THE TARGET DELTA'S OWN SEQ while the general replacement clause and pipeline step 2/4 entered it AT THE CORRECTION'S OWN SEQ — the same stream folded to different values by which sentence was read) → placement UNIFIED as ONE per-kind rule stated at step 3, the pipeline and the coverage rule: a correction of a CUMULATIVE enters at the CORRECTION'S OWN SEQ (vector vii), a correction of a DELTA enters at the TARGET DELTA'S OWN SEQ at chain-tip value (vector xxi), raw occupancy untouched; step 4 orders by PLACEMENT position (the v17 'correcting record sorts at its OWN seq' parenthetical withdrawn as a general statement); vector (xxi) re-run against the full pipeline — same unknown under both readings (14.13.4a). C19-B2 same-value sibling corrections (`C=correct(D,$2)`, `E=correct(D,$2)`) were distinct nodes each 'chaining normally' — descendants `F=correct(C,$5)`, `G=correct(E,$6)` had no deterministic result → same-value corrections of one target are ONE MERGE CLASS: every target-firing rule (chain placement, at-most-once, contradiction, restatement) fires class-wise; divergent descendants = the existing contradiction clause (unresolved unknown, never a silent branch); same-valued descendants chain to one tip; members keep ORIGINAL identities as resolvable targets; mutual same-value pairs are the cycle contradiction CLASS-WISE (cycle check precedes class formation — the restatement rule never absorbs a pair); vectors (xxiii) divergent siblings + (xxiii-ctl) same-valued, (xxiv) mutual pair, (xxv) sibling redelivery no-op (14.13.4a). C19-M3 rewritten vector (xvii) carried raw occupancy {1,2,4}, {1,2,4,6}, {1,2,4,6,8} — interior gaps the dense-sequence gate forbids while the vector claimed values → RENUMBERED CONTIGUOUS (S1@1..S5@5, corrections @3/@4); arithmetic unchanged (14.13.4a). C19-M4 a component reconciled at $20 whose raw set LATER folds clean had no stated value ('$20 chain tip' vs 'lifts forward, never below the floor' competed) → ONE total precedence: while the raw set folds UNKNOWN the chain tip is the value; when it folds CLEAN at R the value is `max(R, tip)` — R>tip lifts forward (the accepted amount is a floor, not a ceiling; raising spend stays provider-correction territory), R=tip agrees, R<tip stays tip with an advisory `reconciliation-floor-divergence` warning (lowering requires a superseding reconciliation through the chain — no new owner override); released targets unchanged (per-term high-water `hw_{i,c}` governs); worked examples $15→$20 / $20→$20 / $25→$25 (14.13.4a). C19-M5 the `warnings[]' carrier was named but no report schema/producer existed → the carrier is DEFINED in the inventory: the **fold-warnings report**, an explicitly NON-RECORD projection recomputed by every fold, returned in band and appended at boundary commit as a `foldSummary` FIELD of the existing `cycle-boundary` record `{ warnings: [{ warning ∈ baseline-cardinality | reconciliation-floor-divergence, streamKey, markerIdentities[] }] }` — closed warning enum, required FULL SORTED markerIdentities for baseline-cardinality, empty for floor-divergence; unsorted/partial/unknown-marker foldSummary is malformed (refusal), replay compares recomputed foldSummary (mismatch ⇒ `disproven-authority`); advisory only — never gates cleanliness, needs-owner, or closure (14.12.4b, 14.13.4a). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 19 (2 BLOCKER + 3 MAJOR on draft v25) |
| 2026-11-20 | §14.13.4a, §14.12.3, §14.10.3 | **TERRA AUDIT ARC cycle 18 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c18-terra-*`, against v24): CHANGES REQUESTED — 2 BLOCKER + 4 MAJOR (all six v24 fixes rated INCOMPLETE); all six folded into v25.** C18-B1 vector (xvii) required an owner act that cannot be expressed (the reconciliation schema has no statement identity and no removal operation, and never overrides a known ledger amount) → (xvii) REWRITTEN to open on a stream that NEVER held a cover (provider records alone reach the no-cover, chain-extension and re-cover states; no deletion authority added) + a pinned clause: reconciliation resolves the COMPONENT value under the known-spend floor and is NOT a graph operation (the fold always replays the full raw set; a later agreeing fold lifts the value forward, never below the floor) (14.13.4a). C18-B2 baselines both did and did not cover a corrected delta (step 2 'COVERS NOTHING' vs the unqualified 'no EFFECTIVE cumulative' coverage predicate) → ONE covering predicate `covers(d,C)`: only a REAL (non-synthetic) effective cumulative with seq(d) < seq(C) covers; a baseline is an OBSERVER only (anchoring, monotonicity, mid-interval incomputability, COMP anchor — never coverage, never blocking), used by coverage, blocked-chain selection, absorption, no-cover detection and every vector; vector (xxi) pins acceptance + monotonicity-unknown (14.13.4a). C18-M3 the lower-baseline redundancy claim over-generalized (a baseline anchors only deltas strictly above itself; with D between markers removing the lower one strands D and monotonicity flips to unknown) → redundancy NARROWED to 'no effective contribution strictly between the markers', both markers participate in monotonicity and eligibility as COMP anchors, vectors (xx) counterexample + (xx-ctl) control, vector (xiv) phrasing narrowed (14.13.4a). C18-M4 'same-value duplicate: folded by the dedup identity rules' could delete a distinct-identity correction node and sever chains targeting it → WITHDRAWN: a same-value correction remains a DISTINCT graph node; identity dedup fires ONLY on same-identity redelivery; a second correction of the same target with the SAME value is a same-value restatement (evidence retained, one unique tip — no contradiction); vector (xxii) (14.13.4a). C18-M5 retirement's first-detection evidence and its closure group were ambiguous snapshots with unspecified ordering → detection-to-append ordering pinned: immutable first-detection evidence vs retirement-time group re-derived at the pinned prefix; ONE serialized sequence under the flock — replay prefix → DETECTION BARRIER (all required scans durably append still-missing faults, deterministic order) → enumerate open faults/residuals → validate → append; newly detected in-channel faults close with the retirement, out-of-channel ones refuse it; same-fold double retirement MUST re-evaluate after the first append (§14.10.3 validation order cross-references the barrier) (14.12.3, 14.10.3). C18-M6 the baseline-cardinality advisory permitted pairwise vs single warnings with no carrier → exactly ONE stream-level warning at ≥2 markers carrying the FULL SORTED marker-identity list, a DERIVED PROJECTION (not a record kind) recomputed per fold, carried in the acceptance report's `warnings[]` array `{ warning, streamKey, markerIdentities[] }`, non-blocking (14.13.4a). DECISIONS-REQUIRED: 0 | TERRA AUDIT ARC cycle 18 (2 BLOCKER + 4 MAJOR on draft v24) |
| 2026-11-20 | §14.13.4a, §14.12.3, §14.10.3 | **TERRA AUDIT ARC cycle 17 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c17-terra-*`, against v23): CHANGES REQUESTED — 2 BLOCKER + 4 MAJOR (all six v23 fixes rated INCOMPLETE); all six folded into v24.** C17-B1 COMP now sums only contributions strictly between the anchor A and the cover, with a mid-interval effective cumulative forcing INCOMPUTABLE (vectors (xv)–(xvi)); C17-B2 one chain-tip value (latest raw correction, blocked or not) read by BOTH CAND and COMP, v23's blocked-exclusion and all-blocked exception WITHDRAWN; C17-M3 step-2 anchoring REAL/SYNTHETIC split — any cumulative strictly BELOW a delta anchors it, a baseline anchors only deltas strictly above itself, only a REAL cumulative covers by observation above (vectors (ix)/(xi)/(xiv) reconciled); C17-M4 baseline-cardinality `needs-owner` flag WITHDRAWN (no record identity, no owner-act payload, attack surface) → deterministic ADVISORY WARNING with pinned provenance, CLOSED-CLEAN allowed; C17-M5 retirement affected-set enumerated by the pre-drain scan replayed at the prefix immediately before the retirement's own append under the §14.6 flock (membership decided once; crash-after-void and same-fold retirements deterministic); C17-M6 one tip-placement rule — delta-targeted corrections enter at the TARGET's own seq for coverage, anchoring, value and the no-cover branch alike, v21's enters-at-correction's-own-seq explicitly WITHDRAWN for delta targets (cumulative targets unchanged per (vii)). | TERRA AUDIT ARC cycle 17 (2 BLOCKER + 4 MAJOR on draft v23) |
| 2026-11-18 | §14.10.3, §14.12.2, §14.12.3, §14.13.4a | **TERRA AUDIT ARC cycle 12 (auditor gpt-6.1-terra, `~/.tre/audits/g2g5-c12-terra-*`, against v18): CHANGES REQUESTED — 2 BLOCKER + 5 MAJOR (7 findings) on draft v18; all folded into v19.** C12-B1 mixed delta/cumulative fold undefined → one algebra: CAND(k)=C_k + Σ later effective deltas, value = max CAND, contradictions fail closed, vectors (v)–(viii) (14.13.4a). C12-B2 the v18 unit-wide high-water reset let one component's reconciliation refund another component's spend → high-water kept PER LEAF-COMPONENT, a reconciliation resets only its own term, two-component vector (14.13.4a). C12-M3 pre-drain fault required an act it cannot cite → evidence by detection mode (duplicate-entries / act-drift / re-detection dedup) (14.12.3). C12-M4 single-entry act drift had no identity → act-drift mode keyed by the drifting entry's queueId (14.12.3). C12-M5 retirement left voided entries failing quiescence and allowed later appends → retired channel refuses appends; VOIDED entries excluded from P1–P3 (14.10.3, 14.12.2). C12-M6 multi-unit unreleased headroom collapsed into one fault → identity includes the unit's disposition record (14.12.3). C12-M7 post-release unaffordable increase had two statuses → budget-exhausted by the residual-overage precedence (14.13.4a). | TERRA AUDIT ARC cycle 12 (2 BLOCKER + 5 MAJOR on draft v18) |
| 2026-11-18 | §14.10.3, §14.12.2, §14.12.3, §14.12.4b, §14.13.4a, §14.14.5 | **v17 self-audit findings 1–8 folded (draft v17→v18), cycle-12 prep.** F1 post-release charge is a high-water fold `charged = max(releasedTotal, HW(P))`. F2 superseding refund expressible (`supersedesReconciliation` in owner payload + record; released targets need a chain tip). F3 pre-drain duplicate fault identity = second queue entry's queueId. F4 P1 + duplicate scan keyed by the triple. F5 `retire-duplicate-channel` disposition with `voidedQueueIds`. F6 new kind `unreleased-headroom`; duplicate release ⇒ `disproven-authority`. F7 cumulative value = max over effective observations; fixture (i) corrected. F8 reset does not carry prior-generation standing notes. | self-audit of v17, findings 1–8 |
| 2026-11-18 | §14.11.2, §14.12.2, §14.12.3, §14.13.4a | **v14 same-session review findings 1–5 folded (draft v14→v15), cycle-10 prep.** F1-B the v14 release-floor test compared AGGREGATE Σ terminal vs Σ lower bounds — one leaf's excess masked another leaf's contradiction (A bound $20/terminal $2, B bound $0/terminal $30 passed the sum test) → the release test is PER LEAF (leaf releases only at ≥ its OWN effectiveLowerBoundUsd) and the release is unit-granular (any contradicted leaf blocks the whole release); normative counterexample vector added. F2-B the contradiction branch said `heldUsd` "holds at Σ observedLowerBoundUsd" — dropping the accepted cap from the hold ($100 cap / $20 bounds ⇒ $20 charge while unresolved) → the hold keeps its full `max(residualCapUsd, Σ effectiveLowerBoundUsd)` formula until valid release. F3-M v14 offered owner `spend-reconciliation` as a lower-bound displacement route, contradicting the reconciliation schema ("never overrides a known ledger amount") → displacement ONLY via a graph-accepted `correctionOf` correction (a loosely worded statement is never displacement evidence; effectiveLowerBoundUsd defined post-correction). F4-M the group-plan wire encoding claimed "standard JSON escaping has exactly one form" (FALSE — `\"` vs `\u0022`, `\n` vs `\u000a`) so byte-identical re-emission was unimplementable → the containing record serializes under `tre-canonical-json/1` (the contract's single normative wire rule), member value = decoded text incl. terminator, digest over decoded UTF-8 bytes, round-trip inequality = `group-plan-mismatch`, byte-level conformance vector added. F5-m the D5-a acceptance claimed the forward jump's "only effect" is a boundary recorded UNCLEAN — it ALSO lifts B's append-blocking and moves escalation earlier → consequence restated precisely (unclean boundary may arrive early; authority never consumed; never a CLEAN boundary early); enum cross-reference points at §14.12.2 for the full statement. DECISIONS-REQUIRED: 0 | self-audit of v14, findings 1–5 |
| 2026-11-18 | §14.11–§14.15 (v10→v11) | **TERRA AUDIT ARC cycle 9 (auditor gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c9-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 12 MAJOR + 1 MINOR on draft v10 (17 findings; several named as v10 fixes being INCOMPLETE); all fixed into v11.** C9-B1 the v10 "late null-seq is non-contributing AND non-degrading" rule let a late independent charge disappear ($10 cumulative + unproven late $5 closed clean) → late null-seq contributes ONLY under provider-backed inclusion evidence (non-contributing, non-degrading) or non-inclusion evidence (additive); with NEITHER the component is unresolved unknown; vectors re-corrected to the three cases (14.13.4a). C9-B2 a PARTIAL provider measurement replaced a residual-cap provisional charge and released headroom while the request kept running → replacement is PER COVERED LEAF by TERMINAL provider-complete evidence only; interim measurements never reduce provisional charges; headroom releases leaf-by-leaf; `spend-reconciliation` remains the owner route for pre-terminal adjustment (14.13.4a). C9-B3 a stalled authorized effect converted B→O and this read as authority consumed, and the act stored a payload DIGEST that cannot reconstruct a lost queue entry → owner-act records store the FULL canonical payload (≤16 KiB, self-contained) + digest; effect conversion unblocks append but NEVER authority (boundary UNCLEAN + needs-owner, `effectApplied` stays false until effects validate; §14.10.3 "no boundary of ANY cleanliness" corrected to "no CLEAN boundary" — the UNCLEAN conversion route stands, authority never converts) (14.10.3, 14.12.2). C9-B4 `evidence-invalidation` and the deferral-loop dispositions were consumed by the contract but ABSENT from the closed owner-act enum (a conforming validator refused them) → both join the closed enum with fully bound schemas (target kinds `repro-run\|acceptance`; loop decisions closed) (14.10.3). C9-M5 invalidation read an immutable acceptance record's own `invalidatedBy` (null can never transition under append-only — mid-episode invalidation was legally impossible) → invalidation is ONE append-only EVENT kind, the target's `invalidatedBy` reading is a deterministic replay FOLD, both target kinds covered, targets never mutated (14.10.3, 14.12.2 r4). C9-M6 idempotencyKey was "unique per (providerAccountId, idempotencyKey) across the episode" while the crash rule made same-key retry under a new callId legal → uniqueness is per LOGICAL PROVIDER OPERATION; retry lineage via `retryOfCallId` (linear, byte-identical request digest enforced), lineage folds to one ledgered request; two independent charges on one lineage ⇒ unresolved unknown (14.13.4a). C9-M7 queue matching mixed receipt-only / act-only / both rules and actId was only per-channel-episode unique (two streams minting `actId:A` → an act dropped) → ONE composite rule everywhere: matched iff `queueReceiptId` AND `(channelId, actId)` both equal; `channelId` minted once per channel via a durable `channel-open` record; conformance tests for both collision cases (14.12.2 step 5). C9-M8 coverage over an EMPTY callUniverse (crash before any `intent-open`) was vacuously true → a zero-call dispatch is covered ONLY by a `zero-call-closure` record with complete provider listing or fence coverage; empty universe + no closure ⇒ coverage FALSE (14.13.4a). C9-M9 one evidence record conflated "no call occurred" with "terminality unobtainable", admitting an HTTP 500 as proof → the two are SEPARATED with a CLOSED admissible-class list (documented not-supported code / doc citation / sustained-unreachability retry series — the last ONLY for the residual-cap route with explicit owner acknowledgment + required cap); timeouts/generic 5xx/empty local queries are never proof; unreachable ≠ non-support named as an interval that cannot converge except by owner acceptance (14.13.4a). C9-M10 the v10 ledger row described the CANONICAL-domain parse rule ("finer ⇒ refused, NEVER rounded") as the PROVIDER-INGEST rule while the body rounds half-away-from-zero at ingest → TWO NAMED DOMAINS stated once (canonical records: six-digit exact, finer refused, never rounded — the ledger's rule; provider-native: converted ONCE with recorded policy — the body's rule), exact-decimal parsing pinned (no binary-float intermediate), conversion basis is a digest-bound DECIMAL STRING, negative amounts/credits rules closed (14.12.3); the v10 row's "RFC-decimal strings" wording meant decimal TOKENS (JSON number literals matching the pinned regex — strings are not accepted amounts) and is clarified here, body normative. C9-M11 the durable group "draft" had no schema/fsync order/timestamp freeze, so byte-identical re-emission was unimplementable → the `group-plan` record (frozen member line digests incl. ts, consumption-bound) is appended BEFORE the group write, recovery RE-EMITS the plan record's bytes (never reconstructs), unplanned groups fail closed, divergent plans are never retried (14.11.2). C9-M12 archive checks (1)–(3) proved recorded identity, not usable closure (a bundle missing a nested blob passed) → check (4) is FULL RECURSIVE REACHABILITY in an isolated clone of the bundle alone (every commit/tree/blob/gitlink edge, zero missing, bounded walk), replay re-runs (1)–(4) + bounds, root/merge parent cases explicit, retention lane named as its providing layer (14.14.4). C9-M13 the deferral "terminal outcome by its own window" paragraph conflicted with successor-duty-moves, cap exits had two vocabularies, and reset counter semantics were dual-named → ONE lifecycle (drain produces terminal OR successor; deadline binds to chain TAIL; predecessors may close unclean with notes; no-outcome blocks finalize; terminal receipts never gain successors), the §14.10.3 op vocabulary is THE exits, reset retains the ORIGINAL receipt and starts a new chain head with `resetOfLoopId`, ONE laundering cap `maxConfirmingCycles + 1` counting records since the last reset head (14.14.5). C9-M14 the quiesce-stall conversion clock had no durable origin (restart reset the wait; two implementations both compliant) → `finalization-wait-anchor` record (conditionId, anchorTs, bootId) appended at first B observation, elapsed measured from the anchor across restarts, drains-evaluated-before-thresholds ordering pinned, stall records must cite their anchor, clock-jump absurdity is a `clock-domain` history-integrity-fault (new faultKind, tuple `(faultKind, affectedRecordId=anchor)`) (14.12.2, 14.12.3). C9-M15 route-(b) acceptance for plain intermediate commits had no producer (the advertised ancestor route was unavailable in the counterexample) → producer availability stated: acceptance binds only artifacts actually submitted; absence is NOT a defect — reuse refuses to EXACT-CANDIDATE execution (safe by default), "complete" over an empty/foreign-sha criterion set never qualifies (14.12.2 r4). C9-M16 the v10 ledger row claimed identity tuples containing an evidenceRefs-set-hash and "lowest reported anchor" first-detection — both contradicting the body → corrected HERE: tuples are (faultKind, boundaryId\|affectedRecordId) per kind (digests/evidenceRefs NEVER identity), first-detection = the first-APPENDED fault record's `detectionAnchorId`, permanent, no retro-amendment (body normative; ledger wording corrected) (14.12.3). MINOR c9-m17: cached `finalizationTailMs` needed replay enforcement → the boundary's tail is ALWAYS recomputed and validated (same boot ids, `monoMsAtBoundary ≥ monoMsAtClose`, exact delta equality) with mismatch ⇒ tail UNKNOWN + counter-divergence fault; charged total pinned to admit-to-close + tail, once (14.12.4, 14.13.4a). Envelope inventory gains the v11 kinds (`finalization-wait-anchor`, `channel-open`, `zero-call-closure`, `group-plan`) and the `evidence-invalidation` both-kinds amendment. DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v11, terra c9 folded) |
| 2026-11-18 | §14.11–§14.15 (v9→v10) | **TERRA AUDIT ARC cycle 8 (auditor gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c8-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 11 MAJOR + 1 MINOR on draft v9; all fixed into v10.** C8-B1 owner-act consumption acked before its effects were durable → **effect binding**: every `owner-act` record carries `effectRecordIds[]` (possibly empty), consumption is complete only when every named effect record is fsynced in the log, recovery re-derives acts whose effects are missing and re-applies them (idempotently), and a queued act with an empty effect set is explicitly attested as observation-only (14.10.3). C8-B2 the A/B/O finalization classes plus the queue-drain precedence had an undefined corner (what when a class-B condition and a class-O condition coexist at one boundary) → precedence pinned **mechanically and totally**: O dominates for verdict (boundary exists, UNCLEAN, needs-owner), B dominates for append-blocking during the same critical section until it converts or clears; no condition may hold both; recovery consults the table in fixed evaluation order (14.12.2). C8-B3 remote-disposition closure allowed "the supervisor asked the provider and got nothing" as no-call evidence → a **durable fence**: absence of any observed request for an intent closes ONLY via `provider-inability-evidence` (verbatim provider response or provider-evidenced non-support, captured at query time, per-`dispatchId`), never via operator memory or an empty local query (14.13.4a). C8-B4 the residual-cap accounting had two paths (per-round recount vs cumulative count) that drift on re-admit → **ONE state machine**: residuals are counted once at boundary commit, re-admission reuses the stored count unless a re-resolution event (`residual-cure` op, owner-gated) mutates it; recounting the log is forbidden (14.13.4a). C8-M5 `residual-cure` had no owner-act schema and CLI display re-serialized payloads → `residual-cure` joins the closed op enum with a per-op payload; CLI display binds to the canonical payload BYTES, never a re-serialization (14.10.3). C8-M6 the usage fold pipeline order was prose → per-stream PIPELINE pinned (parse → sequence-domain placement → gap scan → cumulative reconciliation → sum), LATE null-seq statement rule pinned (a null-seq statement arriving after a gap on its stream lands UNKNOWN-side), gap resolution defined (provider-statement reconciliation closes a gap ONLY forward, never retroactive restatement), conformance vectors corrected to the precedence rule (14.13.4a). C8-M7 queue handoff lacked act-level identity → every act carries a channel-assigned `actId` (unique per channel stream); ack/dedup keys are `(queueReceiptId, actId)`; the full crash matrix (pre-fsync / post-fsync-pre-log / post-log-pre-ack) is closed and recovery dedups by actId (14.12.2 step 5). C8-M8 the coverage set had two derivations (disposition-time vs fold-time) that could disagree → ONE derivation function over the complete per-stream request set, consumed identically by fold and disposition; `provider-inability-evidence` record shape pinned (producer, capture rules, freshness) (14.13.4a). C8-M9 money domain vectors contradicted the parser (trailing-zero/precision rules disagreed between prose and vectors) → parser accepts RFC-decimal strings under ONE normalization (strip trailing zeros; six fractional digits max; more ⇒ refused at ingest, never rounded), conversion units pinned for every `*Usd` field, the "integer micro-cent" spelling is WITHDRAWN (1e-6 domain, micro-cent 1e-8 is a 100× split), serialization canonical = stripped form (14.13.4a). C8-M10 the history-integrity-fault identity tuple was ambiguous across cycles and the first-detection position undefined → identity tuple PINNED (`(faultKind, boundaryId\|null, affectedRecordId\|null, evidenceRefs-set-hash)` — one tuple per kind, members are durable record IDs), `detectionAnchorId` REQUIRED naming the anchor record, first-detection position defined as the lowest replay position any detector reports, two independent detectors reporting the same tuple ⇒ ONE record (14.12.3). C8-M11 the boundary elapsed tail could be computed across a boot discontinuity → `cycle-boundary` gains `bootIdAtBoundary`, `bootIdAtClosed`, `monoMsAtBoundary`, `finalizationTailMs`: tail computed ONLY when bootIds match, else null (fail-closed, reported unknown), monotonic domain pinned per boot (14.13.4a). C8-M12 the ancestor-qualification rule cited a nonexistent `verdict:"passed"` → qualification consumes the ACTUAL acceptance enum (`complete` — vocabulary corrected), binds `checkedAtSha` (evidence qualifies only the sha it was computed against), and an `evidence-invalidation` record (durable, owner-act-sourced, target+reason) removes qualification from replay onward (14.12.2 r4). C8-M13 the group crash window left ids ambiguous between draft and commit → the DRAFT IS the durable source: member ids are assigned at draft time, recovery re-emits the byte-identical plan from the draft, cross-restart dedup is by `groupId`, same-`groupId`-different-bytes ⇒ fail closed `needs-owner` (14.11.2). C8-M14 the deferral active-window rule let obligations move backward through the chain → obligations NEVER move backward; early terminal outcome on a non-tail deferral is legal; laundering counter `maxDeferralLaundering` counts chain records since the last OWNER-granted window reset (`reset-chain-with-new-window` owner-act op is the sole reset — supervisor-side laundering never resets), cap hit appends `deferral-loop` (sole trigger of the state) (14.14.5). C8-M15 intent-phase transitions were ambiguously inventoried "under `dispatch-intent`" while `dispatch-intent` is a per-DISPATCH pre-call record → **`intent-phase` is its own S5 envelope kind** (own inventory entry; discriminated schema with `outcome`, canonical `callId`, uniqueness domain in 14.13.4a); `idempotencyKey` placement rule pinned: non-null ONLY on `call-started` (14.12.4b, 14.13.4a). MINOR c8-m16: the `task-tip-archived` artifact contract was "e.g. a git bundle" + a blob digest that proves bytes, not closure → ONE accepted format (prerequisite-free v3 git bundle), closure enumeration AND verification BEFORE the record appends (header/prereq check, recorded-identity presence, parent closure, `maxArchiveBytes`/`maxArchiveObjects` bounds), record fields pinned (`tipSha`, `objectCount`, `verifiedAt`), publication-before-prune order closed (ref deleted only after durable record + sha256 re-verify; crash windows leave ref-kept or GC-eligible orphan), replay re-runs closure checks and ANY failure ⇒ `task-tip-lost` fail-closed (14.14.4). Envelope inventory extended with the v10 kinds (`provider-inability-evidence`, `evidence-invalidation`, `deferral-loop`, `intent-phase`); `deferral-loop-disposition` is an owner-act op, not a kind. DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v10, terra c8 folded) |
| 2026-11-17 | §14.11–§14.15 (v8→v9) | **TERRA AUDIT ARC cycle 7 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c7-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 9 MAJOR + 1 MINOR on draft v8; all fixed into v9.** C7-B1 the owner-act closed schemas omitted the ratify/reject/supersede ops the norm lifecycle REQUIRES acts for → the op enum now covers every owner-gated transition with a closed per-op payload (explicit nulls), the enumeration is closed (a kind without a schema cannot receive acts), CLI display binds to the canonical payload bytes, and `unprovenId` has ONE normative source (14.10.3). C7-B2 the usage fold still had undefined domains (null statementSeq ordering across providers, gap detection without sequence domains) → sequence domain is PER-PROVIDER-STREAM `(providerAccountId, dispatchId)`; dense-sequence gap detection per stream; null-cumulative semantics pinned (second null cumulative on a stream ⇒ component UNRESOLVED UNKNOWN); UNRESOLVED UNKNOWN is the SOLE failure mode of the fold — every partial rule now terminates in it, never a stale value (14.13.4a). C7-B3 the queue-handoff drain wasn't linearized (two drains, receipt dedup scope) → drain is single-owner under the S5 flock, one FIFO pass per critical section, queueReceiptId dedup is episode-global, and the boundary commits over the drained prefix only (14.12.2 step 5). C7-B4 remote-terminal-disposition covered requests but not the disposition's own coverage proof → evidence-provided set-equality now quantifies over the COMPLETE request set per stream incl. intents with no observed request (proven-not-issued closes them); a disposition over a partial set is refused; accept-residual-risk requires per-dispatchId provider-cannot-evidence proof (14.13.4a). C7-M5 intent phases lacked per-call identity → `callId` per provider call, first phase MUST be `intent-open`, phases strictly ordered once per callId, crash windows settled by durable attestation rules (14.13.4a). C7-M6 money domain was prose-only → canonical money domain pinned: USD micro (10^-6) integer cents everywhere, provider statements converted once at ingest with rounding policy recorded, sums are int64-exact, overflow past 2^53 ⇒ component UNRESOLVED UNKNOWN (14.13.4a). C7-M7 residual-inherited blocked later rounds' cleanliness with no re-resolution ROUTE → the route is defined: a residual re-resolves when a green repro-run (or owner disposition) closes the SURVIVING finding whose chain recorded the residual; re-check per boundary; re-resolution clears the clause forward, never retroactively (14.12.2). C7-M8 history-integrity-fault records lacked fields and the verdict consumed cached values → fault record fields pinned (faultKind incl. `policy-digest-mismatch`, evidenceRefs, first-detection position, one record per fault instance); verify-then-copy: every verdict input is RECOMPUTED from the prefix, a cache mismatch is itself a fault; disposition schema per faultKind (14.12.3). C7-M9 `closed.ts` as elapsed endpoint conflicted with finalization time → elapsed interval split: `closed.ts − admit.ts` is the NORMATIVE cycle elapsed; reconciliation/finalization tail is `finalizationTailMs` (monoMsAtBoundary − monoMsAtClose, boot-continuity required — gap ⇒ unknown fail-closed), reported separately, summed only in explicit wallclock accounting (14.13.4a). C7-M10 deferral "exactly one per submission" collided with legitimate re-deferral → deferrals form a LINEAR CHAIN per submission (first `deferralOf:null`, successors cite predecessor; branch/cycle/cross-submission citation refused at append); ACTIVE window = chain tail's; terminal outcome binds to the tail; clean predicate consumes derived receipt state, laundering bound counts chain records (14.14.5). C7-M11 "durable gate evidence" for intervening commits admitted incomplete verdicts and unrelated records → QUALIFYING evidence defined: green repro-run bound to that sha, or acceptance `verdict:"passed"` bound to that sha, with episode/task lineage, not invalidated; traversal bounds `maxAncestryWalkCommits`/`Bytes` — exceed ⇒ unproven ⇒ refused (14.12.2 r4). C7-M12 group framing had TWO identifiers (`groupId` vs legacy `atomicGroupId`) → ONE identifier `group.groupId` (legacy field name outside `group{}` is malformed framing); writer builds the whole group in memory, one write(), retry-or-abort on short write; memberCount ∈ [2,64], index bounds, groupId uniqueness + content-binding, crash windows closed (visibility vs ack distinct, groupId dedup on recovery) (14.11.2). C7-M13 "MUST NOT append" vs "unclean boundary remains appendable" gave incompatible outcomes → ONE finalization DECISION TABLE with classes A (met) / B (drain-progressing: blocks append, converts to O past `quiesceWaitMaxMs` via durable `quiesce-stall`) / O (owner-only: appends UNCLEAN, never blocks the log) — every examined condition assigned to exactly one class with boundary-existence + cleanliness + verdict effects; deferred receipts are O, owed filings are B; recovery and budget accounting consult the table only (14.12.2). MINOR c7-m14: envelope inventory completed (`history-integrity-fault`, `task-tip-archived`, intent phase-transitions under `dispatch-intent`, queue receipts documented as queue-file-only records with log standing via drained `owner-act`); `providerAccountId` REQUIRED on every fold statement; `taskTipTree` = the SINGLE commit-tree sha (the v8 `objectIds[]` spelling withdrawn); task-tip retention domain = through the last replay that depends on the gate, with the `task-tip-archived` bundle migration path; `task-tip-lost` stays fail-closed (14.12.4b, 14.14.4). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v9, terra c7 folded) |
| 2026-11-17 | §14.11–§14.15 (v7→v8) | **TERRA AUDIT ARC cycle 6 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c6-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 9 MAJOR + 1 MINOR on draft v7; all fixed into v8.** C6-B1 the pending-act queue could converge past a queued hold / strand a cure → queue-admission HANDOFF STATE MACHINE under the SAME S5 flock as the log (engage → drain FIFO INTO the current critical section with queue-receipt-id dedup → quiesce+boundary in one critical section; queued cures apply to the CURRENT cycle; queue = transport buffer, authority = drained owner-act records; lost queue file fails closed to needs-owner citing channel ack receipts) (14.12.2 step 5). C6-B2 ancestor repro reuse didn't implement the claimed closure → ancestor reuse requires (i) A proven RECORDED ANCESTOR of C by walking ALL parents (incl. merge parents) over fully-present objects — shallow/graft/missing ⇒ unproven ⇒ refused; (ii) EVERY commit in C∖A carries its own durable gate/acceptance evidence; then (iii) the v7 trace conditions — checked in that order, any failure ⇒ exact-candidate execution (14.12.2 r4). C6-B3 deferral broke the receipt outcome invariant → `submission-deferral` is a NONTERMINAL state in a defined receipt lifecycle (`open → deferred → filed XOR refused`), refusal classes apply unchanged in the deferral's window, deferred receipts are owed work of windowOf.cycle AND no boundary closes CLEAN with any receipt deferred, laundering rule moved into body text (14.14.5). C6-B4 the usage fold was not a total function → per-provider billing-stream identity `(providerAccountId, dispatchId)`; correction graph ≤1 correction per target, contradiction/unanchored-delta/held-correction/collision ⇒ component UNRESOLVED UNKNOWN (consumes headroom, blocks clean — "refused malformed" never leaves a stale value); cumulative-inclusion stated; streams starting with deltas need a baseline marker; sort (statementSeq asc, providerStatementId), null-seq sequenced last among themselves, second null-seq cumulative ⇒ unknown (14.13.4a). Majors: C6-M5 history-integrity-fault unified — ONE entry/disposition/exit paragraph (fault record kinds incl. fenceless-boundary + duplicate-fence matching rules; gates: unclean+needs-owner forward, dispatch not blocked, verdicts from RECOMPUTED values never a bad cache; per-fault owner dispositions, episode clears only with zero undispositioned faults, faulted boundaries marked never rewritten) (14.12.3, referenced from 14.12.2/14.14.4); C6-M6 remote-terminal-disposition vocabulary PINNED to `accept-residual-risk | evidence-provided` (ledger shorthand retired), evidence-provided requires fresh per-dispatchId terminal evidence covering the COMPLETE request set (partial ⇒ refused), accept-residual-risk never claims terminality, unknown spend stays blocked until spend-reconciliation, requires provider-cannot-evidence proof (14.13.4a); C6-M7 owner-act payloads = CLOSED per-op schemas (explicit nulls; kinds without a schema cannot receive acts) + supervisor INDEPENDENTLY reconstructs and verifies the canonical bytes (CLI digest is a claim) + same compromised-supervisor/same-user limits retained (14.10.3); C6-M8 group framing fields `group:{groupId,memberIndex,memberCount}` — one-pass completeness from the lines themselves, short-write counterexample closed, visibility vs fsync-durability as separate axes (14.11.2); C6-M9 canonicalizer renamed `tre-canonical-json/1` (ONE for the contract) with full value domain: NFC before dup-key detection, integers only −2^53..2^53 no exponents, byte-order key sort, escaping rules, 1 MiB cap, shipped conformance vectors, intake stores canonical bytes / replay verifies stored bytes (14.12.3); C6-M10 intent lifecycle phases `intent-open → call-started → call-settled{issued|no-call|proven-not-issued}` with durable negative attestation, uncertain-call recovery via provider evidence or intent-time idempotency keys, observed-but-unledgered requests reconciled not ignored, retention rule for intent/request evidence (14.13.4a); C6-M11 `usage-recovered` gains `statementSeq`/`correctionOf` (it is a fold statement) (14.12.4b); C6-M12 elapsed interval end = `closed.ts` for EVERY cycle (covers reconciliation/finalization time), boot-continuity via monoMsAtClose + boot identity, gap without continuity ⇒ unknown fail-closed (14.13.4a); C6-M13 chain-member derived states WIRED into cleanliness: open counts at survivor severity; `residual-inherited` is not open but makes its OWN round unclean (named clause of the clean predicate); a later round clean only if the residual is re-resolved; discharged imposes nothing (14.12.2). MINOR c6-m14: gate record carries the full taskTip identity payload (tip+tree+complete ordered parents in the LOG) + OBJECT-RETENTION obligation via per-episode ref; unreadable T ⇒ `task-tip-lost` actionable refusal, never a pass (14.14.4). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v8, terra c6 folded) |
| 2026-11-17 | §14.11–§14.15 (v6→v7) | **TERRA AUDIT ARC cycle 5 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c5-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 9 MAJOR + 1 MINOR on draft v6; all fixed into v7.** C5-B1 the all-actor fence could converge past a durably queued owner hold → owner acts linearized through a DURABLE pending-act queue (append before apply; quiesce requires an EMPTY queue; nonempty queue blocks clean closure), fence engagement durable via `fence-engaged` (crash between engage and boundary re-derives the fence; a boundary line with no fence-engaged is history-fault) (14.12.2 step 5). C5-B2 repro-path tree equality on an ancestor did not prove the accepted fix was tested → ancestor reuse permitted ONLY under a proven-complete dependency closure: every ancestor between the repro artifact and the accepted candidate carries its own recorded repro/gate evidence, else the repro must execute the candidate artifact itself (14.12.2 r4). C5-B3 `remote-terminal-unproven` had no resolution path (budget-extension is a spend act, not a terminality proof) → typed owner `remote-terminal-disposition` act (`evidence-closed` requires fresh provider terminal evidence per the set-equality rule / `accept-open-risk` waives terminality while interval accounting stays unknown — needs-owner until then, never silently clean) (14.13.4a, 14.14.4). C5-B4 task-commit identity check "parent == gated tip" rejected the ordinary gated merge tip → merge-tree consumes the recorded taskTip `T` itself (object id + tree + recorded parents re-read from the object store); the parent relation claim is dropped from verification, identity is `T`'s content address (14.14.4). Majors: C5-M5 policy canonicalization pinned — `tre-policy-json/1` v7 rules (RFC 8785-style key sort, shortest-form integers, no duplicate keys, UTF-8 NFC, revision stores content-addressed bytes + canonicalizer version; replay without the stored bytes refused, never re-canonicalized from a display form) (14.12.3); C5-M6 group visibility — "file length stabilizing" heuristic WITHDRAWN, visibility is decidable in ONE pass from group framing (group seq + terminal count), snapshots discard incomplete groups by framing, not by waiting (14.11.2); C5-M7 next-window deferral unbound to eventual filing → durable `submission-deferral` record (supervisor-authored, one per deferred submission, same critical section as the receipt; filing must cite it; owed-work counts against quiesce; laundering rule: a deferred submission may not be re-receipted into a later window without a new deferral) (14.14.5); C5-M8 late usage had no deterministic correction order → provider statements carry monotonic `statementSeq` + `correctionOf`; fold orders by (statementSeq, providerStatementId), corrections replay deterministically, out-of-order/gapped statements fail closed to unknown (14.13.4a); C5-M9 zero-dispatch closure vacuous → `dispatch-intent` durable record BEFORE any provider call (session id minted at intent time), close proves set-equality against a complete provider session query, provider calls with no intent are contract violations, incomplete query proves nothing (interval stays OPEN), empty set proven by gap-free intent stream (14.13.4a); C5-M10 envelope table internally inconsistent → full S5 envelope incl. `schema`, all v7 kinds enumerated with producers, `mode` specified on usage-recovered, examples relabeled illustrative pseudocode (normative shape = prose field lists + named schemas; "each object parses alone" withdrawn) (14.12.4b); plus c5-M2 (trust boundary + owner-act payload canonicalization/consumption — landed as c5-M1 numbering) and c5-M11 escape-obligation states + waiver + unclean-close + committed-boundary divergence = permanent `history-integrity-fault`, never retroactive refusal (14.12.2/14.12.3/14.14.4). MINOR: envelope/example consistency (folded with c5-M10). Needs-owner row extended (unproven without disposition, nonempty pending queue, history-integrity-fault). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v7, terra c5 folded) |
| 2026-11-17 | §14.11–§14.15 (v5→v6) | **TERRA AUDIT ARC cycle 4 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c4-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 12 MAJOR + 1 MINOR on draft v5; all fixed into v6.** C4-B1 finalization fenced only intake, not owner acts/external obligations → fence ALL actors between quiesce and verdict (queued TTY holds durably registered, applied next window) + fail-closed external-obligation close gate (holds, escapes, unfilled mandates, unconsumed authorizations) (14.12.2). C4-B2 mandated supervisor filing broke the one-receipt-one-outcome invariant → disjoint origins (`originRef` intake XOR supervisor-derived; refusal names derivedFindingId) + stable source-assigned submissionId with dedup before receipt allocation (14.12.4). C4-B3 unresolved scope escape vanished at later boundaries → escapes are EPISODE-GLOBAL needs-owner until a validated scope-escape-resolution record (fields + matching validation defined); own-round stays unclean forever (14.14.4, verdict table). C4-B4 green repro on an unrelated tree could back accepted-fix → artifact binding: executedArtifactDigest == the accepted candidate's sha or ancestor with reproPaths trees provably equal; repro digest = canonical bytes over the repro object only; kind:"none" has no digest (14.12.2 r4). Majors: candidate vs task-commit separated — CAS/gate bind merge-tree OUTPUT, task commit identity verified pre-merge; scopeDigest input excludes the digest field itself (`tre-scope-digest/1`) (14.14.4/.5); numbered intake procedure + O-G2-6 rewritten to the dispatch-only freshness policy, closed refusal vocabulary (14.11.4); chain closure = survivor-disposition × obligation state table incl. cycles→malformed and frozen-per-prefix re-evaluation; digest bytes = canonical repro-object only + falsifiability required (14.12.2 r4); elapsed zero-dispatch endpoint = the `closed` record ts + bounded escalation to durable `remote-terminal-unproven` (fail-closed, cadence never proves terminality) (14.13.4a); late-usage identity (dispatchId, providerRequestRef, providerStatementId) + idempotent dedup + cumulative/delta modes + projection formula (replace-once-then-sum) (14.13.4a); policy-revision stores immutable content-addressed policyRef bytes + canonicalizer version + strictly increasing revisions; counter recurrence is a prefix-only algorithm with post-boundary invalid events frozen per prefix (14.12.3); enforced provenance boundary — S5 0600, privileged appends only via supervisor entrypoints/TTY CLI, durable `owner-act` records bound to op+payloadDigest, authority strings are never proof (14.10.3); torn-group claim is a reader PROTOCOL — readers buffer until group framing completes, snapshots discard half-groups, bytes ≠ logical records (14.11.2); membership = durable filing not receipt, windowOf fully specified (supervisor-authored field), deferral moves work never obligations (14.14.5); retained-set scope function — any unscoped retained member ⇒ `["*"]` ∩ authority, re-run after drops (14.14.5); invalid submissions: three refusal classes (transport / parse-or-schema on raw blob without schema replay / policy) with receipts capturing raw bytes bounded at 256 KiB (14.12.4). MINOR: 14.12.4b replaced with ONE authoritative sequence incl. close ordering + full fence, and introduced-record envelope/producer table (usage-recovered, elapsed-recovered, remote-terminal-unproven, owner-act, boot identity, jsonc fragment semantics). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v6, terra c4 folded) |
| 2026-11-17 | §14.11–§14.15 (v4→v5) | **TERRA AUDIT ARC cycle 3 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c3-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 12 MAJOR + 1 MINOR on draft v4; all fixed into v5.** C3-B1 v4's "boundary n+1 catches it" is FALSE for the final boundary (queued holder lands after the converged boundary, never examined) → drain-and-fence finalization: intake fenced to the cycle's sessions (`windowOf`), owed filings drained, quiesce check atomic with the boundary append, post-finalization acts open a NEW cycle, never a re-clean (14.12.2 freeze). C3-B2 elapsed end included the boundary's own ts while the boundary consumed `closed` (circular) → endpoints = admit..max(last terminal dispatch, last usage KNOWN AT CLOSE); commit order dispatch-terminal → closed → boundary → verdict; late usage is billing evidence, not interval extension (14.13.4a). C3-B3 partition prose said manifest-close, record said boundary, and manifest-close excludes the cycle's own late auditor filings (a 2-cycle budget could exhaust without dispatching a filed finding) → membership = log prefix at the partition's own append position (`computedOverRecordId`), same-critical-section append, next-wave assignment explicit (14.14.5). C3-B4 completion-side `received` counts proved nothing → supervisor-authored `submission-receipt` records appended BEFORE ack carrying the exact source bytes; findings/refusals reference exactly one receiptId; receipt-ledger set-equality at the boundary (14.12.4). Majors: torn-group tail fence (truncate never-visible torn bytes under the writer lock BEFORE the next append; mid-log half ⇒ malformed, 14.11.2); refusal replay binds the RAW source bytes content-addressed + pinned intakeSchemaVersion + derived-id namespace for filings (14.11.4); ONE pin policy — freshness at dispatch only, intake checks against the dispatch record's frozen pin set, never head state (14.11.2/4); chain survivor legitimately fixed via valid repro-run DISCHARGES its chain (only abnormal closure is unclean) + duplicate equivalence = reproDigest equality or owner act (14.12.2 r4); `repro-run` record kind fully specified (findingId/reproDigest/executedArtifactDigest/runner/result), supervisor-authored, required for EVERY accepted-fix; late usage: verdicts never rewritten, additive to the next boundary's recurrence, measured beats accepted in BOTH directions via supersedes-correction (14.13.4a); reconciliation target hierarchy — leaf components only, cycle-target = overhead only, no double-resolution, localRecovery for elapsed; provider-request terminality required at close (session-bounded usage/cancel/billing-cutoff; process death alone insufficient); policy-revision records (owner-authorized, digest) + boundary echoes policyDigest AND checkable counters, recomputed by recurrence, divergence refused (14.12.3/4); `dispatch-authorization` record — retained members only, dropped paths NOT authorized, consumed by gate+verdict (14.14.5); candidate-substitution refusal — parent/tree sha verification before merge-tree, scopeDigest bound to the authorization record (14.14.4); scope-escape durable event + resolution record wired into the verdict table (14.12.3/14.14.4). MINOR: §14.13.5 extension summary includes maxWallclockS. DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v5, terra c3 folded) |
| 2026-11-17 | §14.11–§14.15 (v3→v4) | **TERRA AUDIT ARC cycle 2 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c2-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 12 MAJOR + 1 MINOR on draft v3 (all C1 verifications INCOMPLETE); all fixed into v4.** C2-B1 cutoff selection raced concurrent appends (a pre-boundary hold/finding excluded from the prefix) → boundary membership is LOG POSITION under the S5 single-writer lock; no cutoffRecordId to race; waiting appends land after the boundary and are caught by rule 3 at n+1 (14.12.2/4b). C2-B2 intake-refusal couldn't reconstruct the filing (hash ≠ payload) and pending refusal was absent from the verdict table → refusal carries the full validated source payload, digest-checked on replay, idempotent derived filing id; pending refusal listed as needs-owner (14.11.4, 14.12.3). C2-B3 the scope gate compared the merge candidate without defining the per-task delta (false refusal AND concealment) → mandatory base-to-task-tip tree delta pre-integration, both rename endpoints/modes/gitlinks, tip+base+scope bound into the P12 CAS request (14.14.4). C2-B4 partition was defined at the round-end boundary it must precede → partition is the WAVE-START event appended before first dispatch (computed over the previous manifest-close); explicit per-cycle event ordering admit→partition→dispatches→manifest→completions→boundary→verdict (14.12.4b r5, 14.14.5). Majors: auditor identity = supervisor-minted assignmentId + per-(assignment,attempt) state machine + submissionAccounting closing intake receipts (C2-M1/M16); chains preserve obligations globally — no major→minor downgrade, same-route survivor, reproRunRef required for accepted-fix, refused for repro.kind:none (C2-M6/M7); pin freshness validated at EVERY dispatch under transition serialization (C2-M8); successor lifecycle — predecessor current until successor ratifies, atomic supersede pair, current-norm selection defined, `anchorTextRef` example fixed to content-addressed path (C2-M9); snapshot GC honors reservation window under the same lock, exclusive-create publication (C2-M10); counters are checkable caches recomputed by pure recurrence over boundary lines carrying policyRevision (C2-M11); converged doesn't require admitting a needless next cycle; exhaustion bites only when another cycle is required (C2-M12); parked ≠ stopped-spend — per-identity liveness proof + usage reconciliation before close, late-arriving usage reopens (C2-M13); reconciliation targets exactly one unresolved component, provider-recovery evidence REQUIRED, known spend is a floor, one-time resolution (C2-M14); wallclock endpoints incl. zero-dispatch cycles + newMaxWallclockS extension (C2-M15); dispatch-time revalidation of member dispositions + effective scope = partition ∩ §14.7 authority (C2-M14b). MINOR: stale vocabulary fixed in place (severity escalation → finding-hold; missing pin = norm-unpinned not stale-norm; hold record §14.12.4 ref; O-G2 enumeration in 14.15). DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v4, terra c2 folded) |
| 2026-11-17 | §14.11–§14.15 (v2→v3) | **TERRA AUDIT ARC cycle 1 (gpt-6.1-terra, detached one-shot, `~/.tre/audits/g2g5-c1-terra-*`): CHANGES REQUESTED — 4 BLOCKER + 12 MAJOR on draft v2; all fixed into v3.** C1-F1 open old-cycle blocker vanished from a later round's verdict (round-local check) → GLOBAL open-sign-off-holder check at boundary (14.12.2 rule 3). C1-F2 the boundary freeze was simultaneously authority and prohibited recovery input → `cycle-boundary` cutoff record IS the freeze/commit point; verdicts re-derive deterministically from the prefix (14.12.2/4b). C1-F3 auditor assignment/completion violated append-only (update-in-place) and had no complete-assignment evidence → manifest(close)/completion/retry EVENT kinds, malformed combinations fail closed (14.12.4). C1-F4 same-locant successor norm could impersonate the pinned predecessor at intake → pin-FIRST resolution, locants owner-facing only (14.11.4, O-G2-6). C1-F5 git conflict-on-merge cannot see non-overlapping same-file scope escapes → claim withdrawn, MANDATORY rename-aware diff⊆scope + base-equality gate at P12, escape ⇒ unclean cycle (14.14.4). C1-F6 'immutable' orphan snapshot could be overwritten with different bytes + missing dir-fsync → content-addressed snapshots, digest verified pre-commit, mismatch fail-closed (14.11.3, O-G2-7). C1-F7 rung-4 rewrite invalidated regenerated pins silently → pins bind taskRevision+prompt digest; rewrite⇒regen-or-refuse `prompt-drift`. C1-F8 reconciliation could close a still-spending cycle; wallclock unknown unresolvable → terminal-dispatch-only close, elapsed endpoints, fail-closed (14.13.4a). C1-F9 owner reconciliation reused budget-extension shape → distinct `spend-reconciliation` record with validated fields (14.13.4a). C1-F10 retries had no shape and could burn cycles without admission → retry events inside the admitted cycle, one admit per cycle number (14.13.4). C1-F11 streak/confirming counters unreproducible across exhaustion/extension → persisted streakAfter/confirmingUsed, reset rules pinned (14.12.3). C1-F12 owner minor-escalation unrepresentable → `finding-hold`/`finding-hold-lift` owner records, hold counts as sign-off holder (14.12.2 rule 5, 14.12.4). C1-F13 opinion findings closable via rejected-duplicate chains → orchestrator may not duplicate/supersede opinion blockers; chain validation (rule 4). C1-F14 refusal→filing crash window + prose `A: ratify <rev>` → intake-refusal commit + deterministic filing derivation; typed P13 request/answer payloads with normId+revision CAS (14.11.4). C1-F15 partition recompute disagreed across mid-wave closures; anchor-in-union undefined → partition SNAPSHOT record at cutoff, canonical anchor-stripped unions, unscoped=explicit whole-repo (14.14.4/5). C1-F16 state/result vocabulary clash → single completion-state table. DECISIONS-REQUIRED: 0 | G2–G5 contract (draft v3, terra c1 folded) |
| 2026-11-17 | §14.11–§14.15 (v1) | **Round-0 adversarial audit of the G2–G5 draft (same-session, read-only): 6 BLOCKER + 4 MAJOR, all fixed into v2 the same day.** B1 a crashed/zero-report auditor could count clean → durable per-auditor `auditor-round` records, incomplete/missing/stale-target = unclean (14.12.2 rule 1). B2 later dispositions could retro-clean a round → cleanliness frozen at the boundary into `convergence-verdict` (rule 3). B3 unknown implementer family "computed without exclusion" could false-pass diversity → disqualifying + `needs-owner` (rule 2). B4 ratify commit point not reconstructible → `norm-created` identity record + immutable anchor-text snapshot named by the transition; `norms.json` demoted to rebuildable projection (14.11.2–3). B5 null-digest findings dodged the stale check → supervisor stamps normId+digest from the dispatch pin, no pin ⇒ `stale-norm` (14.11.4, O-G2-5). B6 "S3 mechanically enforces disjointness" was false (S3 says advisory) → disjointness by construction (one group per path), P6 worktree + P12 conflict refusal as backstop, anchor-parallelism on one file removed (14.14.2/4). M7 unknown spend counted at estimate contradicted count-at-cap → single fail-closed rule: unknown consumes ALL headroom until reconciliation/owner act (14.13.2/4a, O-G4-4). M8 recovery spend escaped the cycle cap → cycle projection counts all spend the cycle dispatched (14.13.3, O-G4-3). M9 G2 stale reroute violated G1 route-immutability → G2 is an intake gate; refusals are S5 decision records, owner matters are supervisor-filed records (14.10.1 note, 14.11.4). M10 `needs-owner` masking terminal `budget-exhausted` → precedence fixed: exhausted > needs-owner > converged (14.12.3). Plus: §14.15's strict section-separability qualified for shared-interface dependency review. §14.10 → v4 | G2–G5 contract (draft v2) |
| 2026-11-17 | §14.10.1, §14.11–§14.15 | **G2–G5 drafted in one pass (DRAFT v1, batched, separable sections).** §14.11 G2 norm state (`norms.json` states drafted/ratified/rejected/superseded; sha256 mandatory at ratified — closes the R6 deferral; `norm-transition` CAS records with TTY-owner authority; atomic ratify→regenerate with the ratify record as commit point). §14.12 G3 convergence as a pure verdict over §14.10 records (declared family table, k consecutive clean rounds, `needs-owner` outranks `converged`; owns R8 opinion enforcement). §14.13 G4 design-cycle budget (cycle-boundary admission, separate from §14.7 recovery counters, owner-only extension). §14.14 G5 partitioning (connected components over path-overlap/shared-norm; unscoped collapses to serial; amends §14.10.1 with `scopeRefs`). §14.15 audit order and ratification order. Open decisions O-G2-1..3, O-G3-1..2, O-G4-1..2, O-G5-1..2, each drafted with a default; none ratified; NOT implemented | G2–G5 contract (draft v1) |

## 2. S1 — Worker session entries (the bus)

Workers write standard tre. session JSONL (`SESSION_FORMAT_VERSION` 1; no
changes to the worker format — this section pins the *subset the supervisor
relies on*, which becomes a stability contract for this workstream).

Entries the supervisor consumes (by `type` / discriminator). This table
reflects **code-verified reality** (stress test R2, 2026-10-30), not the
earlier draft's assumptions:

| entry | signals | supervisor use |
|-------|---------|----------------|
| `message` (assistant w/ `toolCall`) | tool name, args digest | command-family classification, pace |
| `message` (toolResult) | `isError`, `details.sameErrorWarn` / `details.sameFamilyWarn` / `details.sameErrorCount` / `details.sameFamilyCount` (persisted today — pipeline.ts ~753/786; exact warn-entry shapes closed at P0 → §14.1) | error-family window (mirrors pipeline family key), verify-gap |
| `message` (user) | injected text | **a steer arrives as a plain user message** — the loop emits a `steer` *event*, and the driver persists `ev.message` only (main.ts ~1119–1128). There is **no `steer` session-entry type**; provenance is absent unless S2's envelope metadata lands |
| `guardStop` | D33 `GuardEvidence` union (identical-batch / permission-stall / repeat-failure) | stop classification → ladder (→ S5 action) |
| `progress_nudge` | kind (`no-success` \| `no-verification`), mode | early warning before a stop — **NOT persisted today** (live event only, consumed at main.ts ~614); persisting it is contract work (Q2a, decided: persist). Shape **closed at P0** → standalone `progressNudge` entry (§14.6), implemented at P1 |
| `progressNudge` *(new, §14.6 — P1)* | `kind`, `mode`, `runId?` | persisted warn evidence (harness metadata, replay-ignored, format version stays 1 — mirrors `guardStop`); the supervisor acts on these + toolResult warn details |
| `runEnd` *(new, §13.4 — P2)* | `runId`, `reason` | terminal record per run: "the run ended and why", never "the task passed"; absence classifies `unknown`, never `crashed`. `reason` ∈ driver `StopReason` (`stop`\|`length`\|`error`\|`aborted`\|`budget`\|`loop`\|`stall`\|`progress` — `toolUse` never terminates a run, so it never appears) plus `crashed` **written only by a reconciling supervisor** (never by the driver — a crashed driver cannot write its own terminal record); absence still classifies `unknown` (§11.1 P2) |
| `compaction` | fold boundary | context-size pressure signal |
| usage-carrying assistant entries | input/output tokens | cost burn, budget % |
| `modelChange` | model id | swap accounting |

What the log does **not** record (stress tests R2/R3 — load-bearing for
every consumer):

- **No general completion record.** `agent_end` persists *only* its guard
  evidence (`guardStop` when present, main.ts ~1112–1116). A clean run end
  leaves no terminal entry; classification uses process evidence + tail
  analysis and remains unknown when those do not establish an outcome
  (Q6, reopened).
- **No live in-progress state.** Silence distinguishes neither "thinking"
  from "hung on endpoint" nor "tool running." Views must carry an
  `unknown`/`stale` state; never infer precise liveness from absence.
- **No provenance on user messages.** Human-TTY, Telegram, and
  orchestrator steers are byte-indistinguishable until S2 envelope
  metadata ships.

Rules:
- **Tail semantics:** byte offset + newline-aligned chunking (the
  tokenomics reporter pattern); entry `id` is the dedup key everywhere.
  **Precondition (→ §13.1):** the file's append boundary must be repaired
  before any consumer/appender writes — see the torn-tail bug.
- **Warn-rung entries are load-bearing:** the pipeline warns
  (`sameErrorWarn`, `sameFamilyWarn`) already ride persisted toolResult
  details; `progress_nudge` must be persisted to join them. The
  supervisor acts on warnings, not only on stops.
- **JSONL is the authoritative recorded history, not a complete live
  execution trace.** Durable semantic facts (messages, warn evidence,
  steer receipts, decisions) live here; ephemeral liveness observations
  (process identity, tool start, heartbeat) do not and must not be
  back-inferred (§13.2 I3).
- Anything the supervisor needs that is NOT an entry today is a candidate
  for a new entry type and must be added here first (Change Ledger row).

## 3. S2 — Steer-file format (new in-run seam)

One new primitive in tre.: a file-backed `SteeringQueue` implementation
alongside the Telegram one, drained at the existing turn-boundary seam with
identical semantics (boundary drain, `steer` event + message identity
persisted, keep-alive rules unchanged).

```
path: <dir>/steer.jsonl          # passed via --steer-file <path>
write: one JSON line appended per steer request
```

Steer request line:

```json
{"id":"steer-7f3a","ts":1730230000,"text":"…","source":"orchestrator","priority":"steer","attemptId":"t2-a1","taskId":"t2"}
```

| field | type | notes |
|-------|------|-------|
| `id` | string | client-assigned, unique per file; used for ack correlation |
| `ts` | number | unix seconds, informational |
| `text` | string | injected exactly as given (no harness templating) |
| `source` | string | free-form label (`orchestrator`, `human-tty`, …) — persisted into the steer envelope provenance (→ §14.2) |
| `priority` | `"steer"` | v1 only `"steer"`; follow-up/queue semantics deliberately excluded (matches current runLoop: no follow-up queue) |
| `attemptId` *(required in managed mode, §14.2)* | string | session this steer targets (→ §14.1). A line whose `attemptId` ≠ the run's current session identity is **skipped with a counted warning — never injected, never dropped silently as success** |
| `taskId` *(optional, provenance)* | string | scheduling label only (scope reporting, scoping on rewrite); the harness does not interpret it |

Acknowledgement (R2-corrected): **ordering correlation is not a usable
ack.** A steer persists as a plain user message with no echoed id; human
and orchestrator steers interleave, and identical texts are
undistinguishable. The ack model is instead:

- **Deduplicated transcript insertion, not exactly-once execution.**
  An ack means "recorded in the session transcript with my `id`" — not
  understood, obeyed, or completed. Uptake and outcome are separate
  evidence (§9, §13.2 I6).
- Stable `id` per logical request, chosen by the appending supervisor and
  retained across supervisor retries. The harness dedups on insert: same
  id + same text = no-op retry; same id + different text = reject with
  stderr warning.
- **Envelope metadata (S1 amendment, Q1 decided):** the persisted user
  message gains optional non-model-visible fields
  (`steering: { requestId, source }` on the session entry, not inside
  `.content`). Replay treats it as an ordinary message; the supervisor
  correlates directly. Recovery scans persisted request ids across the
  whole file, including past compaction boundaries — offsets are an
  optimization, never delivery authority.
- **Request scoping (R3):** every steer targets a task revision +
  session identity. On task rewrite or fresh-session swap, pending
  requests whose scope no longer matches are **not auto-replayed** —
  stale guidance after a task change can be actively wrong.

Contract points:
- File is created by the harness at startup if absent (empty).
- Malformed lines: skipped, never fatal; skipped count logged to stderr.
- **Validation (P0, §14.2):** a line missing `id`/`text`, or with unknown
  `priority`, is malformed (skip + count). `attemptId` is optional when
  `--steer-file` is used standalone (unmanaged: mismatch check off); in
  managed mode the supervisor always writes it and the harness enforces
  the mismatch rule above.
- **P3a is mandatory once any file steer carries a nonempty `source`**
  (or a managed-mode file exists): the harness must persist
  `steering:{requestId,source}` (§14.2), or the supervisor's ack can never
  close. The flag alone without provenance support is rejected with a
  startup error, not a silent degradation.
- No new CLI surface beyond `--steer-file <path>`; absent flag = exactly
  today's behavior.
- **Queue file is append-only for its lifetime** — the supervisor never
  rewrites/truncates beneath the live reader (invalidates reader offsets;
  R2 withdrew the earlier "drop acked lines" proposal). Dedup state lives
  with the supervisor + transcript scan, not in file surgery.
- One consumer per file (the run's harness), and the *pair*
  (queue file, session file) has exactly one harness at a time — see the
  ownership fence, §13.2 I1.
- **Steering is guidance, not policy.** A persisted steer can be
  compacted away; critical constraints (protected paths, spend limits,
  allowed actions) belong in enforced config or task policy, not only in
  steer text (R3).

## 4. S3 — Task graph file

Machine-readable sibling of the parallel-delegation plan.md. One file per
**episode** (a supervised workstream run):

```
path: <episodesDir>/<episodeId>/graph.json
```

```json
{
  "schema": "tre-graph/1",
  "episodeId": "2026-10-30-widget-x",
  "goal": "one-paragraph statement",
  "maxRounds": 6,
  "tasks": [
    {
      "id": "t1",
      "persona": "implementer",
      "promptRef": "prompts/t1.md",
      "dependsOn": [],
      "model": "local/qwen3-…",
      "approval": "yes",
      "scope": { "files": ["src/x.ts"], "notFiles": ["src/y.ts"] },
      "acceptance": { "criteria": ["gate green", "…"], "requiredChecks": ["npm run check"], "artifacts": [] },
      "budget": { "maxTurns": 40, "maxUsd": 2.0 },
      "status": "done",
      "result": { "verdict": "ALL VERIFIED - NO FINDINGS", "acceptance": "complete", "artifacts": [] }
    }
  ],
  "policy": { "$ref": "§14.7 episode policy", "baseCommit": "…", "recoveryBudget": { "maxAttemptsPerTask": 4, "maxEpisodeRecoveryUsd": 6.0, "maxWallclockPerAttemptS": 1800 } }
}
```

Rules:
- `status` ∈ `queued | ready | running | paused | done | failed | parked`.
  The **supervisor** is the only writer; workers never see this file.
- **Derived vs desired authority (P0):** `status`, `result`, and usage
  totals are **derived projections** the supervisor rewrites from
  reconcile (§7 trichotomy); they are never inputs to recovery decisions.
  Desired inputs — `dependsOn`, `scope`, `acceptance`, `budget` caps,
  `approval`, `model`, `persona`, `promptRef` — are edited only by an
  explicit task-rewrite (rung 4), which bumps `revision` (→ §14.4).
  A recovery action may change derived fields; it may never edit desired
  fields.
- Wave scheduling = topological order as in parallel-delegation; wave width
  ≤ slots (2); ≤1 subtask per endpoint per wave.
- `promptRef` keeps the graph small and diffable; prompts are files, same
  convention as `.tre/audits/prompt-*.txt`.
- `scope.notFiles` is advisory for scheduling (disjointness check before a
  wave starts); enforcement stays with the worker's own sandbox + git.
- Task `verdict` is free text by convention; the auditor-loop convention
  (`ALL VERIFIED — NO FINDINGS` vs numbered findings) is reused.

## 5. S4 — Worker workspace layout

One directory per episode, everything inside it; episode dirs never inside
another repo:

```
<episodesRoot>/<episodeId>/
  graph.json          # S3
  prompts/t<N>.md     # task prompt sources
  events/             # supervisor decision log (S5), JSONL
  state.json          # episode state (S6)
  wt/<taskId>/        # git worktree per running task (detached or agent/<taskId>)
  sessions/           # symlink or --session files kept OUTSIDE worktrees
```

- Worktrees: `git worktree add`, one per task, branch `agent/<episodeId>/<taskId>`.
  Integration follows the **merge-action contract (Q5, R2/R3)**: conflicts
  escalate (ladder rung 5).
- **Merge-action contract:** episode branch pinned at an episode `baseCommit`
  (recorded in graph.json). Each task integration: (1) construct candidate
  merge commit from current episode-branch head + task branch; (2) run the
  episode's trusted gate (gate definition from episode policy, never
  weakened by the task under test) against the exact candidate SHA;
  (3) advance the episode branch with compare-and-swap — only if head is
  still the tested parent, else rebuild and retest; (4) record acceptance
  {candidate SHA, parent SHA(s), gate id+result, cleanliness-after}.
  "Gate green" binds to an artifact, not to "tests looked green." No
  automatic conflict resolution or history rewriting in v1; clean merge
  proves mechanics, not design coherence.
- Session files stay under `sessions/` (outside any worktree) so a worker
  never operates on its own history as project files (D20 repo-level
  isolation unchanged; C38 reachability unchanged — see docs/04).
- `<episodesRoot>` = `~/.tre/episodes` (**Q3 decided**, machine level,
  next to `sessions/`). R3 caveats, binding: this is *organizational
  separation, not an access-control boundary* — it grants no isolation;
  and the tokenomics reporter collects configured dirs only, it does
  **not** auto-collect `~/.tre/**` — episode ingestion is an explicit
  future transport decision, not a side effect (→ Q4).

## 6. S5 — Supervisor decision-log entries

The cortex keeps the same journal discipline as the reflexes — append-only
JSONL in `<episode>/events/decisions.jsonl`, one entry per observation→
action cycle that did something (no-op observations are not logged):

```json
{
  "schema": "tre-supervisor/1",
  "id": "d-0042",
  "ts": 1730231234,
  "episodeId": "2026-10-30-widget-x",
  "taskId": "t2",
  "observation": {
    "signals": [
      { "kind": "guard-stop", "guard": "repeat-failure",
        "family": "bash:sed ,+#p unterminated address", "evidenceRef": "sessions/t2.jsonl#<entryId>" }
    ],
    "context": { "nudgesThisEpisode": 1, "stopsThisEpisode": 2, "budgetPct": 0.61 }
  },
  "decision": { "rung": 3, "action": "model-swap", "rationale": "second same-family stop; nudge uptake observed but no progress" },
  "outcome": { "acked": true, "progressAfter": "unknown", "closedById": null }
}
```

| field group | contract |
|-------------|----------|
| `observation.signals[].kind` | closed set, extensible only via this doc: `guard-stop`, `warn-rung`, `semantic-loop`, `verify-gap`, `no-advance`, `endpoint-error`, `budget-threshold`, `worker-exit`, `worker-blocked-on-approval` |
| `decision.rung` | integer 1–5 (see §9 ladder); `action` ∈ `nudge` \| `evidence-nudge-resume` \| `model-swap` \| `task-rewrite` \| `escalate` \| `kill` \| `park` \| `merge` \| `backoff-retry` \| `investigate` \| `repair` \| `accept-finish` (added at P0 for the self-healing scope: bounded retry, bounded diagnosis dispatch, authorized task-local repair, and completing a task on verified acceptance; rung for the new actions: `backoff-retry` = 2, `investigate` = 1.5 recorded as rung 2 with `sideEffect: "none"`, `repair` = 2–3 by authority, `accept-finish` = 0 (not an intervention — recorded when P14 says complete)). **No action executes whose type is not in this enum**; new action types require a Change Ledger row first |
| `outcome.acked` | steer-file path: correlated user-message envelope with `steering.requestId` seen (not a `steer` entry); resume path: run accepted; swap: new worker spawned. Delivery/start acknowledgement only, never proof of progress or acceptance |
| `outcome.closedById` | a later decision entry closing this one with measured effect (`progressed` / `recurred` / `stopped-clean`) — this is the meta-telemetry that teaches thresholds later |

Rule: **every intervention the orchestrator performs gets exactly one
entry before it acts** (log-then-act; a crash between is acceptable,
acting silently is not). Review UIs interleave these with worker entries
on the same timeline — the episode record shows both minds.

R2/R3 refinement — **log-before-act prevents silent intent, not
duplicate action**: a crash after "decide: spawn" but before the spawn's
outcome must be recorded would let recovery re-spawn blindly. Therefore:

- Every action carries a stable `actionId`; every worker start carries an
  `attemptId` (survives supervisor crashes — process identity stronger
  than a PID, which may be reused).
- Intent and observed outcome are recorded **separately**; recovery
  reconciles intent-vs-reality (§13.2 I2) before retrying anything, and
  an ambiguous effect is *never blindly retried* (§13.2 I5).

**Wire contract (P0-closed, → §14.3):** one `decisions.jsonl` file per
episode carrying four discriminated record types by `kind` —
`decision-intent` (before acting; carries `actionId`, `rung`, `action`,
`strategyId`, `expectedEvidence`), `decision-outcome` (after; same
`actionId`, plus `acked`, `progress`, `evidenceRefs`, `closedById`),
`acceptance` (P14 assessment: verdict ∈ `complete|incomplete|blocked|
uncertain`, per-criterion results, evidence refs, invalidated-by), and
`diagnosis` (P15 record: cause class, confidence, proposed actions —
**advice only**, never an authority grant, I-cortex §0.7). Full field
shapes in §14.3; the JSON example above shows the merged view of an
intent+outcome pair.

## 7. S6 — Episode state file

Small, mutable, atomic-rename JSON (`state.json`) — the restart-resume
anchor for the supervisor:

```json
{
  "schema": "tre-episode-state/1",
  "episodeId": "…",
  "supervisorPid": 12345,
  "tasks": { "t2": { "status": "running", "pid": 2345, "session": "sessions/t2.jsonl",
                     "offset": 81234, "nudges": 2, "stops": 2, "modelsTried": ["qwen3", "ds-flash"] } },
  "slots": { "localA": "t2", "localB": null },
  "telegram": { "pendingApproval": null }
}
```

- `offset` per tailed session = resume point (reporter semantics).
- Anything rebuildable from files is NOT stored here beyond a cache;
  `graph.json.status` stays the authoritative **desired** task status.
- Written on every state transition, fsync-style; a corrupt file means
  rebuild-from-files, never a failed run.
- **R2 state trichotomy (binding on recovery):** three categories must
  not be conflated — *desired state* (graph.json + policy), *recorded
  history* (decisions.jsonl + session logs + receipts), *observed
  reality* (processes, branch heads, worktree state). Recovery
  reconciles all three; no single mutable file is privileged. "graph
  says running, no process exists" ⇒ stale record, reconcile — never
  blind re-spawn from either file alone (→ §13.2 I2).
- `supervisorPid` / task `pid` are **hints, not ownership** (PID reuse);
  true ownership is the fence in §13.2 I1.

## 8. S7 — Fleet projection inputs (observation envelope)

All view tiers consume one normalized stream, not three parsers. The
supervisor (or a sidecar tailer) emits an **observation envelope** per
worker update — worker session entries (§2) tagged with fleet identity,
plus supervisor decisions (§5) interleaved:

```json
{ "schema": "tre-fleet/1", "episodeId": "…", "taskId": "t2",
  "seq": 118, "ts": 1730231300,
  "workerState": "tool",           // thinking | tool | await-approval | warned | stopped | dead
  "workerStateDetail": "bash",
  "source": { "kind": "session", "entryId": "…" },   // or {kind:"decision", id}
  "event": { }                     // the underlying entry/decision, verbatim
}
```

- `workerState` is the supervisor's *classification* (rules only), so
  every view agrees on "what is this worker doing" — expressiveness
  problems are interpretation problems, and interpretation is
  centralized here once. Classification must emit `unknown`/`stale`
  when the log cannot distinguish (§2 "not recorded" list); a precise
  state derived from silence is a spec violation.
- **R2 scope pin:** S7 is *normalized worker/session evidence plus
  supervisor decisions*. Herdr's state rollups are a supplementary
  observation transport (→ §12, Q7), **not S7 authority** — they carry
  no warn evidence, no decisions, no episode identity.
- Delivery: append-only JSONL per episode (views tail it like any
  session); the tokenomics collector can ingest the same door later for
  cross-host fleet views (client = episode id). **Open question Q4.**
  Cross-host also presumes actual log access/replication — herdr's SSH
  pane federation does **not** make remote session files readable
  locally; transport + security there is an explicit open decision.

View tiers (consumers, not schemas — listed so projections stay consistent):

1. **Matrix** — per-worker state lanes over time (Gantt/sparkline); the
   "who needs eyes" glance. Terminal (tmux grid) and web (tokenomics
   dashboard extension) share this envelope.
2. **Drill-down** — one worker: existing TUI reducer replaying its session,
   plus worktree diff, gate status, last `guardStop` evidence card, nudge
   history from decisions.jsonl.
3. **Episode record** — postmortem replay interleaving session + decision
   entries on one timeline (both already JSONL with ids; interleave key =
   episode + ts + seq).

## 9. Intervention ladder (policy, normative for S5 `rung`)

| rung | action | channel | resets |
|------|--------|---------|--------|
| 1 | nudge-in-flight | steer-file append | none (context warm) |
| 2 | evidence-nudge-resume | kill if dead-ended → `--resume` with nudge composed from D33 evidence | none (context on disk) |
| 3 | model-swap | respawn same prompt + worktree, different endpoint | reasoning, not artifacts |
| 4 | task-rewrite | cortex decomposes/rewrites task, fresh worker + fresh worktree | episode-local state |
| 5 | park + escalate | stop scheduling the task; Telegram digest with evidence refs; human decides | — |

(*Below the ladder:* raw PTY injection — what herd layers like herdr's
`agent prompt` offer (§12) — is "rung 0". **R2 correction:** it is NOT
"always available, never counted": any supervisor-generated input must be
attributable and budgeted. Where no structured delivery path exists,
record an explicit degraded-mode decision entry instead of intervening
invisibly. R2 also pins: PTY input is not a *reliable* fallback — it may
hit a shell, an approval prompt, or an agent handler with different
semantics. And `tre. --resume` takes a **session file path**, not a
session id — the earlier herdr `resume_argv` sketch was wrong on this.)

Hygiene (binding on the rule engine, mirrors guard design):
- ≤2 rung-1 nudges per episode per task; no near-duplicate nudge text
  (exact/digest repeat blocked — the supervisor obeys anti-loop rules too);
- after any rung-1/2 action, require **uptake evidence** (next tool call of
  a *different* family, or a changed batch signature) before re-judging;
- **R3: uptake ≠ progress.** A changed command is evidence the steer was
  consumed, never that the task advanced. *Progress* requires
  task-relevant evidence: a resolved error family, a passing gate/check,
  a validated artifact, an acceptance milestone. Alternating read/failing
  bash forever is uptake without progress.
- **R2/R3: budgets span attempts, not processes.** Intervention counts,
  turn/spend budgets, and recovery attempts are tracked **per task and
  per episode across respawns, model swaps, resumes, and supervisor
  restarts**. Two workers × local guard limits × supervisor nudges must
  not sum to unbounded burn; the episode budget is the backstop that
  eventually stops automation regardless of local resets.
- **Steer-induced guard resets count.** If a rung-1/2 action resets an
  in-run guard's state, the supervisor must charge itself — otherwise
  external nudges keep unproductive workers alive indefinitely (the
  intervention creates the behavior it diagnoses).
- Boundary steering cannot rescue a permanently blocked tool call; that
  is a timeout/cancellation policy question, not a steer (R2).
- Same guard fires ≥2 times across respawns → prohibit another blind
  same-strategy retry; require diagnosis and a materially different authorized
  strategy, or park/escalate. Guard recurrence is evidence, not an automatic
  request for human attention if useful bounded investigation remains.
- Warnings do not auto-escalate: local reflexes act first; the cortex
  intervenes on patterns the reflex cannot see (cross-run, cross-worker),
  unless escalation policy explicitly says otherwise.

### 9.1 Self-healing policy (accepted scope; wire schemas closed at P0)

The ladder identifies action classes, not a mandatory escalation sequence.
Choose the least disruptive action supported by evidence. Ended-run recovery
uses safe resume; in-flight guidance uses S2; a blocked tool requires runner
investigation/cancellation, not repeated boundary steers.

```text
interruption → reconcile execution → evaluate acceptance
  → finish | continue | investigate | repair | change approach | escalate
  → verify task-relevant progress → continue or revise recovery
```

**Authority is granted upfront, not invented during recovery.** Task/episode
policy must enumerate permitted paths, diagnostic commands, task-local repairs,
approved models/endpoints, spend/time limits, and permitted external effects.
Shared-environment changes, dependency installation, credentials, service
restarts, and publication require explicit policy; absent permission they
are not automatic repairs. Acceptance criteria and safety guards may not be
weakened to make a task pass. Model output is untrusted advice at this boundary.

**Investigation before escalation:** an uncertain cause normally triggers
bounded evidence collection. Transient endpoint failures may back off/retry
only when tool effects are not ambiguous. Premature normal stops resume with
specific remaining acceptance work. Repeated failures require diagnosis,
not generic "continue". Task-local fixes and revised approaches are autonomous
within authority. An observer has no concurrent write entitlement to a live
worker's worktree; mutating repair must be serialized through P7 ownership.

**Limits:** the ≤2 rung-1 nudges rule limits repeated live guidance, not the
whole recovery chain. P8 also enforces aggregate recovery time/spend/attempt
limits and repeated-strategy limits across sessions/restarts, including
observer inference and diagnostics. Record strategy, expected evidence,
resulting progress, and new diagnostic information; activity alone earns no
unlimited retry allowance. P0 pins exact policy fields and default limits.

**Escalate only when** new authority or a consequential human intent decision
is needed, external effects remain unsafe to reconcile, an external blocker
requires human action, or bounded recovery is exhausted without a useful
safe next step. Wait/retry for temporary dependencies within policy. If
ownership cannot be proved, park rather than spawn; investigation may proceed
only without touching ambiguously owned resources. Notify with evidence,
what was attempted, the blocker, and the exact decision needed. A parked task
must not stop independent authorized tasks. Parking is not proof that a live
process stopped; confirmed cancellation remains an explicit controlled action.

**Acceptance:** classify complete/incomplete/blocked/uncertain using approved
criteria, required checks, and artifact-bound evidence. Successful run exit,
a steer receipt, or a worker's claim alone is insufficient. Model judgment
may assess semantic requirements but cannot waive deterministic gates or
promote stale checks after relevant artifacts change.

**P0 schema work required before implementation:** S3/policy must carry
acceptance and authority/recovery limits; S5 must represent structured
acceptance assessments, diagnoses, strategy ids, diagnostic/repair actions,
and separate intent/outcome/progress records; S6 caches their projections;
S7 carries evidence references rather than asserting unobserved state. The
existing S3/S5 examples and action enum are not yet sufficient for this
expanded scope and must be amended before any new action type executes.

## 10. Open questions

| id | question | status |
|----|----------|--------|
| Q1 | Does the steer persist gain provenance for direct ack, or stay correlation-by-ordering? | **decided (R2): envelope metadata.** The premise was fiction — no `steer` entry type exists; steering persists as a plain user message (main.ts ~1119). Ordering can't ack interleaved/multi-source steers. Resolution: optional `steering:{requestId,source}` on the message envelope (not model-visible content); promise deduplicated transcript insertion only. L1 ships the `--steer-file` seam; envelope metadata rides the same seam (S2). |
| Q2 | Should warn-rungs be persisted entries (supervisor semantics depend on them)? | **decided (P0):** pipeline family warns are persisted (toolResult.details — §2 pins `sameErrorWarn`/`sameFamilyWarn`/counts); `progress_nudge` becomes the standalone `progressNudge` entry — shape closed in §14.6, implemented at P1 |
| Q3 | `<episodesRoot>` location | **decided (R2): `~/.tre/episodes`** — organizational only; grants no isolation and no automatic collection (§5 caveats). |
| Q4 | Fleet envelope → tokenomics ingest vs file-only first? | open — lean file-only; cross-host needs explicit transport (§8). |
| Q5 | Worktree integration: auto-merge or stage for human? | **decided (R2, narrowed):** episode-branch integration is **automatic for identified, tested artifacts under approved policy** — per the S5 merge-action contract above (pin base, tested SHA+parents, CAS advance, trusted gate, episode-scoped auto-resolution). *Promotion episode→main stays human by default but is delegable under explicit policy* — "always human" is governance default, not technical necessity. |
| Q6 | Is exit code + session tail sufficient for completion classification, or does one-shot need `--emit-events`? | **reopened (R2):** the old rationale was wrong — `agent_end` is *not* a persisted general completion record (only guard evidence is). Crash/exit classification is underspecified; decide after §13.4 recovery states are implemented. Stdout mirror remains one option, not the only one. → **CLOSED (P2, 2026-10-30)**: terminal `runEnd {runId, reason}` entry is implemented (driver-appended, per-run identity); absent evidence classifies `unknown`, never `crashed`. No `--emit-events` needed — the session file itself is the durable record. |
| Q7 | Adopt herdr as S7 second transport / supervisor as socket client? | **narrowed (R2):** optional adapter only; herdr is not S7 authority, not remote-JSONL transport, and PTY `agent prompt` is not a trusted steer fallback. |
| Q8 | Implement the herdr agent contract in tre. harness as cheap reversible work? | **reframed (R2):** bounded *spike*, not "~a day": state reporting is small, but restart/approval/release/resume correctness (incl. `--resume` = file path) needs tests before any estimate. Not a supervisor prerequisite. |

## 11. Development plan — self-healing-first compartments (P0–P15)

The accepted scope supersedes the earlier observe-only-first product plan:
**self-healing single-worker execution first, multi-worker scale second**.
Observe-only and recommendation-only modes remain development validation
stages, not the first useful product. Existing compartment ids are retained;
P14/P15 make acceptance evaluation and diagnosis/recovery explicit rather
than hiding them in a late optional LLM judge.

Each compartment owns one coherent contract and compiles/tests independently.
Unwired libraries have no execution effects; P1/P2 add recorded evidence but
must not change replayed context; file steering remains opt-in. File/git
modules perform I/O when called, while reducers and policy functions remain
pure. No compartment implies a one-commit implementation.

Tracks: **harness contracts** P1–P3; **episode primitives and control plane**
P4–P8; **acceptance and recovery judgment** P10/P14/P15; **execution and
composition** P9/P11; **deferred integration and richer views** P12/P13.
Detailed wire shapes below remain proposals until P0 closes the schemas.

### 11.1 Compartments

| id | compartment | schemas consumed | status |
|----|-------------|------------------|--------|
| P0 | **Contract closure & schema reconciliation.** Pin run/attempt identity, scoped steering and conflict rules, intent/outcome lifecycle, graph authority, ownership, acceptance evidence, structured observer judgments, diagnostic permissions, repair authority, and recovery budgets. Graph `status`/`result` and usage totals are derived projections; approval, dependencies, scope, acceptance, and budget caps are desired inputs. Update S1–S7 before implementation; examples are not yet complete wire contracts. | all | **done — closed in §14 (2026-10-30)** |
| P1 | **Persisted warning evidence** — `progress_nudge` becomes a session entry (closes the Q2b half: proposed shape = standalone `progressNudge {id,kind,mode,ts}`, mirroring the `guardStop` driver-append pattern at main.ts ~1112 so replay's "ignore non-context entries" path stays unchanged). Exit: recorded; replay/context byte-identical; existing consumers tolerate it | S1, §2 | **done (2026-10-30)** — `ProgressNudgeEntry` + `Session.appendProgressNudge` (session.ts), driver persists every fire in `runTurn.onEvent` (main.ts); shape amended at implementation (turn/count/target, real `ProgressMode`); 4 tests: round-trip, legacy-reader skip (version stays 1), compaction-chain safe, runTurn end-to-end |
| P2 | **Run lifecycle evidence** — terminal record(s) with run identity: `runEnd {runId, reason}` driver-appended (the §13.4 candidate, amended). **`runEnd` means "the run ended and why", not "the task passed"**; acceptance remains supervisor-side. **Absent terminal evidence = `unknown/incomplete`, never `crashed`** (missing can mean old format, still-running, driver crash, persistence failure, or partial observation — exit code corroborates but doesn't replace it). Q6 closes here | S1, §13.4 | **done (2026-10-30)** — `RunEndEntry` + `Session.appendRunEnd` + `driverRunEndReason` (session.ts); `runTurn` allocates the §14.1 runId and appends the terminal record at agent_end after guard evidence; toolUse leak writes NOTHING (absence → `unknown`); 5 tests: round-trip, reason mapping, legacy-reader skip, runTurn tail record, two-runs-per-session |
| P3a | **Structured steering plumbing** (harness-internal): extend the steering path so provenance survives queue → `steer` event → persisted envelope (`steering:{requestId,source}`, Q1). The 2-method `SteeringQueue` (`push(text)`, `drain()`, agent-loop.ts ~108) cannot carry identity — this is an interface change, not a file reader. Legacy TTY/Telegram behavior byte-identical | S1, S2 | **done (2026-11-01)** — `SteerEntry`/`SteeringMeta` (types.ts); `SteeringQueue.push(string \| SteerEntry)` + `drain(): (string \| SteerEntry)[]` (drain widened so string-returning mocks stay valid); `steer` event gains `steering?`; `MessageEntry.steering?` written by the runTurn persist tap; plain pushes normalize to `{requestId:"", source:"tty"}` (content byte-identical); Telegram driver routes `source:"telegram"` envelopes through the handoff buffer (detach normalizes stray strings); 4 tests: loop normalization, session entry round-trip + replay invisibility, driver envelope provenance through the buffer, runTurn end-to-end persistence |
| P3b | **File-backed steering delivery**: `--steer-file <path>` + `FileSteeringQueue` (offset-tolerant incremental drain, malformed lines skipped+counted, scoped-request validation, transcript-scan dedup by request id with scope/provenance conflict rejection, sync-before-ack per §13.1). **Claims deduplicated transcript insertion only — never exactly-once execution** (I6). Tests: §13.3 rows 1/2/4 | S1, S2 | **done (2026-11-02)** — `src/steer/file-queue.ts`: `FileSteeringQueue implements SteeringQueue` — one consumer per steer file (ownership fence §13.2 I1), file created empty at startup (§3). `scanJsonl` incremental cursor: complete lines only (torn tail held as base64 partial and joined on the next append — never repaired, §13.1 repair stays with the exclusive writer), reconcile-to-0 + full rescan on shrink OR head-fingerprint divergence at ANY size (checked against the buffer in hand; a replacement larger than the offset still moves the head) OR file disappearance after content. §14.2 table per line: malformed skipped+counted (missing/non-string id or text, non-object, unknown priority never down-defaults), managed-mode `attemptId` mismatch skipped+counted with warn-once (never injected, never acked; unmanaged ignores `attemptId`), transcript dedup by requestId (recorded + same text → acked no-op; different text → conflictRejected warn-once, not injected, not acked; pending-injection guard settles handed-off-but-unrecorded same-text redelivery as an acked no-op). Offset state at `<path>.offset.json`: persisted offset never advances past the START of a line whose injection is unrecorded (§13.3 row 1 → crash restarts redeliver the whole line); recorded lines settle through dedup with no duplicate transcript insertion (row 2); corrupt state = no state (full rescan, deduped). State writes tmp+fsync+rename; a failed write is safe by construction (stale-previous offset, redelivery deduped). Envelope provenance: `requestId` = line id, `source` default `"file"`, pushed (shared-driver) items drain before file lines. Final stats line to stderr on close (lines/injected/malformed/scope_mismatch/dedup_acked/conflict_rejected). CLI: `--steer-file <path>` requires a session file (transcript is the dedup authority); TUI runs get the queue per-run via factory so run N+1 sees appends during run N. Two enforced compartment guards: nothing outside `src/cli/` imports the module (P3b wiring point is the CLI) and `src/steer/` imports nothing in the repo except node: builtins + type-only. 18 tests |
| P4 | **Episode journal & projections**: typed graph.json / state.json / decisions.jsonl readers-writers, schema validation, atomic-rename, dir scaffold (S4), intent/outcome append records (§6 lifecycle), state trichotomy applied (S6). No process ever writes these yet | S3, S5, S6 | **done (2026-11-01)** — `src/episode/journal.ts`: typed `EpisodeGraph`/`EpisodeState`/§14.3 record classes; `writeEpisodeGraph`/`writeEpisodeState` atomic-rename (tmp+fsync+rename) with schema validation on BOTH write and read (`tre-graph/1`, `tre-episode-state/1`); `DecisionJournal` append-only JSONL — validate-before-append, sync-before-return, §13.1 torn-tail repair on open (truncate partial tail / terminate newline-lost record; mid-file corruption throws), duplicate-id reporting; `createEpisodeLayout` S4 scaffold (idempotent, seeds graph); I2 projections `openIntents`/`latestAttempt`/`unresolvedSpawns`; `defaultEpisodesRoot` = `~/.tre/episodes` (Q3). Source-tree reference test guards premature wiring outside `src/episode/` (not an access-control boundary); hardened validation and append failure handling per the P4 audit ledger row |
| P5 | **Read-only ingestion & fleet projection**: persistent-offset JSONL tailer (reporter pattern), §13.1-*aware* (reconcile cursor on truncation/replacement — see §11.2 boundary note), entry-id dedup, deterministic replay, envelope emission (S7) with explicit `unknown`/`stale` (I3) | S1, S7 | **done (2026-11-02)** — `src/fleet/tail.ts`: `JsonlTailer` (offset-persistent cursor + persisted held partial — a torn line is never duplicated or redelivered across polls or restarts; §13.1-aware: truncation or same-size in-place rewrite (head fingerprint + mtime) → full rescan with `resume` flag + regenerated content-fingerprint ids; invalid-UTF8 lines counted-and-dropped without poisoning the cursor; observation-only — never repairs the watched file); `projectSessionReplay` (deterministic id-sorted replay, entry-id dedup with first-wins + duplicate counts, carry-forward — §13.2 I6); §14.8 `classifyWorkerState` (closed set frozen as `WORKER_STATES`; rule-order dead→stopped→tool/await-approval/thinking (ephemeral, caller-supplied — I3: silence NEVER classifies `thinking`)→pending toolCall→warned; `classifiedFrom` audit trail); `projectWorkerEnvelope` (`tre.observe.v1` S7 doc, monotonic revision, atomic tmp+fsync+rename write); `FleetObserver` (per-episode `tre-fleet/1` envelope stream with per-worker seq, `emitDecision` interleaving, staleness `staleAfterMs` default 300000, live-worker marker staleness); compartment guards pin src/fleet imports to node: builtins only and nothing outside src/fleet imports it; 22 tests |
| P6 | **Worktree provisioning**: `git worktree add/remove`, episode-branch pin at `baseCommit`, isolated task branches/dirs, safe cleanup. **No integration logic here** (that is P12) | S4 | **done (2026-10-31)** — `src/worktree/provision.ts`: `WorktreeProvisioner.open()` (placement gates BEFORE any mutation: wtRoot must be outside our repo AND any foreign repo — bare included — detected via `rev-parse --path-format=absolute --git-common-dir` on the nearest existing directory ancestor; git's own common-dir view is the authority, so renamed-behind-git's-back worktrees and `.git` placements are refused); `ensureTaskWorktree` (open-or-create idempotent: fresh `worktree add --no-track -b agent/<ep>/<task>` pinned at the resolved base sha with post-creation HEAD verification; branch-exists-at-base crash-recovery re-attach; branch-moved → `branch-conflict` never reset; unmanaged dir OR PLAIN FILE/dangling symlink at the task path (lstat-based `pathOccupied`, fail-closed on stat errors) → `path-exists` never adopted/deleted (remove: `not-registered`); vanished dir → `stale-registration` until prune; detached mode supported); `openTaskWorktree` (registry view: task branch or detached accepted, foreign branch refused); `removeTaskWorktree` (registered-only, dirty gate incl. untracked BEFORE any mutation unless force; deleteBranch gated on the INDEPENDENT-PIN proof (ds C8 + ds-c1 F1: base must be reachable from a ref OTHER than the branch being deleted — `for-each-ref --contains` — AND be the tip's ancestor AND `base..branch` empty, every operand `refs/heads/`-qualified because a same-named TAG shadows the branch in plain rev-parse; `base..branch` alone is trivially empty when baseCommit == branch tip and was REJECTED as the gate) — never `branch -d` heuristics — with a branch-users pre-gate that splits stale (unlock+prune guidance) from live (branch-in-use); locked removals need git's double `-f -f`; force = explicit discard); `prune()` (refuses when ANY stale entry lies outside wtRoot — git's prune is repo-global; reports exact removals by before/after registry diff); `resolveCommit` (commit-ish → sha, `^{commit}` peel, `--`-separated option-safe, never a HEAD fallback); fixed-argv execFile git with documented-negative probe classification (search-exhausted wording only — a broken-gitlink `not a git repository: (null)` is a hard git-failed, never "outside"); provenance return feeds §14.1 AttemptRecord (episodeId/taskId/path/branch/head/baseCommit/preexisting; `baseCommit:""` on plain open — P7 fills provenance from the journal). ERROR UNION (typed, ds-c2/c3/c5): not-a-git-repo, wt-inside-repo, wt-in-other-repo, bad-wt-root (wtRoot exists as non-directory), bad-id, unresolvable-base, path-exists, not-registered, stale-registration, foreign-branch, branch-conflict, dirty, unmerged, no-base-for-branch-delete, branch-in-use, prune-refused (prune THROWS it — never a return value), locked (remove + prune refuse locked entries; git never marks locked entries prunable, so liveness is checked via the `<path>/.git` gitfile), git-failed. Compartment guards: nothing outside src/worktree imports it; src/worktree imports only node: builtins. 51 tests on real git repos (mutation-swept: every data-loss guard has a test that fails when the guard is reverted; accepted untested tripwire: the post-creation `head !== baseSha` race guard, kept loud by comment) |
| P7 | **Attempt runner & ownership recovery**: controlled spawn/stop with attempt identity tracked in durable records (not PIDs); lost-supervisor reconcile — the old worker is not our child after a supervisor restart and `waitpid` is not generally available, so PID checks are insufficient: **discover-or-park** is the conservative fallback (I1/I2). Independently testable kill/spawn/reconcile unit *before* any scheduler uses it | §13.2 I1/I2, S6 | **done (2026-11-02)** — accepted after the R4–R8 adversarial re-audit cycle (`.tre/audit-r5-review.md` … `.tre/audit-r8-review.md`, R8 verdict PASS, no actionable findings; repro harnesses `.tre/tmp/r5-audit-repro.mjs` / `r6-audit-repro.mjs` / `r7-audit-repro.mjs` green against the shipped dist, R7-1 mutation-verified 15/15 isolated + fails under the serialization-removal mutation). Final shape: `src/runner/attempt.ts` (~2,090 lines) + 103 tests; full suite 1711 tests / **1697 pass / 0 fail** (14 skipped). The re-audit cycle added, on top of the working-tree remediation below: own-child EXIT no longer bypasses independent live/inconclusive evidence (analyze-probe exclusion is per-pid, spawn-fence gains `prior-attempt-running` / `prior-attempt-unresolved` checks); `confirmStopped` validates the caller's session against the JOURNAL-BOUND session (mismatch = `bad-input`, no confirmation is written); refresh-first ordering regression; and an explicit external-writer contract comment (state.json writes are serialized only within this runner's queue — external writers must stop the runner first; hard cross-process atomicity consciously declined). P9 may now wire P7. Historical text below records the pre-acceptance state. Prior: remediated against the working-tree audit (2026-10-31): `src/runner/attempt.ts` (1,215 lines) + 27 tests named per finding (suite 1638 pass / 0 fail; 8 consecutive stable runner-only runs). The working-tree audit (`docs/audits/audit-p7-working-tree.md`, REJECT: module did not compile) listed 9 findings + dead code; all are addressed: **(1–2)** compile blocker + ESM-safe executable check (`accessSync(X_OK)` via named `constants` import); **(3)** `confirmStopped` ownership is decided by SPAWN GENERATION, not timestamp — confirming an old tuple can never delete or repoint a newer tuple's live claim; **(4)** session paths are canonicalized at `run()`/`resume()` entry, so an uncanonicalized (`..`-traversal) spelling is the same identity as the canonical one; **(5)** group liveness via `kill(-pgid,0)` — `stop()` returns `groupStatus`, leader death alone never releases ownership (`reconcile()` parks, `run()`/`confirmStopped()` refuse, across reopen, while the recorded group is alive or its liveness undeterminable, e.g. EPERM); **(6)** a resolved `'failed'` outcome is negative evidence — it never blocks reconcile or a later spawn; **(7)** single-flight `AttemptRunner.open()` — concurrent opens for one episode yield exactly ONE journal writer; **(8)** `validateSpawnSpec` refuses `--attempt-id` (no such CLI flag) and `--resume`+`--session` (mutually exclusive), and the default `treWorkerSpawner` emits CLI-compatible XOR argv with attempt identity via env, not argv; **(9)** the S6 state hint advances to a legitimately newer attempt but refuses a stale rewind; **dead code removed** (empty `newestPerSession` stub, unused `reservations` tripwire). Prior cycle-1 record: `docs/audits/audit-p7-report.md` (two independent families + a 10-probe live harness in `docs/audits/p7-probes/`) returned **REJECT** on the 807-line/19-test version for 8 defects — history-keyed liveness gate (probe13), group-surviving `stop()` (probe8, I1), taskId-joined fence (probe5, §14.5), concurrent-`run()` double registration (probe10, I1), hint rewind on `confirmStopped` (probe4), incompatible default argv under `stdio:"ignore"`, and `close(true)` + non-normalized roots admitting a second writer — suite green only because tests never exercised concurrency, attempt history, group lifetime, cross-task claims, or hint staleness | P7 remediation (re-audit pending) |
| P8 | **Durable accounting & authority enforcement.** Gate worker, observer, diagnostic, repair, and spawn actions independently of model judgment. Track total time/spend/turns, recovery attempts, strategy fingerprints, progress and new diagnostic evidence across restarts. Reserve/account for outstanding usage and unknown cost. Stable action ids and reconciliation prevent blind duplicate actions. Authority covers paths, commands, environment changes, approved endpoints, spending, and external effects; absence of authority is not permission. | §9, §13.2 I5/I7, S5 | **done** (audit-clean through cycle 8, 2026-11-04; contract `docs/12`; first consumer: P11, `docs/15`) |
| P9 | **Supervisor composition in two stages.** M1: one worker with P14 acceptance, P15 diagnosis, P10 planning, and P11 execution in a closed recovery loop; basic status and escalation included. M2: add DAG scheduling, two or N workers, measured endpoint capacity, shared recovery supervision, and resource/budget isolation. Observe-only mode is a validation switch, not the product milestone. | S1, S3–S7 | **M1 done (2026-11-06)** — `src/supervisor/compose.ts` (`5beb538`, contract docs/18, six audit rounds) + the host episode layer on top (W1–W10 identity/acceptance observation stack, P16 park/escalation wiring, P17 `tre.-episode` activation, P18–P20 lease/activation hardening) + the P12 merge port wired (`738b8e9`); see the 2026-11-06…10 Change Ledger rows. **M2 shipped (2026-11-12), ACCEPTANCE CLOSED (2026-11-15)** — scheduler contract docs/20 (signed off 2026-11-09, Hong approved D1–D6), `src/supervisor/schedule.ts` + `src/host/sched-gate.ts` (WIP baseline `a36b927`), five audit cycles (c1 State Preservation, c2 `--max-parallel` gate + live slots + F1/F2/F3 probes + worker housekeeping, c3 preserve-aside writers, c4 collision-proof asides, c5 atomic aside move + c5b–c5d seam/exhaustion/ownership closes, c5e failed-seam-release disclosure contract, c5f freshEpisode teardown registering removal per caller) incl. one third-family round (Sol, c5d–c5f): final Sol verdict NO production bugs remain (c5f minor only: temp-dir leak + 2 comment-wording imprecisions, closed `0868a9b`; gate 2708/2694/0/14, host-supervise 45/45, P17 14/0). Both former acceptance-close-out items are DONE (see the 2026-11-15 ledger row): the c5f fix went through acceptance rounds c6–c9, and the §11.4 observer-contention benchmark (test/m2-acceptance-bench.test.ts) has recorded, counter-proof-verified runs — Sol c9 clean PASS: "M2 acceptance: CLOSED — all m2c6/c7/c8 minors verified with counter-proofs." Full suite 2743/2729/0/14. |
| P10 | **Evidence classification & recovery planner.** Pure functions combine persisted evidence, P14 assessments, validated P15 diagnoses, authority, and ledger facts into finish/continue/investigate/repair/change-approach/escalate recommendations. No model calls or side effects here; recommendations are checked by P8 and executed by P11. Golden fixtures cover uptake versus progress and repeated-strategy detection. Advanced semantic classifiers can follow M1. | S1, S5, S7, §9 | **done** (pure; `docs/14`; consumed by P11, `docs/15`) |
| P11 | **Recovery action executor.** Executes authorized plans through P7/P8 with durable intent/outcome records: backoff/retry, confirmed-stop resume, scoped in-flight steer (P3b), diagnostic/repair dispatch, and later model/session/task transitions. Owns no independent permission grant. Bounded diagnostics and task-local repair are core M1 capabilities, not late ladder additions. P7 remains the process-control primitive; neither observer nor worker may bypass the control plane. | S2, S5, S6, §9 | **done (2026-11-04)** — `src/executor/exec.ts`: `executeRecoveryAction(plan, ctx, ports)` — §2 hostile-plan revalidation against closed tables (never obeys the plan; `hold` → `held`; strategy-mismatch/rung/decision/authority-inversion/permission-flag all refused), §3 exact port requirement per action (port-missing journals nothing; `merge` `merge-unwired`; `accept-finish` record-only), §4 intent-before-act + actionId dedup (open-intent refuses re-issue, acked-done refused, `no-effect:` replays with distinct journal ids, `executionSeq` the only disambiguator), §5 never-throws fence with per-stage error capture, §6 ack=delivery only / `progress:"none"` always / `outcomeDurable:false` on lost outcome, §7 compartment: the module imports NOTHING, nothing imports it outside tests, and mirror tables are drift-pinned against the real P10 exports (plus `ACTION_DECISION`/`ACTION_RUNG` newly exported from `plan.ts` for the pin). 78 tests (incl. 4 adversarial audit rounds; see the 2026-11-04 Change Ledger row) |
| P12 | **Tested candidate integration** (initially unwired): the §5 merge-action contract as a module — candidate construction, trusted gate bound to the exact candidate SHA, CAS advance on episode-branch head, acceptance record, conflict/head-moved → reconcile-or-park | S4, S5 | done (2026-11-05) — `src/integration/merge.ts`: `integrateTestedCandidate(req, ports)` — merge-tree candidate construction (conflicts never resolved, zero side effect), trusted gate bound to the exact candidate SHA, CAS advance of refs/heads with the `no-effect:`-provability table (docs/15 §4 step 7), §14.3 acceptance record, sticky-terminal dedup with open-tail recovery exemption, realpath+case-folded repo identity, bare/non-bare/.git/non-repo refusal taxonomy. Contract + 4 audit cycles in docs/16 (§7–§10). 58 tests |
| P13 | **Human escalation and richer viewers.** M1 includes an actionable escalation channel with evidence, attempts, blocker, and exact decision needed; Telegram has one orchestrator-owned consumer. Independent tasks may continue while one is parked. Rich matrix lanes, dashboard transport, episode replay UI, and meta-telemetry are deferred. Core observer judgment moves to P15, not an optional late LLM judge. | S5, S7, §9 | **M1 slice done (2026-11-07)** — `src/escalation/channel.ts` + the ONE consumer `src/telegram/escalation.ts` (`6b79584`, contract docs/19; durable-append-before-deliver, delivery ledger vs maxRedeliver cap surviving resolve+restart, closed fail-closed disclosure vocabulary; loop-audit cycles 1–2 `56addb1`/`971165b`, W13 refusal audit + F4b log-token round 2 `44db0a1`), park() delivery parity W12-F1/F2 (`bfd0199`, P16), escalation delivery wired through the host activation path (P17 `58542d5`). Deferred slices unchanged: matrix lanes, dashboard, replay UI, meta-telemetry |
| P14 | **Acceptance evaluator.** Classify complete/incomplete/blocked/uncertain against approved criteria and artifact-bound evidence. Prefer deterministic checks; validated model assessment handles semantic criteria without replacing required gates. Return evidence refs and remaining work, and invalidate stale assessments after relevant artifact changes. Normal stop or model self-report alone never proves completion. | S3, S5, S7, §9 | done (cross-model audit passed 2026-11-03, docs/13 §11) |
| P15 | **Investigation & recovery agent.** Event-triggered, tool-capable diagnosis over a bounded evidence packet; tools run through P8/P11. Distinguish transient errors, premature stops, task defects, environment blockers, and approval boundaries. Produce structured diagnosis, uncertainty, strategy, expected evidence, and proposed actions. Bounded investigation and task-local repair ship in M1; unrestricted recursive delegation does not. Different strategies may be tried within the aggregate budget; repeated generic nudges are not healing. | S1, S3, S5, §9 | **done (2026-11-05)** — `src/investigation/agent.ts`: `investigate(packet, ports, options)` — the §14.3 `diagnosis` producer (contract `docs/17`): closed priority rule table (approval > environment > endpoint > gate-defect > premature-stop > unknown) with confirmed/tentative confidence split at the planner bar; deterministic text-derivation over bounded packet error text (closed substring table, `text:*` markers, endpoint-context gating for generic connect words); probe loop over a 4-probe closed table (class-first selection, run-once, charge-first budget — a probe is never started when its estimate would cross `maxUsd`); advisory judge consulted ONLY for `unknown`, clamped to 0.69 (< the 0.7 bar — INV-2 ceiling), never overwrites a deterministic class; proposed actions built exclusively from the built-in table keyed on the final class (planner rungs/strategy ids, drift-pinned). Hostile-input fence on every field (own-data descriptors, never a getter, array length observed once and re-verified); never throws — worst case a valid `unknown` record. Compartment: imports NOTHING (not even `node:`), nothing imports it outside tests until P9 wires it (P9 calls it from `dispatch.investigate` per docs/17 §8). 54 tests (golden rule table + invariants INV-1..INV-9 + drift pins + Proxy/getter/pollution adversarial suites + cycle-A4 audit traps: revoked proxy, throwing getters, fractional budget, negative-usd refund, marker-reserving ref floods) |

### 11.2 Rules that bind the compartments (from the sanity check)

- **Repair is a writer act, never a reader act.** §13.1's repair-then-append
  belongs to the exclusive writer under the ownership fence (I1). P5 (and
  any tailer/viewer) consumes only complete newline-terminated records,
  buffers partial trailing bytes, and reconciles its cursor on
  truncation/replacement — it **must never truncate or terminate another
  process's file**.
- **Ingestion ≠ projection.** The tailer reports bytes and observation
  freshness; classification (worker state, `unknown`/`stale`, signals)
  happens in the projection layer (P5's projection half / P10), so a
  misreading never corrupts the record of what was read.
- **Identity before classification.** No compartment classifies run
  completion until P0 pins run/attempt identity and P2's terminal record
  ships; until then everything terminal-ambiguous is `unknown`.
- **Ownership before autonomy.** P7 (runner + reconcile) ships and is
  tested before P9 starts or replaces workers. Replay fixtures, observe-only
  runs, and recommendation-only runs validate P10/P11 before live recovery;
  none is a requirement for routine human approval in the finished product.
- **Accounting below judgment.** The budget ledger (P8) gates actions
  independently of classifier output; budgets are never recomputed inside
  a classifier from local views.
- **One contract per compartment**; a schema change is made in §2–§8
  first (Change Ledger row), then the owning compartment implements it.
  Note for parallel dispatch: P1 and P3 both touch the session/driver
  boundary — sequence them or assign one owner.

### 11.3 Dependency shape

```text
P0: close schemas, authority, acceptance, and recovery contracts
├── P1 → P2                         worker evidence (sequence shared-file edits)
├── P3a → P3b                       optional live-steering path
├── P4 → P8                         journal → accounting/authority
├── P5                              ingestion/projection
└── P6 → P7                         isolation → attempt control

P0 + P4 + P5 → P14                  acceptance evaluator
P0 + P4 + P5 + P8 → P15             diagnosis adapter / evidence packets
P14 + P15 contracts + P8 → P10      pure recovery planner
P7 + P8 + P10 contracts → P11       executor, mockable before composition
P2 + P4–P8 + P10/P11 + P14/P15
  + basic P13 escalation → P9/M1    single-worker closed recovery loop
P9/M1 + scheduler/capacity tests → P9/M2   two or N workers
P3b → P11 live-steering capability  not required for ended-run recovery
P4 + P6 + P8 → P12                  deferred tested integration
P5 + P9 → richer P13                deferred viewers/telemetry
```

This is a build dependency graph, not an unbounded runtime delegation tree.
P15 requests tools through the executor; P14/P15 are independently testable
with mock tools/model responses. P4/P5/P6 can be developed independently
once P0 pins interfaces. P1/P3 share the session/driver boundary: one owner
or sequential edits. No need to implement every advanced classifier first.

### 11.4 Milestones & validation gates (supersedes old A1–A6 ordering)

| milestone | delivers | exit evidence |
|---|---|---|
| **M0 — safe execution foundations** | P0 contracts; P1/P2 evidence; P4–P8 journal, observation, isolation, ownership, authority, and budgets | Recovery matrix foundation tests; replay unchanged; unauthorized actions denied; restart accounting and ambiguous ownership handled conservatively |
| **M1 — self-healing single worker** | P9 single-worker composition with core P10/P11, P14/P15, basic P13 status/escalation. Automatic premature-stop continuation, safe transient retry, bounded diagnostics and task-local repair, progress/acceptance checks | Interrupted tasks reach verified acceptance without routine human nudges; failed strategies redirect; unsafe or exhausted cases produce actionable escalation |
| **M2 — shared supervision for two or N workers** | P9 DAG scheduling, measured endpoint limits, on-demand observer, isolated attempts, fair recovery resource allocation | No cross-task mutation or duplicated ownership; aggregate budgets hold; one parked task does not block independent work; concurrency benchmarks include observer contention |
| **M3 — broader autonomy and operational polish** | Approved model swaps, fresh-session handoffs, broader decomposition, optional P3b in-flight steering, P12 tested integration, richer P13 views | Capability-specific recovery and acceptance tests; promotion policy explicit; improvements supported by operating evidence |

M1 includes changing a failed approach within the approved task, not merely
repeating continuation prompts. Cross-model swaps and broad task rewrites
can follow in M3. P3b is not required for recovery of an already ended run;
it is required before enabling live file steering. Automatic merging, richer
views, herdr, and meta-telemetry do not gate M1/M2.

Validate each new recovery capability with replay/fault fixtures, then
observe-only or recommendation-only trials as appropriate, then controlled
live execution under upfront policy. These are engineering release gates,
not a product default of asking the user to approve every recovery action.
No model-proposed action may bypass P8 authority or P7 ownership checks.

**Productivity evaluation:** measure interrupted tasks reaching acceptance
without human intervention, active human minutes per accepted task,
end-to-end accepted throughput, recovery spend/time, harmful/unnecessary
interventions, and regressions/rework. Compare single-worker baseline,
two-worker deterministic supervision, and event-triggered observer recovery
on comparable tasks. Slot utilization and generated output are not success
metrics; additional inference is worthwhile only when accepted results or
human attention improve.

### 11.5 Recovery-matrix mapping (acceptance ownership)

| §13.3 row | compartment tests |
|---|---|
| crash before steer persist | P3b |
| crash after persist, before observe | P3b (dedup by id, scope-aware) |
| old worker alive during recovery | P7 (I1 fence — discover-or-park) |
| task rewritten, steers pending | P3b (S2 scoping) |
| partial final JSONL line | shipped (Session.open repair, §13.1) |
| spawn ok, crash before outcome | P7 + P8 (intent/outcome records, I2) |
| ambiguous external effect | P8 (I5 reconcile-or-escalate) |
| tested candidate, head moved | P12 (CAS) |
| repeated nudges + swaps vs episode budget | P8 (I7 ledger), exercised via P11 |
| self-healing functional scenarios below | P9/P10/P11/P14/P15; authority and accounting via P8 |

### 11.6 Old linear ledger → compartments (superseded)

The pre-check sequence is kept only as a mapping — compartments replace it:
L0 (this doc) → done; L1 (`--steer-file`) → P3a+P3b; L2 (supervisor v0) →
P9/P11 (core recovery in M1, concurrency in M2); L3
(classifiers) → P10; L4 (rung-1 nudges + hygiene) → P11/P3b with P8;
L5 (envelope + matrix) → P5/P13; L6 (dashboard) → P13 (deferred, Q4);
L7 (episode record) → P13; L8 (core model judgment) → P14/P15; L9 (meta-telemetry) →
P13.

Guardrail note (unchanged): P3a/P3b touch `src/loop`/`src/cli` — not the
guardrail zone as currently defined, but **an in-run behavior seam**:
treat those commits with human-review gravity; docs/02 gains the steer-file
contract row with the implementation.

## 12. Prior art — build vs buy: herdr evaluation (2026-10-30, internet research)

**Subject:** [`herdrdev/herdr`](https://github.com/herdrdev/herdr) — Rust,
Apache-2.0, ~47k stars, v0.9.5, active (pushed within days of research).
Self-description: "the runtime your coding agents live on." A terminal
multiplexer (tmux-class) purpose-built for coding agents: background
server, detach/reattach, survives SSH drops and restarts (restores layout
and reruns a per-agent reported *resume command*), manages
workspaces → tabs → panes across local + SSH machines in one client,
runs Claude Code / Codex / Cursor / OpenCode / Gemini and ~25 others
**unwrapped** (owns the terminal, not the agent loop). Ecosystem: plugin
marketplace, desktop/mobile clients (`herdr-app`, `herdrm`, `herdr-gpui`),
`herdr-reviewr` (third-party review pane).

### Verified capability surface (from herdr.dev docs, v0.9.x)

- **State model:** every pane carries `idle / working / blocked`
  (+ `done`/`unknown` in wait semantics), rolled up to tabs/workspaces.
  Two acquisition paths: (a) screen-detection *manifests* — pattern rules
  over the live bottom of the pane, remotely updatable, debuggable via
  `agent.explain`; (b) **agent self-reports** — the *add-herdr-support*
  contract: `HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` env vars,
  three calls: `pane report-agent` (state, monotonic `--seq`, message),
  `pane report-agent-session` (session id + `resume_argv`),
  `pane release-agent`.
- **Control surface (CLI + JSON socket API):** workspace/tab/pane CRUD;
  `pane send_text / send_keys / run / read` (visible, recent,
  unwrapped, detection buffer); `agent wait --until done|blocked`;
  `agent prompt`; `agent start --kind X` (returns only after the agent is
  detected ready for input); `events.subscribe` push subscriptions with an
  explicit **`events_lost` contract** (bounded history; on overrun the
  subscriber must re-`session.snapshot` and treat events as invalidation
  signals — the same reconcile pattern S7 assumes); `worktree.create /
  open / remove` with worktree provenance on workspace records; git
  worktree-aware layouts.
- **`herdr-reviewr`** (plugin): diff pane with four scopes incl.
  *last-turn* diff, line comments bundled and sent back to the agent,
  file viewer, PR view — a shipped precedent for the "human comments flow
  back to the worker" UX this doc's fleet views assume.

### Scored against S1–S7 and §9

| schema | herdr | verdict |
|--------|-------|---------|
| S1 session-JSONL bus | ❌ observes pane buffers + reported state, never the session log | supervisor core stays build |
| S2 steer-file seam | ◐ `agent prompt` / `pane send_text` = PTY injection only (**rung 0**); no mid-run file seam | build |
| S3 task DAG | ❌ none | build |
| S4 worker workspace | ✅ `worktree.*` + per-workspace cwd/provenance | **buy** |
| S5 decision log | ❌ none | build |
| S6 episode state | ◐ server session restores *terminals*, not an episode ledger | partial |
| S7 fleet projection | ✅ strongest hit: `session.snapshot` + `events.subscribe` + state rollups + multi-machine federation **is** an S7-shaped observation feed, incl. lost-events reconciliation | **buy** |
| §9 ladder | rung 0 (PTY send) and rung 4-adjacent (close/kill pane) exist; rungs 1–3 need in-agent cooperation herdr deliberately does not provide | build |

### Conclusion (supersedes the informal pre-research assessment)

1. **Buy the herd, specifically herdr.** Spawn/topology, worktrees,
   detach/persistence, multi-machine federation, state rollups,
   snapshot/events transport, and review-pane UX precedent come free
   (Apache-2.0).
2. **The supervisor remains tre.-built and herdr-agnostic.** S1, S2, S3,
   S5, and ladder rungs 1–3 are behavior-contract work that no herd layer
   offers; the supervisor reads worker session JSONL from disk either way.
3. **tre. as a first-class herdr citizen is ~a day of harness work** and
   independent of the supervisor decision (→ Q8): map loop events →
   `report-agent(working/idle/blocked)` and report
   `resume_argv = ["tre.", "--resume", <session-id>]`.
4. If the buy proceeds, S7 gains a second transport and the supervisor
   becomes a herdr socket client (→ Q7); §9 rung 0 becomes
   `herdr agent prompt` instead of raw PTY writes.

> **R2 stress-test caveat (2026-10-30, supersedes nothing above but
> bounds it):** "buy" means *useful runtime mechanics*, not S7 authority
> (→ §8 scope pin), not a trusted steering path (→ §9 rung-0 correction),
> and not remote session-log transport (→ §8). The "~a day" figure in
> item 3 was ungrounded — see Q8's bounded-spike reframing. Do not treat
> §12 as a decided adoption; the supervisor's correctness prerequisites
> are §13, not herdr.

## 13. Recovery, durability & ownership (normative — L1/L2 acceptance)

Added by stress tests R2–R4. This section is normative: the ledged steps
may not claim "resumable" or "durable" except as defined here.

### 13.1 The torn-tail bug (repro-verified 2026-10-30; pre-fix behavior, now repaired)

PRE-FIX behavior (what the requirement below prevents): `loadSession`
tolerated a partial final line (dropped it, `droppedTornTail` = true),
**but nothing repaired the file**: `Session.open` after such a crash
appended *behind* the partial line, and the session then failed to
reload (`corrupt line N`) — a survivable crash became a permanently
unreadable session. Reproduced against the built dist: append a truncated
JSON line to a closed session → load (tolerated) → `Session.open` + one
append → reload fails. At audit time no caller truncated or repaired
(grep: no truncate/repair path existed in session handling).

**Requirement (L1 precondition, landed in `src/session/session.ts`;
audit 2026-10-30 widened it):** before an appender writes, it must, under
exclusive ownership, repair the tail to a valid newline boundary — then
append. Repair-then-append, never append-past-torn-tail. Two tail classes,
two repairs (a crash can interrupt the last append at any byte after the
previous `\n`):

- **Partial tail line** (unparseable) → truncate it away. This is the
  class the first fix shipped with.
- **Complete record that lost only its terminating `\n`** (parses fine,
  so `droppedTornTail` is false and a naive "repair only on
  `droppedTornTail`" misses it — audit found exactly one such cut out of
  a 99-cut byte matrix) → **keep** the record (`loadSession`/replay
  already count it as an entry; truncating it would desync the replayed
  context from the file) and terminate the line before any further
  appends.

Shipped: `Session.open` checks the last byte; unterminated tail → parse
it → `appendFile("\n")` (valid) or `truncate(lastNL + 1)` (partial). A
load error (mid-file corruption, bad header) throws *before* the file is
touched — repair never runs on a file `loadSession` rejects. Regression
= every-byte crash-cut matrix over the final append, asserting prior
bytes untouched and reload clean at each cut.

**Durability scoping (R3):** repairing the boundary recovers from
*process* death. It is not a power-failure guarantee: fsync policy per
record class must be stated where written (steer receipts and decisions:
sync before ack; routine messages: process-death durability only).
"Durable" in this doc means **process-death durability** unless a record
class says otherwise.

### 13.2 Recovery invariants (I1–I7)

| # | invariant | violated by |
|---|-----------|-------------|
| I1 | **Ownership fence:** one attempt may write a given session+worktree pair. A replacement worker starts only after the prior attempt is confirmed stopped (waitpid-class evidence); if stop cannot be established, **park — do not spawn**. Heartbeat/PID absence alone is not proof of stop (a disconnected worker still runs). | supervisor "helpfully" reviving tasks |
| I2 | **Reconcile before retry:** recovery cross-checks desired (graph) vs recorded (decisions/sessions) vs observed (processes, branch heads) and repairs the projections; it never blindly executes from one file. Spawn intent without recorded outcome ⇒ discover-or-park, never blind re-spawn. | crash between log and act |
| I3 | **No inference from silence:** live state not recorded is `unknown`/`stale`, never guessed. | matrix views lying |
| I4 | **Append-only queues + valid boundary:** queue files are never rewritten under a live reader; exclusive writers repair-then-append (§13.1), never read-only consumers. Offsets are optimizations, not authority. | lost/duplicated steers |
| I5 | **Ambiguous external effects never auto-retry.** A worker action with side effects outside its worktree (push, deploy, message, spend) is only replayed if idempotent/reconcilable; otherwise reconcile-or-escalate. v1 default: workers contain effects in the worktree; publishing paths are separately controlled. | double-push, double-spend |
| I6 | **Three claims, three proofs:** recorded (transcript entry) ≠ available (context-construction evidence) ≠ followed (task-relevant result). Ack grants only the first. | "steered" ≠ "fixed" |
| I7 | **Budgets span attempts:** per-task/per-episode intervention + spend budgets survive respawn/swap/restart (§9). | intervention storm |

### 13.3 Recovery test matrix (acceptance for L1; extended at L2)

(Old step ids: L1 = P3a/P3b, L2 = P9+; per-row compartment ownership in
§11.5.)

| injected failure | required result |
|---|---|
| crash before steer persist | request still eligible; no lost-and-unrecorded state |
| crash after persist, before supervisor observes | no duplicate transcript insertion (id dedup) |
| old worker alive during recovery | replacement never acquires the same writable resources (I1) |
| task rewritten, steers pending | out-of-scope requests not replayed into new revision (S2 scoping) |
| partial final JSONL line | repair to last valid boundary *before* first append (§13.1) |
| spawn ok, crash before outcome logged | attempt discovered or task parked; no duplicate spawn (I2) |
| external effect with ambiguous outcome | reconcile/escalate; no blind retry (I5) |
| candidate tested, integration head moved | CAS rejects advance; rebuild + retest (§5 merge contract) |
| repeated nudges + swaps | aggregate episode budget stops automation (I7) |
| normal run ends before required check | safe resume completes remaining work; no routine human nudge |
| transient endpoint failure | bounded backoff/retry; no replay of ambiguous tool effects |
| correctable task-local failure | diagnosis → authorized repair → check evidence; no human approval per action |
| repeated recovery strategy fails | different evidence-backed strategy or bounded investigation; no generic continuation loop |
| recovery agent proposes unauthorized repair | control plane denies it; no guard/check weakening; actionable authority request if needed |
| work changes after a passing check | stale acceptance invalidated; required checks rerun against relevant artifacts |
| ownership uncertain during diagnosis | no replacement or concurrent mutating repair; reconcile safely or park |
| recovery budget exhausted | stop automated recovery, preserve evidence, escalate; counters survive restart |
| blocked task alongside independent task (M2) | affected task parks; unrelated authorized work continues |

### 13.4 Exit classification (Q6 parking spot)

**Implemented at P2 (2026-10-30):** the durable completion record is the
terminal `runEnd {runId, reason}` entry the driver appends at agent_end
(`runId` required because a session file holds multiple runs; §2 ledger
row + session.ts `RunEndEntry`). Absence of a runEnd at the tail is
`unknown`, NEVER `crashed` (a crashed driver cannot write its own
terminal record; exit code corroborates but never replaces the entry;
only a reconciling supervisor records `crashed`, and only in its own
journal, never in the worker session file). How the reason maps to the
coarse `clean | stopped-by-guard` classes remains a supervisor-side
classification decision (P7/P13) informed by the runEnd reason + the
optional guardStop evidence entry preceding it.

## 14. P0 — Pinned wire contracts (contract closure)

This section **is** P0: the exact wire shapes §2–§9 left open. Nothing
here changes replayed context. Each contract names its implementing
compartment; the schemas in §2–§8 are the normative references and §14
closes their open fields. Field naming is binding (camelCase, `ts`/
`timestamp` per host convention: new supervisor artifacts use `ts` unix
ms; session entries keep `timestamp`).

### 14.1 Identity: runId & attemptId (P0 → consumed by P1/P2/P7)

- **`runId`** — UUID per *run* (one driver invocation against a session,
  i.e. between `agent_start` and `agent_end`). Generated by the driver at
  run start, **not** persisted by the worker session format (it is
  process-lifetime identity, §2 "not recorded"); it is attached to every
  observation envelope event and to the terminal `runEnd` entry (P2).
- **`attemptId`** — `"<taskId>-a<N>"` string (e.g. `t2-a3`). Identity of
  one supervisor-managed worker attempt across spawn/resume: **stable
  across `--resume`** (same attempt, fresh runId), incremented on
  model-swap (rung 3) and task-rewrite (rung 4). The supervisor
  allocates and increments it (persisted in S6 + the attempt record
  below); the worker never sees the string except through the steer-file
  `attemptId` field (S2).
- **Attempt record** — one `kind:"attempt"` record in
  `events/decisions.jsonl` (§14.3) per attempt, carrying `attemptId`,
  `taskId`, `taskRevision`, `sessionPath`, `model`, spawn intent/outcome
  (I2: spawn-before-outcome ⇒ discover-or-park), and worktree path.
  This is the durable answer to "which attempt owns which session file."
- **Unmanaged runs** (a bare `tre. run`, no supervisor): no attemptId;
  runId still exists for envelope/telemetry purposes. S2 `attemptId`
  check is disabled (managed mode requires the flag, §3).

**P4 attempt lifecycle clarification:** append a fresh record ID for each
spawn intent/outcome observation, retaining `(episodeId, taskId, attemptId)`.
`spawnOutcome` absent or `null` is unresolved; `"ok"` / `"failed"` resolves
that attempt. `unresolvedSpawns` projects the latest observation per tuple,
not every historical intent. This projection does not establish process
ownership or permission to respawn; P7 still reconciles observed reality.

### 14.2 Steering envelope & scoped requests (P0 → P3a/P3b)

- **Envelope metadata (S1 amendment, ships with P3a):** a persisted
  steering user message gains
  `steering: { requestId: string, source: string }` on the **message
  entry**, not inside `.content` (model-invisible; replay constructs it
  as an ordinary user message). Legacy entries without the field remain
  valid; `steering` is optional on `MessageEntry`.

  **Implemented (P3a, 2026-11-01):** the plumbing that carries the
  envelope is `SteerEntry` (`{text, requestId?, source?}`, types.ts) on
  the queue seam — `SteeringQueue.push(string | SteerEntry)` and
  `drain(): (string | SteerEntry)[]` (the union return keeps existing
  string-returning callers/mocks valid). `drainSteers` normalizes each
  item: plain strings (TTY, legacy) → `{requestId:"", source:"tty"}`
  with byte-identical delivered `.content`; envelopes pass their
  provenance onto the `steer` event's `steering?: SteeringMeta`, which
  the `runTurn` persist tap writes onto the `MessageEntry`
  (`appendMessage(message, steering?)`). The Telegram driver is the
  first envelope producer: `steer(msg, requestId?)` pushes
  `{source:"telegram"}` envelopes through the handoff buffer (buffer
  items and `attachSteerTarget`'s claimed list are `SteerEntry`; detach
  normalizes any stray strings left in a dead queue). `idle`-turn
  claims still become plain prompt text (no envelope — the message
  starts a run, it is not steered into one). The TUI busy-branch
  telegram steer (`steerTelegramBatch`) pushes the same
  `{source:"telegram"}` envelopes. P3b's `FileSteeringQueue`
  is the next producer: `requestId` = the line's `id`, `source:"file"`
  (§14.2 table), dedup scan reads the entries persisted by this path.
- **`FileSteeringQueue` input line (S2)** — full validation table:

| field | required | validation on violation |
|---|---|---|
| `id` | yes | malformed → skip + stderr count |
| `ts` | no | informational |
| `text` | yes | malformed → skip + count |
| `source` | no (default `"file"`) | — |
| `priority` | no (default `"steer"`) | anything but `"steer"` → skip + count |
| `attemptId` | managed mode only | mismatch with the run's session identity → **skip + count as `scope_mismatch`** (steer stays pending-unrecorded for the *old* attempt; supervisor reconciles per S2 scoping) |
| `taskId` | no | provenance only |

- **Dedup (transcript scan, I4):** at startup and before each drain
  window the harness scans the session file for `steering.requestId`.
  Same id + same text → no-op (already recorded; counts as acked). Same
  id + different text → reject with stderr warning, skip, **do not
  consume** (the supervisor must decide: retire the id or escalate).
  Scan cost is bounded by chunked reading; offsets are an optimization.
- **Ack definition restated (I6):** supervisor marks a steer *recorded*
  when the correlated envelope appears in the session file it tails —
  nothing more.

### 14.3 Decision-log wire records (P0 → P4/P8/P10/P11)

`decisions.jsonl` line = one JSON object, discriminated by `kind`. All
records carry `{schema:"tre-supervisor/1", id, ts, episodeId, taskId?}`.

```jsonc
// kind:"decision-intent" — appended BEFORE acting (log-then-act)
{ "kind":"decision-intent", "id":"d-0042", "ts":1730231234000,
  "episodeId":"…", "taskId":"t2",
  "actionId":"a-0042-nudge-1",           // stable; outcome & reconcile key on it
  "attemptId":"t2-a1", "taskRevision":1,
  "rung":1, "action":"nudge",
  "strategyId":"nudge:evidence:v1",      // fingerprint for repeated-strategy limits (P8)
  "expectedEvidence":"next tool call of a different family",
  "observation": { "signals":[ … §6 shapes … ], "context":{ … } },
  "authority": { "grantedBy":"episode-policy:§…", "sideEffect":"none|worktree-local|external" },
  "rationale":"…" }

// kind:"decision-outcome" — appended AFTER the action resolves (or on reconcile)
{ "kind":"decision-outcome", "id":"d-0042-o", "ts":1730231290000,
  "episodeId":"…", "taskId":"t2", "actionId":"a-0042-nudge-1",
  "acked":true,                          // §3 ack definition (delivery only, I6)
  "progress":"none|uptake|task-relevant", // uptake ≠ progress (§9)
  "evidenceRefs":["sessions/t2.jsonl#<entryId>"],
  "closedById":null,                     // a later outcome closing this action
  "notes":"…" }

// kind:"acceptance" — P14 assessment record
{ "kind":"acceptance", "id":"d-0050", "ts":…, "episodeId":"…", "taskId":"t2",
  "taskRevision":1, "verdict":"complete|incomplete|blocked|uncertain",
  "criteria":[ { "id":"gate","pass":true,"evidenceRef":"gate-run-17",
                 "checkedAtSha":"<git sha>" } ],
  "remainingWork":["…"],
  "invalidatedBy":null,                  // DERIVED at replay (fold of `evidence-invalidation` events over the prefix, v11 c9-M5) — stored null at append, NEVER mutated; a materialized replay view, not a writable field
  "modelAdvisory": null }                // optional {judge, quote, confidence} — never waives a gate

// kind:"diagnosis" — P15 record (ADVICE ONLY — §0.7: no authority transfer)
{ "kind":"diagnosis", "id":"d-0051", "ts":…, "episodeId":"…", "taskId":"t2",
  "attemptId":"t2-a1",
  "causeClass":"transient-endpoint|premature-stop|task-defect|environment-blocker|approval-boundary|unknown",
  "confidence":0.7,
  "evidenceRefs":[ … ],
  "proposedActions":[ { "rung":2,"action":"evidence-nudge-resume","strategyId":"…","authorityNeeded":"none" } ],
  "limitsRespected": { "toolsUsed":3, "spendUsd":0.02 } }
```

**(P14 amendment, 2026-11-03 — docs/13):** the acceptance record grows
three optional fields, all additive (a pre-amendment record stays
valid): `criteria[].advisory?: true` marks a criterion pass funded ONLY
by model judgment (docs/13 EV6 — never set on a deterministic criterion,
AC8); `staleEvidenceRefs?: string[]` lists evidence seen but not at the
judged artifact identity; `artifact?: {sha, dirty?, dirtyDigest?}` pins
the identity the verdict binds to (the staleness anchor, docs/13 §1/§5.1).

Reconcile rule (I2): an intent with no outcome for its `actionId` is
**open**; recovery may close it only with observed reality (attempt
record, process discovery, transcript scan) — never by re-issuing the
action (I5 for `sideEffect:"external"`).

### 14.4 Task revision & scoping (P0 → P3b/P10)

- `task.revision` — integer starting at 1, bumped **only** by rung-4
  task-rewrite (desired-field edit, §4). A steering request carries
  `(taskId, attemptId)`; on rewrite the attemptId changes (new attempt)
  and pending requests for the old attempt are skipped by the harness
  (§14.2) — satisfying S2's "not auto-replayed" rule mechanically.

### 14.5 Ownership record (P0 → P6/P7)

No new file: ownership is *derived*, per I1/I2 — the pair (session file,
worktree) is owned by the attempt whose `kind:"attempt"` record is
latest-unresolved for the task **and** whose process is either confirmed
alive (child of current supervisor) or not disproven. Loss of the
supervisor ⇒ the record does not transfer; the restart reconcile is
discover-or-park. A second harness must refuse to open a session+worktree
pair with an unresolved attempt record **when the episode dir is
supervised** — enforced at P7 (it requires the episode context; the bare
harness stays flag-driven).

### 14.6 `progressNudge` entry (P0 closes Q2b; P1 implements)

Standalone session entry, mirroring `GuardStopEntry` exactly (harness
metadata, replay-ignored, additive, format version stays 1):

```ts
{ type: "progressNudge"; id: string; timestamp: number;
  kind: ProgressKind;              // "no-success" | "no-verification" (types.ts)
  mode: ProgressMode;              // "watch" | "nudge" | "stop" — the mode the
                                   // run was in when it fired (types.ts), mirroring
                                   // the live event's attribution semantics
  turn: number;                    // loop turn the condition fired on (event parity)
  count: number;                   // threshold-crossing count (event parity)
  target?: string;                 // normalized path — "no-verification" only
  runId?: string }                 // §14.1; optional → valid for unmanaged runs
```

Driver-appended (main.ts, same seam as `appendGuardStop` ~1112) when the
loop emits `progress_nudge` — **every fire persists, in every mode**
(§14.8 counts warn evidence from all modes; mode attribution rides the
entry). The event fires once per episode per kind (loop-side anti-spam,
docs/08 §9), so entry volume is bounded without a harness-side cap.
Replay ignores unknown/non-context types by fall-through → replayed
context byte-identical.

*(Amended 2026-10-30 at P1 implementation: the first pin said
`mode:"warn"|"stop"` and omitted turn/count/target; the real `ProgressMode`
is `"watch"|"nudge"|"stop"` and consumers (/stats_progress attribution,
§14.8 classification) need the event-parity fields. Change Ledger row
below.)*

### 14.7 Episode & task policy shapes (P0 → P8/P9/P12)

Desired-input only; the supervisor reads these, workers never do.

```jsonc
// episode policy (graph.json "policy" object; defaults in [] )
{ "baseCommit": "<sha>",
  "gate": { "cmd": "npm run check", "timeoutS": 1200 },
  "approval": "auto|ask",                    // worker approval mode for tasks (S3 "approval")
  "maxParallel": 2,
  "recoveryBudget": {                        // I7 aggregate limits (defaults)
    "maxAttemptsPerTask": 4,                 // [4]
    "maxNudgesPerTask": 2,                   // [2] (§9 rung-1 rule, machine-checked)
    "maxStrategyRepeats": 2,                 // [2] same strategyId per task before strategy must change
    "maxEpisodeRecoveryUsd": 6.0,            // [episode-dependent, required in managed episodes]
    "maxEpisodeRecoveryTurns": 60,           // [60]
    "maxWallclockPerAttemptS": 1800          // [1800]
  },
  "authority": {                             // upfront grants; ABSENCE = NOT permitted (§9.1)
    "paths": ["src/**", "test/**"],
    "notPaths": [".git/**", "~/.tre/**"],
    "allowInstalls": false,                  // [false]
    "allowNetwork": true,                    // [true] within worker's existing sandbox
    "allowExternalEffects": false,           // [false] push/deploy/msg ⇒ escalate (I5)
    "models": ["local/qwen3-…"],             // approved endpoints for swaps (rung 3)
    "diagnostics": { "maxToolCalls": 20, "maxUsd": 0.5 }   // [20 / $0.50 per diagnosis]
  },
  "integration": { "autoMergeTested": false, "promoteToMain": "ask" }  // Q5, M3-gated
}
```

Task `budget` (S3) caps are **per task across attempts** (I7): the P8
ledger accumulates usage from every attempt's session entries against
the task's lifetime totals; a swap or resume never resets them.

### 14.8 Observation envelope `workerState` (P0 → P5)

Closed set (S7), rules-only classification, `unknown`/`stale` mandatory
where evidence ends (I3):
`thinking | tool | await-approval | warned | stopped | dead | unknown`.
Mapping (deterministic, from persisted + ephemeral evidence only):
`tool` ← tool_execution_start without end (ephemeral); `warned` ← last
persisted warn entry (toolResult details / a `progressNudge` entry) with
no later successful tool call; `stopped` ← `guardStop`/`runEnd` at tail;
`dead` ← process confirmed gone without terminal record; otherwise
`unknown`. `stale` is an envelope-level flag (no new byte for
> `staleAfterMs` [default 300000]), not a workerState value.

### 14.9 P0 closure checklist

| contract | closed by | status |
|---|---|---|
| runId/attemptId (§14.1) | this section | done |
| steer envelope + validation (§14.2) | this section | done |
| decision record kinds (§14.3) | this section | done |
| task revision (§14.4) | this section | done |
| ownership derivation (§14.5) | this section | done |
| progressNudge shape (§14.6) | this section | done → P1 implements |
| policy shapes (§14.7) | this section | done |
| workerState set (§14.8) | this section | done |
| audit-finding records (§14.10) | G1 draft v2 (owner round-1 R1–R8 folded 2026-11-15) | drafted — NOT implemented; post-closure additive |

P0 is **closed** by this section; P0-dependent compartments may start.
Wire-shape changes after closure require a Change Ledger row before code.

### 14.10 Audit-finding records (G1 — the loop's classification hinge)

**Status: DRAFT v4 (2026-11-17) — v2 + G5 `scopeRefs` amendment (§14.14.1)
+ v4: route×surface note extended for the G2 intake gate (§14.11.4 seam
fix, round-0 audit finding M9).
Owner review round 1 folded (decisions R1–R8 recorded at §14.10.4). NOT IMPLEMENTED; post-P0 additive wire
shape per the §14.9 closure rule. No module is touched by this section.**

**Purpose.** The autonomous audit-fix loop (HANDOFF 2026-11-15, owner
goal) hinges on routing: an auditor's finding must carry machine-
checkable CLASS so the orchestrator can route without interpreting
prose — fix-worthy findings re-enter the implementation loop, spec
findings become human-review items, accepted residuals are recorded and
never re-litigated. §14.3's kinds cover what the supervisor decides and
observes about its own actions; none represents an audit finding. This
section adds TWO record kinds — `audit-finding` and
`audit-finding-update` — in the episode's decision log (S5,
`events/decisions.jsonl`), same envelope, same durability discipline.
§0.7 holds unchanged: control logic keys on the closed fields only;
free-text fields are advisory, never parsed.

#### 14.10.1 `audit-finding` — wire shape

One JSONL line per finding. Common envelope
`{schema:"tre-supervisor/1", id, ts, episodeId}` (taskId optional — a
finding may name the contract, not a task). `id` is **supervisor-minted
at intake: fresh conforming ULID (F55/F56 precedent), collision-
refused; caller-suggested ids are test-only** (R7). A finding record is
immutable and starts `open` — **it carries no disposition field**; all
state changes flow through `audit-finding-update` (§14.10.2).

```jsonc
{ "kind":"audit-finding", "id":"01J…ULID", "ts":1730231300000,
  "schema":"tre-supervisor/1", "episodeId":"…", "taskId":"t2",   // taskId optional
  "cycle":4,                          // audit round that produced it
  "auditor":{ "endpoint":"…", "model":"gpt-6.1-terra", "sessionId":"…" },
  "route":"code-fix | human-review",               // THE routing field (R1-B)
  "surface":"code | test | doc | spec",            // artifact domain (R1-B)
  "severity":"blocker | major | minor",
  "verdictBasis":"repro | evidence-only | opinion",
  "claim":"…",                        // bounded summary, ≤2000 chars, single line
  "findingRef":"findings/f-0061.md",  // REQUIRED: full-prose artifact in the episode dir (R5-A)
  "scopeRefs":["src/runner/attempt.ts"],  // G5 (§14.14.1): repo-relative paths/#anchors; [] = unscoped, serial
  "repro":{ "kind":"probe|fixture|session-log|none", "command":"…",
            "preFixObserved":"…", "postFixExpected":"…" },
  "evidenceRefs":["sessions/t2.jsonl#<entryId>"],  // ≥1 required
  "affectedNorm":{ "doc":"docs/21-p9-m3-…", "anchor":"§1.1 (c) step (2)",
                   "sha256":null }                 // or null (R6)
}
```

Field rules (closed vocabularies; an unknown value makes the record
invalid — the receiver refuses the line and surfaces it, never silently
drops it):

- **`route` × `surface` (R1-B).** `route` is the ONLY field the
  orchestrator routes on: `code-fix` re-enters the implementation loop;
  `human-review` goes to the owner ledger (G2's norm state — out of
  scope here). G2 (v2) does NOT re-route records — it gates intake: a
  `code-fix` record failing a G2 norm check is **refused at intake**
  (`refusal-code` journaled as an S5 decision-log record naming the
  refused line's content hash — the line never becomes an
  `audit-finding`, so the auditor's immutability rule is untouched;
  a corrected resubmission is a NEW record in the next cycle), and any
  G2 blocker or
  stale-norm situation is filed by the SUPERVISOR as its own
  `human-review` record. One mutable record never overrides another's
  route. `surface` (the R5 round's proven vocabulary) records
  where the defect lives: `code | test | doc | spec`. Intake rule:
  `surface:"spec"` with `route:"code-fix"` is **invalid** — a fix whose
  substance is changing ratified norm text cannot self-route into a
  code cycle; everything else may pair freely (a TEST-major is
  normally `route:code-fix, surface:test`).
- `severity` — the repo's blocker/major/minor audit vocabulary.
  **Minors never hold a sign-off by themselves; the owner decides
  whether any given minor holds** — escalation is a recorded
  `finding-hold` record (14.12.4, `dispositionBy:"owner"`,
  TTY-confirmed; v4 — supersedes v1's "audit-finding-update" wording,
  which predated the hold record kind; R4).
- `verdictBasis` — records that a finding reproduced against pre-fix
  behavior outranks one argued from reading. Whether an `opinion`-basis
  finding may hold a sign-off open is a **convergence** question:
  §14.10 supplies the basis, **G3 owns enforcement** (R8).
- `claim` — bounded single-line summary (S5 record discipline); the
  full finding (location, scenario, fix direction — real findings run
  to several hundred words) lives in `findingRef` (R5-A). The episode
  layout (S4) gains `findings/` accordingly; this section amends S4 by
  adding that directory — file naming within it is open, log-line
  machine-checkability is not.
- `repro` — required (`kind` ≠ `none`) when `route:"code-fix"` AND
  `severity` ≠ minor: an unfalsifiable blocker/major is refused at
  intake (`finding-intake-invalid`). Lesson of record: a claim the next
  cycle cannot re-run wastes a full cycle (p9m3 findings fresh every
  cycle through 4). **Acceptance contract (R4): a transition to
  `accepted-fix` is only meaningful if the finding's repro was re-run
  against `postFixExpected` and observed green** — enforcement of that
  check belongs to the consumer (G2/G3); this section pins its
  semantics.
- `evidenceRefs` — ≥1 session-log or decision-log entry id. Forensics
  rule (D-round): the orchestrator's own echoes are not evidence.
- `affectedNorm` (R6) — an OBJECT `{doc, anchor, sha256}` or null
  (null = pure-code finding, no norm implicated). `anchor` is
  free-text locant; `sha256` (digest of the anchored text at reference
  time) is **optional until G2 rules** whether digests are mandatory —
  reserved now while amendment is free. A finding binds AT MOST ONE
  norm; a finding touching several splits into several records (a
  primary `claim` may name the others in prose).

#### 14.10.2 `audit-finding-update` — disposition transitions (R2-A)

The second kind — fully specified here so no lifecycle is ever inferred
from two encodings:

```jsonc
{ "kind":"audit-finding-update", "id":"01J…ULID", "ts":1730231300001,
  "schema":"tre-supervisor/1", "episodeId":"…",
  "findingId":"01J…ULID",             // MUST reference an existing audit-finding id
  "to":"accepted-fix | rejected-duplicate | closed-residual | superseded",
  "dispositionBy":"orchestrator | owner",
  "authority":null,                    // REQUIRED non-null for closed-residual (see below)
  "supersedes":null,                   // REQUIRED non-null findingId for rejected-duplicate AND superseded
  "reason":"…" }                       // bounded single line, advisory
```

- No `from` field: current state is derivable by log order (single-
  writer flock discipline, S5). Intake rule: a transition applied to an
  already-closed finding is **invalid** (refused) — reopening requires
  the owner filing or re-filing, never an update chain resurrection.
- `closed-residual` records (the old `residual-risk-accepted` class —
  residual acceptance is a DISPOSITION, not a finding class) require
  `authority`: a reference to the accepting owner channel (CLI session,
  ledger line) or a pinned policy clause. An unbacked residual
  transition is invalid.
- `rejected-duplicate` and `superseded` require `supersedes` naming the
  surviving finding — the old "companion record" half-mechanism is
  gone; one encoding, here.

#### 14.10.3 Emission authority (R3)

A shared flock-guarded log has no cryptographic signer; authority is
structural, same posture as F53 (mint, don't trust):

- **Auditor workers append `audit-finding` records only** — via
  supervisor intake (which validates and mints the id). They never
  append updates.
- **The supervisor is the sole appender of `audit-finding-update`.**
  `dispositionBy:"owner"` requires a recorded owner channel behind it:
  owner dispositions originate ONLY from the TTY-confirmed operator CLI
  act (the D2 human-gate precedent, docs/21 §4) and carry its
  reference in `authority` (or the pinned policy clause for residuals).
  The attack this closes: an implementer (or an eager orchestrator)
  downgrading its own blocker to `closed-residual` — the field alone
  could not stop it; the emitter rule can.
- **Enforced provenance boundary (v6, c4-M11):** the threat model is
  the shared machine — any process with filesystem access to S5 can
  forge any string, so an `authority`/`runner` field is NEVER proof of
  origin on its own. The enforcing layer is the **append API**: S5
  direct file access is restricted (0600, supervisor-owned) and there
  is NO general-purpose writer — privileged kinds
  (`policy-revision`, `repro-run`, `spend-reconciliation`,
  `finding-hold`/`-lift`, owner dispositions, `scope-escape-resolution`)
  are appendable ONLY through supervisor entrypoints that are
  themselves reachable only from (i) the trusted-gate/supervisor
  process path (repro-run: the gate runner is a supervisor-executed
  child; its record is written BY the supervisor from the child's
  evidence and bound to `runEvidenceRef`), or (ii) the TTY-confirmed
  operator CLI (the P17 activation precedent): a TTY act appends a
  durable **owner-act record**
  `{ kind:"owner-act", id, ts, episodeId, op:"<exact operation>",
  payload, payloadDigest:"sha256:<canonical payload>", channel:"tty:<dev>",
  sessionRef }` FIRST, and every privileged record's `authority` field
  names that owner-act id; validation replays the owner-act, re-digests
  the payload it bound, and refuses on ANY mismatch (op, digest,
  channel) — channel-to-payload binding is the check, not the string.
  **Payload IN the record (v11, c9-B3): the record stores the FULL
  canonical payload bytes, not a digest alone** — a digest-only act
  is unrecoverable exactly when recovery needs it most: if the queue
  file that carried the act is gone, a digest cannot reconstruct the
  missing effect, so authorized authority would silently lapse. The
  act is therefore self-contained: `payload` (canonical bytes,
  ≤ 16 KiB — payloads are closed per-op schemas, none is larger)
  AND `payloadDigest` over those bytes; validation checks the two
  agree, and that the queue entry (while it exists) matches both.
  A worker-originated privileged record (no valid owning owner-act, or
  digest mismatch) is malformed ⇒ refused at intake AND ignored by
  replay; finding the string "tty:…" in a payload proves nothing.
  **Trust-boundary limits, stated honestly (v7, c5-M1):** this is a
  same-OS-user threat model and its residual limits are part of the
  contract, not hidden by it: (i) a process running as the supervisor's
  OS user that bypasses the append API CAN in principle open the 0600
  file — the enforcement holds against every process that goes through
  the API (the only supported write path) and against separate-user
  attackers by file permissions; closing the same-user bypass would
  require OS-level isolation (separate uid / sandbox) for the CLI and
  worker processes — an OWNER DEPLOYMENT choice, recorded here as a
  declared limit, not claimed enforcement; (ii) a compromised supervisor
  process can mint both owner-acts and privileged records — the
  contract's guarantees assume an uncompromised supervisor and name it
  (Tcb-1 style: the trusted computing base IS the supervisor; nothing
  in the log self-certifies against a corrupted writer). `channel:
  "tty:<dev>"` plus `sessionRef` record WHERE the confirmation was
  collected (the interactive TTY the operator typed at, per the P17
  activation precedent); the human binding is the interactive
  confirmation step in the CLI process, and its forensic trail is the
  owner-act — again with the same limit: an OS-level impersonator is a
  deployment concern (uid separation), not a log-level one.
  **Owner-act payload canonicalization (v7, c5-M1; closed per-op
  schemas v8, c6-M7):** `payloadDigest` is computed over the CANONICAL
  payload of the one operation the act authorizes, using the SAME
  pinned canonicalizer as policy bytes (`tre-canonical-json/1`, §14.12
  v8 pins incl. Unicode NFC and the numeric domain — ONE
  canonicalizer for the whole contract, not two dialects), domain-
  separated by prefixing the bytes `"tre-owner-act/1\n" + op + "\n"`.
  The payload field set is a CLOSED SCHEMA per operation (v8 — a
  validator may NEVER omit an authority-relevant field; omitted
  optional fields are represented as explicit `null` so their absence
  is digest-visible):
  - `finding-disposition`: `{ findingId, fromStatus, toStatus,
    basisRef|null, reproRunRef|null }`
  - `finding-hold` / `finding-hold-lift`: `{ findingId }` — the
    resulting record's `dispositionBy`/`authority` are supervisor-
    stamped, not act-bound; the act binds the finding it escalates
    (v9, c7-B1: without these ops a TTY hold confirmation would be
    refused by the closed-schema rule itself)
  - `norm-transition`: `{ normId, from, to, expectedRevision,
    sha256|null, anchorTextRef|null, supersedes|null }` — exactly
    reconstructible from the resulting §14.11.2 transition record
    (v9, c7-B1: ratify/reject/supersede ARE owner acts under §14.7;
    v8 enumerated every act EXCEPT the contract's most common one)
  - `policy-revision`: `{ revision, digest, policyRef, canonicalizer }`
    — the §14.12.3 record's authority-relevant fields (v9, c7-B1)
  - `scope-escape-resolution`: `{ escapeId, taskId, decision, authId,
    noteDigest|null }` — field-for-field with the §14.14.4 resolution
    record (`noteDigest` = canonical sha256 of the record's `note`, so
    the note's bytes are bound; v9, c7-B1: the v8 payload
    `{escapeEventId, scopeDigest, resolutionTextDigest}` named fields
    the record does not HAVE — no supervisor could reconstruct it from
    the record's own fields, so every such act refused or bypassed
    verification)
  - `scope-escape-waiver`: `{ escapeId }` (record fields `{escapeId,
    authority}`; v9, c7-B1 alignment — v8 folded it into the
    resolution schema it does not share)
  - `remote-terminal-disposition`: `{ unprovenRecordId, cycleId,
    dispatchIds[] (sorted), disposition, evidenceRefs[] (sorted),
    residualCapUsd|null (required non-null iff
    disposition:"accept-residual-risk"),
    acknowledgment|null (v12 audit fix — §14.13.4a's
    sustained-unreachability class (iii) REQUIRES the disposition to
    carry `acknowledgment:"unreachable-is-not-non-support"` but the
    closed payload did not have the field, so a conforming validator
    refused the very disposition the rule demanded — same defect
    class as c8-M15's `outcome`): REQUIRED non-null
    `"unreachable-is-not-non-support"` exactly when the
    terminality-inability evidence for this disposition is class
    (iii) sustained-unreachability, REQUIRED null otherwise; a class
    (iii) disposition without it, or a non-(iii) disposition
    carrying it, is refused at validation)`
    (`unprovenRecordId` added
    v9 per c7-B4 below — one source of truth; `residualCapUsd` v9
    c7-B4 binds the bounded-unknown charge into the same act)
  - `history-integrity-disposition`: `{ faultId, decision, explanationDigest|null, voidedQueueIds|null }` — `decision` ∈ {accept-recomputed, external-explanation, retire-duplicate-channel} (v18, cycle-11 self-audit finding 5); `retire-duplicate-channel` (valid only on a `channel-id-collision` fault) REQUIRES `voidedQueueIds` = the sorted queueIds of EXACTLY the undrained entries whose `channelOpenRecordId` equals the fault's affectedRecordId at disposition (any other set refused) and `explanationDigest` null; every other decision REQUIRES `voidedQueueIds:null`. Retirement (v19, cycle-12 audit finding 5): the disposition records the channelOpenRecordId as RETIRED under the S5 flock; every later queue append carrying it is REFUSED; a listed entry is VOIDED — it is EXCLUDED from pair formation in the pre-drain duplicate scan, from drift checks, and from P1–P3 (v20, cycle-13 finding 5 — v19 excluded voided entries from P1–P3 but the separate every-entry duplicate scan still formed pairs from them), is never drained, and the list is complete because no later append for the retired channel can land. **Drained entries of a retired channel (v21, cycle-14 finding 3; closure predicate and residual mechanism corrected v22, cycle-15 findings 2–3):** a DRAINED entry is consumed fact and is NEVER voided or un-run (same invariant as an accepted ledger entry). Fault closure at retirement is THREE-WAY, and the three cases are exclusive and total for the retired channel's faults:
  (a) a `queue-receipt-divergence` fault whose affected entries ALL belong to the retired channel (drained or voided) — the SAME predicate as §14.12.3 (v21's weaker "affectedRecordId is an entry of" text is WITHDRAWN: it closed mixed-channel faults here but not there, letting replays disagree) — is closed BY the retirement disposition itself (the disposition names the retired channelOpenRecordId, and closing scope follows from the record, never from an owner assertion); a fault already closed is never re-closed (idempotent per fault identity; the retirement whose predicate first holds owns the closure);
  (b) every OTHER outstanding fault arising from the retired channel's duplicate triples — a mixed-channel divergence fault (an affected entry drained on another channel; §14.12.3 invariant), or an execution-side-effect fault from a drained act (a duplicate-act dispatch or receipt) — is NOT closed by the retirement. Such a fault is dispositioned INDIVIDUALLY, by its own ordinary `history-integrity-disposition` appended BEFORE the retirement disposition: the retirement's append-time validation REFUSES (prefix stays clean, nothing retires) while any fault in class (b) touching the channel is still open. Validation order is therefore deterministic on replay: run the §14.12.3 DETECTION BARRIER first — every scan of the pinned pre-append prefix durably appends its still-missing fault records before the retirement may append (v25, cycle-18 finding 5; validation enumerating a stale durable fault set while a detectable fault is unrecorded is NOT equivalent) — then enumerate the channel's faults from the durable fault set → class (b) must all be closed already, else refuse → close class (a) with the retirement record. (v21 said the retirement disposition itself "must name each such fault and disposition it individually" — the closed payload `{ faultId, decision, explanationDigest|null, voidedQueueIds|null }` has NO field able to carry a fault list or per-fault decisions, so the requirement was inexpressible; the individual-disposition route needs no new field and binds each residual to the fault-identity and decision rules that already govern single-fault dispositions.)
  (c) where a residual effect cannot be ESTABLISHED at all — an executed (drained) act whose side effects cannot be enumerated from the durable record set — retirement is REFUSED for the channel and the case escalates `needs-owner`: fail closed; the v18 invariant "a disposition never claims what it cannot establish" governs the channel case (v19 retired unconditionally and left drained-entry faults undisposed).
A queue-receipt-divergence fault whose drifting entries are all voided is disposed by the retirement itself (v20, finding 5; drained-only entries disposed by clause (a), v21); a retire-then-restart scan therefore yields no new fault. An empty list is valid
  - `budget-extension`: `{ supersedesRevision, newMaxCycles|null,
    newMaxUsd|null, newMaxWallclockS|null }`
  - `spend-reconciliation`: `{ targetKind, targetId, component,
    acceptedUsd|null, acceptedElapsedS|null, providerAccountId|null,
    providerRecoveryEvidenceRef, supersedesReconciliation|null }` — the §14.13.4a record's fields (v18, cycle-11 self-audit finding 2: the field was missing from the owner payload)
    exactly; `providerAccountId` (v15, cycle-10 audit finding 8 —
    §14.13.4a REQUIRES it on every owner reconciliation record
    naming usage, yet this closed payload omitted it: a conforming
    owner could not authorize a spend reconciliation without
    violating either the payload schema or the stream-identity rule)
    is REQUIRED non-null when `component:"spend"` targets a
    dispatch-attributable unknown (it names the provider stream
    `(providerAccountId, dispatchId)` the reconciliation closes),
    and legal ONLY as null when `component:"elapsed"` (elapsed has
    no provider — v5) or `targetKind:"cycle"` overhead
    non-attributable to any provider stream; a null where required,
    a value where forbidden, or a `providerAccountId` not matching
    the target's stream ⇒ refused at validation;
    `providerRecoveryEvidenceRef` is the content-addressed
    ref of the nested provider-recovery evidence (v9, c7-B1: the v8
    payload `{cycleId, component, usd, providerStatementRef}` matched
    neither the record's target identity (`targetKind`/`targetId`) nor
    its REQUIRED recovery evidence, and `providerStatementRef` is not
    recovery evidence)
  - `elapsed-reconciliation`: `{ targetKind, targetId,
    acceptedElapsedS, method }` (v9, c7-B1: same record alignment)
  - `dispatch-authorization-drop`: `{ authorizationId }`
  - `evidence-invalidation` (v11, c9-B4 — §14.12.2 r4 consumes
    invalidated evidence but NO op in the closed enum carried it, so
    a conforming validator refused the invalidation the contract
    requires): `{ targetKind:"repro-run"|"acceptance",
    targetRecordId, reason, reasonEvidenceRefs[] (sorted, ≥1) }` —
    the target's authority chain is validated at append: the
    referenced record must exist and be of `targetKind`, and the
    invalidation record's own `authority` names the consuming
    `owner-act` id per the standard binding (no separate
    `ownerActRef` field — ONE binding mechanism, v11 c9-B4). It is
    an APPEND-ONLY invalidation EVENT (the target record is never
    mutated; the target's durable `invalidatedBy` reading is DERIVED
    at replay by folding this event over the prefix — v11, c9-M5: an
    immutable record's own field can never transition null→id under
    append-only, so the fold is the ONLY legal mechanism);
    qualification of the target fails from the invalidation's log
    position forward, for re-runs AND for replays that previously
    saw the target as qualifying (replay is deterministic: same
    prefix ⇒ same derived state). `reason` is a closed enum
    `disproven|stale-lineage|forged-digest|owner-withdrawal`; ≥1
    evidence ref is REQUIRED — an invalidation without evidence is
    itself a doctrine violation (absence of evidence is never a
    proven negative).
  - `deferral-loop-disposition`: `{ loopRecordId, decision:
    "close-terminal-outcome|grant-new-window|waive-receipt",
    newWindowId|null (required non-null iff
    decision:"grant-new-window"), explanationDigest|null }`
    (v11, c9-B4: §14.14.5's cap exits name an owner disposition for
    the `deferral-loop` state but no schema existed, so every
    lift-route record the state machine emits was unproducible;
    `grant-new-window` is the SOLE laundering-counter reset and its
    new window is a fresh record with fresh lineage citation, never
    an edit of the capped chain — see §14.14.5 v11 lifecycle)
  - `residual-cure` (v10, c8-M5 — the §14.12.2
    `residual-re-resolution` route of v9 required
    `authority:"tty:…"` but no op in this closed enum could carry
    it, so the contract's own cure was refused by the completeness
    rule that mandates it): `{ findingId, survivorId,
    route:"accepted-fix|fresh-finding-cycle", evidenceRef }` —
    field-for-field with the §14.12.2 record (v9, c7-M7 shape;
    `evidenceRef` = the repro-green artifact ref for
    `route:"accepted-fix"`, or the new finding id whose lineage
    cites the record for `route:"fresh-finding-cycle"`; REQUIRED
    non-null in both routes — the route is unfunded without it).
    One act cures ONE (`findingId`, `survivorId`) pair; the
    record's `authority` is supervisor-stamped from the act, as
    everywhere.
  **Completeness & binding (v9, c7-B1):** the enumeration is CLOSED
  and COMPLETE — every privileged record kind in §14.11–§14.15 whose
  intake requires owner authority MUST have a listed op schema; a kind
  without one CANNOT receive an owner-act (refused at validation), new
  kinds require their schema added here first, AND an implementation
  conformance test walks the §14.11–§14.15 owner-authorized record
  kinds against this list (a kind in the sections with no op schema is
  a contract defect caught by the test, not at runtime surprise).
  Every payload binds EVERY authority-relevant field of its resulting
  record: the supervisor's independent reconstruction (below) checks
  both digest equality AND field presence — a resulting-record field
  that affects the disposition but is absent from the op schema makes
  the record REFUSED, never accepted on a partial digest.
  **The TTY confirmation binds the FULL supervisor-verified
  operation (v9, c7-B1; display strengthened v10, c8-M5):** the CLI
  displays the supervisor-resolved `op` and the COMPLETE canonical
  payload — EVERY field and value rendered from the exact
  supervisor-verified canonical bytes, explicit `null`s included
  (v10: a digest alone proves byte consistency of something, not
  that the operator read the right thing — informed confirmation
  requires the operator to see every authority-relevant value, e.g.
  a `survivorId` or `residualCapUsd` differing from intent), PLUS
  the canonical payload digest (for operator cross-check against
  their own channel record), BEFORE collecting the confirmation, and
  the `owner-act` record carries `op` + `payloadDigest` recomputed
  and verified by the supervisor (a CLI assertion alone never
  confirms an operation the display did not show). **Verification (v8):** the SUPERVISING
  process independently reconstructs the canonical bytes from the
  privileged record's own fields under the op schema and recomputes
  the digest; the CLI-supplied `payloadDigest` is compared against the
  supervisor's recomputation and the record is REFUSED on any
  mismatch — the CLI's digest is a claim, the supervisor's
  recomputation is the check (a malicious/deviating CLI cannot slip a
  payload by serializing differently). Confirmation of the operation
  itself binds via the interactive channel record as before; the
  compromised-supervisor and same-user limits above still apply
  unaltered. **Consumption (v7, effect-bound v10, c8-B1/c8-M5):**
  one owner-act authorizes exactly ONE privileged record — OR one
  atomic group (the successor-ratification group of §14.11.2 is ONE
  authorized effect: consumption counts the whole group once; a
  half-applied group is malformed per §14.11.2 framing, so partial
  consumption cannot occur) — validation
  refuses a second privileged record naming the same owner-act id
  (redelivery of the identical privileged record is idempotent by ITS
  record id; a different payload under a consumed act is refused);
  multi-operation intent requires multi-field payloads defined per op
  or separate acts.
  **Effect binding (v10, c8-B1):** the `owner-act` record carries
  `effectRecordIds` — the ids of the authorized privileged record(s):
  exactly one id, or exactly the member ids of the authorized atomic
  group. `effectApplied` is a replay-DERIVED state: true iff every
  named record exists in the log and validates against the act's op
  schema. An act with `effectApplied:false` is an **outstanding
  effect**: class B in the §14.12.2 finalization decision table (the
  supervisor owes the effect and can complete it) — no CLEAN boundary
  appends while a drained act's effect is owed
  (v11, c9-B3 precision: the UNCLEAN route via B→O conversion exists
  exactly as the §14.12.2 table defines it — `needs-owner`, effect
  still owed — but AUTHORITY never converts: the act is unconsumed
  until its effects validate), and
  an un-drained queue entry (class B) or a class-O-shaped act follows
  the queue rules — an acknowledged act NEVER closes a CLEAN boundary
  its effect has not entered.
- The orchestrator routes on `route` alone and holds no disposition
  power beyond `accepted-fix`/`rejected-duplicate`/`superseded`
  bookkeeping transitions.

#### 14.10.4 Owner decisions — review round 1 (2026-11-15)

Verbatim owner replies on the eight review points; folded as this v2:

| # | Point | Owner decision |
|---|-------|----------------|
| R1 | taxonomy: HANDOFF four classes vs the loop's CODE/TEST/DOC/SPEC | **B** — two-dimensional `route` × `surface` (§14.10.1) |
| R2 | undefined transition-record shape; duplicate supersede mechanisms | **A** — explicit second kind `audit-finding-update`, fully specified (§14.10.2) |
| R3 | forgeable dispositions | **emission-authority paragraph** (§14.10.3): findings=auditors via intake, updates=supervisor only, owner-dispositions from the TTY-confirmed channel |
| R4 | repro gate bypassable by severity-downgrade | **ok as cheapest fix** — minors never auto-hold a sign-off; owner alone decides whether a minor holds (recorded escalation); `accepted-fix` binds to the repro re-run green (§14.10.1 acceptance contract) |
| R5 | 2000-char claim can't hold a real finding | **A** — bounded `claim` + REQUIRED `findingRef` to the full-prose artifact under the episode's `findings/` (S4 amendment) |
| R6 | `affectedNorm` locant churn | **accept** — object `{doc, anchor, sha256}`; digest mandatory-or-not is G2's ruling, field shape reserved now |
| R7 | sequential caller-chosen ids | **one sentence** — supervisor-minted fresh conforming ULID, collision-refused, caller ids test-only (F55/F56 precedent) |
| R8 | opinion sign-off rule was G3's job in G1's text | **accept** — §14.10 supplies `verdictBasis`; G3 owns enforcement |

#### 14.10.5 What this section does NOT do

- No routing implementation (consumer's job, post-G2) — `route` is the
  contract the router consumes, nothing more.
- No norm state: `affectedNorm` POINTS at ratified text; it does not
  create, gate, or version it (G2, separate section).
- No convergence/stop rule: G3 owns the k-consecutive-clean +
  family-diversity condition AND the severity/opinion sign-off
  enforcement; this record only supplies its inputs (`auditor.model`,
  `severity`, `verdictBasis`, close transitions).
- No autonomy claim: kickoff, design-cycle budget (G4), and finding
  partitioning (G5) are separate open compartments. G2–G5 are drafted
  in §14.11–§14.15 (DRAFT v2 after the round-0 audit, not ratified).
- No transport: records land in the local episode log; cross-host
  collection stays Q4 (file-only until transport decides).

### 14.11 Spec norm state (G2 — ratification as parseable state)

**Status: DRAFT v34 (2026-11-18), batched draft of G2–G5 (§14.11–§14.14).
v34 folds the c27 consistency audit (C27-F1 restoration + mechanical gate; see the c27 Change Ledger row); v33 records owner decision D6 (shared admission of closed unsupported-version boundaries; see the v33 Change Ledger row); v32 folds the v31 audit consistency fixes (C25-B1..B5; see the c25 Change Ledger row); v31 folds the v30 internal review (C24-F1..F6; see the c24 Change Ledger row); v30 folds terra cycle-23 findings 1–7 (1 BLOCKER + 5 MAJOR + 1 MINOR; see the c23 Change Ledger row); v29 folds terra cycle-22 findings 1–5 (1 BLOCKER + 4 MAJOR; see the
c22 Change Ledger row); v28 folds terra cycle-21 findings 1–4 (1 BLOCKER + 3 MAJOR; see the
c21 Change Ledger row); v27 folds terra cycle-20 findings 1–4 (4 MAJOR; see the c20 Change Ledger row);
v26 folds terra cycle-19 findings 1–5 (2 BLOCKER + 3 MAJOR; see the
c19 Change Ledger row); v25 folds terra cycle-18 findings 1–6 (2 BLOCKER + 4 MAJOR; see the
c18 Change Ledger row); v24 folds terra cycle-17 findings 1–6 (2 BLOCKER + 4 MAJOR; see the
c17 Change Ledger row);
v17 folds terra cycle-11 findings 1–8 (2 BLOCKER + 6 MAJOR; see the
c11 Change Ledger row);
v16 folds terra cycle-10 findings 1–9 (see the c10 Change Ledger row);
v15 folds cycle-10 review findings 1–5 (per-leaf release floor +
full-hold formula + correction-graph-only displacement in 14.13.4a;
canonical wire encoding + conformance vector for `group-plan` in
14.11.2; D5-a consequence wording in 14.12.2 — see the v15 Change
Ledger row).
v14 folds self-audit findings 1–5 + owner decision D5-a (see the v14
Change Ledger row); v13 folded the seven v12 self-audit findings (see
the v13 row). v12 folds owner decisions D0-b/D1-a/D2-b/D3-a/D4-a + same-pass audit
fixes (see the v12 Change Ledger row). v11 folds terra audit cycle 9 (late-charge accounting, residual-cap
partial measurement, act-effect durability + replayable stall timer,
closed-op-enum gaps, append-only invalidation, idempotency-lineage,
composite act identity, zero-call coverage, evidence-class split,
money-domain reconciliation, durable group plan, archive reachability,
deferral lifecycle, fault-identity/ledger alignment, tail replay
validation — see the §14.15 ledger v11 row).
v9 folds terra audit cycle 7 (owner-act ratify/reject/supersede op
schemas; usage fold totality gaps; queue-handoff linearization; remote
disposition full coverage — see the §14.15 ledger v9 row).
v8 folds terra audit cycle 6 (group framing fields; owner-act closed
per-op payload schemas + supervisor-side verification; history-fault
lifecycle; fold/deferral/disposition consistency fixes — see the §14.15
ledger v8 row).
v7 fixes terra audit cycle 5 (owner-act linearization + durable
pending-act queue + fence crash recovery; provenance trust-boundary
limits + owner-act payload canonicalization/consumption in 14.10.3;
reader framing decidable in one pass — stabilization heuristic
withdrawn). v6 fixes terra audit cycle 4 (dispatch-only pin policy restated in the
numbered intake procedure and O-G2-6; enforced provenance boundary +
owner-act records in 14.10.3; reader group-framing obligation in the
tail fence). v5 fixes terra audit cycle 3; v4 fixes terra audit cycle 2 (see §14.15 ledger).
v3 fixes terra audit cycle 1: content-addressed snapshots + verified
digest before commit; pin-FIRST intake resolution (no locant-based
successor impersonation); pin invalidation across task rewrites;
refusal→filing crash-atomic protocol; typed P13 payloads. Separable per
section EXCEPT shared-interface edits (`scopeRefs`, norm identity,
verdict table) reopen consumers for dependency-impact review. NOT
IMPLEMENTED; post-P0 additive per §14.9. No module is touched.**

**Purpose.** §14.10's `affectedNorm` POINTS at normative text; nothing
yet says whether that text is settled. Today "PENDING owner ratification"
is prose in docs/21 and a finding against a draft norm can be routed as
if the norm were binding. G2 makes norm state a closed, machine-checked
value, and makes ratification an atomic act whose downstream effects
(worker prompts) are derived from it, so workers never fix against stale
text.

#### 14.11.1 Norm state file (derived projection, supervisor-written; v2)

`<episodesRoot>/<episodeId>/norms.json` — atomic tmp+fsync+rename,
supervisor sole writer (S6 discipline). Keys are supervisor-minted ids.
**v2: this file is a projection of the §14.11.2 records, not an
authority — rebuild-on-restart, repair drift by rewriting it, never the
reverse.**

```jsonc
{ "schema":"tre-norms/1", "episodeId":"…",
  "norms": {
    "N-0007": { "doc":"docs/21-p9-m3-…", "anchor":"§1.1 (c) step (2)",
                "sha256":"ab12…", "state":"ratified",
                "revision":3, "ratifiedAt":1730231400000,
                "authority":"tty:2026-11-16T…/owner-cli-session-ref" } } }
```

- **States (closed):** `drafted | ratified | rejected | superseded`.
  Initial state is `drafted`. There is no `ratified → drafted` edge; a
  changed norm is a NEW norm id with `supersedes` pointing at the old one,
  so history is never rewritten.
- **Digest ruling (closes the G1/R6 deferral):** `sha256` is **mandatory
  for `ratified`** (a ratified norm without a digest is refused — "which
  text was ratified" must be checkable) and optional for `drafted`. The
  digest is computed by the supervisor from the anchored text at the
  ratify transition, never supplied by a worker.
- `revision` is a positive integer, incremented on every transition.

#### 14.11.2 Records: creation, snapshot, transition (S5 kinds `norm-created`, `norm-transition`)

A norm enters the log with a **creation record** — the only place
`doc`/`anchor` live, so `{doc, anchor}` resolution and full replay never
depend on `norms.json` (v2, blocker fix):

```jsonc
{ "kind":"norm-created", "id":"01J…ULID", "ts":…, "schema":"tre-supervisor/1",
  "episodeId":"…", "normId":"N-0007",
  "doc":"docs/21-p9-m3-…", "anchor":"§1.1 (c) step (2)",  // the identity G1 findings resolve by
  "supersedes":null }                  // REQUIRED non-null for a successor norm
```

Transitions carry a **content-addressed snapshot** at the transition, so
the ratified text's provenance lives IN the log, not only in the mutable
doc (v2, blocker fix — replay can reconstruct `norms.json` from
`norm-created` + `norm-transition` alone):

```jsonc
{ "kind":"norm-transition", "id":"01J…ULID", "ts":…, "schema":"tre-supervisor/1",
  "episodeId":"…", "normId":"N-0007",
  "from":"drafted", "to":"ratified",
  "expectedRevision":2,                // CAS: refused unless current revision == this
  "dispositionBy":"owner",             // or "orchestrator" for drafted/superseded only
  "authority":"tty:…",                 // REQUIRED for ratified/rejected; TTY-confirmed owner channel (§14.10.3, D2)
  "sha256":"ab12…",                    // REQUIRED for ratified; supervisor-computed over the anchored text it read
  "anchorTextRef":"norms/sha256/ab12…ef90.txt", // REQUIRED for ratified: the content-addressed snapshot path (§14.11.3 step 1, v4: example matches the addressing scheme, not the withdrawn per-rev naming)
  "supersedes":null }                  // REQUIRED non-null for superseded
```

- **Successor lifecycle (v4, c2 — the transition-era rules v3 left
  undefined):** a successor norm (`supersedes != null`) is a NEW id
  from creation; the chain (`supersedes` edges) is validated acyclic
  and single-parent at every append. **The predecessor stays CURRENT
  (ratified, enforceable) until the successor's own `ratified`
  transition commits** — creation and drafting of a successor change
  nothing about the predecessor. At the successor's ratification
  commit, the supervisor appends the predecessor's `superseded`
  transition as **one JSONL line pair flushed in a single write() under
  the S5 lock** — an `atomic-group` framing the S5 writer guarantees.
  **Framing fields (v8, c6-M8 — the reader decides completeness from
  the lines themselves, one pass, no EOF reasoning):** every grouped
  line carries `"group": { "groupId":"…", "memberIndex":<0-based>,
  "memberCount":<N> }` (ungrouped lines carry no `group` field and are
  individually complete at their newline). The reader's shared
  predicate: a group is COMPLETE iff the reader holds, in contiguous
  line order, all members `0..N−1` for one `groupId` with memberCount
  equal across them and each line newline-terminated; a `groupId`
  whose observed members are missing an index, or whose memberCount
  values disagree, or whose last observed member lacks a terminator,
  is INCOMPLETE (torn-tail ⇒ discard under the fence; mid-log ⇒
  malformed log ⇒ fail closed). A short write of a two-member group
  shows member 0 alone — incomplete by count, never exposed, which is
  exactly the c6-M8 counterexample closed. Visibility (complete group
  present) is decidable in one pass from these fields; fsync
  durability is a SEPARATE axis: visibility follows completeness,
  durability follows the writer's fsync-before-ack, and a consumer
  that needs durability serializes with the writer lock (the two
  permitted modes below are unchanged).
  Lines of one group carry the same `group.groupId` — **the ONE
  normative group identifier (v9, c7-M12):** the v8 fold introduced
  `group:{groupId,memberIndex,memberCount}` while leaving the v7
  prose ("Lines of one group carry the same `atomicGroupId`", reader
  buffering "by that field") normative, giving two identifiers with
  potentially different values; here they are CLOSED to one:
  `group.groupId` IS the atomic group id (an implementation reading a
  legacy `atomicGroupId` field outside the `group{}` object treats it
  as malformed framing — there is exactly one identifier in the
  wire shape). **Writer contract (v9, c7-M12):** the writer builds
  the ENTIRE group's lines in memory before the single write()
  (memberCount is known at construction, so every member carries the
  same count); the group is emitted as ONE write() of the fully
  concatenated newline-terminated lines under the S5 lock (bytes are
  contiguous; a short write leaves an incomplete tail the fence
  truncates — the writer RETRIES the remaining bytes, and an
  unfixable short write aborts the whole group with no member ever
  visible); `memberIndex ∈ [0, memberCount)` with `memberCount ∈
  [2, 64]` (a group of 1 member is malformed framing — use no group;
  >64 exceeds the contract's group vocabulary and is refused);
  `groupId` is unique per group for the episode (content-addressed:
  sha256 over the canonical encoding of the ordered member ids, or
  an episode-unique ULID prefix — writer-chosen but collision-free
  against reuse: a `groupId` whose member CONTENT differs from a
  prior group of the same id is malformed ⇒ fail closed). A writer
  crash BEFORE the group's write() is visible as: nothing on disk
  (write() never began) or an incomplete tail (fence truncates) —
  both leave the pair unapplied and the successor correctly drafted;
  crash AFTER write() but before fsync/ack — ONE recovery rule
  (v10, c8-M13; v9 said BOTH "a complete-but-unacked group at tail
  is also truncated" AND "may be RETAINED" in adjacent sentences —
  mutually exclusive outcomes for the same crash point, and the
  reader rule below says a complete observed group is NEVER
  truncated, so the truncate branch contradicted the reader
  contract): recovery runs the tail fence, which classifies the tail
  group by the shared framing predicate ONLY. INCOMPLETE tail group
  ⇒ truncated (never fully visible; truncation is safe). COMPLETE
  tail group (all members present + trailing newline) ⇒ RETAINED,
  ALWAYS — the fence NEVER truncates a complete group, because a
  reader may already have observed it (visibility precedes ack
  across the crash); retaining is correct BECAUSE the retry is
  idempotent by construction, not by luck. **Retry identity —
  deterministic, pinned (v10, c8-M13; v9 gave no durable source for
  the group's identity, so a re-emitted group either minted fresh
  member ids (changing a content-addressed groupId — a different
  group) or reused the ULID with drifted content (malformed ⇒ fail
  closed — a guaranteed defect either way; **the draft artifact
  itself now specified (v11, c9-M11 — v10 said "the draft IS the
  durable source" without defining that artifact: no record schema,
  no fsync order, no timestamp freeze, no location — "byte-
  identical" was unimplementable because `ts` fields were never
  pinned):** the writer's group
  PLAN is built deterministically in the durable draft state BEFORE
  the write — member record ids, groupId, and exact canonical line
  bytes are a pure function of the pre-write draft (the draft IS
  the durable source: ids assigned at draft time, never re-minted
  at emit time). **The draft-plan record (v11, c9-M11; BYTES
  CARRIED v12, owner decision D1-a — v11 stored only per-line
  DIGESTS, and a digest cannot reconstruct: a crash after plan
  fsync with the queue/draft state lost left recovery with hashes
  but no bytes to re-emit, while the rule demanded byte-identical
  re-emission):** a durable
  `group-plan` record appended to the log BEFORE the group write:
  `{ envelope, groupId, plannedAtTs, memberLines[] (ordered, each
  entry the member's EXACT canonical line bytes VERBATIM — the ts
  values inside are frozen INTO the bytes at plan time; the plan's
  `memberLineSha256[]` (v13, audit finding 2: the per-member sha256 digests are stored as the INTEGRITY COMPARISON values, one per entry of `memberLines[]`; the BYTES remain the sole re-emit source and the digests never substitute for bytes) — **wire encoding (v14, audit finding 4; REWORKED v15, cycle-10 review finding 4: v14's "standard JSON string escaping" admits MULTIPLE escaped spellings of the same text — `"` may appear as `\"` or `\u0022`, `\n` as `\n` or `\u000a` — and its "exactly one escaped form" claim is FALSE, so no producer could implement byte-identical re-emission from the record): the CONTAINING `group-plan` record is serialized under `tre-canonical-json/1` (§14.12.3) like every other record in the contract — that is the single normative rule for the bytes on the wire. Each `memberLines[]` entry is a JSON string whose decoded value is the member line's exact text INCLUDING its terminating newline (the trailing `\n` is part of the member value, not framing); `memberLineSha256[i]` is sha256 of the member value's UTF-8 BYTES AFTER decoding (computed at plan time over the same bytes that will be re-emitted, re-checked after every decode); recovery decodes under the canonicalizer, verifies `memberLineSha256[i]` over the decoded bytes, and re-emits the decoded UTF-8 bytes byte-identically into the group write (never the escaped string). A decode that does not round-trip (canonical-encode(decoded bytes) ≠ the stored escaped form, or digest inequality) is the same `group-plan-mismatch` fault. BYTE-LEVEL CONFORMANCE VECTOR (v15, normative; REPLACED same-cycle after the auditor showed the first vector was not a valid canonical line — noncanonical spacing and a raw TAB inside a JSON string): the member line is a CANONICAL record (no insignificant whitespace, minimal escaping — control characters use the short escapes, so a TAB inside a string value is `\t`, never a raw TAB byte), value text `x"y\z` + TAB + `é` (NFC precomposed U+00E9): member line BYTES `{"a":"x\"y\\z\té"}` + newline (the `\t` here is the two-byte ESCAPE sequence, the trailing newline is the record terminator), 20 bytes, hex `7b2261223a22785c22795c5c7a5c74c3a9227d0a`, `memberLineSha256[i]` = sha256 over exactly those 20 bytes = `b66d049310fb10a3f9de2681aa964a1a1bcc898e59efc92bd845ee24465667e0`; the containing `group-plan` stores the member under `tre-canonical-json/1` as the 31-char string `"{\"a\":\"x\\\"y\\\\z\\té\"}\n"` — every structural quote, backslash and escape of the member text re-escaped, the newline terminator as `\n`, raw NFC UTF-8 for `é`, NO `\uXXXX` long form where a short form exists; recovery decodes, re-hashes, and re-emits the 20 bytes byte-identically. A stored spelling that decodes to the same 20 bytes but is not the canonical 31-char string (e.g. `"` written as `\u0022`) is a noncanonical-encoding mismatch — see the fault-field amendment below. The binding's CLAIM is bounded and named (v14): it detects in-place corruption of the member BYTES within an otherwise-valid record (bit rot, torn append, partial rewrite) — the same integrity model as `policy-digest-mismatch` (v9 c7-M8: stored bytes vs the digest recorded alongside them). A rewriter that coherently replaced bytes AND digests is outside this check's threat model AND outside every record-level digest in this contract (the same residue `policy-digest-mismatch` accepts; no prefix hash chain is defined here — tamper-resistance rests on the S5 single-writer flock and storage protection, and this contract has never claimed more). v13's "self-binding" shorthand means the record carries its own comparison values, nothing stronger), `ownerActRef }`
  (envelope kind added to §14.12.4b; producer:
  supervisor; consumption-bound to the act authorizing the
  transition). Publication protocol, pinned order: (1) compute all
  member line bytes (including frozen `ts` — taken ONCE at plan
  time; no clock read survives step 1), (2) append `group-plan`,
  fsync(log), (3) append the group, fsync(log), (4) ack. Recovery
  finds the `group-plan` record by `ownerActRef`/`groupId` (a
  plan with no following group ⇒ re-emit from the plan; a plan
  whose following group digests match ⇒ done). A group found in
  the log with NO preceding `group-plan` is malformed ⇒ fail
  closed `needs-owner` (an unplanned group has no deterministic
  provenance — this closes the "reconstructed plan with a new ts"
  case: recovery NEVER reconstructs, it RE-EMITS the plan record's
  bytes). Same-`groupId`-different-bytes ⇒ `needs-owner` disposition
  is terminal for the group: the ONLY exits are an owner act
  (`finding-disposition`-class decision naming the group) or the
  fault-exit path; the writer NEVER retries a divergent plan —
  a divergent re-attempt would be non-determinism, which the plan
  record exists to detect. **Plan self-binding & size (v12,
  D1-a):** recovery verifies each stored member line's bytes against its stored `memberLineSha256[i]` before re-emitting it (v13); a mismatch is a `history-integrity-fault` with faultKind `group-plan-mismatch` (identity tuple = (faultKind, affectedRecordId = the `group-plan` record id), boundaryId null), never a silent skip; the plan is ONE log line and self-bounds:
  `memberCount ≤ 64` and the serialized plan record ≤ 1 MiB
  (same cap as §14.12.3 canonicalization) — the writer refuses
  to plan a group whose serialized plan exceeds the cap
  (`group-plan-oversize` — the writer's own
  refusal, journaled, before any append; members are never truncated, and
  any conforming member is itself far under the cap because the
  S5 envelope + per-record field bounds apply to each member
  line independently). Retention:
  `group-plan` records share
  the log's retention domain (any replayable prefix that can
  resolve the group keeps its plan). Recovery re-emits THE PLAN, byte-identical (same
  ids, same bytes), and append-if-absent applies: a tail group with
  the SAME groupId and byte-identical members ⇒ the write already
  landed; skip the re-emit, ack it, done (dedup by groupId — never
  doubled). A tail group with the SAME groupId and DIFFERENT bytes ⇒
  malformed ⇒ fail closed `needs-owner` (a deterministic plan
  cannot produce different bytes; divergence means state corruption)
  . The
  replay rule is group-aware — a half-group (successor `ratified`
  without the paired predecessor `superseded` inside the same
  complete-line group, delimited by the trailing newline of the group's
  last line) is a torn tail: the reader discards the incomplete group
  entirely (the successor stays drafted) and re-derives, exactly as S5
  treats a torn final line. **Tail fence (v5, c3):** one write() does
  NOT guarantee both lines survive, and the next unrelated append would
  push a half-group mid-log — so BEFORE any append the writer inspects
  the tail: an incomplete group at EOF is truncated away under the
  writer lock. Discarding never-acked, never-visible torn bytes is not
  an update-in-place of history (no reader ever saw them as a record).
  After the fence the invariant holds: a half-group is always the EOF
  tail or already gone. A half-group found mid-log despite the fence ⇒
  malformed log ⇒ fail closed, `needs-owner`. Restart runs the same
  fence before serving any append.
  **Reader obligation — the visibility claim is a PROTOCOL, not a
  fact about bytes (v6, c4-M12):** "no reader ever saw them as a
  record" holds only if every reader validates GROUP FRAMING before
  exposing either member. Contract: a lock-free reader MUST buffer
  lines and withhold BOTH members of a `group.groupId` until the
  complete group (all members + the trailing newline of the last
  line) is present under the SAME framing predicate the writer's tail
  fence uses (v7, c5-M6: the "file length stabilizing" heuristic is
  WITHDRAWN — an unbounded observation interval is neither checkable
  nor durable, and a quiet log would withhold forever). Visibility is
  instead decidable in one pass: a group the reader observes COMPLETE
  under the shared predicate can never subsequently be truncated (the
  fence truncates only groups the same predicate classifies
  INCOMPLETE — a short-write artifact is always incomplete, and a
  complete group is never removed, only followed); the reader may
  expose it immediately, no waiting. A reader that must additionally
  know the group is fsync-durable before acting serializes with the
  writer's lock (shared flock) or consults only acked positions — the
  two permitted modes, restated: buffer-and-validate under the shared
  predicate, or lock-serialized reads; "watch the length
  stabilize" was neither and is removed; a snapshot taken
  concurrently with an append/truncate that shows a half-group at
  tail yields NOTHING from that group (the snapshot's interpretation
  is "torn tail, discard" — identical to replay). An implementation
  that exposes a complete first line before the group terminates
  violates the contract — either buffer-and-validate or serialize
  readers with the writer lock; there is no third option. Group size
  is bounded by the writer's single-buffer flush (max one group per
  write()); termination is the trailing newline of the group's last
  line; durability is per-write fsync before ack; physical bytes ≠
  committed logical records — a logical record exists only when its
  group is complete.
  **Current-norm selection:** the current norm for a `{doc, anchor}`
  locant is the unique non-superseded `ratified` norm with that locant;
  zero ⇒ none (code-fix intake refuses `norm-unknown`); more than one
  ⇒ `norm-ambiguous` (fail closed — concurrent ratifications of
  conflicting successors are serialized by the same lock, so this
  records a bug, not a race). A drafted or rejected successor never
  affects resolution; a rejected successor is inert forever (its locant
  may be re-proposed as a fresh norm).

- **Resolution rule (v4, pin-first — supersedes the v2 ordering):**
  intake resolves `affectedNorm` `{doc, anchor}` **only against the
  `normRevisions` snapshot pinned at the auditor's dispatch record**
  (§14.11.4): the pinned set maps `normId` → the `norm-created` record
  (hence `doc`+`anchor`+snapshot digest) the norm had when that auditor
  was admitted. Resolution matches the finding's `{doc, anchor}` against
  the PINNED norms. Zero matches in the pinned set ⇒ intake refusal
  (`norm-unknown`); more than one non-superseded match ⇒ refusal
  (`norm-ambiguous`) — identity is never guessed. A norm ratified or
  superseded AFTER the pin is resolved by its pinned identity (the
  finding audits what the auditor saw; convergence rule 5 compares
  pinned digests, not head state). Finding records carry the resolved
  `normId` + `normDigest` from the pin — never a re-resolved live
  identity.
- **Authority is structural, same as §14.10.3:** only an owner act over the
  TTY-confirmed channel may move a norm to `ratified` or `rejected`. The
  orchestrator may propose (`norm-created`, `drafted`) and mark
  `superseded` only.
- **`from` is recorded here** (unlike `audit-finding-update`) because
  norm transitions are rare and an explicit `from` lets the CAS check be
  replayed; a mismatch with the derived state is refused.
- Transition applied to a `rejected` or `superseded` norm is refused.
- `norms.json` is a **derived projection** of these two kinds (the S3
  rule): on restart the supervisor rebuilds it from the log and repairs
  drift by rewriting the file — never the other way around.

#### 14.11.3 Atomic ratify → regenerate

The **ratify transition record is the single commit point.** Everything
downstream is derived from the log and is idempotent:

1. Supervisor writes the anchor-text snapshot file **content-addressed**
   (`norms/sha256/<digest>.txt`, tmp+fsync(file)+rename+fsync(dir)) — two
   writes of the same digest produce byte-identical content at the same
   path, so "immutable" is a property of the addressing, not a promise
   (v3).
2. Supervisor appends `norm-transition` (ratified, naming the snapshot's
   digest) — commit point. The transition's digest reference is verified
   against the snapshot BEFORE the append; a committed transition whose
   snapshot is missing or whose bytes mismatch the digest ⇒ fail closed:
   the norm is treated as NOT ratified, `needs-owner`, never silently
   repaired (v3).
3. Supervisor updates `norms.json` (atomic rename; a derived projection,
   rebuildable from the log).
4. Worker prompt headers are regenerated for every queued/ready task whose
   `promptRef` cites the norm, carrying `normRevisions: {N-0007: 3}` and
   the digest.

A crash between 2 and 4 is repaired on restart by re-deriving (3) and (4)
from the log; re-deriving is a pure function, so no duplicate effect
exists. A crash between 1 and 2 leaves an orphan content-addressed
snapshot — harmless (unreferenced, byte-stable).
- **Publication is exclusive-create; GC honors a reservation window
  (v4, c2):** step 1 writes with `O_EXCL`-style no-replace publication
  (tmp+link+rename — never overwrite). If the digest path already
  exists, its bytes are verified against the digest FIRST: equal ⇒
  proceed (same content, idempotent); mismatch ⇒ corruption — fail
  closed, `needs-owner`, never replaced. GC may sweep unreferenced
  digest files ONLY under the supervisor's S5 single-writer lock, in
  the same critical section, and only those older than a stated grace
  window (≥ the maximum publication-to-commit latency of step 1→2,
  which are adjacent appends): a file published but not yet
  transition-committed is young and untouchable, verification-then-
  commit runs inside one protected window, and a committed transition's
  snapshot is referenced forever (never swept). No window exists where
  a verified snapshot can vanish before its transition commits.
A task already
`running` under revision 2 is NOT interrupted; its dispatch record pinned
`normRevisions` at spawn (§14.11.4), and its findings are checked against
that pinned digest.

#### 14.11.4 Consumer rules (what G1 intake and G3 read; v3)

Norm state is an **intake gate, never a route rewrite** (G1 seam, v2):
the immutable `audit-finding` record's `route` is final; G2 refuses or
admits it at intake, and any situation needing the owner is filed by the
SUPERVISOR as its own record (§14.10.1 route×surface note).

- **Digest binding (v3, pin-FIRST resolution):** a `code-fix` finding
  with non-null `affectedNorm` MUST carry the digest of the norm text it
  was prompted with. Mechanism: the S3 dispatch record gains an additive
  desired field `normPins: [{normId, revision, sha256}]` (frozen at
  spawn — an amendment recorded in the Change Ledger), and intake
  resolves **in this order, and no other**: (1) find the submitting
  task's dispatch record and its `normPins`; (2) a cited locant resolves
  ONLY against a pinned `normId` — the pin names identity, revision and
  digest the worker actually saw; (3) **pin-vs-current comparison is a
  DISPATCH-time gate, never an intake step (v6, c4-M6):** at dispatch
  the supervisor compares each pin against the CURRENT ratified norm
  (successors included via `supersedes`): pin == current ratified ⇒
  dispatch proceeds; pin exists but names a non-current norm ⇒ the
  dispatch is refused `stale-norm` until pins+prompt regenerate
  atomically; at INTAKE no such comparison runs at all — the finding is
  checked against its dispatch record's validated pin set only (below);
  the supervisor stamps the pin's `{normId, sha256}` onto the finding;
  no pin at all, or a locant
  matching none of the pins ⇒ `norm-unpinned` refusal (a task dispatched
  before G2 has no pins: fail closed, never resolve by locant against
  current state). A worker-supplied digest is overwritten by the pin
  (workers cannot forge freshness; null is not an escape hatch).
  **Pin freshness at EVERY dispatch (v4, complete gate — supersedes
  v3's rewrite-only rule):** freshness is validated not only on
  rung-4 rewrites but at EVERY dispatch, under the same serialization
  as norm transitions: the supervisor re-reads each cited norm's
  current ratified state and compares against the pins generated for
  the delivered prompt bytes + taskRevision. Any pin whose norm was
  superseded, rejected, or re-ratified since generation ⇒ the
  dispatch is refused (`prompt-drift`) until pins+prompt are
  regenerated atomically — regardless of whether a task rewrite
  occurred (v3 gap, c2: a queued prompt generated at rev 2 could
  dispatch after rev 3 landed with no rewrite to trigger the check).
  The validated pin set + delivered-prompt digest + taskRevision are
  bound into the durable dispatch/attempt record. If a norm transitions
  AFTER a dispatch, the in-flight run is not interrupted (same rule as
  §14.11.3), and its audit completion still counts (14.12.2 completeness
  — v5 cross-ref fixed: rule 5 is the minor-hold rule, not a digest
  rule, c3). **One intake policy for in-flight pins (v5, resolves the
  §14.11.2-vs-§14.11.4 contradiction):** the pin-vs-current freshness
  gate runs at DISPATCH time only (it decides what may be dispatched);
  at INTAKE, a finding is checked against the pin set recorded in its
  dispatch/attempt record — pin matches the dispatch record's validated
  pin ⇒ admit with the pin's {normId, sha256} stamped, regardless of
  any norm transition that happened meanwhile; pin cited by the finding
  is not in that dispatch record's pins ⇒ `norm-unpinned`; a cited
  locant resolves ONLY within the dispatch record's pins (identity is
  the dispatch snapshot, §14.11.2's pin-first rule). Cleanliness never
  re-compares pins against head state — the dispatch record is the
  frozen comparison basis (replayed from authoritative transitions, not
  from the rebuildable norms.json projection).
  `{doc, anchor}` locant-matching remains ONLY for owner-facing records
  (P13 questions), never for fix-loop intake (v3: closes the
  same-locant successor impersonation).
- `code-fix` whose pinned norm is NOT `ratified` ⇒ **refused at intake**
  (`norm-not-ratified`); the supervisor files its own `human-review`
  record carrying the original `findingRef`.
- **Refusal + owner filing is ONE protocol (v4, crash-atomic with full
  payload):** intake appends `intake-refusal` — commit point — carrying
  the **complete validated source payload** (the full submitted finding
  record: findingRef, claim, severity, route, surface, scopeRefs,
  affectedNorm, evidence refs — every field the supervisor filing
  needs) plus `refusalCode`, the source line's content hash, and a
  `derivedFindingId` field — **ONE identity formula (v7, c5-M2):**
  `derivedFindingId = truncateToUlid(sha256(refusalId || "#filing"))`
  (the v4 text "follow-up id `refusalId+"#filing"`" denoted THIS
  derived id; there is no raw-concatenation id anywhere in the
  contract — any record claiming a follow-up id not equal to the
  formula output is malformed). The supervisor's
  `human-review` filing is DETERMINISTICALLY DERIVED from it (pure
  function of the refusal record). Restart between refusal and filing
  re-derives the filing from the payload — a content hash alone could
  not reconstruct it (v3 defect, c2); replay verifies the payload
  validates against the finding schema and its digest matches the
  source-line hash before re-filing (corrupt/missing payload ⇒ fail
  closed, `needs-owner`); this applies to POLICY-class refusals only —
  parse-or-schema refusals store the raw blob and replay verifies
  bytes→digest without schema validation (v6, c4-M15, 14.12.4 class
  table). **What bytes (v5, c3):** the refusal stores
  the source as a content-addressed blob (like submission receipts,
  14.12.4: `submissions/<sha256>.json` — the EXACT received line) plus
  the parsed payload with `intakeSchemaVersion` pinned; the hash domain
  is the raw line bytes, so replay verifies bytes→hash (no
  re-serialization ambiguity) and re-validates against the PINNED
  schema version, not the then-current one (schema evolution cannot
  invalidate an accepted refusal; a version newer than the reader
  knows ⇒ fail closed). **Derived-filing identity (v5):** the filing is
  NOT a raw ULID mint (G1's fresh-ULID intake rule is for auditor
  submissions; supervisor filings are derived records): its id is
  `sha256(refusalId||"#filing")` truncated to the ULID namespace per
  the S5 derived-id convention, `originating:"derived"`, authority =
  the refusal record's own intake act — it exists in a documented
  separate namespace from worker submissions and redelivery appends it
  at most once (append-if-absent by that deterministic id). Until the filing is durable the item sits in a fail-closed
  pending state **listed in the verdict table as a `needs-owner`
  condition** (v4 — v3's table omitted it; two clean cycles could
  converge past a pending refusal). No crash window can lose the owner
  ask.
- A `human-review` finding whose norm is `drafted` is queued as a
  **blocker of kind `norm-ratification`** (additive kind on the P13
  channel) with a **typed request payload** `{blockerId, normId,
  expectedRevision, options:["ratify","reject","revise"]}` and a
  **typed answer** `{blockerId, choice, normId, expectedRevision}` —
  the answer's `normId`+`expectedRevision` MUST equal the request's
  (CAS; a revision moved underneath ⇒ the answer is voided and the
  blocker re-issued at the new revision, never applied to a stale one);
  parsed only from the TTY-confirmed channel — §0.7, no prose parsing
  (v3: `<rev>` is data in the payload, not text scraped from a label).

#### 14.11.5 Owner decisions for ratification

- **O-G2-1** Digest mandatory at `ratified` only (drafted optional) — as
  drafted above.
- **O-G2-2** `from` field recorded on norm transitions (differs from
  audit-finding-update by design; rationale in §14.11.2).
- **O-G2-3** A changed norm supersedes by new id, never by in-place edit.
- **O-G2-4 (v2)** Norm identity lives in `norm-created`; the ratified
  text's provenance lives in the immutable snapshot named by the
  transition. `norms.json` is a rebuildable projection.
- **O-G2-5 (v2)** Supervisor (not the worker) stamps `normId`+digest on
  findings from the dispatch pin.
- **O-G2-6 (v3, v4-corrected, v6-aligned with the dispatch-only
  policy, c4-M6)** Intake resolves against the dispatch PIN set ONLY
  (locants are owner-facing) — intake NEVER compares pins to current
  head state (that comparison is the dispatch-time `stale-norm` gate,
  14.11.4 step 3): a cited pin found in the dispatch record ⇒ admit
  with the pin's digest stamped; a cited pin NOT in the dispatch
  record, or no pin at all (or a locant matching no pin) ⇒
  `norm-unpinned` — these are
  distinct codes: `stale-norm` = DISPATCH-TIME only (a pin exists but
  names a non-current norm — the dispatch never happened);
  `norm-unpinned` = no pin to check at intake (v4 closes the v2/v3
  vocabulary clash the audit flagged: a missing pin is
  `norm-unpinned`, never `stale-norm`). Never substituted with current
  state.
- **O-G2-7 (v3)** Snapshots are content-addressed (`norms/sha256/<d>`);
  committed transition with missing/mismatched snapshot ⇒ norm treated
  NOT ratified + `needs-owner` (fail closed, no silent repair).

#### 14.11.6 What this section does NOT do

No norm text editing, no doc generation, no ratification UI (the P13
channel is the only human surface). Does not decide what a finding's
`route` should be (G1). Cross-episode norm sharing is out of scope: norms
are episode-scoped, so a norm ratified in one episode is not implicitly
ratified in another.

### 14.12 Convergence stop rule as data (G3 — the verdict, not "auditor says clean")

**Status: DRAFT v34 (2026-11-18), batched with §14.11/§14.13/§14.14
(v34: c27 consistency audit folded (C27-F1 restoration, see the c27 Change Ledger row); (v33: owner decision D6 folded (shared admission, see the v33 Change Ledger row); v32: v31 audit consistency fixes C25-B1..B5, see the c25 Change Ledger row; v31: v30 internal review C24-F1..F6 folded, see the c24 Change Ledger row; v30: terra cycle-23 findings 1–7 folded, see the c23 Change Ledger row; v29: terra cycle-22 findings 1–5 folded, see the c22 Change Ledger row; v28: terra cycle-21 findings 1–4 folded, see the c21 Change Ledger row; v27: terra cycle-20 findings 1–4 folded, see the c20 Change Ledger row; v26: terra cycle-19 findings 1–5 folded, see the c19 Change Ledger row; v25: terra cycle-18 findings 1–6 folded, see the c18 Change Ledger row; v24: terra cycle-17 findings 1–6 folded, see the c17 Change Ledger row; v17: terra cycle-11 findings 1–8 folded, see the c11 Change Ledger
row; v16: terra cycle-10 findings folded, see the c10 Change Ledger row;
v13: self-audit findings 1–7 folded, see the v13 Change Ledger row;
v14: self-audit findings 1–5 + owner decision D5-a, see the v14 row). v12: owner decisions D0-b/D1-a/D2-b/D3-a/D4-a folded, see the v12
Change Ledger row). v8
(terra c6): queue-admission handoff state machine under the S5 lock
with drain-in-current-window (14.12.2 step 5); repro ancestor reuse
proven via object-store ancestry + per-intervening-commit evidence
(14.12.2 r4); chain members wired into the clean predicate
(residual-inherited = unclean, 14.12.2); history-integrity-fault
entry/disposition/exit unified (14.12.3); canonicalizer renamed
`tre-canonical-json/1` with full value domain + conformance vectors
(14.12.3). v7
(terra c5): fence owner-act linearization + durable pending-act queue
(nonempty queue blocks clean closure) + `fence-engaged` crash recovery
(14.12.2 step 5); repro ancestor reuse requires proven-complete
dependency closure (14.12.2 r4); escape obligation states + waiver +
unclean-close clarification + disproven-authority ⇒
`history-integrity-fault`; committed-boundary divergence = permanent
history fault, never retroactive refusal (14.12.3); ONE derived-ID
formula + refusal-class receipt/outcome/filing table (14.12.4);
authoritative envelope table incl. `schema`, v7 kinds, examples
relabeled pseudocode (14.12.4b). v6
(terra c4): finalization fences ALL actors + external-obligation
close-gate; disjoint receipt origins + stable submissionIds; episode-
global scope escapes; repro artifact binding to the accepted candidate;
chain closure state table; three refusal classes for invalid intake. v5
(terra c3): drain-and-fence boundary finalization; durable submission
receipts; policy-revision records; boundary-carried checkable counters;
repro-run evidence kind; chain-discharge rule. v4
(terra c2): assignment identities + per-attempt state machine; boundary
membership by log position; partition = wave-start event before dispatch;
refusal carries full payload; counters = replay recurrence. v3
(terra c1): append-only manifest/completion/retry event kinds; GLOBAL
open-blocker check; cycle-boundary cutoff as the authoritative freeze;
persisted streakAfter/confirmingUsed; owner finding-hold record;
opinion-finding closing channels restricted.**

**Purpose.** HANDOFF G3: "auditor says clean" is disproven as a stop
condition by this repo's own history (P6 cycle-4 ACCEPT overturned by an
independent cycle-5; p9m3 produced fresh findings through cycle 4; AUD51
closed UNCONFIRMED after five cycles with no CYCLE CLEAN). G3 makes the
stop condition a pure function over the §14.10 records, recorded at each
cycle boundary. It also owns the enforcement half of R8 (opinion-basis
sign-off), which §14.10 deferred here.

#### 14.12.1 Policy inputs (desired authority, graph.json `policy.convergence`)

```jsonc
{ "cleanRoundsRequired": 2,            // k consecutive clean rounds [2]
  "minDistinctAuditorFamilies": 2,     // among the round's auditors, excluding implementer family [2]
  "families": { "gpt-6.1-terra": "openai-gpt", "gpt-6.1-sol": "openai-gpt",
                "claude-haiku-5.5": "anthropic", "qwen3-…": "local-qwen" },
  "opinionBlockers": "owner-only"      // see below; [owner-only]
}
```

- **Family is a policy table, never inferred from a model string.** A model
  absent from `families` has family `unknown`, which never counts toward
  diversity. This is the G3 answer to "family diversity is manual": it is
  now declared, checkable data.
- The implementer's family is derived from the task's `model` (S3) through
  the same table. An implementer family of `unknown` makes the exclusion
  undecidable and therefore **disqualifies the round** (14.12.2 rule 2,
  v2) — it is never silently treated as "excluded nothing". A policy
  waiver must name the model and its resolution on the record; a waiver
  for one task does not generalize.

#### 14.12.2 Round cleanliness (pure function over a frozen boundary, cycle `n`)

Input set: the **cycle-manifest** (§14.12.4) assigns cycle `n`'s auditors;
the round is those auditors plus the `audit-finding` records with
`cycle == n` filed by them. Round `n` is **clean** iff all:

1. **Completeness (v4):** the cycle-manifest exists and is CLOSED, and
   every manifest ASSIGNMENT (14.12.4; identified by a supervisor-minted
   `assignmentId`, never by the model string — two sessions of one model
   are otherwise indistinguishable, c2) has an effective terminal
   completion: exactly one `auditor-round-completion` for the assignment
   with `state:"completed"` and `targetDigest` == the manifest's, and
   **intake accounting closed** — every submission intake received from
   that auditor session is filed (id-bound to the assignmentId) or
   durably refused; an unaccounted receipt makes the round unclean (both
   absence AND loss of findings are non-evidence).
   **Per-assignment state machine (v4, c2):** attempts start at 1; at
   most ONE completion per `(assignmentId, attempt)` — a duplicate for
   one attempt is malformed ⇒ unclean; a retry event is valid ONLY after
   attempt 1 reached a terminal `incomplete` (recorded or restart-
   reconciled) and ONLY once (one retry ever); NO completion or retry
   may append after the cycle-boundary of `n` (late events are malformed
   ⇒ unclean). Effective outcome = the completion of the highest valid
   attempt. **Absence of findings is not evidence of cleanliness.** An
   in-flight-at-restart assignment reconciles to `incomplete` (S3 rule).
   Retry lives INSIDE the same admitted cycle (same `cycle` number, same
   admission record; usage attributed to that cycle's G4 accounting —
   retries never mint cycle numbers nor dodge the cycle budget). One
   retry, then the round is unclean and the verdict is `needs-owner`.
2. **Diversity:** distinct families among *completed* round auditors,
   excluding the implementer family, ≥ `minDistinctAuditorFamilies`.
   **Unknown implementer family is disqualifying (v2):** if the task's
   `model` maps to family `unknown` (or ambiguously), the exclusion cannot
   be computed, so diversity is *undecidable*, not "computed without
   exclusion". An undecidable diversity makes the round unclean and yields
   `needs-owner` — the owner must map the model or waive the requirement
   in policy, on the record.
3. **No open sign-off holders, GLOBALLY (v3):** at the boundary instant,
   NO finding anywhere in the episode is open at `severity` blocker/major
   — not merely none with `cycle == n` (v2's round-local check leaked: an
   un-dispositioned old-cycle blocker vanished from the verdict). Clean
   round + open ancient blocker ⇒ unclean. Minors: see rule 5.
4. **Opinion rule (R8 enforcement; v3 tightened):** an open blocker/major
   with `verdictBasis:"opinion"` holds the round unclean unless dispositioned
   `closed-residual` by the owner (authority) BEFORE the boundary.
   **Closing channels for opinion findings are restricted (v3):** an
   orchestrator may NOT move an opinion-basis blocker/major to
   `rejected-duplicate` or `superseded` — those bookkeeping transitions
   are reserved to owner disposition for this basis class (a duplicate
   pointing at a closed or non-equivalent survivor would erase the
   owner-decision obligation). `accepted-fix` remains allowed ONLY with machine-checkable
   evidence, for EVERY finding — opinion or not (v5, c3): the update
   MUST carry `reproRunRef` naming a durable **`repro-run` record**
   (14.12.4) — a supervisor-authored observation with required fields
   `{ findingId, reproDigest, executedArtifactDigest (the tested tree/
   candidate sha), runner:"trusted-gate|supervisor", result:"green|red",
   runEvidenceRef (gate log / command record), ts }` — where
   `reproDigest` equals the finding's repro definition digest computed
   over its canonical serialization (v6: the repro digest is defined
   over the finding's `repro` object ONLY, excluding bookkeeping fields,
   so `repro.kind:"none"` findings have NO digest and cannot be
   "equalled"), `result == "green"` against `postFixExpected`, AND —
   **artifact binding (v6, c4-B4; tightened v7, c5-B2)** —
   `executedArtifactDigest` EQUALS the sha of a durable `acceptance`
   record (§14.3)/integration candidate that is the artifact being
   accepted for THIS task. The DEFAULT is exact: the green run must have
   executed against the accepted candidate itself. **Ancestor reuse is
   permitted ONLY under a proven-complete dependency closure (v8,
   c6-B2 — ancestry and intervening evidence are explicit requirements,
   not ledger-only claims):**
   (i) `executedArtifactDigest` (call it `A`) must be a RECORDED
   ANCESTOR of the accepted candidate `C`, established by walking
   `C`'s parent graph in the object store through FULLY PRESENT
   objects — every parent commit and tree along the walk (ALL parents
   of every commit reached, merge parents included); a shallow clone,
   graft, missing object, or unreachable parent makes the ancestry
   UNPROVEN ⇒ reuse REFUSED. An `A` that is not an ancestor of `C`
   never qualifies, whatever the trace says.
   (ii) EVERY commit in `C \ A` (every parent of every commit reachable
   from `C` but not from `A`, walked over present objects) carries its
   own **qualifying** gate evidence — **qualifying (v9, c7-M11; the
   v8 wording admitted an `incomplete`/`blocked` acceptance or an
   unrelated repro-run, proving nothing): the evidence record must be
   (a) a `repro-run` with `result:"green"` bound (via
   `executedArtifactDigest`) to exactly that commit's sha, OR (b) an
   `acceptance` record with `verdict:"complete"` (the CLOSED §14.3
   acceptance enum `complete|incomplete|blocked|uncertain` — v10,
   c8-M12: v9 required `verdict:"passed"`, A VALUE THE ACCEPTANCE
   SCHEMA CANNOT PRODUCE, so route (b) was legally dead and a
   conforming P14 `complete` acceptance never qualified; there is no
   "passed"/"failed" acceptance verdict and none is added) bound to
   that commit's sha: bound via `checkedAtSha` EQUAL to that sha on
   EVERY PASSING criterion (`pass:true` — a `complete` verdict is
   necessary not sufficient: any passing criterion checked at a
   different sha, or lacking `checkedAtSha`, does not bind the
   acceptance to THIS commit and the commit does not qualify;
   v10, c8-M12 — `pass:false` criteria carry no binding sha and are
   irrelevant to a complete verdict's qualification; **NON-VACUITY
   (v11, c9-M15):** an acceptance whose criterion set is EMPTY, or
   whose passing criteria all lack `checkedAtSha` or bind a
   different sha, NEVER qualifies — "complete over nothing" proves
   nothing and fires the refusal, not a pass), AND in both
   cases (c) PROVENANCE:
   the record names the episode and task (revision) the candidate
   belongs to or a recorded dispatch lineage linking it to this
   task's candidate chain — an acceptance for an unrelated task or a
   DIFFERENT episode with no lineage link does not qualify (an
   unrelated green repro of the same sha is not THIS candidate's
   gate), (d) NOT INVALIDATED — the mechanism is the acceptance
   record's DERIVED `invalidatedBy` reading (v10, c8-M12, replacing
   the undefined "a later record marks it invalidated"; reading
   reconciled v12 with v11 c9-M5 — no STORED field is consulted:
   the acceptance record is never mutated; replay folds
   `evidence-invalidation` events over the prefix and the check
   runs on the derived value): a `repro-run`
   record is IMMUTABLE and never carries invalidation; for an
   acceptance, qualification fails iff its replay-folded
   `invalidatedBy`
   is non-null (the derived value names the invalidating record —
   the check is present-or-null on the acceptance record's FOLDED
   state at this log position, replay
   trivially deterministic). To invalidate a REPRO-RUN's
   qualification there is exactly ONE route (v10, c8-M12): an
   append-only `evidence-invalidation` record `{ envelope,
   targetKind:"repro-run", targetRecordId, reason, reasonEvidenceRefs[],
   authority }` (v13, audit finding 4: the ONE wire shape is the §14.10.3 closed-enum schema; the v10 names `reasonCode`/`reasonDigest`/`ownerActRef` are withdrawn) — owner-act consumption-bound
   (§14.10.3), appended only after the target's `owner-act`
   consumption lands, and a target that any committed boundary's
   verdict already consumed is ALSO invalidated retroactively for
   FUTURE reuse qualification only: past verdicts stand as appended
   (the log never rewrites), the invalidation binds forward from its
   position; replay rule: an evidence record is unqualified at any
   position ≥ the invalidation's log position (an invalidated gate
   is absent evidence, fail closed). Traversal bounds (v9, c7-M11): the walk
   is bounded by the episode policy `maxAncestryWalkCommits`
   (default 512) AND `maxAncestryWalkBytes` (default 64 MiB of
   object reads); exceeding either bound leaves the closure UNPROVEN
   ⇒ reuse REFUSED (fail closed, resource pressure never silently
   weakens the check — a refusal is the safe answer, not a partial
   walk). A merge commit whose OTHER parent lies outside the walked
   reach is part of `C \ A` by the same rule and needs its own
   qualifying evidence via its own lineage; the walk is exactly
   `C`'s ancestor set minus `A`'s ancestor set over present objects
   (recorded git reachability, not filesystem guessing).
   **Route-(b) producer availability (v11, c9-M15):** acceptance
   records are minted for ARTIFACTS P14 evaluates (the merge-tree
   CANDIDATE; a plain commit only when one is separately submitted
   and accepted), so a PLAIN intermediate commit inside `C \ A` has
   a route-(b) acceptance ONLY IF one was actually produced and
   bound to its sha earlier in the episode. No rule fabricates an
   acceptance for an arbitrary intermediate commit, and its absence
   is not a contract defect — such a commit qualifies via route (a)
   (green repro bound to its sha) or ancestor reuse REFUSES and
   falls back to EXACT-CANDIDATE EXECUTION, the standing default
   (the route is available exactly when per-commit evidence EXISTS;
   a candidate-level acceptance NEVER propagates to intermediate
   commits — the c9 counterexample (candidate C with a plain worker
   commit X between A and C, no acceptance producer for X) is
   therefore SAFE: reuse refuses, exact-candidate runs, no false
   clean).
   One commit in `C \ A` without QUALIFYING evidence ⇒ reuse REFUSED.
   (iii) The trace conditions (v7, kept): the repro ran in a recording
   sandbox whose access trace (every file, env var, and network
   endpoint the run touched) is part of `runEvidenceRef`;
   `reproPaths` (resolved canonically) is the supervisor-verified
   SUPERSET of the traced filesystem inputs; every traced path has
   EQUAL tree object ids between `A` and `C` (verified against the
   object store); and the trace shows no non-reproducible input
   (network fetch, mutable env, clock-dependent config) — any
   untraceable input, a truncated trace, an unsandboxed run, or a
   `reproPaths` set that is empty or not provably a superset of the
   trace ⇒ ancestor reuse REFUSED (fail closed: the completeness of
   the closure is never assumed, and an equality check over a path set
   the repro did not actually consume is vacuous).
   (i)+(ii) are checked FIRST from the object store and the ledger,
   then (iii) over the trace; any failure at any level ⇒ exact-
   candidate execution required (the DEFAULT stands). A green run on
   an unrelated tree does NOT support
   `accepted-fix` (refused). The
   transition check verifies the referenced record EXISTS, binds the
   same findingId + reproDigest, was written by the supervisor (not the
   worker; runner authority recorded), AND passes the artifact binding;
   missing, mismatched, worker-authored, unbound, or red ⇒ transition
   refused. `repro.kind:"none"` (unfalsifiable —
   typical opinion/human-review) ⇒ `accepted-fix` is REFUSED outright;
   owner dispositions only.
   **Chains preserve obligations GLOBALLY, not only for opinion basis
   (v5, c3; state table v6, c4-M7):** `rejected-duplicate`/`superseded`
   is valid ONLY if the survivor has severity ≥ the source's and the
   same `route` — a major may NOT retire into a minor (refused; needs
   owner disposition or an independent fix). **Equivalence is
   machine-checked or owner-authorized (v5, digest bytes v6):** a
   duplicate link requires `reproDigest` EQUAL to the survivor's, where
   the digest is `tre-scope-digest/1`-style canonical bytes over the
   repro object ONLY (key-sorted UTF-8 JSON, §0.7; kind, command,
   fixture refs, postFixExpected — bookkeeping excluded) AND the repro
   is FALSIFIABLE (`kind != "none"`); equal hashes of
   `repro.kind:"none"` or of an under-specified repro NEVER equate
   findings — those links require an owner disposition on the duplicate
   act; severity+route alone is not equivalence (an unrelated open
   major cannot absorb one, c3).
   **Chain closure = survivor disposition × obligation table (v6 —
   replaces the contradictory "open-or-owner-closed" clause):**
   | survivor disposition | chain-member outcome |
   |---|---|
   | open | member stays open (counts against sign-off as the survivor's severity) |
   | `accepted-fix` with VALID repro-run evidence (incl. artifact binding) | DISCHARGED — every member resolved |
   | owner-closed `closed-residual` (authority REQUIRED) | member inherits the residual — resolved as residual, surfaced at P13; NOT a clean discharge |
   | owner `superseded` onto a third norm/finding | member relinks to the new survivor (revalidate severity/route/falsifiability) |
   | closed by any other route (stale, duplicate-of-nothing, dangling) | UNCLEAN — violation at every boundary thereafter |
   Transitive chains resolve through this table end-to-end at every
   boundary; every survivor transition — including orchestrator
   `rejected-duplicate` pointing at an owner-`superseded` third
   finding (row 4's relink applies) and duplicate-to-third chains
   (folded iteratively to a fixed point per boundary; a chain longer
   than the prefix's finding count is a cycle ⇒ malformed) — is a row.
   Link CYCLES (A→B→A) are malformed ⇒ needs-owner. A
   survivor whose disposition later CHANGES re-evaluates member
   outcomes for LATER boundaries only (verdicts stay frozen). A
   committed boundary whose recorded chain outcome disagrees with this
   table's recomputation is a `history-integrity-fault` (14.12.3 v7) —
   never a retroactive refusal (14.14.4).
   **Chain members in cleanliness (v8, c6-M13 — the table is WIRED
   into the predicates, not parallel to them):** each member's derived
   state at a boundary is exactly its row's outcome: `open` (counts
   against rule 3 at the survivor's severity), `discharged`, or
   `residual-inherited`. An `open` member is an open finding for rule
   3 (blocks clean). A `residual-inherited` member is NOT open — it
   does NOT satisfy rule 3's "no open blocker/major" question — but
   its row's "NOT a clean discharge" means the ROUND is unclean by
   ITS OWN: the inherited-residual set is a named clause of the
   unclean predicate (14.12.2 clean = no open blocker/major AND no
   `residual-inherited` member of ANY severity at this boundary AND
   the other clauses). An owner-accepted residual never permits the
   round carrying it to be clean; a LATER round may be clean only if
   the residual was itself re-resolved — **the re-resolution route is
   an append-only `residual-re-resolution` record (v9, c7-M7):
   `{ kind:"residual-re-resolution", id, ts, findingId, survivorId,
   route:"accepted-fix|fresh-finding-cycle", evidenceRef,
   authority:"tty:…" }` naming the SURVIVOR's closed residual
   disposition it re-resolves. It is NOT a transition on the closed
   finding (G1's "a transition applied to an already-closed finding
   is invalid" §14.10.2 stands — this record does not change the
   finding's disposition; it records the owner's act of RE-OPENING
   THE RESIDUAL QUESTION onto new work: `route:"accepted-fix"` binds
   a repro-green artifact for a FIX committed after the record;
   `route:"fresh-finding-cycle"` binds a new finding id whose
   lineage cites this record). Replay re-derives chain state
   FORWARD ONLY: a chain row's `residual-inherited` member clears
   for boundaries AFTER the re-resolution record settles (fix
   reproduced green, or the fresh finding itself disposed) and every
   earlier boundary keeps its original state — prior boundaries
   never re-derive cleaner; the inherited member of the CURRENT
   round is unclean until its re-resolution settles, and an unsettled
   re-resolution does NOT downgrade anything. A re-resolution on a
   finding whose survivor residual was never owner-accepted is
   refused (nothing to re-resolve); a second re-resolution on the
   same (`findingId`, `survivorId`) pair before the first settles is
   refused (no forked cure).
   `discharged` members
   impose nothing.
5. **Minors (v3):** never hold a round unclean BY DEFAULT — **unless** an
   owner escalation record `finding-hold` (14.12.4; authority REQUIRED)
   names the finding and is not lifted. `finding-hold` keeps the finding
   OPEN (it is not a disposition); a held minor counts as a sign-off
   holder for rule 3 until the owner lifts it (`finding-hold-lift`,
   owner-authorized).

**Boundary freeze (v5, drain-and-fence finalization — replaces v4's
"boundary n+1 catches it" claim, false for the final boundary, c3):**
prefix membership is **log POSITION** — the evaluated prefix is every
line before the `cycle-boundary` line. The v4 error: a queued owner
`finding-hold` or late auditor major could land immediately after the
FINAL boundary, produce `converged` over the frozen prefix, and (since
converged needs no next cycle) never be examined at any later boundary.
v5 finalizes under a protocol, in ONE S5 critical section:
1. **Fence intake for cycle `n`:** after the manifest closes, intake
   accepts submissions ONLY from `n`'s assigned auditor sessions
   (receipts, 14.12.4b); a submission from any other source during the
   fence is filed to the NEXT cycle's window explicitly (it carries a
   `windowOf` reference and cannot silently join `n`).
2. **Drain:** before appending the boundary, the supervisor flushes
   every pending derived append it owes (deterministic owner filings
   from intake-refusals, supervisor-filed records) — the drain set is
   computed from durable refusal/pending state, not memory.
3. **Quiesce check, atomically with the boundary append:** no intake
   receipt from `n`'s sessions is unresolved (each filed/refused), no
   owed filing is pending, no completion/retry event is outstanding
   (rule 1 state machine settled). If the quiesce check fails, the
   boundary MUST NOT append — the cycle is not finalizable; it sits
   `needs-owner` (fail closed), never a partial boundary.
   **v9 scoping (c7-M13):** this MUST-NOT-APPEND applies ONLY while
   every failing condition is DRAIN-PROGRESSING (class B of the
   finalization decision table below) — a check that fails on an
   owner-only condition never blocks the append (it forces unclean);
   and a drain that makes no progress for `quiesceWaitMaxMs`
   (episode policy; default = one full wave plus reconciliation
   grace) converts the condition to class O (durable needs-owner
   obligation), so finalization can never livelock without a
   recorded fact — see the table.
4. Append `cycle-boundary`; evaluate the prefix; append the verdict —
   all inside the same critical section, so no eligible act can be
   "waiting on the lock" across the commit: eligible acts are either
   inside the prefix or explicitly assigned to the next window.
5. **Fence ALL actors — not just intake:** the finalization fence
   covers EVERY writer that could change the verdict inputs: intake
   (rule 1), owner acts (§14.7), supervisor derived appends, and the
   dispatch lane (§14.11). Between steps 3 and the verdict append the
   ONLY permitted writers are the finalization path itself.
   **Owner-act linearization (v7, c5-B1; handoff state machine v8,
   c6-B1):** an owner act's linearization point is its `owner-act`
   record's APPEND POSITION, not its arrival. Before the fence engages,
   an arriving act is appended normally and is in the evaluated prefix
   like any record. Once the fence engages, the supervising process
   admits the act through a serialized queue-admission protocol (v8):
   the pending-act queue is a separate append-only file, but it is
   written under the SAME S5 `flock` as the log (one lock serializes
   both files — there is no window where a queue append and a boundary
   append race). State machine, all transitions under that lock:
   (a) FENCE state `open → engaged` — append `fence-engaged { cycle,
   engagedTs }` to the LOG; from this point every arriving owner act is
   appended to the QUEUE file (fsynced, with a queue receipt returned
   to the act's origin) and NEVER to the log.
   (b) DRAIN — at finalization, before the quiesce check, the
   supervisor drains the queue FIFO into the log INSIDE the current
   critical section: each drained act is appended as an `owner-act`
   record carrying its original queue-receipt id (deduped against
   redelivery: an act whose queue-receipt id already appears as an
   `owner-act` in the log is skipped), AND its authorized effect
   record(s) are validated and appended in the SAME critical section,
   immediately after the act (act → effect(s) → next queue entry —
   v10, c8-B1: an act drained without its effect is an outstanding
   effect, class B; the quiesce check at step (c) can never pass with
   one, so no boundary commits between an act and its effect; the
   successor-ratification group of §14.11.2 is one such effect —
   both members appended as the atomic group, same lock).
   Drained acts are therefore IN
   the evaluated prefix — a queued cure (a waiver act) applies to the
   CURRENT cycle and can close it; it is never stranded waiting for a
   later window.
   **Linearization point & blocked writers (v9, c7-B3):** the ONE
   admission/ack linearization point of an owner act in a fenced
   window is the fsync of its QUEUE append (unfenced: the fsync of its
   LOG append). A writer blocked on the flock while the finalization
   critical section runs is NOT acknowledged and NOT admitted — it is
   pending, and the contract makes NO claim that a pending act "was
   queued" or counts anywhere until its append lands. The finalization
   critical section is drain + quiesce + boundary + verdict + fence
   release under a single lock hold, so **no admission path exists
   between the drain and the fence release**: the v8 sentence admitting
   acts "arriving between the drain and the lock handoff" to the queue
   is RETRACTED — under one lock such arrival cannot be observed
   mid-section; a writer that acquires the lock after the section
   finds the fence released and appends to the log normally as a
   POST-WINDOW act. The window ends at the boundary commit; acts are
   in the prefix iff appended (queue-drained) before the boundary
   line, post-window otherwise — the time a HUMAN confirmed at a TTY
   governs nothing; the contract orders ACT-RECORD ADMISSION, and an
   acknowledged-but-unadmitted confirmation is a pending channel
   write, never a prefix member (v9 answers the c6 question
   explicitly: a pre-boundary human confirmation does NOT prevent
   convergence; only an admitted act can hold the boundary).
   (c) QUIESCE CHECK — under the lock, queue empty AND no owed work;
   the emptiness check and the boundary append are the SAME critical
   section, so no act can slip in between check and commit. "Queue
   empty" means **no entry fails any of the THREE SEPARATE PREDICATES
   below (v17, cycle-11 audit finding 6 — v15's single MATCHED/NOT-matched
   vocabulary carried three different questions at once: v15 said an
   entry was "MATCHED iff" the act identity existed while two
   paragraphs later an act-landed-without-effect entry was "likewise
   NOT matched" — an entry both matched and not matched — and the
   drain's act-identity skip could bypass a second duplicate entry
   before it was ever scanned. Matching is now THREE pinned
   predicates, evaluated per durable entry over the WHOLE queue file,
   every entry, on every recovery — never lazily and never only for
   entries not yet matched:**
   - **P1 transport match:** the log contains an `owner-act` whose
     act identity `(channelOpenRecordId, channelId, actId)` (the triple, v18 finding 4) equals the entry's. The
     `queueReceiptId` equality is NOT a matching condition — it is
     enforced STRUCTURALLY at append: a conforming appender never
     creates a second queue entry for an existing act identity
     (same-act append returns the EXISTING entry with its ORIGINAL
     receipt — see the dedup paragraph below), so the queue holds AT
     MOST ONE entry per `(channelOpenRecordId, channelId, actId)` triple for all time and receipt
     drift cannot arise inside a conforming queue file.
   - **P2 integrity:** the entry's `queueReceiptId` equals the
     receipt cited by the P1-matched log act AND its canonical
     payload is byte-identical to that act's. A nonconforming writer
     or corruption that lands a second entry for an existing act
     identity with a DRIFTING receipt but identical payload is
     detected at the pre-drain scan (below, not at first-drain skip)
     as a `queue-receipt-divergence` history-integrity-fault (kind
     added v15, §14.12.3 — detection evidence, never a second
     consumption); a different payload under an existing act identity
     stays the append-time conflict (refused + `needs-owner`).
   - **P3 effect completion:** if P1 is matched, the matched
     `owner-act`'s effect record is also present (a landed act
     without its effect is class B — effect owed, c8-B1). P3 failure
     is NOT "unmatched" in the transport sense — the act consumed
     once, the owed effect drives recovery — it fails the emptiness
     test: an entry failing ANY predicate makes the queue NON-EMPTY
   for quiescence (a VOIDED entry of a retired channel is excluded from all three predicates, v19 finding 5); "matched" in every other paragraph of this
     document means P1 only.
   **Pre-drain full scan (v17, cycle-11 finding 6, normative before/after):**
   before the drain consumes ANY entry — on every startup and before
   every quiescence check — the recovery pass scans EVERY durable
   entry in the queue file, INCLUDING P1-matched and already-drained
   entries, for (i) duplicate act identities (two entries, same
   `(channelOpenRecordId, channelId, actId)` triple — a nonconforming append. A duplicate pair with byte-identical payloads is dispositioned by the SINGLE drift algorithm of §14.12.3 (v21, cycle-14 finding 2 — v20 hard-coded "the SECOND entry is the fault" HERE, which contradicted §14.12.3 once a matched owner-act lands and cites a different receipt): the reference is the matched owner-act's receipt when that act exists, else the FIRST-APPENDED entry's receipt, and EVERY entry drifting from the reference is a `queue-receipt-divergence` fault. Before any act exists the rule reduces to "the second (non-first) entry drifts" (receipts differ: the drift case) — the v20 text was the no-act special case, stated as if it were the whole rule. With payloads differing, it is an append-conflict `needs-owner` — decided by the two queue entries ALONE, no logged act consulted, because before the first drain no owner-act exists (v18, finding 3) and (ii)
   receipt drift (P2). Counterexample pinned (v15 was bypass-prone):
   two entries, same act, same payload, different receipts, NEITHER
   drained; the first drains; crash; restart — the scan visits BOTH
   entries regardless of the first's drained state and reports the
   second's receipt drift; an implementation that resumes "at the
   first unmatched entry" and stops at the first P1 hit silently
   bypasses it (forbidden). A partially drained queue is
   indistinguishable from this and replays identically (drain
   resumes at the first entry failing P1; drained prefix entries
   dedup by the composite rule, so partial-drain replay is
   idempotent without a drain cursor).
   (d) boundary + verdict append; FENCE state `engaged → open`
   (implicit: the fence ends with the critical section; a queue write
   that finds no `fence-engaged` without a following boundary in the
   log is a post-window act admitted normally).
   **Identity & ack inventory (v9, c7-B3; dedup key fixed v10,
   c8-M7; identity domain RE-PINNED v11, c9-M7 — "unique per acting
   channel episode" let TWO distinct channel streams each mint
   `actId:A`, and act-only drain skipping then DROPPED the second
   stream's act; BINDING TO THE CHANNEL-OPEN RECORD RE-PINNED v17,
   cycle-11 audit finding 7 — a collision detection based on
   `(channelId, actId)` alone cannot CITE the duplicate channel-open
   as the drain requires: entries identifying acts by
   `(channelId, actId)` give C2's entry the same identity as C1's
   already-drained act, so it skips as consumed while the contract
   simultaneously demands refusing entries citing the duplicate
   channel-open — the specified identity does not supply that
   citation):** every act carries a channel-assigned `actId`
   under the channel's **durable `channelId`** — the channel
   identity is minted once at channel establishment (ULID, recorded
   in a durable `channel-open` record in the log: `{ envelope,
   channelId, channelKind:"tty-cli", device }`, envelope kind added
   to §14.12.4b, v11), and every act and queue entry additionally
   carries `channelOpenRecordId` — the envelope `recordId` of the
   channel-open record that minted its channel (v16, copied from
   the channel's own establishment record at act creation/queue
   append; a channel cannot forge another channel's record id
   because the appender copies it from the channel's session state,
   which was set when the channel-open record was appended). The
   ACT's identity is the composite
   `(channelOpenRecordId, channelId, actId)` — a TRIPLE, globally
   unique across the episode: under channel-id uniqueness the first
   two components collapse to one authority, and when a second
   `channel-open` reuses a `channelId` (history-integrity-fault,
   `channel-id-collision`, fail closed — v15), the triple KEEPS the
   two streams' acts DISTINCT instead of silently fusing them: C1's
   and C2's `actId:A` entries carry different
   `channelOpenRecordId`s, so dedup never consumes C2's entry as
   "already drained", the drain's refusal cites the duplicate
   channel-open record directly (its `recordId` is IN the entry's
   identity), and the disposition is pinned (v16): while the
   `channel-id-collision` episode is open, entries whose
   `channelOpenRecordId` equals the DUPLICATE channel-open's record
   id are NOT drained (refused per entry, episode stays needs-owner);
   entries of the FIRST channel-open continue to drain normally —
   already-drained first-channel acts are untouched (append-only),
   and if the owner's disposition retires the duplicate channel, its
   undrained entries are durably voided by a
   `history-integrity-disposition` citing the collision fault and
   listing the voided entries, never drained under any identity.
   `actId`
   is stable across redelivery of the same
   confirmation) and each queue append gets a `queueReceiptId`
   unique for all time within the episode (monotonic per-writer
   counter + writer id — content may repeat, receipt ids never do).
   **v9's "Dedup is BY `queueReceiptId` only" is RETRACTED
   (v10, c8-M7):** a crash after the queue fsync but before the
   channel durably records the receipt lets a retry mint a NEW
   receipt id for the same `actId`, and receipt-only dedup admits it
   twice — for a one-act-consumption op that is not exactly-once
   delivery. The dedup key is the STABLE composite
   `(channelOpenRecordId, channelId, actId)` (v17, cycle-11 finding
   7 — the triple, per the identity re-pin above; the two channels'
   acts under a REUSED channelId stay distinct because their
   channel-open record ids differ; assigned before
   submission, never re-minted): the drain skips a queue entry whose
   full triple already appears in a log `owner-act`; a queue APPEND for
   the same triple already present in the queue file is a
   redelivery —
   the existing entry (with its original receipt id) is returned,
   never duplicated; a same-triple append whose canonical payload
   DIFFERS is a conflict ⇒ refused at append + `needs-owner`
   (channel collision or lie — fail closed); an append whose
   `(channelId, actId)` matches an existing entry but whose
   `channelOpenRecordId` DIFFERS is the channel-id-collision case —
   it is NOT a redelivery and NOT silently a distinct act: it is
   refused at append + the collision fault path (v17), because the
   two channel-open records prove one of the two writers is
   nonconforming. `queueReceiptId` stays
   the per-append transport marker: a drained `owner-act` cites the
   receipt of the entry it drained AND its full triple,
   and crash recovery resumes the
   drain at the first queue entry with no matching log `owner-act`
   (matching by act identity (the triple) per the reconciled
   predicate rule above; the
   cited `queueReceiptId` must equal the entry's own receipt —
   drift there is the `queue-receipt-divergence` fault above, not
   a matching condition).
   Channels keep `actId` stable across redelivery; a channel that
   cannot is non-conforming. Conformance tests (v11, c9-M7;
   receipt clause RE-PINNED v15, cycle-10 audit finding 6 — the v11
   vector asserted "same act / new receipt ⇒ skipped by act
   identity" while the AND-matching rule made that entry
   permanently unmatched, contradicting the skip; channel-collision
   vectors PINNED v17, cycle-11 finding 7): same act / new
   receipt ⇒ the APPEND returns the existing entry with its
   original receipt (no second entry, no new receipt in the queue
   file; a writer that lands one anyway is detected at drain as
   `queue-receipt-divergence`, the act consumed once, the boundary
   is UNCLEAN needs-owner);
   different channels / same local `actId` ⇒ BOTH drain (composite
   identity differs), neither dropped;
   two channel-opens C1/C2 with EQUAL channelId, each mints
   `actId:A`, C1's act already drained: the pre-drain scan detects
   the channel-id-collision from the channel-open pair; C2's queued
   entry carries `channelOpenRecordId:C2` — it is NOT skipped as
   already-consumed (the triple differs from C1's drained act), it
   is refused citing the duplicate channel-open record C2 directly
   (its recordId is in the entry's identity), the episode goes
   needs-owner, C1's drained act is untouched (v17);
   same triple / different payload ⇒ refused at append +
   needs-owner (redelivery lie, v11). Crash windows (conformance-tested,
   v10, c8-M7): crash before the queue fsync ⇒ nothing durable, a
   retry with the same actId appends fresh (idempotent); crash after
   queue fsync before the receipt is returned/recorded ⇒ the retry
   finds the entry by actId and re-returns its receipt (no second
   entry, no second act); crash after ack before drain ⇒ the entry
   waits in the queue and drains exactly once (actId dedup). The
   queue append IS the ack: the receipt (actId, queueReceiptId, ts)
   is returned only after fsync, and the channel keeps its own
   append-only ack log (durable, independent of the queue file) so
   loss of the queue file is DETECTED as ack-log entries with no
   matching queue record or log `owner-act` — the episode fails
   closed to `needs-owner` citing those entries (loss of a transport
   buffer is an incident, never a silent drop).
   A nonempty queue at any quiesce check blocks CLEAN closure (unclean
   boundary remains appendable per c5-M3). Crash recovery:
   `fence-engaged` with no following boundary ⇒ the cycle remains open;
   restart resumes finalization from queue + log state (drain is
   idempotent by queue-receipt id AND `(channelId, actId)` — v10,
   c8-M7 / v11 c9-M7 — resuming
   at the first unmatched
   entry). Queue durability/replay: the queue file is NOT authoritative
   history — authority is the drained `owner-act` log records; the
   queue is a transport buffer, and replay reconstructs pending state
   as "queue-file records with no matching log `owner-act`" (order =
   queue append order).
**External obligations at close (fail-closed gate):** a cycle is NOT
finalizable while any obligation it incurred is unmet: unmet owner
holds, unresolved scope escapes (see 14.12.2a), findings mandated to
the supervisor but not yet filed, dispatch authorizations neither
consumed nor explicitly dropped (with owner act). Such a cycle sits
`needs-owner` — it CANNOT close clean; a CLEAN boundary line is appended
only when every obligation is met, owner-explicitly waived, or
discharged per its rule (v7, c5-M3: an UNCLEAN `needs-owner` boundary
remains appendable while obligations are open — the gate constrains
clean closure, never the log's ability to record an unclean close).
**Finalization decision table (v9, c7-M13 — ONE table resolving
"MUST NOT append" vs "unclean boundary remains appendable"; recovery
and budget accounting consult THIS table, and only this table, to
decide whether a cycle closed):** every condition the finalization
protocol examines is assigned to exactly one class, and the classes
have disjoint, exhaustive effects:

| Class | Condition (examples) | Boundary append? | Boundary verdict inputs | Cycle state after |
|---|---|---|---|---|
| **A — met/disposed** | receipts all filed/refused; owed filings drained; completion FSM settled; queue drained to empty; obligations met/waived/discharged; remote-terminal disposed; deferrals resolved in-window | YES | clean contribution | closes per verdict table (clean possible) |
| **B — drain-progressing (supervisor can still resolve; NOT yet finalizable)** | owed filing pending but its source refusal record is durable (drain will file it); intake receipt from `n`'s sessions whose session is still alive/respawnable; queue entry awaiting its drain turn; drained `owner-act` with an outstanding effect (`effectRecordIds` not all present in the log, v10 c8-B1); mandated filing awaiting its deterministic derivation | NO — step 3 MUST-NOT-APPEND holds; retry finalization after the drain lands | n/a (no boundary yet) | cycle stays OPEN; if drain stalls past `quiesceWaitMaxMs` the condition is reclassified O (durable `quiesce-stall` needs-owner record citing the stalled condition) |
| **O — owner-only (unclosable-clean, closable-unclean)** | active `finding-hold`; unresolved `scope-escape`; `remote-terminal-unproven` without disposition; history-integrity-fault; deferred receipt still `deferred` (window elapsed or still open); nonempty pending-act queue whose entries are all class-O-shaped acts (holds/dispositions); escape-obligation open without waiver | YES — boundary appends, UNCLEAN | every unclean predicate of the verdict table fires; `needs-owner` | closed UNCLEAN + `needs-owner`; obligations carry into the next window (deferral) or stay episode-global (escape, fault); NEVER retroactively re-cleaned |

Precedence is mechanical (v10, c8-B2 — total, no silent waiver): a
cycle is closable-unclean iff NO condition is in B (any single B —
regardless of which O conditions co-occur — blocks the append until it
drains or converts); if ≥1 condition is in O (and none in B) the
boundary appends UNCLEAN; if all are A the boundary appends clean. An
O condition NEVER waives a B drain obligation: an owed filing pending
plus an open scope escape means the boundary waits for the filing,
then closes unclean for the escape — the escape's unclean verdict is
computed at that later boundary, not skipped past. B→O conversion at
`quiesceWaitMaxMs` is the ONLY route past a stalled B (so B never
livelocks), and O never blocks the append, only cleanliness — BUT a
converted condition's owed item does not evaporate: the `quiesce-stall`
record names it (`refConditionRecordIds`), and the carried-forward
obligation is consumed by the NEXT window's drain as work the previous
cycle left owed (counted there, reported at every later boundary until
filed). **Authorized-effect stall — the NON-EQUIVALENT conversion
(v11, c9-B3):** a drained `owner-act` whose `effectRecordIds` are not
all durable is class B, and its B→O conversion at `quiesceWaitMaxMs`
unblocks the APPEND but NEVER the AUTHORITY: the converted condition's
boundary appends UNCLEAN + `needs-owner` (never clean), the effect
stays OWED across every later boundary until applied (the act is
self-contained per the v11 payload rule, so recovery can always
reconstruct and re-apply it from the log even if the queue file is
gone), and no downstream consumer may treat the O conversion, the
unclean boundary, or the carried-forward mention as the act having
been consumed — `effectApplied` stays false until every named effect
record exists and validates. **Replayable stall timer (v11,
c9-M14):** the conversion clock has a DURABLE ORIGIN — the first
finalization attempt that finds a condition in B appends (once per
condition identity) a `finalization-wait-anchor` record
`{ envelope, conditionId, conditionKind, anchorTs, bootId }`
(`conditionId` = the identity of the condition the table names —
e.g. the owed filing's source record id, the stalled act's
`owner-act` id, the queue entry's `(channelOpenRecordId,
channelId, actId)` triple (v17, cycle-11 finding 7); `anchorTs` =
wallclock ts at first observation; envelope kind added to §14.12.4b,
v11); conversion past `quiesceWaitMaxMs` is measured from `anchorTs`
(wallclock — the monotonic-domain rules above do NOT apply to this
timer). **Unit normalization & late conversion (v12, owner decision
D4-a — the v11 expression `quiesceWaitMaxMs + maxClockSkewS` added
a SECONDS-typed tolerance to a MILLISECONDS-typed threshold, so the
guard was off by 1000×):** the tolerance is defined in
milliseconds — `maxClockSkewMs = maxClockSkewS × 1000` (`maxClockSkewS`
is the episode policy's clock-skew tolerance expressed in seconds —
the parameter this contract defines, v12) — and there
is NO upper absurdity bound (v13, audit finding 3: the v12 text called `elapsed > quiesceWaitMaxMs + maxClockSkewMs` an absurdity bound while the same paragraph declared lateness expected; both cannot hold, and lateness is never a fault).
**A late conversion is NOT a clock fault (v12, D4-a):** when the
supervisor is down or busy, the `quiesce-stall` record is appended
at the next re-attempt, which can be arbitrarily later than the
anchor + threshold; the clock-domain fault tests the RECORD'S
CLAIMS AGAINST THE ANCHOR'S DIRECTION OF TIME, not lateness — it
fires only on (a) elapsed negative (a ts before the anchor), or (b) a claimed `quiesce-stall.waitedMs` disagreeing with `ts − anchorTs` beyond `maxClockSkewMs`. The monotonic clock is NOT consulted by this timer (v13): the anchor and stall records carry wallclock only, so no monotonic-ordering fault exists for them. Elapsed greater than the threshold is EXPECTED (downtime) and is never itself a fault; replay verifies `waitedMs ≥ quiesceWaitMaxMs` and the claimed-vs-ts agreement above (v11 c9-M14),
never a silent shortening. **Forward-jump limitation — ACCEPTED (v14, owner decision D5-a):** a wallclock step FORWARD (an NTP correction, a clock set ahead) shortly before the conversion is invisible to this timer and may fire the B→O conversion EARLY (the real wait shorter than `quiesceWaitMaxMs`): the stall's `waitedMs` is computed from the same shifted clock that supplies the elapsed test, so the record's claims agree and rule (b) cannot fire. This is classified as an ACCEPTED limitation, not a defect, because every consequence it can produce is owner-visible and none consumes authority — **wording corrected v15 (cycle-10 review finding 5: v14's "its only effect is the safe direction — a boundary that might have been clean is instead recorded UNCLEAN" overstated: early conversion ALSO lifts the append-blocking the B class imposes and moves escalation earlier, so it changes WHEN work stops being blocked, not merely how a boundary is labeled):** a forward jump may convert the stalled condition B→O early, permitting an UNCLEAN needs-owner boundary to be appended before the intended real-time wait elapses — with every outstanding effect still unvalidated, `effectApplied` still false, authority still NOT consumed (§14.10.3 c9-B3 stands: the conversion route never converts authority), and needs-owner still owed to the owner; it can never produce a CLEAN boundary early, and never the reverse. No wallclock-only scheme detects a step from its own records, and a cross-boot step is undetectable even with monotonic samples (c8-M11's boot-pairing nulls the comparison across boots). A supervisor restart NEVER resets the
wait: recovery reads the anchor from the log and converts at the
same wallclock point every implementation does. Each finalization
re-attempt re-evaluates the class of every condition from current
records, ordering pinned: evaluate drains FIRST, then thresholds (a
drain landing at exactly the threshold clears B before conversion is
evaluated); `quiesce-stall` MUST cite its anchor record id in
`refConditionRecordIds` so replay verifies elapsed ≥ threshold — a
stall record without a verifiable anchor origin is malformed (fail
closed). A deferred receipt is O (blocks
clean; does not block append) — this is the single normative reading
of the v8 "deferred blocks every clean boundary" rule; owed filings
are B (they block append until drained, because the supervisor OWES
them and can complete them). The queue rule restated through the
table: a queue entry whose act would change verdict inputs is B until
drained (drain is mandatory before append, effect included per
c8-B1), and an entry parked past
`quiesceWaitMaxMs` is O (durable needs-owner, transport incident per
the ack-log rule). Deterministic for recovery: replaying the prefix
re-derives each condition's class from records alone.
**Acts after finalization:** owner holds/lifts and new findings
appended after a `converged` boundary are recorded and surfaced (P13)
but never retroactively rewrite the verdict (append-only, and the
verdict is the round's frozen fact); a post-convergence owner act opens
a NEW cycle (owner-initiated, fresh admission) — the reopen is explicit
forward history, not a re-clean. Two boundaries for one cycle, a
boundary with no manifest window between it and the previous boundary,
or any evaluation that re-derives differently over the same prefix ⇒
malformed ⇒ cycle unclean + `needs-owner` (fail closed). Crash
reconstruction replays up to the last boundary line; evaluation is
deterministic over that prefix, so a later disposition can never
re-clean (the boundary line, not the disposable verdict, is the
freeze). The `convergence-verdict` stays a derived, recorded projection
— the authoritative history is the log itself plus its boundary
lines.

#### 14.12.3 Verdict (at each cycle boundary)

The **streak** is the count of consecutive clean rounds ending at the
latest round, **evaluated at boundary cutoffs only**. Persisted in every
verdict: `streakAfter` (authoritative value after this boundary —
a clean round increments, an unclean round resets to 0;
`budget-exhausted` records `streakAfter` as computed at that boundary
and freezes it). Verdict, in precedence order:

| verdict | condition |
|---|---|
| `budget-exhausted` | the loop still NEEDS a next cycle (streakAfter < `cleanRoundsRequired` or any needs-owner condition) AND G4 refuses its admission (§14.13) — terminal until an owner extension |
| `needs-owner` | any open `norm-ratification` blocker (G2), any `route:human-review` finding awaiting disposition, any opinion-basis blocker/major awaiting owner decision, any active `finding-hold`, any intake-refusal whose supervisor filing is not yet durable (v4), any unresolved unknown spend/elapsed of the current cycle, any unresolved `scope-escape` event ANYWHERE earlier in the episode (v6 — episode-global until a valid resolution **or waiver** (v7); v5's "of this cycle" was leaky), any `remote-terminal-unproven` without a valid `remote-terminal-disposition` (v7), any nonempty pending-act queue at quiesce (v7, 14.12.2 step 5), any episode in `history-integrity-fault` (v7, 14.12.3/14.14.4), or undecidable diversity (14.12.2 rule 2) |
| `converged` | streakAfter ≥ `cleanRoundsRequired` AND no needs-owner condition holds |
| `continue` | otherwise |

**Converged does not require admitting another cycle (v4, c2):** a cap
that blocks a NEEDLESS next cycle cannot demote a fully-verified result;
exhaustion bites only when another cycle is actually required. Current-
cycle unknowns still hold `needs-owner` (listed above), so this is not
an escape for unreconciled spend.

Precedence (v2): `budget-exhausted` outranks `needs-owner` — exhaustion
is a fact about the loop's authority to continue, and must not be masked
by an outstanding owner question (the owner sees it anyway: exhaustion
is surfaced on the P13 channel together with any pending owner question,
merging the asks into one). `needs-owner` outranks `converged` — a clean
streak with an outstanding owner decision is NOT converged (the same
"presence of a finding outranks absence of evidence" principle as P14
C3-F2).

**Extension/resumption (v4, replay recurrence):** `streakAfter` and
`confirmingUsed` are **checkable caches, never authority** (v4 resolves
v3's contradiction — verdicts stay prohibited recovery inputs). Every
boundary line carries `policyRevision` (effective policy version at that
prefix) and the budget/admission evidence ids it consumed. Recovery
recomputes counters by a **pure recurrence over boundary lines in log
order**: clean round ⇒ streak+1, unclean ⇒ 0; `confirmingUsed` counts
clean rounds AFTER the first clean candidate of the current run and
**resets to 0 whenever a round closes unclean** (an unclean round ends
that candidate run; a later candidate starts a fresh confirming run —
one confirming run per candidate streak). A boundary whose recorded
counters disagree with the recurrence ⇒ malformed ⇒ unclean +
`needs-owner`. Crash-before-verdict recovers from the boundary line
alone (the verdict is simply re-derived). **Policy revisions are
durable records (v5, c3; reproducible bytes v6, c4-M10):** a policy
change appends
`{ "kind":"policy-revision", "id":"…", "ts":…, "episodeId":"…",
"revision":7, "digest":"sha256:…", "policyRef":"policies/<sha256>.json",
"canonicalizer":"tre-canonical-json/1", "authority":"tty:…" }` — owner-
authorized (policy is owner authority, §14.7). **The bytes, not just
the digest (v6):** `policyRef` is the immutable, content-addressed
full policy document (family table, cleanRoundsRequired, caps) written
exclusive-create BEFORE the revision record appends; `canonicalizer` names `tre-canonical-json/1` (v8 rename of v7's
`tre-policy-json/1` — ONE canonicalizer for the whole contract:
policy bytes, owner-act payloads, and repro/duplicate digests all use
it; the old name in a revision record is a version mismatch, refused).
**Value domain & algorithm (v8, c6-M9; money domain v9, c7-M6 —
pinned completely):** input
must be a JSON document whose values are: strings (Unicode,
normalized to NFC BEFORE duplicate-key detection — two keys that are
distinct pre-NFC but equal post-NFC are duplicates and REFUSED);
numbers (v9, c7-M6; money domain corrected v10, c8-M9 — the v8
"integers only" rule REFUSED the
contract's own values: `20.0` (policy cap), `1.8`, `1.5`, `12.4`
(owner reconciliation and records) are legitimate and must
canonicalize; a rule no live document can satisfy is a defect, not a
safety property. **Fixed-point decimal domain, exact and closed:** a
number's SOURCE form must match
`^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$` — no exponent, no leading zeros,
at most SIX fractional digits. **Range — bounds pinned (v10, c8-M9):**
the domain is CLOSED at ±(2^53 − 1) = ±9007199254740991 on the scaled
integer (`value × 10^6` for decimals, the value itself for integers);
v9's ambiguous "outside −2^53..2^53" ellipsis is disambiguated — v9's
prose admitted integers through 2^53 while its own vector 5 refused
2^53; the closed bound is normative and agrees with both vectors
(vectors 5–6). Input parsing (v10, c8-M9): the parser accepts RFC
8259 inter-token whitespace (space, tab, LF, CR between tokens); the
canonical OUTPUT contains none — this is what makes "two submits
differing only in insignificant whitespace canonicalize to the SAME
bytes" true (v9 stated that intake rule while vector 7 refused such
input outright; the two were mutually unsatisfiable). Whitespace
inside a numeric literal is malformed and refused. **Money domain
(v10, c8-M9 — units pinned):** every `*Usd` field of every record,
payload and policy is an amount in MICRO-USD (10^-6 USD, the smallest
representable unit = 1 micro-USD) whose scaled integer is the exact
micro-USD count. v9's §14.13.4a/changelog prose "USD micro (10^-6)
integer **cents**" is WITHDRAWN (v10, c8-M9): a micro-cent is 1e-8
USD — a unit the ledger never handled, and the ambiguous name would
license a 100× implementation split. **Ingest conversion (v10,
c8-M9 — the v9 rule "an amount finer than 1e-6 USD is refused" is
RETRACTED as an ingest rule:** a provider that bills $0.0000005 has
real spend; refusing its statement strands money unaccounted):
provider amounts arrive in the provider's native unit/currency and
the supervisor converts ONCE at ingest to micro-USD with the closed
deterministic rule round-half-away-from-zero, recording on the
statement record `originalAmount` (provider's amount, verbatim
string), `originalUnit` (provider's unit id), `conversionPolicyRef`
(the named conversion basis used), and the converted value.
Conversion is applied once, never re-derived from a display form; a
correction carries the provider's native unit and converts under the
policy recorded for its STREAM — a correction whose recorded policy
differs is a stream-identity mismatch, refused malformed. Overflow
past 2^53 − 1 scaled after conversion ⇒ component UNRESOLVED UNKNOWN
(not a refused record — spend the provider already incurred cannot be
un-acknowledged by dropping its statement; the unknown blocks
admission and clean closure like any component unknown).
**TWO RULES, TWO DOMAINS — the ledger/body reconciliation stated
once (v11, c9-M10 — terra c9-F10 caught the v10 ledger row
describing the CANONICAL-DOMAIN rule ("finer ⇒ refused at ingest,
NEVER rounded") as if it governed PROVIDER INGEST, where the body
says the opposite (convert-and-round): two implementations charging
different amounts for $0.0000005 was a real split, so the domains
are now named explicitly and the ledger row corrected in the v11
row):**
- **Canonical record domain (the `^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`
  rule and vector 4):** every numeric amount WRITTEN IN A
  CONTRACT RECORD is already micro-USD, six-or-fewer fractional
  digits; finer canonical input is refused at parse, never rounded
  (a record may not smuggle sub-micro precision through the JSON
  parser). This rule NEVER applied to provider-native amounts.
- **Provider-ingest domain (the conversion rule):** provider
  amounts arrive in the provider's native unit and are converted
  ONCE to micro-USD by round-half-away-from-zero; the finer-than-
  micro case is exactly what conversion exists for (refusing such a
  statement strands real spend). The ledger's "never rounded" is
  TRUE of the canonical domain only.
**Parse mechanics pinned (v11, c9-M10):** conversion input is parsed
as an EXACT DECIMAL (arbitrary-precision decimal arithmetic —
never via a binary float intermediate: `0.0000005` must not become
`5.0000000000000004e-7` on the way through a double), applied to
the decimal scaled value, output is the nearest micro-USD integer
with halves away from zero; the conversion basis is identified by
`conversionPolicyRef` whose content names the unit ratio as a
DECIMAL STRING (not a float) and is digest-bound — two statements
on one stream sharing the policy ref provably share the basis.
Negative provider amounts (credits/refunds) convert under the SAME
rule (half-away-from-zero on the magnitude, sign preserved) and
fold as negative contributions; a credit driving a component below
zero is an unresolved unknown (ledger invariant violation, not a
negative balance).
**Canonical serialization (v9):** strip trailing zeros from the
fraction; if the fraction becomes empty, write the integer form (so
`20.0` → `20`, `1.50` → `1.5`, `0.000001` → `0.000001`); `-0` and
`-0.0…` normalize to `0`; no exponent ever. This is a bijection on
values: two source forms canonicalize equal iff their scaled integers
are equal, so the shortest-roundtrip-decimal ambiguity is closed
without excluding money. Equality, comparison and folding in §14.13
operate on the scaled integer;
booleans; null; arrays (order SIGNIFICANT,
serialized as-is); objects (duplicate keys — raw OR post-NFC —
REFUSED; keys serialized after NFC, members sorted by UTF-8 BYTE
sequence of the NFC form (memcmp order — the total, normative
ordering); string escaping = minimal valid JSON: quotation mark and
reverse solidus escaped, control chars via \uXXXX short forms (\b \f
\n \r \t) else raw UTF-8; no whitespace anywhere). Max canonical
bytes 1 MiB (larger refused at canonicalization; policyRef blobs count
against it). CONFORMANCE VECTORS (v9, c7-M6 — SHIPPED HERE, normative
byte-level; `→` separates source document bytes from canonical bytes,
`␠` marks a literal space):
1. `{"a":20.0}` → `{"a":20}` (trailing-zero strip, money integral)
2. `{"a":1.50,"b":0.000001,"c":-0.0}` → `{"a":1.5,"b":0.000001,"c":0}`
3. `{"a":1e3}` → REFUSED (exponent)
4. `{"a":0.1234567}` → REFUSED (7 fractional digits)
5. `{"a":9007199254740992}` → REFUSED (2^53 exclusive edge)
6. `{"a":9007199254740991}` → `{"a":9007199254740991}`
7. `{"a":␠20.0␠}` → `{"a":20}` (corrected v10, c8-M9 — v9 said
   REFUSED, contradicting the intake rule that whitespace-variant
   submits collapse to one blob; inter-token whitespace PARSES and
   strips; whitespace INSIDE a numeric literal, e.g. `{a:1 0}`, is
   malformed and refused — and whitespace inside a STRING, e.g.
   `{"a":" 20.0 "}`, is untouched content: `{"a":" 20.0 "}`)
8. `{"é":1,"é":2}` (U+0065 U+0301 vs U+00E9 — NFC-equal keys) →
   REFUSED (post-NFC duplicate key)
9. `{"b":1,"a":[true,null],"":1}` → `{"":1,"a":[true,null],"b":1}`
   (byte-order key sort incl. empty key before ASCII)
10. `{"a":"x\\y\"z\t"}` → `{"a":"x\\y\"z\t"}` (minimal escaping:
    backslash, quote, \t short form; no \u0007 — control char
    `` → `\u0007`)
A canonicalizer that cannot reproduce EVERY vector is a version bump
(`tre-canonical-json/2`), never a silent change; implementations are
gated by these vectors in CI (v9: the vectors live in the contract, so
"the module will ship them later" cannot be the answer to a defect).
**Intake stores
CANONICAL bytes; replay verifies (v8):** the producer canonicalizes
ONCE at intake and writes those exact bytes; every later consumer
verifies sha256(stored bytes) == the recorded digest and re-derives
values FROM THE STORED BYTES — nothing is ever re-canonicalized from
a display form (two submits differing only in insignificant
whitespace canonicalize to the SAME bytes, so they collapse to one
blob — intended); a stored blob whose digest mismatches is refused
and enters history-integrity handling, never "repaired". **Publication & lifetime (v7, c5-M5):** the write protocol
is write-temp → fsync(temp) → rename-excl(policyRef) → fsync(dir) →
append revision record → fsync(log). A crash between rename and append
leaves an ORPHAN blob: orphans are GC-eligible ONLY under the rule
"no policy-revision record AND no boundary policyDigest reference in
the whole log names this blob's sha" — and a referenced blob is
durable FOR THE LIFETIME of every replayable prefix that can resolve
it (the log and its referenced blobs share a retention domain: no GC
may delete a blob any replayable boundary's `policyDigest`/revision
still resolves to; prefix replay of an early boundary reads the blob
named by the revision record in THAT prefix, so historical blobs are
never collected while any boundary references them). GC runs under the
S5 writer lock with the same exclusivity rules.
**History-integrity-fault: entry, disposition, and exit (v8, c6-M5 —
ONE definition; 14.12.2 and 14.14.4 reference THIS paragraph):**
- ENTRY conditions (any one sets the episode flag; each entry is a
  durable `history-integrity-fault` record written by the detecting
  supervisor path): (a) recomputation of a committed boundary's
  counters disagrees with its cached values; (b) a `cycle-boundary`
  line with NO matching `fence-engaged` immediately preceding it
  inside the same critical section (matching = the fence record's
  `cycle` equals the boundary's, no other boundary or fence record
  lies between them; a boundary without its fence is exactly as
  serious as a diverging counter); (c) an owner-act authority found
  disproven for a record already in a committed boundary's prefix
  (14.14.4); (d) more than one `fence-engaged` for one cycle without
  a boundary between them; (e) a stored policy blob whose digest
  mismatches the `policy-revision` record naming it (v9, c7-M8 — the
  v8 text routed this into history-integrity handling but the fault
  enum could not represent it); (f) a second `channel-open` reusing
  a `channelId` (v15, cycle-10 audit finding 9 — §14.12.2 demanded
  this fault and the closed enum lacked the kind) routed to
  `channel-id-collision`; (g) a queue entry matched by act identity
  whose cited receipt differs from the logged act's receipt (v15,
  cycle-10 audit finding 6) routed to `queue-receipt-divergence`;
  (h) a boundary's `policyDigest`/`policyRevision` resolves to NO
  `policy-revision` record in the prefix, or names a revision
  record whose content blob is MISSING (v29, C22-B1/M4 — the
  missing input of the §14.12.4b foldSummary legacy test, replay
  condition R3) routed to `policy-digest-mismatch` in its
  unresolvable-blob form, sub-form per the §14.12.3 per-kind fields (v30, C23-F1 — the no-revision-record sub-case is the missing-revision form) (see the named-handling paragraph in
  §14.12.4b); (i) a committed `cycle-boundary` whose
  `foldSummary.foldSummaryVersion` is GREATER than the reader
  implements (v29, c22 finding 5 — §14.12.4b requires such a
  boundary treated "unreadable, needs-owner" but no faultKind
  could represent it, the same closed-enum gap cycle-10 hit with
  `channel-id-collision`; NOT `disproven-authority` — an
  unsupported version does not prove any authority false, it only
  exceeds the reader) routed to
  `fold-summary-unsupported-version`. The fault record: `{ envelope,
  faultKind: "counter-divergence" | "fenceless-boundary" |
  "disproven-authority" | "duplicate-fence" | "policy-digest-mismatch"
  (v9) | "group-plan-mismatch" (v13, audit finding 2) | "clock-domain" (v11, c9-M14, units + direction pinned v12
  per D4-a — a finalization-stall elapsed value that is NEGATIVE,
  or a `quiesce-stall` whose claimed `waitedMs` disagrees with its
  own `ts − anchorTs` beyond `maxClockSkewMs` (= `maxClockSkewS×1000`; v13: the v12 `quiesceWaitMaxMs +` term is removed — there is no upper bound, see §14.12.2); lateness is NOT this
  fault — see §14.12.2 v12 D4-a; a wallclock forward-jump conversion
  is likewise NOT this fault (v14 D5-a — an accepted limitation,
  see §14.12.2 for its full consequence statement, v15); identity tuple
  = (faultKind, affectedRecordId = the anchor recordId),
  boundaryId null pre-boundary) | "channel-id-collision" (v15, cycle-10 audit finding 9 — §14.12.2 requires a history-integrity-fault when a second `channel-open` reuses a `channelId`, but the CLOSED enum could not represent it, so a conforming validator refused the fault the contract mandates: the second `channel-open` record whose `channelId` duplicates an earlier one; identity tuple = (faultKind, affectedRecordId = the SECOND channel-open recordId), boundaryId null; required fields: affectedRecordId + evidenceRefs naming BOTH channel-open records (first and duplicate); digests null — the evidence is the pair of records; the duplicate channel's acts are NEVER drained — the drain refuses entries citing the duplicate channel-open (v17, cycle-11 finding 7: refusal is decidable because each entry carries `channelOpenRecordId` in its identity — the duplicate channel's entries are exactly those whose `channelOpenRecordId` equals the fault's `affectedRecordId`) and the episode goes needs-owner per the unified paragraph) | "unreleased-headroom" (v18, cycle-11 self-audit finding 6 — a boundary's admission consumes released headroom while the prefix holds NO `residual-unit-release` record for that unit; fail closed, the headroom counts as still HELD; boundaryId REQUIRED, affectedRecordId = the residual disposition record consumed, digests null; identity tuple = (faultKind, boundaryId, affectedRecordId) — ONE fault per unit consumed at the boundary; a boundary that consumes two unreleased units appends two faults (v19, cycle-12 audit finding 6)) | "queue-receipt-divergence" (v15, cycle-10 audit finding 6 — a queue entry whose cited `queueReceiptId` differs from the receipt recorded by the matching log `owner-act` (act identity equal, receipt drift — the nonconforming-writer case the reconciled matching rule routes here; §14.12.2 step 5 (c)); identity tuple = (faultKind, affectedRecordId = the drifting queue entry, per the evidence-by-drifting-entry paragraph below), boundaryId null; required fields: affectedRecordId + evidenceRefs per mode; digests null; detection is at the pre-drain full scan and at drain time (v17, cycle-11 finding 6 — the scan visits every durable entry including P1-matched and drained ones, so the second duplicate entry cannot be bypassed), the act is consumed once (matching is by act identity), and every boundary from detection is UNCLEAN needs-owner until a `history-integrity-disposition` closes it) | "fold-summary-unsupported-version" (v29, c22 finding 5 — a committed `cycle-boundary` whose `foldSummary.foldSummaryVersion` exceeds the highest version the reader implements: §14.12.4b required "unreadable, needs-owner" with no representable kind (the closed-enum gap pattern of cycle-10 finding 9); identity tuple = (faultKind, affectedRecordId = the boundary recordId), boundaryId = that same boundary (it IS the affected boundary; set even though the fault is the reader's version limit, because the record needing owner attention is identified and committed); required fields: affectedRecordId + evidenceRefs naming the boundary record; digests null — the evidence is the record's own version field, nothing to recompute; NEVER `disproven-authority` (an unsupported version disproves no authority — it only exceeds the reader); detection is at replay-read of the boundary; the boundary is UNCLEAN needs-owner in the DURABLE log (v30, C23-F4 — the fault is one durable fact; clean-closure, retirement and admission read the durable fault state, never a reader's local verdict) until a `history-integrity-disposition` closes the episode: `external-explanation` whose explanationDigest covers the owner's explanation naming the version and the later contract clause relied on (no new decision value); if no disposition is written the boundary stays unclean — the quarantine state, needing no record; an owner may not silently re-clean it. A reader implementing a version ≥ the boundary's validates it LOCALLY (readability only), but local validation never closes the durable fault — a newer reader's existence never closes an episode; the fault is appended once by the first reader that meets the unsupported version and deduplicated by identity (v32, C25-B1 — narrowed from C24-F4 without adding a record kind: an `external-explanation` disposition on a `fold-summary-unsupported-version` fault closes the durable FAULT only. The closed fault does NOT by itself establish a clean verdict for a reader whose implemented version is BELOW the boundary's `foldSummaryVersion`: that reader treats the boundary as unreadable-to-it, which is local readability state and never a clean verdict. A reader at or above the version validates LOCALLY (readability only). (v33, OWNER DECISION D6 — DECIDED (option A, version-capable consumer; closes the C25-B1 open item): no durable validation-record kind is defined and none is added. Validation of an unsupported-version boundary is the deterministic replay verification §14.12.4b ALREADY performs — recomputed from the durable log at decision time, which is this contract's sole authority (recomputation is the authority; stored copies are performance artifacts). Therefore: a closed `fold-summary-unsupported-version` boundary IS admissible to SHARED retirement and admission if and only if the deciding shared gate performs its cleanliness evaluation with a reader implementing a `foldSummaryVersion` ≥ the boundary's — the gate's own replay verification IS the authoritative validation. A gate implementing a version BELOW the boundary's treats the boundary as NOT admissible (fail closed) and NEVER admits on the explanation alone. The explanation closes the fault; capability at decision time supplies the verdict — no new record kind, no authority proof for a validation record, nothing replay cannot regenerate. A closed fault is never reopened by an unsupported read, and no later validation rewrites it. (v29: writers of this contract version emit `foldSummaryVersion: 1`)), boundaryId|null, affectedRecordId|null, evidenceRefs[],
  recomputedDigest|null, reportedDigest|null, detectionAnchorId }` —
  **per-kind field
  requirements (v9, c7-M8; identity tuple PINNED v10, c8-M10; v8
  required all fields for every kind,
  which a pre-boundary duplicate-fence or fenceless pre-state cannot
  satisfy):** `counter-divergence`: boundaryId, recomputedDigest,
  reportedDigest REQUIRED; `fenceless-boundary`: boundaryId REQUIRED
  (the boundary EXISTS — that is the fault), digests null;
  `disproven-authority`: affectedRecordId REQUIRED (the record whose
  authority is disproven), boundaryId set iff that record lies in a
  committed boundary's prefix, else null; `duplicate-fence`:
  affectedRecordId = the SECOND fence record's recordId REQUIRED
  (v10, c8-M10 — v9 said "the second fence record's CYCLE" but the
  fault record HAS no `cycle` field: the second fence record's own
  recordId is the anchor, and its cycle is derivable from that
  record on replay — no field is invented, the identity is
  replay-stable), boundaryId null when no boundary
  follows yet (the fault is detected pre-boundary — a fault record
  is appended at DETECTION with the fields the detection has;
  missing-at-detection fields stay null forever, never backfilled);
  `policy-digest-mismatch`: affectedRecordId = the policy-revision
  record, recomputedDigest = sha256 of stored bytes, reportedDigest =
  recorded digest, boundaryId null (set only if a specific boundary's
  resolution was the detection point). **Unresolvable-blob form (v29, C22-B1/M4; missing-revision form v30, C23-F1): two sub-forms, each with exactly one legal DIGEST null (`recomputedDigest`); `boundaryId` is governed by its canonical rule below, not by the null count (v32, C25-B5). (a) MISSING BLOB — the revision record exists but its named blob is missing (entry condition (h), blob sub-case): affectedRecordId = that `policy-revision` record; recomputedDigest NULL (no stored bytes to recompute); reportedDigest = the digest recorded in the revision record; boundaryId = null (v31, C24-F5 — canonical; see the identity paragraph below). (b) MISSING REVISION — no `policy-revision` record in the prefix matches the boundary's cited `policyDigest`/`policyRevision` (entry condition (h), record sub-case): affectedRecordId = the CITING `cycle-boundary` recordId (the v29 form demanded a revision record that does not exist); recomputedDigest NULL (no revision bytes exist to recompute); reportedDigest = the `policyDigest` the boundary cites; boundaryId = that same boundary. Identity = (faultKind, affectedRecordId), replay-stable: one fault per citing boundary for sub-form (b), one per revision record for sub-form (a). (v31, C24-F5 — CANONICAL PAYLOAD, detector-order independent: for sub-form (a) the boundaryId field is ALWAYS null, whatever the detector; the boundary whose replay hit the blob is NOT part of the identity or payload and is recovered on replay from the prefix, never stored. For sub-form (b) boundaryId = the citing boundary, which IS the identity, so it is deterministic. A full scan and a boundary replay therefore produce byte-identical fault records, and deduplication by identity is safe regardless of which detector appends first.) Detection at the boundary's replay-read, deduplicated by identity. Every other `policy-digest-mismatch` requires both digests. Each sub-form is needs-owner, closed only by a `history-integrity-disposition` per the R3 clause of §14.12.4b; the boundary is not clean while the episode is open.** `group-plan-mismatch` (v13 kind,
  fields pinned v14 audit finding 3 — v13 added it to the enum and
  named its tuple in §14.11.2 but left it out of THIS list, the same
  consumed-but-unbound defect as c9-B4): affectedRecordId = the
  `group-plan` recordId whose decoded member line failed its stored
  `memberLineSha256[i]` comparison, REQUIRED; boundaryId null;
  recomputedDigest = sha256 of the decoded member bytes,
  reportedDigest = the stored `memberLineSha256[i]` — set when the
  mismatch is digest-vs-bytes, null for a length/shape failure;
  **and the third detection mode (v15, cycle-10 audit finding 4):
  a NONCANONICAL stored encoding with EQUAL digests — the stored
  escaped string decodes to bytes whose sha256 equals
  `memberLineSha256[i]`, but canonical-encode(decoded bytes) ≠ the
  stored spelling — is the same kind with the SAME field rule
  (recomputedDigest == reportedDigest; that equality is precisely
  the signature of this mode, and the identity tuple is unchanged
  since digests are never identity members); the evidence for it is
  the `group-plan` record itself (the record's own bytes retain the
  stored spelling — evidenceRefs names the record; no duplicate-text
  field exists and none is added), and the disposition is the same:
  re-emit is FORBIDDEN in every mode — the plan may not be re-emitted
  from a store that cannot prove byte-identical round-trip (a
  noncanonical store might mangle it on the next read),
  fail closed needs-owner (14.11.2);
  digests are NEVER identity members here any more than elsewhere.
  **Stable identity tuple (v10,
  c8-M10 — one tuple per kind; every member a durable record ID,
  none detector-dependent):** `counter-divergence` = (faultKind,
  boundaryId); `fenceless-boundary` = (faultKind, boundaryId);
  `disproven-authority` = (faultKind, affectedRecordId);
  `duplicate-fence` = (faultKind, affectedRecordId) [second fence
  recordId]; `policy-digest-mismatch` = (faultKind,
  affectedRecordId); `fold-summary-unsupported-version` = (faultKind,
  affectedRecordId = the boundary recordId) (v29, c22 finding 5;
  boundaryId = that same boundary — see the enum entry above);
  `clock-domain` = (faultKind, affectedRecordId =
  the anchor recordId) (v11, c9-M14); `group-plan-mismatch` =
  (faultKind, affectedRecordId = the `group-plan` recordId),
  boundaryId null (v14, mirroring §14.11.2 — v13 named this tuple
  only in §14.11.2 and left it out of this list, the consumed-but-
  unbound defect again as in c9-B4); `channel-id-collision` =
  (faultKind, affectedRecordId = the SECOND channel-open recordId),
  boundaryId null (v15, cycle-10 audit finding 9); `unreleased-headroom` = (faultKind, boundaryId, affectedRecordId = the unit's residual disposition record), digests null (v19);
  `queue-receipt-divergence` = (faultKind, affectedRecordId = the drifting queue entry (v20, cycle-13 finding 6)), boundaryId null (v19 finding 4) (v15, cycle-10
  audit finding 6 — detection is per act identity, so one tuple per
  drifted act; a second queue entry drifting for the same act is
  the same tuple, deduped). **Evidence by drifting entry (v20, cycle-13 finding 6 — v19's duplicate-entries and act-drift modes gave one entry several identities; the drifting entry is now the only identity axis): a queue entry DRIFTS iff its `queueReceiptId` differs from its REFERENCE receipt, where the reference is the receipt cited by the matched owner-act once that act exists (act-drift), and otherwise the receipt of the FIRST-APPENDED same-triple entry (duplicate-entries). Fault identity = (faultKind, affectedRecordId = the drifting entry's queueId): one tuple per drifting entry, so entries with receipts R1, R2, R3 against reference R1 give two faults (E2, E3), each with its own disposition. Evidence = the `(queueId, receiptId)` of the drifting entry and of its reference entry, plus the owner-act's queueReceiptId when that act is the reference. Detection after the owner-act exists re-derives the reference and dedups by tuple. **Reference-change lifecycle (v21, cycle-14 finding 2): when the reference changes (the matched owner-act lands), drift is RE-DERIVED over every surviving durable entry of the triple; a previously recorded fault whose drifting entry no longer drifts is NEITHER mutated NOR silently erased — it stays outstanding until a `history-integrity-disposition` closes it, because the underlying duplicate-triple condition persists regardless of which entry the current reference marks. A fault record is never mutated to add later evidence; a reference change NEVER deletes a fault record (append-only). A disposition may close the whole duplicate set: `retire-duplicate-channel` on the channel's collision fault disposes every queue-receipt-divergence fault whose entries ALL belong to the retired channel (voided, or drained per the retirement rule of §14.10.3) — **ONE closure predicate everywhere (v22, cycle-15 finding 2):** "ALL the fault's affected entries belong to the retired channel" is the closure test in both this section and §14.10.3 (v21 wrote a weaker "affectedRecordId is an entry of the retired channel" there — a DIVERGENCE fault is per-acting-entry, so its evidence list may cite entries of other channels; the weaker text cleared those faults here but not there; the stronger predicate governs and a replay yields ONE disposition result for every fault). A divergence fault with any affected entry OUTSIDE the retired channel is OUT of retirement's automatic scope: it stays outstanding until its own `history-integrity-disposition` closes it, so a fault is never double-disposed by two retirements (the first retirement that satisfies ALL-entries owns the closure; a later retirement cannot re-close a closed fault — dispositions are idempotent per fault identity) **and cross-channel faults are impossible-by-invariant, stated and validated (v22; exception WITHDRAWN v23, cycle-16 finding 4):** the queue act identity is the triple `(channelOpenRecordId, channelId, actId)` of §14.12.2 — an entry of another channel can NEVER match that triple (its channelOpenRecordId differs), and an already-drained foreign entry cannot join a fault: the pre-drain scan groups duplicate act identities by the full triple, so every member of a duplicate group shares ONE channel, drained or not. v22's purported drained-foreign-entry exception is WITHDRAWN (it contradicted the triple identity). Consequently every `queue-receipt-divergence` fault's affected entries belong to a single channel by construction; the ALL-entries predicate is evaluated against the fault's **affected set (v23, finding 4; PREFIX PINNED v24, cycle-17 finding 5): the duplicate-group entries of the fault's channel as enumerated by a pre-drain-scan replay of the log IMMEDIATELY BEFORE the retiring disposition's own append — the same prefix the retirement's validation runs under the same single-writer flock (§14.6), pinned so voiding the retirement's own channel can never erase the group before the closure test reads it.** A fault's membership is decided ONCE by that scan, and the fault record is never mutated (append-only); if drift later ceases (reference change), the outstanding fault persists until a disposition closes it — closure mapping is faultId -> group at that pinned prefix (the fault identity names the acting entry; the group is found by replaying the scan over the pinned prefix, not by re-scanning the post-void log, so crash-after-void replays identically). **Detection-to-append ordering pinned (v25, cycle-18 finding 5):** first-detection evidence (the fault record's `detectionAnchorId`, evidenceRefs, identity) is IMMUTABLE, but the AFFECTED GROUP used for the closure predicate is the retirement-time group re-derived at the pinned prefix — the two are distinct snapshots by design (e.g. a same-triple entry E3 that lands after a {E1,E2} fault's first detection belongs to the retirement group). Under the §14.6 flock the retiring disposition executes in ONE serialized sequence: (1) replay the log to the prefix immediately before the retirement's own append; (2) DETECTION BARRIER — run every required duplicate and drift scan over that prefix and DURABLY APPEND (fsync) every detected fault not yet durable, in the scans' deterministic order, BEFORE the retirement may append — a barrier append is an ordinary fault record with ordinary identity (a newly drifted E3 is a NEW fault identity, not new evidence on the {E1,E2} record); (3) enumerate the open (undispositioned) faults and residual effects over the post-barrier prefix; (4) validate: every class-(b) fault touching the channel must already be closed, and the class-(a) predicate must hold, else REFUSE (clean prefix); (5) append the retirement record. A newly detected barrier fault whose entries all belong to the retiring channel is closed by that same retirement (class (a)); one outside it is class (b) and the retirement is refused until its own disposition lands. Already-closed identities are skipped (idempotent per fault identity). Two retirements deciding in the same fold: each runs the FULL sequence at its own pre-append prefix under the serialization of the flock — a batch implementation MUST re-evaluate after the first retirement's append; validation before both appends is NOT equivalent — the first retirement whose predicate holds owns the closure; a closed fault is never re-closed (idempotent per fault identity). **The kind set is CLOSED: every
  kind in the enum above MUST have an entry in this list and in the
  per-kind field rules — a kind without a binding here cannot be
  produced or validated (v14 closure rule; the defect class of c9-B4
  and v13 finding 3, now closed mechanically rather than by audit).**
  Digest values and `evidenceRefs` are NEVER
  identity members: two independent detectors of the same fault may
  legitimately produce different digests (partial recomputation
  progress) or different evidence sets, and identity keyed on them
  would re-append the same fault once per detector (v9's "the kind's
  REQUIRED non-null fields" admitted exactly that defect — digests
  are required for counter-divergence, so a second detector with a
  different digest was a "different" fault). `evidenceRefs`
  cardinality ≥ 1 REQUIRED (a detection without evidence appends no
  fault record). **First-detection position — defined (v10,
  c8-M10):** the required field `detectionAnchorId` names the
  recordId whose verification (or whose absence, for the
  pre-boundary kinds) first triggered the fault; the §14.12.4b
  inventory's "first-detection position" means exactly this field —
  NOT the fault record's own append position (a re-detection appends
  nothing, so only the anchor is stable across detectors). **No
  retro-anchor (v11, c9-M16):** the FIRST-APPENDED fault record's
  `detectionAnchorId` is the normative first-detection position for
  the identity tuple, permanently; a later detection that could name
  an EARLIER anchor does NOT amend it (amendment is update-in-place
  over history — forbidden) and the dedup skip means no second
  record exists to carry it: the contract chooses stable first-append
  anchoring over minimum-reported-anchor, and the v10 Change Ledger
  row's "lowest replay position any detector reports" phrasing
  misdescribed the body — CORRECTED HERE to what the body does (the
  BODY is normative; two detectors, same tuple, one record — the
  first-appended — anchored at ITS detection).
  **Detection idempotency (v9, c7-M8; identity = the pinned tuple):**
  a fault is appended ONCE per identity tuple —
  a re-detection matching an existing undispositioned-or-
  dispositioned fault record of the same identity is NOT re-appended
  (dedup skip, regardless of which detector found it — CONFORMANCE
  VECTOR, v10, c8-M10: two independent detectors report the same
  duplicate-fence with different `evidenceRefs` and different
  recomputed digests ⇒ exactly ONE fault record in the log (the
  first-appended); the second detection dedups); disposition
  coverage is set-checked on replay: the
  episode flag is clear only when EVERY fault record in the prefix
  has a citing disposition (any undispositioned record — including
  one appended after the last disposition — keeps the flag set).
- GATES while the flag is set: every boundary after the fault is
  UNCLEAN and `needs-owner` (no clean closure, no convergence —
  forward progress is permitted, silent recovery is not); DISPATCH of
  a new cycle is NOT blocked (the episode continues to record and
  work); reporting and any derived verdict use the RECOMPUTED values,
  never a known-bad cache (the verdict for a faulted boundary is
  derived from recomputation and marked faulted). **Recomputation vs
  "copies the boundary values" — ONE rule (v9, c7-M8):** the verdict
  normally copies a boundary's cached counters ONLY when they verify
  against recomputation (the copy is a performance identity, not an
  authority); once a fault names that boundary (or recomputation at
  any point has produced a different value), the RECOMPUTED values
  are the sole authority for reporting, derived verdicts, budget
  recurrence and admission — and if recomputation ITSELF fails (an
  object or blob needed by the prefix replay is unreadable), the
  component is UNKNOWN (not "keep the cached value"): unknown feeds
  the unknown-spend/unknown-elapsed rules and blocks clean exactly
  like an unresolved unknown does.
- EXIT: one owner act per fault record —
  `history-integrity-disposition` `{ envelope, faultId, decision:
  "accept-recomputed" | "external-explanation" | "retire-duplicate-channel", explanationDigest, voidedQueueIds,
  ownerActRef }`, produced via the §14.10.3 owner-act protocol
  (consumption-bound, payload canonicalized); validation: `faultId`
  names an undispositioned fault record, `accept-recomputed` requires
  the recomputed values to be self-consistent against the prefix,
  `external-explanation` requires a non-empty explanationDigest whose
  bytes are stored content-addressed (the explanation itself is
  owner-supplied text, retained). The LAST undispositioned fault (by
  log order) keeps the flag set: dispositions are per-fault, the
  episode clears only when NO undispositioned fault remains. A
  disposition never rewrites or deletes the faulted boundary or its
  verdict (append-only): the historical record stands marked faulted+
  dispositioned; cleared forward history starts clean again.
**Revision uniqueness & selection (v6):** revision numbers
are strictly increasing per episode (a duplicate or regressed
revision ⇒ malformed, refused); the effective policy at any log
position is the LAST `policy-revision` record before it whose digest
verifies. `policyRevision` on a boundary references THAT record's
revision
number; replay resolves it by finding the revision record in the prefix
and verifying the boundary's evaluation used the document digest it
names (the digest is echoed on the boundary as `policyDigest` — v5,
c3: v4's boundary carried a bare integer a reader could not resolve).
**Checkable counters live on the boundary (v5):** the boundary record
carries `streakAfter`/`confirmingUsed` as the writer's claimed cache
values; recovery recomputes both by a **prefix-only algorithm (v6,
c4-M10):** over the lines before the boundary, in order, (i) classify
each event's validity under the policy revision effective AT THAT
POSITION (a malformed late event is a permanent fact of every later
prefix — it cannot be "undiscovered" by a shorter replay), (ii)
resolve duplicate/supersede chains per the rule-4 table restricted to
the prefix, (iii) apply escape events (episode-global, v6), then
determine clean/unclean for that boundary; a chain or escape resolved
AFTER a boundary line never changes that line's determination (frozen
per prefix), and every boundary's recorded counters must equal the
algorithm's output. **Divergence at a COMMITTED boundary is a
permanent history fault, never a retroactive refusal (v7, c5-M8):**
the boundary line is already durable (append-only — "refused" is
undefined after commit). A committed boundary whose recomputation
disagrees with its cached counters marks the episode
`history-integrity-fault` (14.14.4, same condition forged-authority
enters): no FURTHER boundary may close clean under any prefix
containing it until an owner `history-integrity-disposition` act; the
recomputation is the recovery/reporting value — bad cached values are
NEVER adopted as recovery authority, and re-derivation runs the full
prefix (never stops mid-prefix or accepts a cached recurrence result
from a prior writer). The
derived verdict copies the boundary values ONLY under the verify-then-
copy identity of the unified recomputation rule (v9, c7-M8: values a
fault has named, or any prefix where recomputation disagrees, are used
recomputed — never copied from the cache); a verdict/boundary mismatch
is malformed ⇒ unclean + `needs-owner`. A budget extension (14.13.5)
lifts the terminal state; evaluation resumes at the next boundary from
the recomputed recurrence — neither reset nor invented, never upgrading
the recorded UNCONFIRMED closure. `maxConfirmingCycles` and `maxCycles`
are checked independently at admission (both must pass).

A **`converged` verdict is the only path to a CONFIRMED-CLEAN round
closure.** `budget-exhausted` closes the round UNCONFIRMED, exactly as
AUD51 did, and that status is recorded, never upgraded.

#### 14.12.4 Records (S5, append-only event kinds)

v3 replaces the v2 "written-at-assignment, updated-at-completion"
record (an UPDATE is not append-only JSONL) with an event sequence —
no field mutation, lifecycle by event order (S5 discipline):

```jsonc
// 1. assignment manifest — CLOSED marks the complete set committed;
//    assignments carry supervisor-minted ids (v4): model strings are NOT
//    identities (two sessions of one model must not collapse).
{ "kind":"auditor-manifest", "id":"…", "ts":…, "episodeId":"…", "cycle":4,
  "targetDigest":"sha256:…",             // the artifact digest all auditors must audit
  "assignments":[ { "assignmentId":"01J…", "model":"gpt-6.1-terra",
                    "endpoint":"…", "sessionIdRef":"…" } ],
  "closed":true }
// 1b. submission receipts (v5, c3; raw-bytes receipt v6, c4-M15) —
//     SUPERVISOR-authored, one per intake from an auditor session,
//     appended BEFORE any acknowledgement to the auditor (log-then-act,
//     §14.3): the wire submission arrives, the supervisor allocates a
//     receiptId, appends the receipt with the RAW BYTES (captured
//     BEFORE parsing, bounded at 256 KiB — over-cap is a transport
//     refusal `oversize` with the truncated capture + full-byte digest
//     stored durably), THEN acks. An ack with no durable receipt is a
//     contract violation (the auditor must resubmit).
{ "kind":"submission-receipt", "id":"…", "ts":…, "episodeId":"…",
  "assignmentId":"01J…", "submissionId":"…",   // stable id, v6
  "receiptId":"01J…",   // receipt id IS this record's id
  "sourceBytesRef":"submissions/<sha256>.json" // exact received bytes, content-addressed (v5; raw v6)
}
//     THREE REFUSAL CLASSES (v6, c4-M15) — an invalid input never has
//     to validate to be accounted:
//     - `transport` (oversize / non-UTF8 / read error): receipt stored
//       with the raw capture; refusal code recorded on the receipt
//       itself (`transportError`), no parse attempted. Transport-class
//       inputs have NO source-assigned submissionId (the submission
//       never framed): the receipt's identity IS the accounting
//       anchor, and no resubmit dedup applies — the auditor resubmits
//       as a NEW submission with a NEW submissionId, which the ledger
//       accepts (two receipts for the same attempt is legitimate; the
//       transport failure is the first receipt's outcome, not a
//       pending state). **Receipt/outcome/filing table (v7, c5-M2):**
//       | class | outcome location | filing | drain obligation |
//       | transport | `refused` on the receipt itself | none derived | satisfied at refusal |
//       | parse-or-schema | `refused` via intake-refusal (`malformed-input`) | human-review filing quoting raw bytes + schema error (derivedFindingId) | refusal AND filing both drained |
//       | policy | `refused` via intake-refusal (policy code) | deterministic human-review finding from stored validated payload (derivedFindingId) | refusal AND filing both drained |
//       | valid | `filed` (the finding record itself) | n/a | satisfied at filing |
//       A read error with no full-byte digest is still transport
//       (`transportError:"read-error"`; capture may be empty — the
//       outcome and drain are unchanged; only the digest-verification
//       step is unavailable, recorded as such). Conflicting payloads
//       under one submissionId (redelivery differs from the recorded
//       capture digest) ⇒ refuse `submission-conflict`, needs-owner
//       (never overwrite, never silently prefer).
//     - `parse-or-schema` (bytes don't parse / fail the finding
//       schema): `intake-refusal` with refusalCode `malformed-input`,
//       payload = the RAW BLOB ref only (no parsed-payload field is
//       required, and replay does NOT validate the payload against the
//       finding schema for this class — it verifies bytes→digest only);
//       the derived supervisor filing is a human-review record quoting
//       the raw bytes + the schema error, not a reconstructed finding.
//     - `policy` (valid payload, refused by policy, e.g.
//       norm-not-ratified): v5 rules unchanged (validated payload
//       stored, deterministic filing).
//     Dropping any class is forbidden: every receipt resolves to
//     EXACTLY ONE outcome (filed XOR refused — transport errors
//     resolve to `refused` on the receipt itself).
//     INVARIANTS (checked at boundary; violation ⇒ round unclean):
//     - DISJOINT ORIGINS (v6, c4-B2): a record's provenance field is
//       `originRef` = { origin:"intake", receiptId } for records whose
//       outcome IS a receipt resolution (filed finding XOR refused —
//       exactly one per receipt), OR { origin:"supervisor-derived",
//       fromRefusalId } for the mandated human-review filing a refusal
//       produces. A supervisor-derived finding is NOT a receipt outcome
//       (its origin never names a receiptId); the originating refusal
//       names it via `derivedFindingId`. The invariant "every receipt
//       resolves to EXACTLY ONE outcome (filed XOR refused)" is
//       preserved; quiescence (14.12.2 step 3) counts both outcomes AND
//       their derived filings as drained.
//     - STABLE SUBMISSION ID (v6, c4-B2): the wire submission carries a
//       source-assigned `submissionId` (source+assignmentId+seq,
//       unique per episode); the receipt records it. Crash before the
//       receipt append ⇒ no ack ⇒ auditor resubmits the SAME
//       submissionId ⇒ the supervisor dedups on (assignmentId,
//       submissionId) before allocating a new receipt — fresh receipt
//       ids alone never identify redelivery.
//     - completion.submissionAccounting lists receiptIds (not bare
//       counts); replay verifies set-equality against the receipt ledger
//       — an internally-consistent but receipt-less "received:0"
//       completion cannot hide a lost finding (c3 blocker).
// 2. per-assignment completion — one terminal completion per attempt:
{ "kind":"auditor-round-completion", "id":"…", "ts":…, "episodeId":"…",
  "cycle":4, "manifestId":"01J…", "assignmentId":"01J…",
  "attempt":1,                           // state machine: 14.12.2 rule 1
  "state":"completed | incomplete",      // the ONLY predicate field
  "targetDigest":"sha256:…",
  "submissionAccounting":{ "receiptIds":["01J…","01J…"],  // exhaustive vs the
                            "filed":["01J…"], "refused":[] } } // receipt ledger (v5)
// 3. retry — explicit, inside the same cycle, one per assignment ever:
{ "kind":"auditor-round-retry", "id":"…", "ts":…, "episodeId":"…",
  "cycle":4, "manifestId":"01J…", "assignmentId":"01J…" }
```

A completion with no matching manifest entry, a manifest never closed,
a second manifest for one cycle, an attempt beyond 1+retries, or a
completion whose `targetDigest` ≠ the manifest's ⇒ the round is
**unclean** (fail closed on every malformed combination; the manifest,
not inference, is the evidence of "every assigned auditor").

```jsonc
// boundary + verdict + owner-hold records (14.12.2 freeze, rule 5):
{ "kind":"cycle-boundary", "id":"…", "ts":…, "episodeId":"…", "cycle":4,
  "policyRevision":7, "policyDigest":"sha256:…", // resolves to a policy-revision record in the prefix (v5)
  "streakAfter":1, "confirmingUsed":0,   // writer's claimed cache values (v5) — recovery recomputes by recurrence and refuses divergence
  "admissionEvidenceIds":["01J…"],       // cycle admit AND closed records consumed (14.13.4a order)
  "partitionSnapshotId":"01J…",          // the 14.14.5 snapshot this cycle ran (v4)
  // Elapsed-tail accounting PERSISTED at the boundary (v10, c8-M11
  // — v9 computed finalizationTailMs in the deciding process but the
  // schema persisted NEITHER sample, so a crash between boundary and
  // verdict left the charged tail unreconstructible — recovery could
  // not reproduce the value it must re-charge):
  "bootIdAtBoundary":"01J…",             // boot identity record of THIS append (REQUIRED)
  "bootIdAtClosed":"01J…",               // boot identity record the closed sample belongs to (REQUIRED)
  "monoMsAtBoundary":4921173,            // this boot's monotonic sample at this append (REQUIRED int)
  "finalizationTailMs":41200,            // MEASURED tail (monoAtBoundary − monoAtClosed under one boot identity) OR null (REQUIRED field, null = cross-boot/no continuity ⇒ tail UNKNOWN, fail closed)
// (membership = log position up to this line — no cutoffRecordId to race, v4;
//  appended only after the v5 drain-and-fence quiesce check passes)
// repro-run record (v5, c3): the machine-checkable evidence every
// accepted-fix must reference (14.12.2 rule 4):
{ "kind":"repro-run", "id":"…", "ts":…, "episodeId":"…",
  "findingId":"01J…", "reproDigest":"sha256:…",       // == the finding's repro definition digest
  "executedArtifactDigest":"<git sha>",               // the tested tree/candidate
  "runner":"trusted-gate | supervisor", "result":"green | red",
  "runEvidenceRef":"…" },                  // gate log / command record; supervisor-authored only
{ "kind":"convergence-verdict", "id":"…", "ts":…, "episodeId":"…",
  "cycle":4, "boundaryId":"01J…", "streakAfter":1, "confirmingUsed":0,
  "verdict":"continue", "implementerFamily":"openai-gpt",
  "roundFamilies":[…], "completionRecordIds":[…], "openBlockers":[ids],
  "partitionDigest":"…", "inputsDigest":"…" },
{ "kind":"finding-hold", "id":"…", "ts":…, "episodeId":"…",
  "findingId":"01J…", "dispositionBy":"owner", "authority":"tty:…" },
{ "kind":"finding-hold-lift", "id":"…", "ts":…, "episodeId":"…",
  "findingId":"01J…", "dispositionBy":"owner", "authority":"tty:…" }
```

`inputsDigest` hashes the input record ids and dispositions **as of the
boundary cutoff**; `partitionDigest` (§14.14.5) is included so the
schedule the verdict relied on is reproducible. **Verdict and round
records stay derived projections, never inputs to recovery decisions**
(S3 rule) — the authoritative freeze is the `cycle-boundary` cutoff
itself, which is a desired-history record, not a projection.

#### 14.12.4b The boundary protocol (commit point)

**Authoritative sequence (v6, c4-m16 — this list supersedes every
earlier/shorter ordering statement, including v5 prose that omitted
the close record or the full fence):**

1. Close the cycle-manifest (append the closing manifest record — no
   more assignments for `n`).
2. Wait for all completions/retries to settle (crash here ⇒ restart
   reconciles `assigned`→`incomplete` per S3; retry budget per 14.12.2
   rule 1).
3. **Append the cycle's terminal budget/liveness records:** all
   dispatch-terminal records, then the cycle `closed` record (14.13.4a
   — spent/elapsed resolved or fail-closed unknowns) BEFORE any
   boundary line (the boundary consumes `closed`; c3 ordering).
4. Run the FULL finalization protocol of §14.12.2 freeze steps 1–5
   (intake fence, drain, quiesce check, ALL-actor fence incl. queued
   owner acts, external-obligation gate) and append `cycle-boundary`
   **inside the same S5 single-writer critical section**: the boundary
   line's log position IS the cutoff — every append queued behind the
   lock lands after it and belongs to the next window; nothing selects
   or races a cutoff id.
   **This append is the boundary commit point.**
5. Evaluate cleanliness over the prefix (all lines before the boundary);
   append `convergence-verdict`. A crash between 4 and 5 is repaired on
   restart by re-evaluating over the same boundary line — deterministic
   (the counters recurrence, 14.12.3), so the verdict cannot drift and
   no verdict is ever needed to recover one.
6. **Cycle event ordering:** per cycle `n`, append order is
   `cycle admit` (14.13.4) → **`partition` snapshot (§14.14.5, the
   wave-start event)** → fix dispatches → auditor manifest (open…closed)
   → completions/retries → dispatch-terminals + `closed` →
   `cycle-boundary` → `convergence-verdict`.
   The partition is a WAVE-START event that precedes every dispatch of
   `n`; the boundary is the ROUND-END event after all completions
   settle. They are distinct records with distinct roles — v3's
   conflation ("wave-start instant = the cycle-boundary cutoff") made
   cycle-4 dispatch impossible before cycle-4's own boundary and left
   the verdict's `partitionDigest` referencing a record outside its
   prefix (c2 blocker). Out-of-order records ⇒ malformed ⇒ unclean.

**Introduced-record envelopes (v6, c4-m16; corrected v7, c5-m10) —
every record introduced anywhere in §14.11–14.15 carries the FULL
standard S5 envelope (`kind, id, ts, episodeId, schema` — §14.3; v6's
table omitted `schema`, corrected) plus its listed fields, and exactly
one producer. Envelope elision in examples: where an example shows
`"id":"…"`, `"episodeId":"…"`, or the shorthand `envelope`, the full
envelope is REQUIRED at runtime and omitted for brevity only — see
the example-syntax clause below.**
- `usage-late-arrived` — producer: supervisor (provider path); fields
  per §14.13.4a (incl. `providerStatementId`, `statementSeq`,
  `correctionOf`, `mode`).
- `usage-recovered` — producer: supervisor; `{ envelope, targetId,
  providerAccountId, component:"spend", measuredUsd, providerRequestRef,
  providerStatementId, statementSeq, correctionOf,
  mode:"cumulative", recoveredAt }` (v8, c6-M11: a recovery record IS
  a cumulative statement in the fold, so the fold's ordering fields
  are REQUIRED on it too — `statementSeq` from the provider statement
  it recovers, `correctionOf` null unless it corrects an earlier
  statement; identity/
  dedup same rule as usage-late-arrived (v7: `mode` IS specified —
  recovery records are cumulative-mode statements in the fold);
  measured-beats-accepted applies.
- `elapsed-recovered` — producer: supervisor; `{ envelope, targetId,
  component:"elapsed", measuredElapsedS, method:"clock-log|
  dispatch-records", evidenceRef }`; one per target (one-time rule).
- `remote-terminal-unproven` — producer: supervisor (deadline
  escalation); fields per §14.13.4a (the v6 example omitted
  `episodeId`; the envelope is required, example elision per above).
- `remote-terminal-disposition`, `scope-escape-waiver`,
  `history-integrity-disposition` — producer: owner via TTY CLI
  (§14.10.3 owner-act protocol, one act per record); fields per
  §14.13.4a / §14.14.4 (v7).
- `fence-engaged` — producer: supervisor finalization path; `{ cycle,
  engagedTs }` (§14.12.2 step 5, v7).
- `dispatch-intent` — producer: supervisor dispatch lane, before any
  provider call; fields per §14.13.4a (v7).
- `submission-deferral` — producer: supervisor intake; fields per
  §14.14.5 (v7; deferral CHAINS: v9 c7-M10 adds `deferralOf`, one
  record per chain position, all supervisor-authored).
- `owner-act` — producer: TTY operator CLI; fields per §14.10.3.
- `history-integrity-fault` — producer: supervisor (the detection
  path that finds the fault: replay divergence, fenceless-boundary, unreleased-headroom,
  duplicate-fence, `policy-digest-mismatch` (v9, c7-M8)); fields per
  §14.12.3 (`faultKind`, `evidenceRefs[]`, first-detection position);
  exactly one fault record per fault instance (re-detection cites it,
  never duplicates it) (v9, c7-m14).
- `task-tip-archived` — producer: supervisor retention path; `{
  gateId, bundleRef, sha256, tipSha, objectCount, verifiedAt }`
  (v9, c7-m14; fields pinned v10, c8-m16 per the §14.14.4 artifact
  contract; only when the per-episode
  ref is pruned inside the replay horizon).
- **Intent phase transitions (v9, c7-m14; KIND UNIFIED v10,
  c8-M15):** each phase transition of a provider call is its OWN
  `intent-phase` KIND record (append-only; one record per phase per
  `callId`, `phase` is the discriminator) — producer: supervisor
  dispatch lane. v9's inventory claimed these counted "under
  `dispatch-intent`" while §14.13.4a's closed schema names the wire
  kind `intent-phase` — a producer following one text was rejected
  by a validator following the other; ONE kind now: `intent-phase`
  is its own S5 envelope kind (distinct from `dispatch-intent`,
  which remains the pre-call per-DISPATCH record), the phase-ORDER
  rules (14.13.4a) are its validation, and the full discriminated
  schema (incl. `outcome`, canonical `callId` encoding, uniqueness
  domain, idempotency-key placement, restart validation) is defined
  in §14.13.4a and consumed identically by producer and validator.
- **Queue receipts (v9, c7-m14; entry shape extended v17, cycle-11
  audit finding 7):** queue entries and their receipts
  live in the QUEUE FILE, not the S5 log — they are NOT S5 envelope
  kinds and carry the queue-file's own record shape (queueId,
  receiptId, act payload, append ts, AND the full act-identity triple
  `(channelOpenRecordId, channelId, actId)` — v17: the entry must
  carry `channelOpenRecordId` or the drain cannot cite the duplicate
  channel-open on a collision refusal and cannot keep two channels'
  acts distinct under a reused channelId); they gain log standing ONLY as
  the drained `owner-act` record (which cites its `queueReceiptId`);
  this is why the envelope table has no queue-receipt row (transport
  buffer, not history — 14.12.2 step 5).
- `quiesce-stall` — producer: supervisor finalization retry path (the
  same process that owns the drain turn, on exceeding
  `quiesceWaitMaxMs` — no timer daemon; the deadline is checked at
  each finalization re-attempt and at every queue/log append inside
  an engaged fence); fields `{ stalledCondition, classBefore:"B",
  classAfter:"O", waitedMs, refConditionRecordIds[] }`; appended to
  the LOG (class-B→O conversion is a log-visible fact, replayed by
  recovery — recovery re-derives O for the stalled condition from
  this record even if the wall clock elapsed while down)
  (§14.12.2 finalization decision table, v9, c7-M13).
- **v10 (c8) record kinds:** `provider-inability-evidence` —
  producer: supervisor provider path (captured provider responses
  verbatim; shape, provenance and freshness per §14.13.4a's
  `accept-residual-risk` rule, v10 c8-M8); `evidence-invalidation`
  — producer: TTY operator via owner-act consumption (target,
  reason, replay position semantics per §14.12.2 r4, v10 c8-M12);
  `deferral-loop` — producer: supervisor intake in the same
  critical section as the chain-cap refusal (sole trigger of the
  `deferral-loop` state, per §14.14.5, v10 c8-M14);
  `intent-phase` — producer: supervisor dispatch lane (the unified
  phase kind, v10 c8-M15 above). `deferral-loop-disposition` is an
  OWNER-ACT op (§14.10.3 closed enum), not its own kind.
- **v11 (c9) record kinds:** `finalization-wait-anchor` — producer:
  supervisor finalization path, once per B-condition identity
  (`{ conditionId, conditionKind, anchorTs, bootId }`, §14.12.2 v11
  c9-M14 — the replayable stall-timer origin); `channel-open` —
  producer: the TTY act channel at establishment
  (`{ channelId, channelKind:"tty-cli", device }`, §14.12.2 step 5
  v11 c9-M7 — durable composite act identity `(channelId, actId)`);
  `zero-call-closure` — producer: supervisor dispatch lane
  (`{ dispatchId, evidenceRef, fenceCoverageWindow }`, §14.13.4a v11
  c9-M8 — dispatch-level proof for an empty callUniverse);
  `group-plan` — producer: supervisor, consumption-bound to the
  authorizing act (`{ groupId, plannedAtTs, memberLines[],
  memberLineSha256[], ownerActRef }` (v14: the inventory shape
  carries the v13 digests — `memberLines[]` hold each member's EXACT
  canonical line bytes verbatim (v12 D1-a), `memberLineSha256[]`
  their integrity digests (v13 finding 2, one per memberLines entry);
  plan ≤ 1 MiB, `group-plan-oversize`
  refusal, §14.11.2 v11 c9-M11 + v12 — durable group plan
  re-emitted byte-identical by recovery). The v10 kinds' semantics are
  amended by v11: `evidence-invalidation` serves BOTH
  `repro-run` and `acceptance` targets as an append-only fold
  (c9-M5, §14.10.3/§14.12.2 r4).
- **v17 (cycle-11) record kind:** `residual-unit-release` —
  producer: supervisor residual-disposition path; `{ envelope,
  residualDispositionId, unitId, coveredLeafRecordIds[], terms[], releasedUsd,
  evidenceRefs[] }` (§14.13.4a, v17 cycle-11 finding 5 — the sole
  durable source of the frozen post-release total `releasedTotal`;
  append-if-absent keyed by `(residualDispositionId, unitId)`,
  different bytes for the same key ⇒ `disproven-authority` fault (affectedRecordId = the conflicting second release record, boundaryId null — v18 finding 6),
  identical bytes ⇒ idempotent redelivery; fsynced BEFORE any
  boundary that consumes the released headroom; release state in
  replay is the record's presence in the prefix, never a
  boundary-derived cache).
- `scope-escape-resolution`, `partition`, `dispatch-authorization`,
  `submission-receipt`, `policy-revision`, `repro-run` — producers and
  fields as specified in place (14.14.4/.5, 14.12.4, 14.12.3, 14.12.2
  rule 4). `windowOf` is a field (14.14.5 membership rule), not a
  record kind.
- **Usage-record provider identity (v9, c7-m14):** `providerAccountId`
  is a REQUIRED field on every fold statement — `usage-late-arrived`
  and `usage-recovered` included (the billing-stream identity
  `(providerAccountId, dispatchId)` of 14.13.4a is incomplete in the
  field lists above without it; here it is closed: a usage record
  without `providerAccountId` is schema-malformed ⇒ refusal class 2,
  and the affected stream component folds to UNRESOLVED UNKNOWN).
- **Boot identity:** liveness/ABA checks (§14.13.4a) compare
  (pid, start-time, bootId) triples; `bootId` is the OS boot
  identifier read at record time and recorded on the liveness-evidence
  record alongside the tuple.
- **Record-example syntax (v6; scoped v7, c5-m10):** the ```jsonc
  blocks in §14.11–14.15 are **illustrative pseudocode, not parseable
  fixtures** — `…` placeholders and `//` comments make individual
  objects non-parseable by design, and no implementation may
  instantiate them verbatim; the NORMATIVE shape of every record is
  its field list in prose plus the schema it names in `schema`.
  Commas between top-level `{}` objects are fragment separators, not
  JSON syntax. Conformance comes from the named schemas, not from
  these blocks (v6's "each object parses alone" claim is withdrawn —
  with placeholders it was false).
- **Fold-warnings report — the acceptance-report carrier, defined
  (v26, cycle-19 finding 5 — v25 said the baseline-cardinality
  warning is "carried in the acceptance report's `warnings[]`
  array" but NO acceptance-report record, schema, producer, or field
  existed anywhere in §14.11–14.15, so a conforming implementation
  had nowhere to surface it):** the carrier is a NEW explicitly
  NON-RECORD projection — the **fold-warnings report** — NOT an S5
  envelope kind and NOT part of the introduced-record inventory
  (consistent with the warning being a derived projection, not a
  record): producer: the supervisor's usage-fold evaluation,
  computed at EVERY fold (boundary commit, verdict computation,
  recovery replay — every consumer that evaluates the fold
  recomputes it, never a cached copy); availability: it is returned
  IN BAND to that consumer (the boundary-protocol step that
  consumes fold results) and, at boundary commit ONLY, appended as
  a `foldSummary` FIELD of the `cycle-boundary` record (existing
  kind, field added here): `{ foldSummary: { foldSummaryVersion: 1,
  warnings: [ {
  warning: "baseline-cardinality" | "reconciliation-floor-divergence",
  streamKey, markerIdentities[] } ] } }` —
  **`streamKey` is the warning subject's identity, serialized as a
  canonical JSON array under `tre-canonical-json/1` (§14.12.3):**
  for `baseline-cardinality` the billing-stream identity
  `["<providerAccountId>","<dispatchId>"]` (§14.13.4a); for
  `reconciliation-floor-divergence` the reconciliation-target
  identity `["<targetId>","<component>"]` (v27, C20-M3 — the entry
  must name WHICH component diverges; one string per subject,
  canonical bytes, no ad-hoc joins).
  `markerIdentities[]`
  required non-empty and FULLY SORTED ((statementSeq ascending,
  providerStatementId lexicographic)) for
  `baseline-cardinality` (the stream's distinct baseline marker
  identities, per §14.13.4a), REQUIRED EMPTY ARRAY for
  `reconciliation-floor-divergence` (the advisory that the current
  clean recomputed value diverges from the reconciliation chain tip
  — spend below tip OR elapsed measured ≠ tip, §14.13.4a
  precedence rules; the divergence value pair itself stays derivable
  from the log, the warning only flags it).
  **Total order of `warnings[]` (v27, C20-M3 — v26 sorted each
  baseline warning's marker list but left the ARRAY order free, so
  one prefix with two affected streams had two legal serializations
  and the mismatch clause was unimplementable):** the array is
  REQUIRED non-decreasing under the TOTAL sort key
  `(warning lexicographic, streamKey lexicographic)` over the UTF-8
  bytes (the enum has two members; `baseline-cardinality` sorts
  before `reconciliation-floor-divergence`), and the sort key is
  UNIQUE: at most ONE entry per `(warning, streamKey)` pair for all
  time within one foldSummary (baseline-cardinality is one per
  stream by construction, v25 C18-M6; floor-divergence one per
  target-component — the subject identity IS the dedup key); two
  entries with equal keys is malformed. Canonical comparison: the
  stored `foldSummary` object and the recomputed one are compared
  as `tre-canonical-json/1` BYTES — byte-equal or mismatch, no
  field-tolerant fuzzy compare.
  **Comparison prefix (v27, C20-M3):** the recomputation folds
  EXACTLY the prefix that ends immediately before THIS boundary
  line — the same prefix the boundary protocol evaluates
  cleanliness over (§14.12.4b step 5: all lines before the
  boundary) — never a later recovery prefix, never the prefix of a
  subsequent boundary; a replay at any later time re-folds that
  fixed prefix, so the comparison is stable across restarts.
  A `foldSummary` with an
  unsorted or partial `markerIdentities[]`, an unsorted or
  duplicate-keyed `warnings[]`, or an unknown `warning`
  marker outside the closed enum, is a malformed boundary record ⇒
  refusal (the fold SUMMARY is deterministic replay output, so
  divergence between two computations of one prefix is a
  `disproven-authority` fault, never two tolerated summaries);
  replay semantics: the `foldSummary` in the prefix is compared
  against the recomputed fold at verification — a mismatch is the
  fault above (the log never rewrites it); the warnings are
  ADVISORY: they never gate cleanliness, never trigger
  needs-owner, never block closure, and disappear deterministically
  when the underlying condition leaves the effective set.
  **Version binding and legacy replay (v27, C20-M2 — v26 added the
  field to an EXISTING record kind without saying what a boundary
  committed before v26 (which has no `foldSummary`) means under the
  new verification rule: one implementation rejects the old
  boundary as malformed, another accepts it, so replay was
  implementation-defined across pre-v26 history):** the LEGACY
  exemption is keyed on IMMUTABLE DEPLOYMENT HISTORY, not on
  presence alone (v28, C21-B1; the v27 sentence "the presence of
  the field IS the activation marker" is WITHDRAWN v29, C22-M1 —
  the two rules were contradictory as written, and presence-only
  classification was exactly what C21-B1 closed): the test below
  is a LOG-POSITION test over the `policyDigest` chain, never an
  inference from the absent field.
  **Activation revision and its resolution (v29, C22-B1 — cycle-22
  blocker: v28 stated the test against A but left the CASE WHERE A
  DOES NOT EXIST IN THE PREFIX undefined — a deployment that
  adopted this contract with `foldSummary` already in force at its
  first-ever policy revision has no activation revision A in its
  own log, and the test "resolves STRICTLY EARLIER than A" has no
  defined result; this paragraph defines it):** A is defined ONCE
  against the contract text (the FIRST policy revision in the
  contract lineage whose policy bytes implement the `foldSummary`
  rule — this document, v26); it is not a per-deployment constant.
  For a given log, the replaying reader resolves A's policy
  content three ways, and the test is TOTAL over the three:
  **(R1) a policy-revision record implementing the `foldSummary`
  rule exists in the prefix** ⇒ A is that record; apply the
  resolution test below per boundary.
  **(R2) no such record exists in the prefix — no-A deployment:** every boundary whose `policyDigest` resolves to a revision record in the prefix (R3 covers the rest) cites a revision whose policy bytes do NOT implement `foldSummary` — the resolution namespace is THIS log's prefix, so no other deployment's revision can resolve here (v30, C23-F2), and a revision that did implement the rule would itself be an implementing revision in the prefix, i.e. R1. Each such boundary is therefore **LEGACY** exactly as (i) — verified under its own rules, the absence is never a mismatch. v30 (C23-F2): the former R2 branch "policy bytes DO implement it ⇒ (ii) malformed" is UNREACHABLE BY CONSTRUCTION and is removed; a post-activation writer that omits the field is refused at append by the R1 position test. A pre-A policy blob stays resolvable for as long as
  ANY deployment's replayable prefix references it — the
  content-addressed store's existing lifetime rule ("no
  policy-revision record AND no boundary `policyDigest` reference
  in the whole log names this blob", §14.12.3) keeps pre-A blobs
  durable, so a no-A deployment keeps its history verifiable; a
  deployment that has NO pre-A policy at all resolves R2 with an
  empty legacy class.
  **(R3) the boundary's `policyDigest` resolves to NO policy
  revision in the prefix (missing or unresolvable blob) — the
  digest-chain fault that predates this field:** a boundary whose
  `policyDigest`/`policyRevision` matches a revision record whose
  content blob is missing is a history-integrity episode per
  §14.12.3 (the existing blob-digest mismatch handling —
  "refused and enters history-integrity handling, never
  repaired"); its `foldSummary` test is NOT evaluated until the
  episode is disposed, and until then the boundary is NOT clean
  (a boundary whose policy cannot be resolved cannot be shown
  governed — fail closed per §7; the disposition record governs the outcome, using ONLY the existing closed decision set (v31, C24-F1/F3 — no decision value is added and no historical verdict is rewritten): (a) MISSING BLOB (the revision record exists, its blob is absent): the disposition's `decision` is `external-explanation`; its `explanationDigest` names the owner-supplied explanation TEXT (stored content-addressed, as for every `external-explanation`) and is NOT the policy bytes' digest. The restored policy bytes are a SEPARATE payload: the owner supplies them as the revision's content blob via the §14.12.3 publication protocol, and the append is accepted only if sha256 of the restored bytes equals the fault's `reportedDigest` (otherwise refused). The explanation text names that `reportedDigest` and the blob's content identity, so the record authenticates both; a restored blob with a valid explanation is published durable before the disposition is appended. A restored blob never rewrites a recorded verdict: each affected boundary's recorded verdict stays marked faulted and dispositioned. The restored bytes are accepted only if they hash to the revision's recorded digest, so they are the same content any replayer verifies; the R1/R2 test is applied to that verified content for the boundary's OWN position. The disposition's prefix supplies only the citing-boundary set and the closing record; it never selects which policy applies to a boundary. A boundary's classification is therefore a function of its own position and the verified content of the policy its digest names, not of when the blob was restored. (b) MISSING REVISION (no revision record exists): an `external-explanation` disposition closes the fault as EXPLAINED only — a disposition cannot create a revision record (that would be a policy-change act, not a history-integrity act), so the citing boundary stays UNCLEAN and is classified by no test. The disposition's boundary set is the boundaries IN ITS OWN PREFIX citing the faulted revision (v32, C25-B4: later citations are governed by their own position and never by this disposition) (sub-form a) or the single citing boundary (sub-form b); the explanation text, not the restored bytes, is the only payload in sub-form (b). (v32, C25-B3: until the disposition is appended the restored blob is INERT — the R3 episode stays open and the fault stays undispositioned; a crash between blob publication and the disposition append therefore leaves the state exactly as before the restore, and a retry appends the disposition against the same content-addressed blob, never a different one.)
  For a boundary whose policy resolves (R1 or R2, or via
  disposition), apply: **(policy-resolution test, v28)** — policy
  bytes STRICTLY EARLIER than the contract's `foldSummary`
  rule ⇒ (i) **LEGACY**: committed under a pre-`foldSummary`
  contract; replay verifies it under the rules that governed its
  commit. Policy implements the rule (A or any policy derived
  from it) ⇒ the rule is in force: a boundary WITHOUT
  `foldSummary` is (ii) post-activation malformed writer ⇒
  REFUSAL at append, and the replay of such a line — should one
  ever exist in the log through bug or corruption — is refused
  too (it is byte-distinguishable from a legacy line by its
  resolved `policyDigest`). (iii) boundary WITH `foldSummary` ⇒
  fully governed as below. The append-time validator knows the
  full policy lineage (the append of a policy-revision record
  itself declares whether the incoming policy implements the
  rule — the FIRST such append in the log IS A for that log) and
  validates against the policy in force, so it never confuses
  (i) with (ii); a replaying reader resolves the same
  `policyDigest` chain from the prefix.
  **Named handling for the no-A and unresolved-digest replay
  conditions (v29, C22-M4 — v28's replay rules named `faultKind`s
  for every other replay condition but offered none for these,
  leaving implementers to invent):** an R3 episode is NOT a new
  faultKind — it is the EXISTING `policy-digest-mismatch`
  (v9, c7-M8) in its unresolvable-blob form (entry condition (e)
  covers a stored blob whose digest mismatches; a REFERENCED blob
  that is absent violates the same retention contract — "no GC may
  delete a blob any replayable boundary's `policyDigest`/revision
  still resolves to" above — and reuses the same kind rather than
  widening the CLOSED enum for a missing-input case; the
  field-requirement paragraph is amended to say so):
  the field requirements are the canonical per-kind rule of §14.12.3 (v31, C24-F2 — the v29 text that named a revision record as the sole identity is WITHDRAWN): sub-form (a), missing blob — affectedRecordId = the `policy-revision` record whose named blob is missing, recomputedDigest NULL, reportedDigest = the digest recorded in the revision record; sub-form (b), missing revision record — affectedRecordId = the citing `cycle-boundary` record, recomputedDigest NULL, reportedDigest = the cited `policyDigest`. Each sub-form has exactly one legal DIGEST null (`recomputedDigest`); the sub-form (a) boundaryId null is canonical, not a second legal null (v32, C25-B5).  The boundaryId of each sub-form is the canonical value named in §14.12.3, not the detector's view: see the canonical payload rule in the §14.12.3 identity paragraph (C24-F5). needs-owner as every
  episode, closed by a `history-integrity-disposition`; the
  boundary is not clean while the episode is open. R2 needs NO fault: legacy
  classification is not a fault (per (i) — "the ABSENCE is never
  a mismatch"), and the (ii)-equivalent under R2 is append-time
  REFUSAL — a refused record never enters the log to be
  replayed. **Contract clause for deployments that begin AFTER
  this version (v29, C22-B1 closing clause):** a deployment whose
  first policy revision already implements the `foldSummary` rule
  declares it (the append declares the rule implemented), so A is
  that first revision and its legacy class is empty — every
  boundary from its first MUST carry `foldSummary`. **Bootstrap
  ordering (v29, C22-B1 — the auditor's "require a durable
  activation revision before a v28 writer appends a boundary"):**
  a writer governed by a policy implementing the rule appends that
  `policy-revision` record (and its content blob, published per
  the §14.12.3 publication protocol) and confirms it durable
  BEFORE it appends any boundary whose `policyDigest` names it —
  a boundary cannot cite a policy that is not yet in the log, so
  the ORDER (activation durable → first governed boundary) is an
  append-time precondition, identical to the pre-existing rule
  that every record's digest must resolve to a durable revision;
  a boundary appended under a not-yet-durable policy is a bug
  caught by the R3 resolution (unresolvable digest ⇒ history-
  integrity episode, not clean), never a fourth classification.
  Writers of this contract version ALWAYS append the field
  (`warnings: []` when nothing warns — an empty array is legal,
  omission is not).
  Discrimination (decidable per record, one pass):
  (a) boundary line WITHOUT a `foldSummary` field whose
  `policyDigest` resolves to a policy-revision earlier than the
  deployment's activation revision A (under ANY of the three
  resolution modes R1–R3 above — a no-A prefix whose resolved
  policy content does not implement the rule is LEGACY here per
  (R2), v29 C22-B1; an UNRESOLVED digest is not (a) at all, it is
  (R3) and its test waits for the disposition) ⇒ **LEGACY**:
  such a line committed under a pre-v26 contract is verified under
  the rules that governed its commit — the ABSENCE is never a
  mismatch, never a fault, never a refusal, and no consumer may
  retro-synthesize or backfill a summary for it (history is never
  rewritten; the advisory warnings of a legacy round simply were
  not surfaced, and later folds recompute them forward from the
  later boundaries only); a boundary WITHOUT `foldSummary` whose
  `policyDigest` resolves to A or later is NEVER legacy — it is the
  malformed post-activation writer (ii) ⇒ refusal. (b) boundary
  line WITH a `foldSummary` ⇒ fully governed:
  `foldSummaryVersion` is
  REQUIRED, its value
  MUST be ≤ the highest version the reader implements, and the
  field's absence on a line produced by a writer implementing this
  contract version is malformed at append ⇒ refusal (writers of
  this version ALWAYS append the field, with `warnings: []` when
  nothing warns — an empty array is legal, omission is not);
  `foldSummaryVersion` GREATER than the reader implements ⇒ fail
  closed exactly as the pinned-version intake rejections do
  (§14.12.4, v5 c3): the reader cannot validate what it does not
  know — the boundary is treated as unreadable, needs-owner, never
  silently skipped and never validated under a guess, and the
  reader appends a `fold-summary-unsupported-version`
  history-integrity-fault for it, once per identity (v32, C25-B2: a fault already present with the same identity, open or CLOSED, is NOT re-appended; the rule is the deduplication in §14.12.3) (v29, c22 finding 5 — the named,
  representable durable outcome, entry condition (i) and the enum
  entry in §14.12.3; the episode closes per §14.12.3, never by
  silently skipping the boundary). Version 1 is
  the field set defined above; a future version bumps the number
  and registers its delta in this paragraph. **Registration clause
  (v33, D6):** a version bump MUST state in this paragraph whether the
  D6 capable-consumer rule still suffices for shared admission of
  boundaries at the new version. If the new version's `foldSummary`
  semantics are NOT deterministically replay-verifiable by a reader
  implementing it, the bump MUST register a durable validation-record
  kind (§14.12.3 + §14.12.4 entry) IN THE SAME revision; a bump that
  does neither is OUT OF CONTRACT and its boundaries are not eligible
  for D6 admission.

#### 14.12.5 Owner decisions for convergence

- **O-G3-1** Opinion-basis blockers/majors: `owner-only` (drafted above) vs
  `hold-until-repro` (the orchestrator may hold, but only the owner may
  close). The drafted default is `owner-only` because an unfalsifiable
  blocker is the case the convergence rule exists to surface.
- **O-G3-2** `cleanRoundsRequired` default 2 (matches the k=2 consecutive
  rule implied by HANDOFF G3). Lower values are not permitted without an
  owner-recorded policy change.

#### 14.12.6 What this section does NOT do

No budget (G4). No partitioning (G5). No auditor invocation or model
selection. It consumes `auditor.model` and the §14.10 dispositions; it
does not create them.

### 14.13 Design-cycle budget (G4 — the rounds/time/spend cap)

**Status: DRAFT v34 (2026-11-18), batched with §14.11/§14.12/§14.14
(v34: c27 consistency audit folded (C27-F1 restoration, see the c27 Change Ledger row); (v33: owner decision D6 folded (shared admission, see the v33 Change Ledger row); v32: v31 audit consistency fixes C25-B1..B5, see the c25 Change Ledger row; v31: v30 internal review C24-F1..F6 folded, see the c24 Change Ledger row; v30: terra cycle-23 findings 1–7 folded, see the c23 Change Ledger row; v29: terra cycle-22 findings 1–5 folded, see the c22 Change Ledger row; v28: terra cycle-21 findings 1–4 folded, see the c21 Change Ledger row; v27: terra cycle-20 findings 1–4 folded, see the c20 Change Ledger row; v26: terra cycle-19 findings 1–5 folded, see the c19 Change Ledger row; v25: terra cycle-18 findings 1–6 folded, see the c18 Change Ledger row; v24: terra cycle-17 findings 1–6 folded, see the c17 Change Ledger row; v17: terra cycle-11 findings 1–8 folded, see the c11 Change Ledger
row; v16: terra cycle-10 findings folded, see the c10 Change Ledger row;
v13: self-audit findings 1–7 folded, see the v13 Change Ledger row;
v14: self-audit findings 1–5 + owner decision D5-a, see the v14 row).
v12: owner decisions D0-b/D1-a/D2-b/D3-a/D4-a folded, see the v12
Change Ledger row). v8
(terra c6): usage fold specified as a total function — per-provider
billing-stream identity, correction-graph validity, cumulative/delta
inclusion, collisions ⇒ unresolved unknown (14.13.4a); intent
lifecycle phases + uncertain-call recovery + retention (14.13.4a);
elapsed interval end = `closed.ts` for every cycle with monotonic
boot-continuity fail-closed (14.13.4a); remote-terminal-disposition
vocabulary pinned + coverage/freshness validation (14.13.4a). v7
(terra c5): remote terminality separated from spend value — typed
owner `remote-terminal-disposition`, budget-extension never resolves
it; deterministic statement fold (statementSeq ordering, correctionOf
chains, out-of-order/gap fail-closed); dispatch-intent records before
provider calls + proven empty-set closure + complete-session-query
requirement (14.13.4a). v6
(terra c4): elapsed zero-dispatch endpoint + bounded escalation
(`remote-terminal-unproven`); late-usage identity/dedup/cumulative-vs-
delta projection; reproducible policy-revision bytes + prefix-only
counter recurrence. v5
(terra c3): non-circular close→boundary ordering; provider-request
terminality at close; late-usage forward-only accounting; leaf-component
reconciliation. v4
(terra c2): liveness proof before interval close; reconciliation targets
one unresolved component with provider-recovery evidence and one-time
resolution; wallclock endpoints incl. zero-dispatch; wallclock cap
extensible; converged needs no next-cycle admission. v3
(terra c1): intervals close only when ALL dispatches are terminal;
elapsed-time unknowns fail closed; distinct spend-reconciliation record
from budget-extension; one admit per cycle number, retries attributed
inside the admitted cycle.**

**Purpose.** §14.7 budgets are per-*recovery* (per task, per attempt).
The audit-fix loop needs a separate budget per *design cycle* (one
audit→fix round), because its spend is not recovery spend. Without it,
AUD51-style "max 5 cycles, closed UNCONFIRMED" is an operator habit, not
a limit the machine enforces. The G4 cap also gives the owner a bounded,
recorded place to extend a loop.

#### 14.13.1 Policy (desired authority, `graph.json policy.cycleBudget`)

```jsonc
{ "maxCycles": 5,                 // design cycles incl. confirming cycles [5]
  "maxConfirmingCycles": 3,       // confirming cycles after the first clean-candidate [3]
  "maxWallclockS": 14400,         // [14400] over all cycles
  "maxUsd": 20.0                  // cycle spend cap — ALL spend the cycle dispatched: auditors + implementers + their recoveries (v2) [required in managed episodes]
}
```

Defaults are bracketed; `maxUsd` is required, matching the §14.7
`maxEpisodeRecoveryUsd` discipline (no unbounded managed loop).

#### 14.13.2 Enforcement point: cycle boundaries only

- Budget is checked **only when admitting cycle `n+1`** (the cycle
  boundary), never mid-cycle. In-flight workers finish under their own
  §14.7 per-task budgets; the design-cycle budget decides whether another
  cycle may START.
- **Admission is a pre-check with an estimate:** admit cycle `n+1` only if
  `spent + estimate(n+1) ≤ cap`, where `estimate` is the mean observed cost
  of prior cycles (or `maxUsd / maxCycles` before any observation).
  **One fail-closed rule for unknown spend (v2, blocker fix):** ANY
  unresolved unknown spend — a worker with missing usage, or an `admit`
  with no matching `close` (§14.13.4) — consumes **all remaining headroom
  for admission** (equivalently: unknown ⇒ no next cycle), never an
  estimate. An estimate is a prediction, not evidence of what a crashed
  cycle actually spent; counting crashed work at its estimate could grant
  headroom a $10 crash had already burned. The same A6 posture as P8:
  unknown is counted, not forgiven. The only unlock is **reconciliation**
  (§14.13.4a): the supervisor resolves the unknown against provider
  usage; if usage is unrecoverable, only an owner act (§14.13.5 shape)
  records the accepted value. Estimate error on KNOWN costs can still
  overshoot the next cycle; the record states this rather than claiming a
  hard bound (same honesty as docs/21 D5 revised).
- Wallclock is checked the same way against elapsed time; an unresolved
  open interval (admit without close) counts as consuming the remaining
  wallclock budget, same fail-closed posture.

#### 14.13.3 Two projections, one ledger (v2 fix)

Design-cycle spend and time are a **separate projection over the same
usage records**: a cycle's projection sums ALL spend attributable to
work the cycle dispatched — auditors, implementers, AND recoveries of
those tasks. A dollar may appear in both the §14.7 recovery projection
and the cycle projection (they are views over the ledger, not accounts;
"double-counting" would mean counting it twice in ONE projection, which
never happens). v2 closes the v1 escape hatch: v1 said "recovery spend
never draws down the cycle budget", so a $1 audit task whose recovery
burned $9 counted only its $1 against a $2 cycle cap. The projections
still govern DIFFERENT decisions and never mutate each other's counters
— a recovery budget stops the next *attempt* (§14.7 unchanged), the
cycle budget stops the next *cycle* — but both read the true spend of
the same records, under P8's discipline (append-only, stable ids,
reconcile on restart).

#### 14.13.4 Records (S5 kind `cycle`)

```jsonc
{ "kind":"cycle", "id":"…", "ts":…, "schema":"tre-supervisor/1", "episodeId":"…",
  "cycle":4, "phase":"admit | closed",
  "admitted":true, "reason":"within-budget | budget-exhausted | wallclock-exhausted | spend-unknown",
  "estimateUsd":1.8, "spentUsd":12.4, "unknownSpendUsd":0,
  "elapsedS":7200, "confirming":false }
```

Admission is appended BEFORE the cycle starts (log-then-act, §14.3); the
close record carries observed spend. **Cycle identity (v3):** each cycle
number has EXACTLY ONE `phase:"admit"` record (a second admit for the
same number is invalid); auditor retries (14.12.2 rule 1) execute under
their cycle's existing admission and NEVER mint a new cycle number or
admission — burning `maxCycles` without budget records is unreachable.
A `phase:"admit"` with no matching
`closed` on restart is reconciled as **spend-unknown**: it blocks
admission (14.13.2) until §14.13.4a resolves it.

#### 14.13.4a Reconciliation (v3: only TERMINATED cycles close)

A cycle interval closes ONLY when all its dispatches are terminal
(every task in a durable terminal state — S3 `done/failed/parked` — or
provably dead per dispatch/attempt identity reconciliation, §7
trichotomy). Restart rules:

- Workers still live ⇒ the interval STAYS OPEN. The supervisor resumes
  supervising; it never closes an interval with live spend, so "close
  then admit the next cycle while the old one spends" is unreachable
  (v3). A live-but-abandoned worker is first failed/parked via the
  normal recovery path; the interval closes only after that.
- All dispatches terminal ⇒ resolve usage: `closed` record with
  observed `spentUsd` where P8 usage resolves, `unknownSpendUsd`
  counting records whose usage is unrecoverable.
- **Elapsed time resolves too (v5, non-circular endpoints — v4's list
  made close and boundary depend on each other, c3; endpoint extended
  to cover the full admitted cycle v8, c6-M12):** interval start =
  the `admit` record ts; interval end = the `closed` record's own ts
  **for EVERY cycle** (v8 — the v6 rule ended the interval at the last
  terminal dispatch/usage ts, which under-counted a cycle whose
  reconciliation and close took hours after the last worker stopped;
  `closed` IS the durable, non-circular close-time observation — it
  is appended before the boundary and consumes no later line's ts —
  so elapsed covers admit→closed INCLUDING dispatch, worker runtime,
  reconciliation, drain, and close preparation). The v6/7
  zero-dispatch special case is subsumed: every cycle's endpoint is
  `closed.ts`. **What the cap covers — TWO measured spans, neither
  omitted (v9, c7-M9):** the v8 text claimed `closed.ts` covers
  "reconciliation, drain, and close preparation" while §14.12.4b's
  ordering places `closed` BEFORE the full finalization protocol
  (queue drain, owner confirmations during close, boundary + verdict
  append) — so the finalization tail after `closed` escaped the cap.
  v9 fixes it by measurement, not narration: the cycle's TOTAL
  charged elapsed = `(closed.ts − admit.ts)` (the dispatch/runtime/
  reconciliation span, v8) **PLUS** `finalizationTailMs` — the
  monotonic delta between the `monoMsAtClose` sample and a
  `monoMsAtBoundary` sample taken by the same supervisor process at
  the `cycle-boundary` append (both under the same boot identity, so
  no wallclock trust is needed for the tail). The tail covers drain,
  quiesce waiting, and the commit work; if the boundary appends under
  a DIFFERENT boot than `closed` (crash between them), the tail is
  UNKNOWN (fail closed — an owner `elapsed-reconciliation` may fix
  it; it is never estimated at 0). Inter-cycle idle (previous
  boundary commit → next `admit`) is charged to NO cycle (it is
  episode idle, reported separately) — stated explicitly so "cover
  everything" cannot be read as double-charging. **Monotonic
  continuity (v8, c6-M12; admission sample v9, c7-M9):** the
  supervisor's
  monotonic reference must be reconstructible across restart — the
  `admit` record carries `monoMsAtAdmit` (v9 — the v8 rule sampled
  only at close, so a cross-boot cycle interval had no admission-side
  anchor), each
  `closed` records `monoMsAtClose` from the boot identity record
  (§14.12.4b) plus the boot-relative monotonic reading, and restart
  reconciliation joins boot spans: a joined span is admissible only
  with BOTH boot identity records present and an overlap witness (the
  previous boot's last durable record's wall ts and the new boot's
  identity-record wall ts must straddle the gap within tolerance, and
  the mono readings must be individually valid per boot); if
  continuity across a boot gap cannot be established the elapsed is
  UNKNOWN (fail closed; owner
  `elapsed-reconciliation` only may fix it). **Tail replay validation
  (v11, c9-m17):** the cached `finalizationTailMs` on the
  `cycle-boundary` record is NEVER an authority any consumer may
  trust unverified — replay ALWAYS recomputes the tail from the
  durable samples and VALIDATES: (i) the `closed` record's schema
  normatively carries `bootId` + `monoMsAtClose` (required fields,
  not prose-only); (ii) for a non-null `finalizationTailMs`:
  `bootIdAtBoundary == bootIdAtClosed` (same boot identity record,
  both named by recordId), `monoMsAtBoundary ≥ monoMsAtClose`, and
  `finalizationTailMs == monoMsAtBoundary − monoMsAtClose` EXACTLY;
  any mismatch, a negative delta, or a missing/mismatched boot id
  ⇒ the tail is UNKNOWN (fail closed) AND the mismatch itself is
  a `counter-divergence` history-integrity-fault naming the
  boundary — a forged or erroneous cached tail can never be charged
  differently by two consumers, because BOTH charge the recomputed
  value or none; (iii) the charged total is pinned as ONE formula:
  admit-to-close + tail (or UNKNOWN), never tail alone, never
  admit-to-boundary double-counting the tail. Non-understated coverage comes
  from (b): usage records appended after close are retrospective
  BILLING evidence, not interval extension — they attach through the
  late-usage path below and count at admission without rewriting the
  interval. Clock source: supervisor monotonic reference stamped as
  wall time on the records themselves; a clock discontinuity (recorded
  ts going backwards beyond tolerance) makes elapsed UNKNOWN (fail
  closed). A cycle whose endpoints cannot be read consumes remaining
  wallclock like an unresolved spend (14.13.2), and only an owner
  reconciliation record (below) may fix it. **Commit order (v5):** all
  dispatches terminal + liveness-proven → `closed` (observed spend +
  elapsed resolved or unknown-marked) → `cycle-boundary` (its
  `admissionEvidenceIds` consume the admit AND the closed records —
  both exist in the prefix) → verdict. No event consumes a later one.
- **Owner reconciliation is a DISTINCT record from extension (v4,
  precise targeting):**
  `{ "kind":"spend-reconciliation", "id":"…", "episodeId":"…",
     "targetKind":"cycle|worker", "targetId":"…",
     "component":"spend|elapsed",                    // exactly ONE unresolved component
     "acceptedUsd":1.5, "acceptedElapsedS":null,     // value for that component only
     "providerAccountId":"acct-…",   // REQUIRED non-null for a dispatch-attributable spend target (names the closed stream (providerAccountId, dispatchId), v15 cycle-10 finding 8); null ONLY for elapsed or cycle-overhead targets
     "providerRecovery":{ "attemptedAt":…, "outcome":"unrecoverable",
                          "evidenceRef":"…" },       // REQUIRED: independent proof
     "authority":"tty:…" }` — validates: the named target AND component
  exist and are currently unresolved; `providerRecovery.evidenceRef` is
  a durable record of the provider-usage recovery attempt proving the
  value is unrecoverable (provider-first: a RECOVERABLE component is
  reconciled from provider usage as a MEASURED value in a separate
  `usage-recovered` record — the owner route is only for unrecoverable
  data, and reconciliation never overrides a known ledger amount: known
  spend is a permanent floor, v4); values are finite non-negative
  numbers matching the component (spend ⇒ `acceptedUsd`, elapsed ⇒
  `acceptedElapsedS`; both null or the wrong pair ⇒ refused); the
  record carries `providerAccountId` under the SAME placement rule as
  the §14.10.3 op payload (v15, cycle-10 audit finding 8 — required
  for a dispatch-attributable spend target, null only for elapsed or
  cycle overhead; the record's stream identity is
  `(providerAccountId, dispatchOf(targetId))` and validation refuses
  a mismatch), and the resulting reconciliation record is
  reconstructed and byte-verified by the supervisor from the owner
  act's full canonical payload (c9-B3 payload + c6-M7 independent
  reconstruction — conformance vector v15: an owner payload missing
  the required `providerAccountId`, or carrying one on an
  elapsed-target reconciliation, is refused and nothing lands); TTY-
  confirmed act bound to these exact values (§14.10.3 posture; the
  orchestrator may append a validated owner act, never originate one).
  **Target hierarchy (v5, c3):** reconciliation resolves ONE unresolved
  leaf component — a WORKER/dispatch-level spend or elapsed unknown —
  and `targetKind:"cycle"` is admitted ONLY as sugar for the cycle's
  own accounting overhead (non-dispatch-attributable); a cycle-targeted
  reconciliation NEVER covers a component that is attributable to a
  dispatch with its own unknown (validation refuses: the named target's
  unknown must not decompose into other unresolved unknowns). Known
  amounts are the floor at EVERY level; the cycle total is
  Σ(dispatches) + cycle-level component, and double-resolution of one
  underlying unknown (cycle + its worker) is unreachable by
  construction.
  **Elapsed recovery evidence (v5):** elapsed has no provider — its
  `providerRecovery` is `localRecovery` instead: required
  `{ method:"clock-log|dispatch-records", attemptedAt, outcome:
  "unrecoverable", evidenceRef }`, and measured elapsed from durable
  dispatch records lands as a measured `elapsed-recovered` record
  (measured beats accepted exactly as spend does).
  **One-time resolution (v4; supersession chain v17, cycle-11 audit
  finding 2 — v4's absolute once-only rule made the prescribed
  post-release refund cure (14.13.4a: "a fresh `spend-reconciliation`")
  unexecutable for any component already reconciled once: the only
  specified route was refused by this very validator):** a component
  may be reconciled at most once PER CHAIN POSITION: the FIRST
  reconciliation for a (targetId, component) carries
  `supersedesReconciliation:null`; a SECOND (or later) reconciliation
  of the same (targetId, component) is refused UNLESS it names the
  current chain tip record in `supersedesReconciliation` — forming a
  LINEAR SUPERSESSION CHAIN (validated acyclic, one tip at a time; the
  chain tip's accepted value is the effective value; every prior
  reconciliation stays in the log, nothing is modified — append-only).
  **Effective value with a reconciliation chain vs later raw folds —
  ONE precedence, TOTAL over all cases (v26, cycle-19 finding 4 —
  v25's chain-tip clause said 'the chain tip's accepted value is
  the effective value' while the fold text said a later raw fold
  'lifts the value forward, never below the accepted floor', and the
  two competed for a component whose raw set later folds CLEAN —
  reconciled at $20 with a later clean raw fold R of $15 or $25 had
  no stated result):** let `tip` be the accepted value of the
  current chain tip and `R` the raw fold result of the CURRENT
  provider record set (the ordinary graph/coverage/monotonicity
  machinery, unchanged). (1) While the raw set folds UNRESOLVED
  UNKNOWN, the component's value is `tip` (owner authority stands
  over unknown provider evidence — this is what the reconciliation
  is FOR). (2) When the raw set folds CLEAN at R: the component's
  effective value is `max(R, tip)`. R > tip: the provider's own
  evidence now shows MORE spend than the owner accepted — the fold
  lifts the value forward (the owner never accepted a CEILING;
  acceptedUsd ≥ floor is a floor assertion, and raising spend is
  provider-correction territory per the high-water rules). R = tip:
  agreement, value tip. R < tip: the owner's accepted amount is a
  FLOOR the raw fold may never lower — the value stays `tip` and
  the divergence (provider evidence below the owner-accepted
  amount) is surfaced as an advisory note in the fold-warnings
  report
  (same carrier as the baseline-cardinality warning, §14.12.4b
  `warnings[]`; advisory only, never needs-owner, never a closure
  blocker) — lowering below the accepted amount requires a
  SUPERSEDING reconciliation through the chain (the only owner
  route), exactly the refund discipline of the released case; no
  new owner override is introduced and no raw fold ever amends a
  reconciliation record. (3) RELEASED targets: the same rule
  applies per term of the high-water accounting (`hw_{i,c}`), and
  the released-and-known floor paragraph governs superseding
  amounts; nothing here changes post-release `charged(P)`.
  Examples: reconciled $20, later clean raw fold $15 ⇒ value $20
  (advisory note); fold $20 ⇒ $20; fold $25 ⇒ $25 (forward). All
  three are deterministic from the record set; no arrival-order
  read.
  **Component scope of this precedence (v27, C20-M4):** clauses
  (1)–(3) are the precedence for the **SPEND** components ONLY
  (`tokensUsd`, `requests`, `bytes`). The ELAPSED component has its
  own fold and reconciliation semantics and NEVER uses `max(R,tip)`:
  elapsed has no provider, so its "raw fold" R is the deterministic
  local fold over the elapsed evidence set (valid clock spans per the
  boot-discontinuity rules above plus the `elapsed-recovered` record
  if present — a monotonic measure, never a max; a recovered
  measured value is an observation, not an owner assertion).
  Precedence for elapsed: (E1) while the elapsed evidence set folds
  UNRESOLVED UNKNOWN, the value is the chain-tip `tip` (if no chain,
  UNKNOWN) — same rationale as (1). (E2) when it folds CLEAN at R:
  **R == tip: agreement (the fold reproduces the accepted duration —
  this is the normal recovered-elapsed case, since reconciliation
  measures FROM the same clock spans). R != tip (either direction):
  the MEASURED value wins — the effective value is R, both upward
  (recovered longer elapsed) and downward (a reconciliation accepted
  a duration longer than the spans measure),** because elapsed is a
  monotonic measurement and the measured-beats-accepted rule (§ this
  section, late-usage) applies to time with both-direction force: an
  owner accepting an elapsed estimate is not a FLOOR assertion on
  time — money floors protect granted authority; a duration is a
  fact, and an owner-held wrong duration must stay correctable by
  measurement without a superseding act. The divergence (R != tip)
  is surfaced as the `reconciliation-floor-divergence` advisory in
  `warnings[]` (reusing that marker, the elapsed pair derivable
  from the log — the marker names the condition "clean recomputed
  value diverges from the chain tip", v27 generalized from
  spend-below-tip only). A superseding elapsed reconciliation stays
  legal (a later owner correction with better evidence) and re-passes
  validation. No max: `tip` with spans measuring LESS yields the
  measured value; examples (v27): accepted 3600 s, recovered/
  re-measured 5400 s ⇒ 5400 s (advisory divergence note); accepted
  3600 s, re-measured 1800 s ⇒ 1800 s (advisory); re-measured 3600 s
  ⇒ 3600 s, silent. Deterministic from the record set either way;
  no arrival-order read.
  The chain tip is the latest ACCEPTED reconciliation for that (targetId, component); a refused record never enters the chain (v19, finding 2). For a RELEASED target (v18, finding 2) a superseding reconciliation is legal ONLY when `supersedesReconciliation` names an existing chain tip for that component; the validation clause 'target currently unresolved' reads 'unresolved OR released-with-chain-tip'. A released component with NO prior reconciliation has no chain and is NOT owner-reconcilable — its post-release change arrives only as a provider `correctionOf` statement (the graph path). A second reconciliation WITHOUT a valid `supersedesReconciliation` —
  including a replayed or reordered one — stays refused; redelivery of
  the same record id is idempotent, any differing payload under the
  same id is refused. Every superseding reconciliation re-passes the
  FULL validation of the first (unresolved-or-released target,
  providerRecovery evidence, TTY-confirmed act, floor checks against
  the CURRENT effective bounds); an owner disposition is never
  required to authorize one beyond the act itself.
- **`parked` is NOT proof of stopped spend (v4, c2):** interval closure
  requires, regardless of task status, **independent liveness proof per
  dispatch identity** — the recorded attempt/session process is gone
  (pid+start-time identity check) or provably dead (§7 trichotomy) —
  AND provider-usage reconciliation of every dispatch the cycle made.
  A task recorded `parked` whose process liveness is unknown keeps the
  interval OPEN and blocks admission (fail closed): "close then admit
  the next cycle while the old one spends" stays unreachable.
  Delayed provider usage observed AFTER close appends a
  **`usage-late-arrived` record** (v5, deterministic effects — v4 said
  "counts at the next admission check", which never happens after a
  converged closure, c3): `{ cycleId, dispatchId, usd,
  providerRequestRef, providerStatementId, statementSeq:null|<int>,
  correctionOf:null|providerStatementId, mode:"cumulative|delta",
  supersedesReconciliation:null|id }`. **Deterministic statement fold
  (v7, c5-M4; total function specified v8, c6-B4):** the wire record
  carries `statementSeq` = the provider's monotonically increasing
  statement sequence for that **billing stream**, where a stream is
  identified by `(providerAccountId, dispatchId)` — sequences from two
  providers never share a domain (v8: per-provider-stream, not global;
  v9, c7-B2: `providerAccountId` is a REQUIRED field on every
  `usage-late-arrived`, `usage-recovered`, and owner reconciliation
  record naming usage — a stream cannot be identified without it and
  a record missing it is refused at append). **Sequence-domain
  guarantee (v9, c7-B2):** the provider statement sequence is
  REQUIRED to be dense (no gaps) per stream; the fold therefore
  GAP-DETECTS: after the pipeline's P3 gap-check stage (below), if
  the accepted sequenced statements of
  a stream do not form a contiguous sequence over their claimed range
  (from the lowest accepted seq to the highest), the missing interior
  sequences are UNKNOWN statements and the component is an unresolved
  unknown — a missing sequence number is never skipped past, because
  nothing in the prefix distinguishes "statement 2 was a correction"
  from "statement 2 changed coverage" (v9: accepting the highest
  cumulative across a gap is exactly how stale values survive). A
  provider that does not guarantee dense sequences must be declared
  non-dense in the provider capability record, in which case ONLY
  cumulative statements with provider-attested completeness markers
  are accepted; else the component is unknown.
  The fold is a TOTAL FUNCTION of the prefix; the algorithm, per leaf
  component (v29, C22-M2 — the fold carries TWO numbering systems
  and v28 let them collide: the enclosing RULES below are numbered
  F1–F5 and the execution PIPELINE in the null-seq paragraph is
  P0–P4; every bare cross-reference now names one or the other —
  an unqualified "step N" is no longer resolvable and is REJECTED
  by this audit arc):
  F1. Collect the component's statement records (deduped by identity,
     below). Build the correction graph on `correctionOf`: each
     statement may be corrected AT MOST ONCE; a second record
     correcting the same target with a different value is a
     CONTRADICTION ⇒ the component becomes an unresolved unknown (see
     F5); a second record correcting the same target with the SAME
     value is a SAME-VALUE RESTATEMENT (v25, cycle-18 finding 4):
     both records are retained as evidence and chain to ONE unique
     tip value — no contradiction, no fork, no unknown. **SAME-VALUE
     SIBLINGS ARE ONE MERGE CLASS (v26, cycle-19 finding 2 — v25
     retained two sibling restatements as distinct nodes and said
     each 'chains normally', so `D; C=correct(D,$2); E=correct(D,$2)`
     with `F=correct(C,$5)`, `G=correct(E,$6)` had NO deterministic
     graph result):** same-value corrections of one target are
     graph-EQUIVALENT nodes — they form a single MERGE CLASS, and
     EVERY rule that fires on a correction target (chain placement,
     at-most-once, contradiction, same-value restatement) fires at
     MERGE-CLASS level: a correction naming ANY member of the class
     is a correction of the class. Two corrections of one class with
     DIVERGENT values (the F/G case) are the SAME CONTRADICTION
     clause applies to two corrections of one record ⇒ unresolved
     unknown — the contract does NOT silently select a branch. Two
     corrections of one class with the SAME value chain to one tip
     value (no contradiction, no fork). Each member retains its
     ORIGINAL IDENTITY as a resolvable target (F's `correctionOf: C`
     resolves through C's class — identities are never rewritten);
     redelivery (same identity) stays a no-op dedup; a MUTUAL pair
     (`A=correct(B,v)`, `B=correct(A,v')`, any v,v') is the ordinary
     correction CYCLE contradiction evaluated CLASS-WISE — the
     same-value restatement rule NEVER absorbs a mutual pair (the
     cycle check precedes class formation). Raw evidence is always retained — §14.13.3
     replace-in-graph never deletes; a merge class is a resolution
     equivalence, not a record deletion. A correction whose target is absent from the prefix is HELD
     pending (applied by the next replay once the target lands;
     unresolved at close ⇒ fail closed). Corrections of corrections
     form chains — replace-in-graph, never apply-and-mutate; a
     correction CYCLE (a corrects b corrects a) is a contradiction ⇒
     unresolved unknown (v9, c7-B2). A correction whose value EQUALS
     its target's value is a same-value correction (v25, cycle-18
     finding 4 — v9's "same-value duplicate: folded by the dedup
     identity rules" is WITHDRAWN: an identity DEDUP deletes records,
     and a correction whose identity DIFFERS from its target's is not
     a redelivery of anything — deleting the node would sever chains
     of corrections targeting it): it remains a DISTINCT graph node
     in place of its target (replace-in-graph as usual, value
     unchanged) and chains normally; dedup by identity fires ONLY on
     same-identity redelivery.
     **Same-identity conflict (v9, c7-B2 tightens v8):** a redelivered
     record whose identity `(dispatchId, providerRequestRef,
     providerStatementId)` matches an accepted record but whose `usd`
     (or `mode`, or cumulative value) DIFFERS makes the component an
     unresolved unknown IMMEDIATELY — the conflicting value does not
     merely get "refused malformed" while the old value stands:
     identical identity with contradictory content means the fold can
     no longer trust WHICH value the stream carries (retaining the
     first amount recreates the v8 stale-value hole the rule claims
     to close). Resolution requires an owner disposition citing both
     records.
  F2. Determine anchoring (v23 finding 5; REAL/SYNTHETIC distinction
     added v24, cycle-17 finding 3 — v23's single "iff" rejected its
     own vectors (ix)/(xiv) and is WITHDRAWN): a delta contribution d
     is ANCHORED iff EITHER an effective cumulative (real OR baseline
     marker) exists at seq STRICTLY BELOW seq(d) — d then sits on top
     of that observation and is added by the CAND rule — OR a REAL
     (non-synthetic) effective cumulative exists at seq ≥ seq(d) —
     a real cumulative at seq k is an OBSERVATION of the total of
     every statement with seq ≤ k and so COVERS (includes, stated not
     inferred) every delta at or below it (same boundary as the
     coverage rule above). A baseline marker
     COVERS NOTHING (it asserts total 0 at its own seq with no
     knowledge below: it anchors only deltas strictly above itself);
     a delta below every baseline and every real cumulative (e.g.
     vector (xi)'s delta@1 under baseline@2) is UNANCHORED, and ANY
     unanchored delta — or an effective set with no cumulative at all
     — makes the component an unresolved unknown (fail closed,
     recomputed from the current effective set, never frozen from
     arrival order).
  F3. Apply remaining records sorted by `(statementSeq ascending,
     providerStatementId lexicographic)`; `mode:"cumulative"` at seq k is an OBSERVATION of the total of every statement with seq ≤ k; `mode:"delta"` at seq d is an ADDEND. ONE mixed-mode algebra (v19 cycle-12 finding 1; monotonicity, baseline and vectors corrected v20, cycle-13 findings 1–2): for each effective cumulative observation C_k define CAND(k) = C_k + Σ{ effective delta d : seq(d) > k } (a delta at or before k is already inside C_k and is never added twice). The effective cumulative observations, ordered by seq, must have NON-DECREASING CAND; the component value is CAND of the LAST effective cumulative observation (the maximum, given monotonicity). A violation (a later effective cumulative whose CAND is below an earlier one's) is an UNRESOLVED UNKNOWN, fail closed, never resolved by choosing a branch, until a graph-accepted correction or an owner reconciliation removes it. A correction REPLACES its target (the target leaves the effective set; **effective-value placement — UNIFIED v26, cycle-19 finding 1: the v25 general clause here said the correcting value 'enters at its own seq' while the delta coverage rule below says the corrected value enters AT THE TARGET DELTA'S OWN SEQ — two normative definitions for one record set, so the same stream (e.g. baseline $0 @1, D delta $2 @2, baseline $0 @3, correction-of-D $4 @4) folded to different values depending on which sentence an implementation read; the placement is now ONE rule stated once per kind**): a correction targeting a CUMULATIVE enters at the CORRECTION'S OWN SEQ position (with its own `(statementSeq, providerStatementId)` sort key — vector (vii)); a correction targeting a DELTA enters at the TARGET DELTA'S OWN SEQ at its chain-tip value (the same single position used by coverage, anchoring and value alike — vector (xxi)). Raw OCCUPANCY is untouched by either: every accepted raw statement keeps its own seq position. Monotonicity is checked on the POST-replacement set; the v19 comparison of CAND(k) against a raw C_k was wrong and is withdrawn. **Corrections targeting DELTAs — coverage rule (v21, cycle-14 finding 1):** a cumulative C_k OBSERVES the total of every statement with seq ≤ k (stated above), so a later REAL effective cumulative COVERS every delta at seq ≤ k. **ONE covering predicate (v25, cycle-18 finding 2 — the single definition used by the coverage rule, blocked-chain selection, absorption, no-cover detection and every vector): `covers(d, C)` holds for delta d and cumulative observation C iff C is a REAL (non-synthetic) effective cumulative with `seq(d) < seq(C)`; a `baseline:0` marker NEVER covers anything — it is an OBSERVER only, participating in F2 anchoring, the monotonicity check and mid-interval incomputability, and it may serve as the COMP anchor A, but it contributes NO coverage and blocks NO correction.** A correction replacing a delta d is ACCEPTED ONLY IF no REAL effective cumulative observation covers d (i.e. no REAL effective cumulative with seq > seq(d)) survives in the post-replacement effective set; the corrected value then enters AT THE TARGET DELTA'S OWN SEQ (the contribution position — v24, cycle-17 finding 6 WITHDRAWS v21's 'enters at the correction's own seq' for DELTA-targeted corrections: one placement rule for every chain state, and it is the position used by coverage, anchoring and value alike; corrections targeting a CUMULATIVE keep entering at the correction's own seq per vector (vii)). If a covering cumulative survives, the provider's correction is incomplete — it corrects a contribution but leaves the cover carrying the stale value, and adding the replacement on top double-counts it (the v20 vector (viii) value $17 did exactly this) — so the correction is NOT APPLIED, the component is an UNRESOLVED UNKNOWN fail closed (never "choose a branch", never an implicit subtraction from the cover). **Restated-cover absorption (v22; agreement equation REDEFINED and chain/no-cover branches added v23, cycle-16 findings 1–3) — one deterministic rule replacing v21's open-ended "until the cover is addressed":** the correction is NEVER re-admitted into any sum from any position (that half of v21 stands). **Chain normalization first (v23, finding 2):** a delta D whose raw-record set contains corrections (a correction targeting D, or targeting a prior correction of D) is replaced IN THE EFFECTIVE SET by a SINGLE synthetic contribution C D with value = the TIP of the chain = the value of the LATEST raw correction in that chain REGARDLESS of whether that tip is itself coverage-blocked (v24, cycle-17 finding 2 WITHDRAWS v23's all-blocked-keeps-raw-value exception: ONE tip value feeds both CAND and COMP; when every correction in the chain is blocked the component is still UNRESOLVED UNKNOWN under the coverage rule, and the tip value participates in the absorption agreement test as below), positioned at D's OWN raw seq. D's raw record leaves the effective set once normalized (never double-counted); all raw records are retained as evidence; graph membership (§14.13.3 replace-in-graph) is unchanged by normalization — normalization only defines which single value represents the chain in the sums. **Agreement against an independently anchored composition (v23, finding 1 — v22's equation `C.value = CAND(C) with the target replaced` is WITHDRAWN: substituting into the cover's own CAND makes the cover both evidence and input, and the substitution cancels for any cover with seq > target, so it AGREES TAUTOLOGICALLY and the (xii) rejection could never fire):** define **A** = the LAST effective cumulative (real or baseline marker) strictly below the LOWEST blocked chain position of the stream, and V = A's value. **COMP(C) = V + Σ of the distinct delta contributions whose position seq is STRICTLY BETWEEN the anchor and the cover (seq(A) < seq(d) < seq(C)) — v24, cycle-17 finding 1: deltas at or below the anchor are already inside V and are NEVER added again (v23's 'seq < seq(C)' summed everything below the cover and double-counted S2 under the S3 anchor: the correct $17 cover tested as $19 and an erroneous $19 cover passed). If ANY effective cumulative observation (real or baseline) has seq STRICTLY INSIDE the interval (seq(A) < seq(k′) < seq(C)), the agreement is INCOMPUTABLE — the corrected total through a mid-interval observation would require re-deriving that observation under the correction, which provider evidence alone cannot supply ⇒ the component stays UNRESOLVED UNKNOWN (fail closed; never sum across an observation; the cover C itself is the interval endpoint, not inside it).** A CORRECTED contribution counts AT ITS CHAIN-TIP VALUE (the latest raw correction value in that chain, blocked or not — the SAME tip value CAND reads, v24 finding 2), an uncorrected delta at its raw value (v23, finding 1: every delta evaluated at the value the provider says is correct, never at a stale raw value, and counted once). **when no cumulative or baseline exists below that lowest blocked position, the agreement is INCOMPUTABLE and the component STAYS UNRESOLVED UNKNOWN (v23: an independently anchored lower side is REQUIRED for agreement to count as evidence — V is NEVER defaulted to 0; fail closed per §7).** COMP never reads C's own value (v22's withdrawn defect: substituting into the cover's own CAND made the cover both evidence and input, so it agreed tautologically). The absorption unknown resolves IF AND ONLY IF the LAST effective cumulative C whose seq exceeds every blocked chain position satisfies C.value = COMP(C). Agreement is EVIDENCE, not a contribution: it says the provider restated the total to include the corrected amounts; the component then takes the ordinary value rule (CAND of the last effective cumulative, with chain tips as the delta contributions). While the last cover does not agree, the provider's own evidence is contradictory (cover value vs corrected composition) and the component STAYS UNRESOLVED UNKNOWN — a restated cover of a DIFFERENT value does not resolve it; an owner reconciliation (F5) also resolves it. **No-cover branch made exclusive (v23, finding 3):** the absorption rule governs ONLY while a blocked delta exists (a chain whose tip is coverage-blocked — blocking uses the SAME covering predicate: only a REAL effective cumulative above the target blocks; a baseline above the tip never blocks and never covers). If a graph change removes the last REAL effective cumulative above the chain, the coverage rule APPLIES the tip at the contribution's own seq — the tip is then anchored (or not) by F2's rule exactly like any other delta contribution: ANY effective cumulative (real or baseline) strictly BELOW the tip's position, or a REAL effective cumulative at seq ≥ the tip's position — v23's 'any effective cumulative at seq greater than the tip' is corrected v24 (finding 3): a surviving BASELINE marker above the tip anchors nothing (baselines cover nothing); it does NOT stay unknown by the absorption clause (v22's "(or no cover exists) stays unknown" is WITHDRAWN; with no surviving cumulative at all the component is unknown via F2 — the SAME fail-closed result, reached by one named rule, not two competing ones). The test is a pure function of the raw-record set (no arrival order, no pending-flag, no binding record between restatement and correction — every consumer replays the same answer). A correction of a replacement cover is re-tested at the new last cover: disagreement there re-opens the unknown. A correction targeting a CUMULATIVE needs no such rule: the target's own observation IS the cover, and replacement removes it with its cover. A `baseline:0` marker (F2) is a SEQUENCED synthetic cumulative observation C=0 at its OWN raw `statementSeq`, occupying that sequence position like any raw statement (P4 sorts it into the seq order) — **collision and pre-baseline rules (v21, cycle-14 finding 4; moved APPEND-TIME → FOLD-TIME v22, cycle-15 findings 4–5):** a baseline marker is subject to F4's collision rule like any raw statement — a second arrival at the baseline's seq with DIFFERENT identity (whether it is a real statement arriving after the baseline, or the baseline arriving after a real statement at that seq) makes the component an UNRESOLVED UNKNOWN under the general rule, with BOTH records retained as evidence (append-only; the fold never drops either colliding record) until an owner disposition; v21's "malformed append, prefix stays clean" is WITHDRAWN — append-time validation is structural only (presence, types, and the §14.3 log-then-act contract) and cannot see a future arrival, so v21's text made the outcome order-dependent (statement-first refused the baseline; baseline-first hit the general unknown) and one record set could yield two different stream states. Baseline identity (v23, finding 6) is the record identity `(streamKey, providerStatementId)` like any raw statement: same-identity redelivery dedups per F1; two markers at ONE seq with different identities are the general fold collision ⇒ unknown. **Two DISTINCT baseline markers at DIFFERENT seqs (v23, finding 6 — v22's "TWO baseline markers is the same fold collision" over-reached and is WITHDRAWN): the stream has two synthetic zeros (v25, cycle-18 finding 3 NARROWS the v24 redundancy claim: "the lower marker is REDUNDANT" holds ONLY WHEN NO effective contribution sits strictly between the two markers — a baseline anchors only deltas strictly ABOVE itself, so with a contribution D, seq(B1) < seq(D) < seq(B2), D is anchored by B1 but NOT by B2 (a baseline anchors only what is strictly above it), removing B1 would leave D UNANCHORED, and the monotonicity check runs over ALL markers: CAND(B1) counts D while CAND(B2) does not, so the component is an UNRESOLVED UNKNOWN (vector (xx)) — v24's unqualified 'removing the lower marker changes no anchor and no sum' is WITHDRAWN except in the no-intervening-contribution case it illustrates, e.g. baseline@1, baseline@2, delta@3 $4 ⇒ value $4 and the marker removal changes nothing (vector (xx-ctl)); BOTH markers participate in monotonicity as ordered cumulative observations and both are eligible COMP anchors (the LAST one strictly below the lowest blocked position), and the warning stands independently of the value result); the presence of two or more distinct baselines is ALSO a provider evidence-quality ADVISORY WARNING at fold time (v24, cycle-17 finding 4 replacing v23's needs-owner flag; representation pinned v25, cycle-18 finding 6: exactly ONE warning PER STREAM whose effective set holds ≥ 2 distinct baseline markers, identity = streamKey, carrying the FULL SORTED list of the marker identities ((statementSeq ascending, providerStatementId lexicographic) — the F3 sort order) — never pairwise warnings, never an arbitrary subset; the warning is a DERIVED PROJECTION, not a record kind: it is recomputed by every fold from the current effective set and appears and disappears deterministically as markers enter or leave it, carried in the acceptance report's `warnings[]` array — the carrier is the fold-warnings report defined in §14.12.4b (v26, cycle-19 finding 5) (entry `{ warning:"baseline-cardinality", streamKey, markerIdentities[] }`) — advisory only, NEVER a needs-owner condition, NEVER a closure blocker). Implementations cannot silently differ on the value OR on surfacing the anomaly. **Marker authority (v24, finding 4):** a `baseline:0` marker is provider-sourced evidence with the SAME provenance requirement as any statement of the stream (appended only from the provider's own stream, never synthesized by the orchestrator or a consumer); an unexpected second same-provider marker is exactly the anomaly the advisory surfaces — a consumer cannot manufacture it, and a hostile provider can at worst produce a warning, not a blocked closure (v23's flag made guaranteed-needs-owner an attack surface).** Pre-baseline deltas are FOLD STATUS, not append validity (v22): a delta at seq < baseline.seq is not included in CAND(baseline); whether it harms the stream is computed by the fold from the CURRENT effective set — if any effective cumulative with seq > baseline.seq exists the delta is inside that cover (value rule unchanged); if none does, the delta is an unanchored addend and the component is UNRESOLVED UNKNOWN via the ordinary F5 mechanism (NOT "malformed at append": a later cover — or a correction of a cover — changes the effective set, and an entry accepted under one prefix must not flip to "was always malformed" when the graph changes; unknown recomputes deterministically from the full raw set either way, and an owner reconciliation resolves it). So CAND(baseline) = Σ of the effective deltas at seq > baseline.seq and the delta-only value is defined. Vectors (v22 additions (x)–(xii); (v)–(vii) and (ix) unchanged from v20; (viii) CORRECTED v21; (viii-b) RE-STATED v22 under the absorption rule, arithmetic via COMP v23; (xiii)–(xiv) v23; (xv)–(xix) v24, cycle-17 findings 1 and 6; (xvii) REWRITTEN and (xx)–(xxii) added v25, cycle-18 findings 1–4; (xvii) RENUMBERED DENSE and (xxiii)–(xxv) added v26, cycle-19 findings 2–3; (xiii) AND (xviii) RENUMBERED DENSE v27, cycle-20 finding 1). **Numbering and density convention (v27, cycle-20 finding 1 — closes the "apparent S-number-as-sequence" reading for every vector at once): where a vector states an explicit `@seq`, THAT is the statement's `statementSeq`; where one is omitted, the label number is the `statementSeq` (S1 ⇒ 1, S2 ⇒ 2, …) and the vector's implied raw occupancy is dense over its claimed range — a vector claiming a value (not the unknown) must have dense occupancy under this convention, and the whole vector set (v)–(xxv) was rescanned against the dense gate under it: every value-claiming vector except (xiii) and (xviii) is dense as written ((xiii) and (xviii) fixed above); the deliberately gap-bearing fixtures state their gap and claim the UNKNOWN the gate produces:** (v) S1 cum $10, S2 delta $2, S3 cum $12 ⇒ CAND(1)=12, CAND(3)=12 ⇒ value $12 (not $14); (vi) S1 cum $10, S2 delta $2, S3 cum $11 ⇒ CAND(1)=12 > CAND(3)=11 ⇒ violation ⇒ unresolved unknown; (vii) S1 cum $10, S2 delta $2, S3 cum $12, S4 `correctionOf:"S3"` cum $13 ⇒ effective {S1, S2, S4} ⇒ CAND(1)=12, CAND(4)=13 ⇒ $13; (viii) CORRECTED v21, cycle-14 finding 1 — the v20 claim "value $17" double-counted: S1 cum $10, S2 delta $2, S3 cum $12, S4 `correctionOf:"S2"` delta $5 ⇒ S3 (seq 3 > 2) is an effective covering cumulative of the target delta S2 ⇒ the coverage rule REFUSES application of S4 ⇒ the component is UNRESOLVED UNKNOWN, neither $17 nor $12 nor $15 is stated value while S4 stands unabsorbed (the pre-S4 prefix had value $12, but once S4 is in the record set the coverage rule makes the provider's own evidence contradictory, so the component is unknown from S4's arrival; resolution: restated-cover absorption per (viii-b)/(xii), or an owner reconciliation). Companion vector (viii-b) (v21; RE-STATED v22; agreement arithmetic restated to COMP v23, cycle-16 finding 1): same stream as (viii) — S4 chain-blocked, component unresolved unknown — then S5 `correctionOf:"S3"` cumulative $15 replaces S3: chain normalization of S2's chain {S2 $2, S4 $5} gives one tip delta $5 at S2's own seq 2; effective {S1, tip$5@2, S5} ⇒ CAND(1) = 10 + 5 = 15 (tip at seq 2 is after seq 1), CAND(5) = 15 (no effective delta after 5) ⇒ non-decreasing; absorption agreement: COMP(S5) = V(= S1's 10, the last cumulative below the tip) + tip $5 = 15 = S5.value ⇒ AGREES ⇒ the (viii) unknown RESOLVES ⇒ value $15. S4's corrected $5 is never re-admitted into any sum from any position (agreement is evidence, not a contribution), and $15 is accepted because the provider's restated total agrees with the corrected composition — not because a delta was added under a stale cover. (ix) sequenced baseline:0 at seq 0, S1 delta $2, S2 delta $3 ⇒ CAND(0)=5 ⇒ value $5 (no cumulative exists in this stream; v19 had no value here). (x) baseline collision (v22, finding 4): baseline@seq 2 then S1 `mode:"cumulative"` $9 @seq 2 ⇒ different identities at one seq ⇒ BOTH retained as evidence, component UNRESOLVED UNKNOWN until an owner disposition; reversed arrival order (statement first, then baseline) yields the IDENTICAL outcome — v21's order-dependent pair (refused-append vs unknown) is closed. (xi) pre-baseline delta is fold status (v22, finding 5): baseline@seq 2 with an effective delta @seq 1 and no cumulative ever ⇒ the delta is an unanchored addend ⇒ UNRESOLVED UNKNOWN (fail closed; v21's "malformed at append time" withdrawn — no entry is retroactively invalid); if a cumulative @seq 3 $12 later arrives covering seq ≤ 3, the SAME raw set replays to value $12 deterministically; if instead the cover's replacement removes it, the unknown returns — fold status, recomputed, never a mutation of history. (xii) disagreement keeps the unknown (v22, finding 1; arithmetic via COMP v23, cycle-16 finding 1 — the agreement test NEVER reads S5's own value, so it cannot agree tautologically): stream (viii) then S5 `correctionOf:"S3"` cumulative $14 ⇒ COMP(S5) = 10 + tip $5 = 15 ≠ 14 ⇒ the restated cover does NOT agree with the independently computed corrected composition ⇒ the provider's own evidence stays contradictory ⇒ UNRESOLVED UNKNOWN stands (a restated cover of a DIFFERENT value does not resolve it; v21's open-ended "addresses the cover itself" permitted that misreading and is pinned here). (xiii) correction chain under a restated cover (v23, finding 2; RAW SEQs MADE EXPLICIT AND DENSE v27, cycle-20 finding 1 — v23 left S4/S6's `statementSeq` unstated and numbered S6/S7 past a missing seq 5, so the apparent occupancy {1,2,3,4,6,7} violated the dense gate that the vector itself relies on): S1 cum $10 @1, S2 delta $2 @2, S3 cum $12 @3, S4 `correctionOf:"S2"` delta $5 @4, S5 `correctionOf:"S4"` delta $6 @5 ⇒ occupancy {1,2,3,4,5} contiguous; S2's chain {S2, S4, S5} normalizes to ONE tip delta $6 at seq 2 (S2 and S4 leave the effective set, raw records retained), blocked by surviving S3 ⇒ component UNRESOLVED UNKNOWN; then S6 `correctionOf:"S3"` cumulative $16 @6 replaces S3 (occupancy {1,2,3,4,5,6} contiguous) ⇒ anchor A = S1@1 (last effective cumulative strictly below the lowest blocked position 2), interval (1,6) holds no mid-interval effective cumulative (S3 is replaced) and ONE contribution, the tip $6 ⇒ COMP(S6) = 10 + 6 = 16 = S6.value ⇒ AGREES ⇒ value $16 (the intermediate S4 never contributes; the cover is re-tested once at the new last effective cover). (xiv) two distinct baselines, different seqs (v23, finding 6; narrowed v25, cycle-18 finding 3 — 'redundant' holds ONLY with no contribution between the markers, see vector (xx)): baseline@1, baseline@2, delta@3 $4 ⇒ value $4 (no contribution sits between the markers, so the lower one changes no anchor and no sum) BUT the fold raises the deterministic ADVISORY WARNING `baseline-cardinality` (v24, cycle-17 finding 4 replacing v23's needs-owner flag: advisory only — surfaced in the acceptance report, never a needs-owner condition, never a closure blocker; the component is CLOSED-CLEAN with the warning surfaced); two markers at ONE seq ⇒ the general fold collision unknown (vector (x) with the baseline as the second identity). (xv) pre-anchor delta does NOT double-count (v24, cycle-17 finding 1): S1 cum $10 @1, S2 delta $2 @2, S3 cum $12 @3, S4 delta $3 @4, S5 cum $15 @5, S6 `correctionOf:"S4"` delta $5 @6, S7 `correctionOf:"S5"` cum $17 @7 ⇒ blocked chain S4 (tip $5, blocked by S5); anchor A = S3 ($12, the last cumulative below seq 4); interval (3,7) holds ONE contribution, the tip $5 ⇒ COMP(S7) = 12 + 5 = 17 = S7.value ⇒ AGREES ⇒ value $17 — S2 sits BELOW the anchor, is inside V, and is never added again (v23's sum-everything-below-COMP would have computed $19 and accepted a $19 cover). (xvi) mid-interval cumulative blocks agreement (v24, finding 1): as (xv) but with an effective cumulative S6b $14 @7 between the anchor and the cover (S7 moves to @8) ⇒ the interval (seq 3, seq 8) contains BOTH the tip delta (at the target's own seq 4) and the observation @7 ⇒ agreement INCOMPUTABLE ⇒ UNRESOLVED UNKNOWN (fail closed; never summed across an observation). (xvii) no-cover → chain extension → new cover, one replay (v24, cycle-17 finding 6; REWRITTEN v25, cycle-18 finding 1 — v24's opening had an owner reconciliation 'remove S3 from the effective set', but the reconciliation schema carries NO statement identity and NO removal operation, and it never overrides a known ledger amount, so that transition was INEXPRESSIBLE and is WITHDRAWN; no deletion authority is added; the replacement opens on a stream that NEVER held a cover, reaching the same states by provider records alone; SEQs RENUMBERED DENSE v26, cycle-19 finding 3 — v25's raw positions {1,2,4}, {1,2,4,6}, {1,2,4,6,8} carry missing interior positions the dense-sequence gate forbids, so every stage claimed a value the gate would have refused; arithmetic unchanged): S1 cum $10 @1, S2 delta $2 @2, S3 `correctionOf:"S2"` delta $5 @3 (occupancy {1,2,3} contiguous) ⇒ no REAL effective cumulative with seq > 2 exists (S1 sits below the target) ⇒ the coverage rule ACCEPTS the correction; the tip $5 is APPLIED at the target's own seq 2, anchored by S1@1 (F2), value CAND(S1) = 10 + 5 = $15; chain extension S4 `correctionOf:"S3"` $6 @4 (occupancy {1,2,3,4}; still no cumulative above seq 2) re-normalizes the chain to tip $6 at seq 2 → value $16 (the tip's single placement at seq 2 is used by coverage, anchoring and value alike — v23's two placement rules could not both hold here); a later cumulative S5 $16 @5 (occupancy {1,2,3,4,5}; a fresh statement, not a correction) re-covers the chain: the set replays with the tip blocked by S5 and the absorption test runs — A = S1@1, interval (1,5) contains the tip $6 → COMP(S5) = 16 = S5.value ⇒ AGREES ⇒ value $16; had S5 carried $15, disagreement keeps the unknown (one rule at every state, no arrival order read). **Reconciliation vs later provider evidence (v25, cycle-18 finding 1; precedence MADE TOTAL v26, cycle-19 finding 4 — see the "Effective value with a reconciliation chain" rule above for the full case analysis):** an owner reconciliation resolves the COMPONENT's unresolved value to its accepted amount under the known-spend floor; it is NOT a graph operation — it removes, mutates or rewrites no observation (the fold always replays the FULL raw record set); while the raw set folds UNKNOWN the chain tip is the component's value, and when the raw set folds CLEAN at R the effective value is max(R, tip) — a later agreeing fold lifts the value forward above the tip, a clean fold BELOW the tip never lowers it. (xviii) two blocked chains, one restated cover (v24, cycle-17 finding 1; SEQs RENUMBERED DENSE v27, cycle-20 finding 1 — v24 supplied raw positions {1,2,3,4,6,7,8}: seq 5 missing, an interior gap the dense gate forbids while the vector claimed $19): S1 cum $10 @1, S2 delta $2 @2, S3 delta $3 @3, S4 cum $15 @4, S5 `correctionOf:"S2"` $5 @5, S6 `correctionOf:"S3"` $4 @6, S7 `correctionOf:"S4"` cum $19 @7 ⇒ occupancy {1,2,3,4,5,6,7} contiguous; chains S2 (tip $5 @2) and S3 (tip $4 @3), both blocked by S4; lowest blocked position 2 ⇒ A = S1@1, V = 10; S4 is REPLACED (removed from the effective set, so no mid-interval observation); interval (1,7) holds BOTH tips and no other cumulative ⇒ COMP(S7) = 10 + 5 + 4 = 19 = S7.value ⇒ AGREES ⇒ value $19 (a $18 or $20 cover disagrees). (xix) baseline anchor (v24, cycle-17 findings 1+3): baseline marker $0 @0, S1 delta $2 @1, S2 delta $3 @2, S3 cum $5 @3, S4 `correctionOf:"S1"` $4 @4, S5 `correctionOf:"S3"` cum $6 @5 ⇒ chain S1 (tip $4 @1) blocked by S3; A = the baseline @0 (a baseline marker IS a valid COMP anchor — anchoring, not covering), V = 0; interval (0,5) holds the tip $4 and the uncorrected S2 $3 ⇒ COMP(S5) = 0 + 4 + 3 = 7; S5.value = $6 disagrees ⇒ UNRESOLVED UNKNOWN; the same stream with S5 cum $7 agrees ⇒ value $7. (xx) intervening contribution defeats lower-baseline redundancy (v25, cycle-18 finding 3): B1 $0 @1, D delta $2 @2, B3 $0 @3, D4 delta $4 @4 ⇒ D anchored by B1 (strictly above it), D4 anchored by either marker; BOTH markers participate in monotonicity: CAND(B1) = 0 + 2 + 4 = 6, CAND(B3) = 0 + 4 = 4 ⇒ a later marker's CAND is BELOW an earlier one's ⇒ UNRESOLVED UNKNOWN (v24's blanket 'removing the lower marker changes no anchor and no sum' would have predicted $4 — WITHDRAWN; removing B1 would also leave D unanchored); the `baseline-cardinality` warning (one stream-level warning, sorted marker list [B1, B3]) stands alongside the unknown without causing or curing it. (xx-ctl) control with NO contribution between the markers (v25): baseline@1, baseline@2, delta@3 $4 ⇒ CAND(1) = 4, CAND(2) = 4 ⇒ non-decreasing ⇒ value $4 (the no-intervening-contribution case where removal genuinely changes nothing). (xxi) baseline observer does not cover but monotonicity still rules (v25, cycle-18 finding 2): B0 $0 @0, D delta $2 @1, B2 $0 @2, D′ `correctionOf:"D"` delta $4 @3 ⇒ no REAL cumulative above seq 1 survives ⇒ the covering predicate says D′ is ACCEPTED (B2 covers nothing — the unqualified v24 'no EFFECTIVE cumulative' text read B2 as a blocker and diverged); the tip $4 applies at seq 1 anchored by B0; monotonicity is still evaluated over the observers: CAND(B0) = 0 + 4 = 4 while CAND(B2) = 0 ⇒ decreasing ⇒ UNRESOLVED UNKNOWN fail closed (the provider's own zero assertion above a nonzero contribution is self-contradictory — the REAL-only coverage fixes the branch, never the value; RE-RUN AGAINST THE FULL PIPELINE v26, cycle-19 finding 1: occupancy {0,1,2,3} contiguous — P3 passes — and P4 places the corrected value at the TARGET'S seq 1 (the unified per-kind placement rule), so the pipeline yields the SAME unknown this vector states — the withdrawn v25 pipeline reading ('correction's own seq') would have placed $4 at seq 3, both observer CANDs 4, and returned $4 in contradiction). (xxii) same-value correction keeps its node (v25, cycle-18 finding 4): baseline $0 @0, D delta $2 @1, C `correctionOf:"D"` delta $2 @2 (same value, DIFFERENT provider identity), E `correctionOf:"C"` delta $5 @3 ⇒ C is a same-value correction: DISTINCT graph node, NOT deduplicated (identity dedup fires only on same-identity redelivery — deleting C would strand E's target and hold the chain); chain {D, C, E} normalizes to tip $5 @1, anchored by the baseline @0 (strictly below), no REAL cover above ⇒ value CAND(baseline) = $5 (had C been folded away, E would be HELD and the stream unknown — the withdrawn reading); redelivery of C byte-identical under the same identity dedups to a no-op: tip stays $5, value $5. (xxiii) same-value siblings with divergent descendants (v26, cycle-19 finding 2): baseline $0 @1, D delta $2 @2, C `correctionOf:"D"` delta $2 @3, E `correctionOf:"D"` delta $2 @4 (same-value siblings ⇒ ONE merge class {C,E}), F `correctionOf:"C"` delta $5 @5, G `correctionOf:"E"` delta $6 @6 ⇒ F and G are corrections of the SAME merge class with DIVERGENT values ⇒ CONTRADICTION ⇒ UNRESOLVED UNKNOWN (the class rule fires — the contract never silently selects $5 or $6; every raw record stays retained as evidence; resolution needs an owner disposition citing F and G). Companion (xxiii-ctl): same stream with G delta $5 (same value as F) ⇒ one class, one tip $5 at D's own seq 2, anchored by the baseline @1, no REAL cover above ⇒ value $5 (no contradiction, no fork). (xxiv) mutual same-value pair is a cycle, not a merge class (v26, finding 2): A `correctionOf:"B"` delta $2 @1, B `correctionOf:"A"` delta $2 @2 (same value, distinct identities) ⇒ the cycle check precedes class formation ⇒ correction CYCLE contradiction ⇒ UNRESOLVED UNKNOWN (the same-value restatement rule never absorbs a mutual pair; both records retained). (xxv) sibling redelivery is a no-op (v26, finding 2): stream (xxiii-ctl) then E redelivered byte-identical under E's identity ⇒ identity dedup no-op (redelivery is not a new class member) ⇒ class {C,E}, tip $5, value $5 unchanged.
     **Null-sequence precedence — ONE rule (v9, c7-B2; pipeline
     pinned v10, c8-M6; stages RENAMED P0–P4 v29, C22-M2 — the
     pipeline and the enclosing fold rules F1–F5 above are distinct
     numbering systems and every cross-reference names its system
     explicitly):** the fold evaluates a per-stream PIPELINE
     over IMMUTABLE raw records: (P0) PARSE — structural validation
     only (presence, types, S5 envelope, §14.3 log-then-act); every
     form-valid raw record OCCUPIES its own `statementSeq` position
     at the instant it is accepted, REGARDLESS of its correction
     status (a correction-of-future-target is accepted-and-HELD,
     not refused; same as every other raw record, it stays in the
     set). (P1) collect raw statements (deduped by identity, fold
     rule F1's redelivery rules);
     (P2) build the correction graph on the PARSED records of the
     prefix and compute the EFFECTIVE statement set by replacement
     in the graph. A graph edge whose TARGET is absent is HELD —
     it contributes no placement, but the record REMAINS in the raw
     set at its own seq (v28, C21-M2 — the HELD state is a graph
     status, never a removal from occupancy). Only AFTER the graph
     is resolved does the fold run (P3) GAP-CHECK over the occupancy
     of the accepted raw set and (P4) ORDER/VALUE — so a graph
     resolution never outruns the gate: a resolvable chain on a
     gapped prefix is STILL unknown under P3. **Sequence occupancy vs effective-value placement are
     SEPARATE (v17, cycle-11 audit finding 3 — v15 said the corrected
     statement "leaves the set" while its seq position "stays CLAIMED
     by the correcting record", yet the correction also carries its
     OWN `statementSeq`: one effective statement occupying two
     sequence positions was never defined, and either reading breaks
     — claiming only the target's seq exposes an apparent gap at the
     correction's own seq when a later statement lands; claiming only
     the correction's seq erases the target's):** EVERY accepted RAW
     statement (corrections included) permanently OCCUPIES its own
     `statementSeq` in the stream — occupancy is a property of raw
     identities only; replacement NEVER vacates, moves, or
     double-books a sequence position. Replacement affects VALUE
     placement only — and placement is PER TARGET KIND (v26,
     cycle-19 finding 1, restating the unified rule of F3
     above): the target's value leaves the applied set; a correction
     of a CUMULATIVE enters at the CORRECTION'S OWN SEQ POSITION
     (with its own `(statementSeq, providerStatementId)` sort key),
     while a correction of a DELTA is folded by chain normalization
     into a single synthetic contribution AT THE TARGET DELTA'S OWN
     SEQ (below), so the P4 ordering key is the target's seq for
     delta chains and the correction's own seq for cumulative
     replacements. (P3) gap-check the RAW
     OCCUPANCY set (every accepted raw statement's seq, including
     every correction's and every superseded target's) for
     contiguity over [minOccupiedSeq..maxOccupiedSeq] — so a
     correction can never hide a gap AND never creates a phantom
     one; (P4) order effective statements by their PLACEMENT position
     `(position, providerStatementId)` — the target's own seq for a
     delta chain's synthetic contribution, the record's own seq
     otherwise (v26: the v17/v25 parenthetical 'the correcting
     record sorts at its OWN seq' held only for cumulative-target
     corrections and contradicted the delta rule; WITHDRAWN as the
     general statement) — and apply; the null-seq set is applied within (P4) per the
     precedence rule below. Fixtures (v20, normative; supersede v18 (i)/(i-b), whose stated values the monotonicity rule forbids, cycle-13 finding 1): (i) contiguous stream with correction — S5($20 cum), S6($21), S7($22), S8 `correctionOf:"S5"`($2): occupancy {5,6,7,8} contiguous, no gap; effective set {S6 21@6, S7 22@7, S8 2@8} ⇒ CAND 21, 22, 2 decrease ⇒ UNRESOLVED UNKNOWN (release and clean closure refused until an owner reconciliation or further correction resolves it); (i-b) same stream with S8 `correctionOf:"S7"`($2): effective {S5 20@5, S6 21@6, S8 2@8} ⇒ 20, 21, 2 ⇒ UNRESOLVED UNKNOWN; (ii) held-correction-of-held-correction — RENUMBERED DENSE v28, cycle-21 finding 2 (the v20 form carried raw positions 5, 8, 11 with interior gaps 6–7 and 9–10, so the dense gate the vector teaches made the component UNKNOWN before the graph ever ran — graph resolution was stated while the stream example itself violated P3): S1 cumulative $8 @1 arrives first: occupancy {1}, contiguous ⇒ density passes; the fold has exactly one observation ⇒ value $8 (the component is terminal-capable here — but NOT releasable on value alone, see the release-prerequisite rule below). S2 `correctionOf:"S1"` cumulative $2 @2 arrives: occupancy {1,2}, contiguous; chain {S1, S2} applies (cumulative target ⇒ correction's own seq): effective {S2 $2 @2} ⇒ value $2. S3 `correctionOf:"S2"` cumulative $11 @3 arrives: chain extends to {S1, S2, S3}, tip S3 at its own seq 3 ⇒ effective {S3 $11 @3} ⇒ value $11. Held state taught by staged prefixes, not by gaps: when ONLY S3 has landed (S1 absent), S3's target S2 is itself ABSENT ⇒ S3 is HELD — and S2 is in turn HELD for absent S1 — so the prefix {S3} has no effective observation and the component folds UNRESOLVED UNKNOWN; when S2 lands, the S1 leg is still held; when S1 lands the whole chain re-plays in one deterministic fold (occupancy {1,2,3}, S2 replaces S1 at seq 2, S3 replaces S2 at seq 3) — partial chains never fold half-applied (one total function over the full prefix). Records
     with `statementSeq:null` are NOT interleaved into the seq order
     at all: they form a separate pending set with a single
     precedence rule — a null-seq statement
     contributes its value ONLY while the component has no accepted
     sequenced value yet, and ANY accepted sequenced statement
     supersedes every pending null-seq statement for that component
     (the v8 text said null-seq sorts "after every sequenced record"
     in P4 while P5 said the sequenced statement "replaces"
     it — under one lock those orderings could disagree; here the
     rule is value-level: sequenced wins, definitionally, no sort
     involved). **LATE null-seq (v10, c8-M6; REPLACED v11, c9-B1 —
     the v10 "non-contributing AND non-degrading" rule let a late
     independent charge vanish: a $10 sequenced cumulative plus a
     late null-seq per-request $5 with NO inclusion evidence closed
     clean on $10 though the known evidence may represent $15 —
     absence of inclusion proof is never proof of inclusion):**
     a null-seq statement arriving when the component ALREADY has an
     accepted sequenced value contributes ONLY under ONE of: (i)
     **inclusion evidence** — provider-backed proof that the
     accepted cumulative already accounts for this request (the
     cumulative's covering session/statement demonstrably enumerates
     the request's identity, or the provider statement itself states
     inclusion): then the late statement is non-contributing (it is
     already in the number), AND non-degrading (it proved it is not
     new spend); OR (ii) **independence evidence** — provider-backed
     proof the request is NOT in the cumulative: then it folds as
     additive spend (the standing projection rules apply); OR
     (iii) NEITHER (the default): the late statement may be neither
     added nor dropped, so the COMPONENT becomes unresolved unknown
     (fail closed: money whose inclusion status is unknown is
     unknown money), degrading the boundary per the unknown rules —
     and it interacts with gaps the same way: a late statement on a
     stream with an open sequence gap lands UNKNOWN-side of that gap
     (v10 wording retained for the gap case). The "second null
     cumulative ⇒ unknown" trigger continues to count null-seq
     cumulatives in the PENDING set only. Conformance vectors
     corrected (v11, c9-B1): `seq 7 = $10; LATE null-seq $5 with
     inclusion proof ⇒ $10, clean` (case i); `seq 7 = $10; LATE
     null-seq $5, no evidence ⇒ component UNRESOLVED UNKNOWN` (case
     iii — the v10 vector claiming "non-degrading, clean" is
     WITHDRAWN); `seq 7 = $10; LATE null-seq $5 with provider-attested
     non-inclusion ⇒ $15` (case ii). Only
     delta-mode or single-value per-request records
     may carry null; a SECOND null-seq cumulative PENDING on the same
     component ⇒ unresolved unknown. A single accepted null-seq
     cumulative degrades to "value known at < seq ∞": it blocks CLEAN
     closure (an unaugmented ∞-value is never clean-final); it is
     replaced — and the block lifted — when a sequenced statement
     lands for that stream.
     **Gap resolution (v10, c8-M6 — a gap must be closable without
     erasing the fault):** a sequence gap makes the component an
     unresolved unknown (above); the unknown resolves by EITHER (i)
     the missing statement(s) arriving (the fold re-derives total
     and the gap simply no longer exists in the new prefix — no
     erasure needed: the fault is derived, never stamped), OR (ii)
     ONE owner `spend-reconciliation` for that component with
     `providerRecovery` proving the missing statement is
     unrecoverable (the one-time reconciliation rule applies — the
     gap unknown is an ordinary component unknown and consumes the
     ordinary resolution route; no gap-specific record kind
     exists). Until resolved, the gap blocks clean closure and
     admission per the unknown rule and is reported in every
     boundary's standing notes (component, stream, missing seq
     range) so a long-lived gap stays visible, never silently
     carried.
  F4. Collision rules: two records, same stream and `statementSeq`,
     same identity ⇒ dedup (idempotent); same seq, DIFFERENT
     identity ⇒ the fold REFUSES the sequence AND the affected
     component becomes an unresolved unknown until an owner
     disposition — "refused malformed" alone never leaves a stale
     value standing (v8).
  F5. UNRESOLVED UNKNOWN is the single failure mode of the fold: any
     contradiction, collision, unanchored delta, same-identity value
     conflict, sequence gap (above), or held correction unresolved at
     close ⇒ that component is `unknown` — it consumes admission
     headroom per the unknown-spend rule (no admission while unknown)
     and blocks clean closure; it is never silently dropped and never
     folded by arrival order. Ordering is unavailable from a provider
     at all ⇒ the component is `unknown` likewise.
     **Recovery-record stream placement (v28, C21-M4 — the inventory
     field list (14.12.4b) is the normative shape; `providerAccountId`
     is REQUIRED there):** `usage-recovered` names the same billing
     stream as the record it recovers — its stream identity is
     `(providerAccountId, dispatchOf(targetId))` EXACTLY like a
     provider `usage-late-arrived` statement on that stream
     (14.13.4a sequence-domain paragraph), and it folds by P3's
     dense occupancy rules (a recovery at a not-yet-occupied seq
     lands UNKNOWN-side until the stream is dense — a recovery
     never BYPASSES the gate). It is NOT a separate namespace:
     identity/dedup are the same rule as every stream statement
     below (`(dispatchId, providerRequestRef, providerStatementId)`,
     idempotent redelivery, same-identity-different-usd refused
     malformed); producer: supervisor (the only writer that talks
     to provider APIs).
  **Fold conformance vectors (v9, c7-B2; corrected v10, c8-M6;
  RE-Corrected v11, c9-B1):**
  the contract's test suite ships executable fold fixtures —
  gap-before-boundary (unknown, not max-accepted), null-seq
  cumulative then sequenced (sequenced wins), **sequenced then a
  LATE null-seq cumulative (v11 c9-B1 three-case vector: WITH
  provider-backed inclusion evidence ⇒ non-contributing, non-
  degrading, clean; WITH provider-backed non-inclusion evidence ⇒
  additive spend; WITH NEITHER ⇒ component UNRESOLVED UNKNOWN — the
  v10 "always non-degrading" vector claimed the third case was
  clean, which let an unproven $5 disappear behind a $10 cumulative;
  that vector is WITHDRAWN)**, same-identity different-value (component
  unknown, old value does NOT stand), correction chain and correction
  cycle, delta-stream with and without baseline marker —
  a fold implementation that disagrees with any vector is a defect,
  not an interpretation.
  Identity & dedup (v6,
  c4-M9):** `providerStatementId` = the provider statement/billing-
  document id the usage came from (per-request records use
  `"req:<requestId>"`); record identity is
  `(dispatchId, providerRequestRef, providerStatementId)` — a redelivery
  of the same identity is IDEMPOTENT (ignored, never double-added), a
  SAME identity with different `usd` is refused malformed. `mode:
  "cumulative"` statements REPLACE the prior component value once
  (last-write-wins per dispatch, per statement sequence); `mode:
  "delta"` records add. **Projection formula (v6):** spent(cycle) =
  Σ over dispatches of (current accepted value of each leaf component
  after applying its latest cumulative statement or the sum of its
  deltas) + cycle-level component — "purely ADDITIVE" applies to
  DELTA-mode records only; a cumulative statement replacing an accepted
  value can move spent DOWNWARD (a provider correction), and that is
  the measured-beats-accepted rule, not a contradiction. Producer:
  supervisor (the only writer that talks to provider APIs); recovery
  records (`usage-recovered`) use the same identity rule
  (placement + stream binding pinned v28, C21-M4 two paragraphs
  above).
  **A verdict already recorded is never rewritten or
  un-recorded** (append-only) — instead the NEXT boundary's recurrence
  reads true totals, and if the added spend makes the loop need a cycle
  it cannot afford, that boundary is `budget-exhausted` (even past a
  prior `converged` streak: convergence of round n does not
  pre-authorize round n+1's money). A converged closure stands as a
  fact about correctness; spending truth extends forward only. If the
  late usage targets a component the owner already reconciled, it
  REPLACES the accepted value (the reconciliation record gets exactly
  one `supersedes`-linked correction, marked
  `measured-overrides-accepted`; the floor rule is one-directional: a
  MEASURED value always beats an accepted estimate, up or down).
  **Interval end is not retroactively moved** (billing evidence ≠
  wallclock).
- **Provider-request terminality, not process death (v5, c3):** local
  liveness (pid+start-time, ABA-checked against boot id) proves the
  PROCESS stopped, not the provider request. Close additionally
  requires per-dispatch provider-request evidence: usage records
  terminal for all requests the dispatch issued per its request ledger
  (below), OR a provider cancel/terminal confirmation, OR the
  provider's usage-statement window having closed past the dispatch's
  end (billing cutoff).
  request inventory (v7, c5-M9):** the empty set must be PROVEN, not
  vacuous: every dispatch allocates a durable `dispatch-intent` record
  BEFORE any provider call (fields `{ dispatchId, cycleId,
  sessionId, authorizedAt }`, log-then-act §14.3), and the provider
  session id is minted only at intent time — a provider call with no
  intent record is a contract violation reported as an unresolved
  unknown. Close's inventory check is set-equality: the provider's
  session query result (requests observed under the session id) must
  equal the recorded request ledger for the dispatch (every issued
  request appended at issue time, content-addressed from the provider
  response id); a session query that cannot be shown complete (the
  provider exposes no exhaustive listing, or the query is partial/
  truncated) proves NOTHING — terminality stays unknown (fail closed).
  **Intent lifecycle & uncertain-call recovery (v8, c6-M10; per-call
  identity v9, c7-M5):** one `dispatch-intent` may cover MULTIPLE
  provider calls (retries, paging, multi-request dispatches), so the
  unit of the lifecycle is the CALL, not the intent. Every call has an
  immutable **`callId`** = content address of
  `("call", dispatchId, attemptNumber)` — `attemptNumber` is a
  per-dispatch dense counter starting at 1 assigned by the supervisor
  dispatch lane under the S5 lock BEFORE the call begins. Each phase
  transition is its own durable append with a CLOSED record schema
  (producer: the supervisor dispatch lane; validator: the same lock
  path — no other producer is permitted):
  `intent-phase { id, ts, dispatchId, callId, attemptNumber, phase,
  idempotencyKey|null, retryOfCallId|null, requestDigest|null,
  evidenceRef|null, outcome|null }` (v10,
  c8-M15: the CLOSED discriminated schema carries `outcome` in every
  intent-phase record — REQUIRED non-null exactly when `phase ==
  "call-settled"` with `outcome ∈ { issued | no-call |
  proven-not-issued | superseded-attempt }` (v13, audit finding 1: the closed enum must express the §14.13.4a coverage-fold settlement). `superseded-attempt` is REQUIRED for the settlement of a lineage attempt that is NOT the lineage's settled attempt (any position, head included) and REFUSED for a callId whose lineage has no settled attempt; the settled attempt settles `issued | no-call | proven-not-issued` as before. REQUIRED null for `intent-open` and
  `call-started`; v9's field list omitted `outcome` from the schema
  while its rules required it — validators and producers disagreed
  on the wire shape. **v12 audit fix (same defect class, same
  field):** the c9-M6 retry-lineage rules below name `retryOfCallId`
  and the canonical request digest as rules on `call-started`, but
  the closed schema above did not carry them — a conforming
  validator refused every lineage record the rules required. They
  now JOIN the closed schema with pinned placement: both keys are
  REQUIRED PRESENT exactly when `phase == "call-started"`
  (omitting either key is malformed; `retryOfCallId` is `null` for
  a lineage HEAD and the preceding attempt's `callId` otherwise;
  `requestDigest` is never null on `call-started`) and REQUIRED
  null for `intent-open` and
  `call-settled`. No field may ever be rule-referenced in body text
  without being in the closed schema — an append-only add, this and
  no other.) `phase ∈ { intent-open | call-started |
  call-settled }`. **Canonical `callId` encoding & collision domain
  (v10, c8-M15):** `callId` = sha256 over the canonical encoding
  (tre-canonical-json/1) of `["call", dispatchId, attemptNumber]`
  hex — content-addressed, so the SAME (dispatchId, attemptNumber)
  pair can never produce two different callIds, and a restart
  resumes by recomputing ids from the dense counter recovered from
  the prefix (the highest durable `attemptNumber` for the
  dispatchId + 1); a collision between a NEW callId and an existing
  one is impossible by construction (dense counter), and one
  observed anyway ⇒ history-integrity-fault, fail closed.
  **Idempotency-key placement (v10, c8-M15; uniqueness domain
  RE-PINNED v11, c9-M6 — v10 pinned uniqueness per
  `(providerAccountId, idempotencyKey)` across the episode WHILE its
  own crash rule (window ii) declared "a retry with the SAME
  `idempotencyKey` under a NEW `callId` is legal": the second
  `call-started` carrying the reused key violated the uniqueness
  rule, so idempotent retry was simultaneously required and
  forbidden):** uniqueness is **per LOGICAL PROVIDER OPERATION, not
  per call attempt** — the durable identity is
  `(providerAccountId, idempotencyKey)` naming ONE logical operation;
  multiple `call-started` records MAY share a key iff they form a
  **retry lineage**: each `call-started` after the first for a key
  carries `retryOfCallId` naming the immediately preceding attempt
  (chain head: `retryOfCallId:null`), the chain is linear (no
  branch — two `call-started` with the same `retryOfCallId` ⇒
  history-fault), and ALL attempts in one lineage MUST carry
  byte-identical request semantics (the canonical request digest is
  a field of `call-started`; a lineage member with a different
  digest ⇒ refused at validation — a different request under the
  same key is a NEW logical operation and needs a NEW key).
  Validator rule: group `call-started` by key ⇒ exactly one lineage.
  Settlement and billing dedup: the lineage folds to ONE provider
  request — usage ledgered once against the lineage (the settled
  attempt's evidence), the other attempts settle
  `superseded-attempt` (no separate charge), and a lineage with TWO
  independently ledgered charges is an unresolved unknown (double
  spend — the exact thing the key exists to prevent). **Coverage
  fold for superseded attempts (v12 audit fix — the set-equality
  check below quantifies over "the COMPLETE request set per
  stream", which previously left superseded attempts undefined:
  counted, they would demand provider evidence for requests that
  (deduped) were never made; uncounted, the check's domain was
  unstated):** for coverage purposes the request set contains
  EXACTLY ONE element per lineage — its SETTLED attempt — with the
  lineage head's `idempotencyKey` as its identity; superseded
  attempts are excluded from the provider-facing set (the provider
  saw one request) and are NEVER removed from the log or the
  callUniverse (they remain addressable records; a zero-usage
  statement attributed to a superseded attempt is ignored, not
  folded). A superseded attempt that later shows independent
  provider-side evidence of delivery is the two-charges case above
  (unresolved unknown), not a re-count. **Lineage-settlement
  evidence scoping (v14, audit finding 2):** a LOCAL (non-provider)
  negative attestation may settle a lineage as `no-call` /
  `proven-not-issued` ONLY when NO attempt in the lineage reached
  `call-started` — an attestation about one attempt is never evidence
  about its siblings, so if any earlier attempt entered
  `call-started`, closing the lineage on a local attestation is
  REFUSED; the settlement then requires provider-side evidence keyed
  to the lineage's `idempotencyKey` (the c8-B3 query covers the whole
  lineage because providers dedup on that key), and absent it the
  lineage is an unresolved unknown exactly as before.
  Assigned BEFORE the socket opens and carried verbatim to
  the provider — the no-call evidence rule (c8-B3) queries on
  exactly this key. Validation rules (v9, c7-M5): the FIRST phase
  record for a `callId` MUST be `intent-open`; phases for one `callId`
  are strictly ordered, each recorded ONCE (`call-started` twice for
  one callId ⇒ history-fault); `call-settled` requires its
  `callId`'s `call-started` OR a `no-call` attestation as below; a
  phase record naming an unknown `dispatchId` or a non-dense
  `attemptNumber` is refused. The inventory the set-equality check
  consumes is the per-CALL set: close enumerates every `callId` in
  the dispatch's prefix and requires each settled `issued` to have a
  ledgered request content-addressed to its provider response id.
  Crash windows: (i) crash after `intent-open`, before any
  `call-started` — restart MAY settle it `no-call` only on a durable
  negative attestation **whose evidence source is named and
  independent: the supervisor's own word is not evidence under the
  doctrine (v9, c7-M5) — a `no-call` settlement requires
  `evidenceRef` naming EITHER (a) provider evidence that the session
  contains no request for that `callId`'s idempotency key / session
  window, OR (b) a crash artifact from an INDEPENDENTly enforced
  durable fence (v10, c8-B3): the contract's alternative is a
  LOG-BEFORE-SOCKET FENCE whose state is durable OUTSIDE the crashing
  process (the OS/session-manager connection ledger, or the
  provider-side session listing), and it proves no-call only when
  the fence's own coverage proves no outbound connection for that
  session window crossed the fence boundary before the crash. The
  v9 phrasing "the intent append fsynced and no outbound-connection
  record durable" is RETRACTED (v10, c8-B3): absence of a record
  written BY the crashing process is exactly the pre-call-crash
  case — the process may have opened the socket and died before
  logging it, and the provider can still execute and bill the
  request. Absence of the crashing process's own records is NEVER
  negative evidence; only an independent authority's COMPLETE record
  set (naming its coverage window) can prove the socket was never
  opened**; absent
  such evidence the phase stays uncertain, interval
  OPEN — fail-closed forever absent provider cooperation is the
  ACCEPTED outcome, stated honestly (v9, c7-M5): `no-call` without
  independent evidence is not derivable and the contract does not
  pretend otherwise; an `intent-open` with no `call-started` and no
  attestation is NOT no-call — it stays uncertain, interval OPEN;
  (ii) crash after
  `call-started`, before the response id lands — the call is
  UNCERTAIN: recovery MUST NOT mint a new session and re-issue blindly
  (double-spend); the call enters `uncertain-call` and resolves
  ONLY by provider-side evidence — a session query showing the request
  (ledger gains the request retroactively, content-addressed, with an
  `observed-unledgered` flag) or provider idempotency-key support
  (v8: where the provider supports an idempotency key, the supervisor
  mints it AT intent time and records it in the intent, so a retry is
  provably not a second charge; v9, c7-M5: the key is carried on the
  `call-started` phase record's `idempotencyKey` — a retry with the
  SAME `idempotencyKey` under a NEW `callId` is legal and deduped to
  one provider request; a retry with a DIFFERENT key is a new charge
  and must ledger separately); else `proven-not-issued` requires
  provider evidence the session contains no such request. A retry
  under a NEW session is permitted only from a `proven-not-issued`
  settlement. (iii) a provider query reveals a request absent from the
  ledger — the set-equality check FAILS toward reconciliation: the
  request is ledgered retroactively with evidence refs (and bound to
  its `callId` where identifiable — an unbindable observed request is
  an unresolved unknown, v9, c7-M5) and the
  interval stays OPEN until its usage is terminal (an observed-but-
  unledgered request is reconciled, never ignored). **Retention
  (v8, c6-M10):** `dispatch-intent`, `intent-phase` and request-ledger
  records (and their terminal evidence) are retained as long as any
  interval they
  touch is unresolved OR any replayable boundary's accounting depends
  on them; compaction may tombstone only evidence whose dispatch is
  terminal-proven and whose usage is folded and undisputed in every
  boundary since.
  Zero-dispatch closure = no `dispatch-intent` record exists for the
  cycle AND the intent stream is gap-free (intents are append-only
  under the S5 lock, so absence in the prefix is the empty-set proof);
  an intent with no matching terminal evidence keeps the interval
  OPEN. Unknown remote state ⇒ interval stays OPEN (fail closed); a
  configurable reconciliation cadence re-polls provider usage before
  admission is granted — **polling is not terminality: a poll that
  returns no terminal status neither proves nor discharges the
  interval (v6, c4-M8).** **Bounded escalation (v6, c4-M8):** the
  cadence runs only until `reconcileDeadlineS` (episode policy,
  §14.7; default 24h) after the close attempt; past the deadline the
  cycle enters `remote-terminal-unproven` (durable record:
  `{ kind:"remote-terminal-unproven", id, ts, cycleId, dispatchIds,
  lastEvidenceRef, deadline }`) — it STAYS fail-closed: unknown spend
  consumes headroom (14.13.2), no admission is granted. **Resolution is
  a DISTINCT typed owner disposition from `spend-reconciliation`
  (v7, c5-B3):** remote-execution TERMINALITY and unknown billing VALUE
  are separate unresolved conditions with separate records. A
  `spend-reconciliation` resolves only a missing VALUE (it accepts a
  number; it is NOT terminality evidence and does not unlock a
  `remote-terminal-unproven` close — validation refuses any close that
  treats a value acceptance as proof the request stopped). Terminality
  resolves ONLY by: (a) durable provider evidence of request terminality
  (usage records terminal / cancel confirmation / billing cutoff,
  appended as measured evidence); or (b) an owner **`remote-terminal-
  disposition`** record `{ kind:"remote-terminal-disposition", id, ts,
  cycleId, unprovenRecordId, dispatchIds[], disposition:"accept-
  residual-risk|evidence-provided", evidenceRefs[], residualCapUsd|null, acknowledgment|null, authority:"tty:…" (v13, audit finding 6: the record carries the same fields and null rules as the §14.10.3 owner-act payload)
  }` — vocabulary pinned to THESE two spellings (v8, c6-M6; the
  ledger's c5 shorthand "evidence-closed/accept-open-risk" is
  retired). **`unprovenRecordId` is REQUIRED (v9, c7-B4): a
  disposition binds to exactly ONE `remote-terminal-unproven` record
  — its `dispatchIds` must be a SUBSET of that record's `dispatchIds`
  and the covering set is computed PER unproven record, never across
  records.** **Derived per-dispatch coverage (v9, c7-B4):** the
  validating supervisor computes, for each `remote-terminal-unproven`
  record `U`, the coverage set = union of `dispatchIds` over all
  VALID dispositions citing `U`; the verdict predicate "a valid
  `remote-terminal-disposition`" is TRUE for `U` ONLY when that
  coverage set EQUALS `U.dispatchIds` as a SET (partial coverage —
  some dispatches of `U` covered, others not — leaves `U` UNRESOLVED
  in full: a valid disposition for `[A]` never satisfies a `U` naming
  `[A,B]`; B's unprovenness holds the whole record, because the
  close gate and budget headroom consume the derived state, not the
  presence of one disposition). A disposition naming ids OUTSIDE
  `U.dispatchIds`, or citing a nonexistent `unprovenRecordId`, or
  duplicating a prior valid disposition for the same
  (`U`, dispatch) pair with a DIFFERENT disposition kind ⇒ REFUSED
  at append (validator error, nothing lands). **Validity
  (v8, c6-M6; v9, c7-B4 coverage binding) — what "a valid
  disposition" means (the verdict-table reference resolves here):**
  **Coverage set — one derivation (v10, c8-M8; domain RE-PINNED v15,
  cycle-10 audit finding 5 — v10/v13 quantified coverage over raw
  callIds while the retry-lineage rule (c9-M6) kept superseded
  attempts in `callUniverse` but never in `issuedSet`/`provenNoCall`,
  so a fully-evidenced crash+retry could never reach
  `evidence-provided`: coverage is computed over the LINEAGE
  PROJECTION, with the superseded-attempt obligation carried
  separately):** the per-dispatch set the `evidence-provided` check
  consumes is DERIVED, not quoted: for each dispatch, `callUniverse`
  = every `callId` in the dispatch's prefix
  (`dispatch-intent`/`intent-phase` records) — including
  `intent-open` calls never started; project it:
  `logicalOps` = one element per retry lineage (c9-M6 — a lineage is
  the transitive closure of `retryOfCallId`; a callId with no lineage
  edge is its own singleton lineage; identity = the lineage HEAD's
  `idempotencyKey`, or the head's `callId` where no key exists);
  `issuedSet` = lineages whose SETTLED attempt is settled `issued`
  with a ledgered provider request (content-addressed);
  `provenNoCall` = lineages settled `no-call`/`proven-not-issued` on
  independent evidence (never absence — c8-B3; settlement per the
  c9-M6 lineage rule — local attestation only when NO attempt
  entered `call-started`). Coverage for the dispatch is TRUE iff
  (a) every member of `logicalOps` is in `issuedSet` with terminal
  usage evidence OR in `provenNoCall`, (b) the `issuedSet` ledger
  equals the provider's observed session set (c5-M9 set-equality,
  fresh evidence), (c) `logicalOps \ (issuedSet ∪ provenNoCall) = ∅`
  — an intent whose logical operation is neither issued nor
  independently proven not-issued defeats coverage no matter how
  complete the ledger for the others is, AND (d) EVERY SUPERSEDED
  attempt (a raw callId not the settled member of its lineage)
  belongs to a VALID SETTLED LINEAR LINEAGE (c9-M6: linear,
  byte-identical request digests, exactly one settled member whose
  disposition is in `issuedSet` or `provenNoCall`, no second
  ledgered charge) — a superseded attempt outside such a lineage is
  NOT projected away, it keeps its own raw-callId obligation and
  defeats coverage. Conformance vectors (v15): (i) crash/retry —
  attempt A `call-started` then crash, B same key settles `issued`
  with terminal usage, A settles `superseded-attempt` ⇒ coverage
  TRUE (one logical op, issued; A satisfies (d)); (ii) same shape
  but BOTH A and B independently ledgered charges ⇒ unresolved
  unknown (two charges on one lineage, c9-M6); (iii) superseded A
  whose lineage settlement is missing entirely ⇒ coverage FALSE via
  (d) and via (c) (the lineage is neither issued nor provenNoCall).
  **Zero-call dispatches are NOT vacuously covered (v11, c9-M8):**
  a `dispatch-intent` whose process crashed before ANY
  `intent-open` yields an EMPTY `callUniverse` — every per-call
  universal check then passes vacuously, and the v10 derivation
  called that coverage, though nothing proves the dispatch issued
  no request (the empty set must be PROVEN, not vacuous — an empty
  provider-session query is expressly insufficient evidence
  elsewhere in this section). A zero-call dispatch is covered ONLY
  by a **dispatch-level zero-call closure attestation**: a durable
  record `{ envelope, kind:"zero-call-closure", dispatchId,
  evidenceRef, fenceCoverageWindow }` (envelope kind added to
  §14.12.4b, v11; producer: supervisor dispatch lane) whose
  `evidenceRef` names EITHER (a) a provider session listing
  COMPLETE for the dispatch's session window (freshness per the
  freshness rule below; the listing itself must show zero requests
  in the window — provider-completeness is the provider's
  assertion, not a local query returning nothing), OR (b) the
  log-before-socket fence's own COMPLETE coverage of the dispatch's
  window (c8-B3 class (b) evidence at dispatch scope). Coverage for
  a dispatch with `callUniverse = ∅` AND no valid zero-call-closure
  record is FALSE (the disposition refuses; the fold's unknown
  component for that dispatch stands) — no clean boundary, no
  `evidence-provided` discharge, until closure is proven.
  - `evidence-provided`: for EVERY id in `dispatchIds`, `evidenceRefs`
    must name durable provider evidence that independently satisfies
    the c5-M9 set-equality rule and the coverage derivation above
    for that dispatch's COMPLETE call universe (a cancel
    confirmation for ONE request of a multi-request
    dispatch does NOT cover the dispatch — coverage is per-dispatch
    and complete, checked by the validating supervisor against each
    dispatch's request ledger); evidence must be FRESH (acquired after
    the `remote-terminal-unproven` record's ts — stale evidence cannot
    discharge a state that outlived it). Partial coverage ⇒ the
    disposition is REFUSED, the record is not appended.
  - `accept-residual-risk`: the owner explicitly accepts that requests
    of unknown remote state MAY STILL BE RUNNING. It closes the
    TERMINALITY question only — it NEVER proves terminality (records
    say "closed by owner risk acceptance", never "terminal"). **The
    residual-cap accounting state machine — ONE path (v10, c8-B4
    replaces v9's two contradictory rules):** `residualCapUsd` is
    declared, in the contract's own words, an **OWNER-ACCEPTED
    EXPOSURE ALLOWANCE, not a provider-enforced maximum** — nothing
    in the contract bounds what the provider may actually bill; the
    cap is the owner's authority to carry the unknown forward as a
    PROVISIONAL charge. Admission accounting, exactly one sequence:
    (1) on an accepted `accept-residual-risk` disposition, headroom
    is consumed by `residualCapUsd` as a **provisional component
    charge** (the loop may admit, having paid the owner's stated
    exposure); (2) provider statements arriving later fold NORMALLY
    against the same stream identity — but **only a TERMINAL,
    provider-complete statement may replace the provisional charge
    (v11, c9-B2 — the v10 rule "a measured cumulative that lands
    replaces the provisional charge (up OR down)" released the cap
    on a PARTIAL measurement: an accepted $10 residual exposure for
    a request that may still be running, followed by a $2 interim
    cumulative, replaced the $10 provisional and handed the loop $8
    of phantom headroom while the original request kept billing):**
    **the cap is held WHOLE — unit release only (v12, owner
    decision D2-b; supersedes the v11 leaf-by-leaf release):** the
    provisional charge is released as a UNIT, once, when EVERY
    covered leaf (every dispatchId in the disposition's coverage
    set) has terminal, provider-complete evidence (a statement the
    provider marks final, or a closed session listing proven
    complete) — no partial or per-leaf release exists. On that
    single transition the provisional component is replaced by the
    Σ of the leaves' measured terminal amounts, up OR down (a
    terminal $2 replacing an accepted $10 provisional is a genuine
    $8 return to headroom — that moment is the ONLY scheduled time
    headroom moves (v14, audit finding 5: "the ONLY time" was false
    as written — v13's heldUsd rule below also moves headroom the
    moment an observation exceeds the cap; scheduled release and
    over-cap observation are the ONLY two movers, and the release
    requires the complete terminal picture, which the v11 per-leaf
    rule could not guarantee: "terminal by its own
    statement" on one leaf while a sibling still billed mixed
    settled and live amounts into one aggregate). Interim
    measurements on any leaf are recorded as observations and NEVER
    reduce the provisional charge; the aggregate
    `residualExposureUsd` note equals `heldUsd` (v14, audit finding 5:
    the note tracks the CHARGE, so it equals `residualCapUsd` while no
    observation exceeds it, rises the moment `Σ effectiveLowerBoundUsd`
    exceeds the cap, and is the measured Σ after the unit release —
    one number, no divergence between what is charged and what is
    reported) while ANY leaf lacks terminal evidence. **No-observation state (v30, C23-F6):** a leaf with NO effective observation has `effectiveLowerBoundUsd` = NULL — a distinct state, never 0 and never an evidence value. The Σ_leaves in the formula below ranges over leaves whose bound is non-null (null terms are omitted; they contribute nothing); `residualCapUsd` carries the hold, and such a leaf is still open (no terminal evidence), so the cap-floor and unknown rules apply unchanged. Null imposes no lower limit in any interval test and satisfies no terminal-evidence test. **Held charge while leaves are open (v13, audit finding 5; ONE formula for every consumer, v15, cycle-10 audit finding 2 — admission, hold, exposure note and release share it; the pre-v15 admission sentence still named the uncorrected `observedLowerBoundUsd`, which disagreed with the contradiction branch's effective-bound rule):** every admission check uses `heldUsd = max(residualCapUsd, Σ_leaves effectiveLowerBoundUsd)`, where `effectiveLowerBoundUsd` (defined once, at F1 of the fold below, and replay-defined) is **the MAXIMUM over the leaf's EFFECTIVE observation values after correction-graph replacement (v17, cycle-11 audit finding 4 — a correction replaces its TARGET OBSERVATION in the graph, never "the bound": a leaf with uncorrected observations S1=$18 and S2=$20 whose S2 is validly corrected to $2 keeps the still-effective S1=$18 ⇒ bound $18, NOT $2 — replacing the bound wholesale erased a valid observation and would let release at $2 pass), recomputed from the prefix on every replay (observations are lower bounds, never releases; a correction HELD PENDING — its target not yet in the prefix — does NOT adjust the bound; the bound moves only when the correction is applied by the fold; cumulative-coverage interaction: a cumulative observation demonstrably covering an earlier one still counts independently toward the maximum — only a graph-accepted correction removes the value it names)**. Observed spend above the cap is charged AT ONCE through `heldUsd`; the cap is never added on top of observations, so nothing is double-counted, and the unit release replaces `heldUsd` by Σ terminal amounts — **with the known-spend floor enforced PER LEAF at release (v14, audit finding 1; per-leaf test + hold formula corrected v15, cycle-10 review findings 1–2: a v14 AGGREGATE test would let one leaf's excess mask another leaf's contradiction, and v14's "holds at Σ observedLowerBoundUsd" could drop the charge below the accepted cap):** the release test is per leaf, never on sums — leaf `i` may release only if its terminal amount is ≥ its OWN `effectiveLowerBoundUsd` as defined above (the max over its effective observations), WHERE A VALID CORRECTION RECORD (accepted by the correction-graph rules above — the correction carries its OWN statement identity and names the bound-setting record in `correctionOf`; a redelivered record under the SAME identity with a different value is NOT a correction, it is the same-identity conflict ⇒ unresolved unknown (v15, cycle-10 audit finding 1: v15's first wording demanded "same identity" for the displacement, which made the advertised displacement unimplementable — the graph only accepts a correction as a NEW identity pointing at its target), at-most-once per target, no contradiction; a loosely worded statement is never displacement evidence, only a graph-accepted correction is) REPLACES its target observation so the maximum is recomputed over the remaining effective observations (a provider correction attests the earlier observation was wrong; this is the ONLY route that LOWERS a bound — a bound set by a STILL-EFFECTIVE uncorrected observation never lowers (v17, cycle-11 finding 4 vector: S1=$18 + S2=$20, S3 corrects S2⇒$2 ⇒ v20: the effective set {S1 18@1, S3 2@3} violates monotonicity ⇒ UNRESOLVED UNKNOWN; the cap-hold bound stays $18 and release is refused on either ground); the owner `spend-reconciliation` route may still resolve the contradicted component per its own schema, but never accepts an amount BELOW a standing lower bound (reconciliation never overrides known spend, exactly as the schema above states (v15, cycle-10 finding 3: v14 offered reconciliation as the displacement alternative, contradicting it)); an owner who believes the terminal figure gets it by reconciling at ≥ the floor, never by silently releasing below it). COUNTEREXAMPLE VECTOR (v15, normative): leaf A bound $20 / terminal $2, leaf B bound $0 / terminal $30 — Σ terminal $32 ≥ Σ bounds $20 but leaf A's contradiction is unexplained: NO release; A stays non-terminal (unresolved unknown, needs-owner).
  **Bound-displacement vectors (v15, cycle-10 audit finding 1 — the correction identity is the correction record's OWN `providerStatementId` with its own `statementSeq` on the same stream `(providerAccountId, dispatchId)`, pointing at the bound-setting record via `correctionOf`; the redelivered-same-identity case is the graph's unresolved-unknown conflict, never a displacement; DENSE V28, cycle-21 finding 3 — the v15 forms carried raw positions {5,8} (vector a) and {5,8,11} (vector c) with interior gaps 6–7 (and 9–10), so under the P3 gate those prefixes fold UNKNOWN for density alone and "release is legal" was never established by the printed stream; each vector below carries its contiguous occupancy explicitly so the stated graph result IS the stated fold result):** (a) displacement — leaf bound $20 from statement S1 (cumulative $20) @1; provider later sends S2, `correctionOf:"S1"`, cumulative $2 @2, accepted by the graph (cumulative target ⇒ correction's own seq; occupancy {1,2} contiguous) ⇒ effective observations {S2 $2 @2} ⇒ `effectiveLowerBoundUsd` = $2 (the ONLY route that lowers a bound); graph displacement and the release gate are SEPARATE (v28: displacement rewrites the BOUND; release additionally requires the full terminal fold to be clean — dense prefix, terminal evidence for EVERY leaf, no open contradiction in any component — "release at terminal $2 is then legal" means the per-leaf bound test passes against the DISPLACED bound AND every other release prerequisite holds; a gapped prefix that displaces the bound still folds UNKNOWN and releases nothing). (b) held correction — the bound is ALWAYS the maximum over the effective observations ACTUALLY IN THE PREFIX — never a value remembered from an absent target (v29, C22-M3 — the v28 form said "the bound stays $20" over prefix {S2} while the definition (maximum over the leaf's effective observations replayed from the prefix) derives NO bound from a prefix containing none; the $20 was imported from the absent S1, and "stays" presupposed a bound no prefix state ever set — WITHDRAWN; two corrected stages, forward-only). (b-1) NO OBSERVATION TO HOLD — S2 `correctionOf:"S1"` cumulative $2 @2 arrives FIRST (prefix {S2}, S1 absent): S2 is HELD (target absent) and the prefix has NO effective observation ⇒ the per-leaf lower bound is NULL (v30, C23-F6 no-observation state, omitted from Σ, never 0) — no maximum is derived from the empty set (the NULL state above) — and `heldUsd` is carried by its `residualCapUsd` term alone (the shared formula's cap floor). When S1 (cumulative $20 @1) lands, prefix {S1,S2} (occupancy {1,2} contiguous) replays in ONE deterministic fold: S2 applies at once ⇒ effective {S2 $2 @2} ⇒ bound $2 FORWARD from that prefix — never retroactively; NO replayed prefix ever derived a $20 bound, so there is no moment at which a consumer "holds" $20. (b-2) BOUND LIVE UNDER A HELD CORRECTION — the prefix that legitimately shows a held correction leaving a bound standing MUST contain the bound-setting observation: S1 `cumulative $20` @1 (bound $20, prefix {S1}), then C `correctionOf:"X"` cumulative $25 @2 correcting statement X = a FUTURE statement @3 not yet arrived (the P0 stage accepts correction-of-future-and-HELDS it): prefix {S1, C} occupancy {1,2} is dense — the claimed range ends at 2, X's seq 3 is outside it, so P3 passes — C is HELD and contributes nothing, and the bound STAYS $20 because S1's $20 is an EFFECTIVE OBSERVATION IN THE PREFIX (the assertion is now supported by the printed stream). When X (cumulative $30 @3) lands, occupancy {1,2,3} replays: C applies at once (cumulative target ⇒ the correction's own seq 2), effective {S1 $20 @1, C $25 @2}, CAND 20, 25 non-decreasing ⇒ bound $25 — forward from $20, never retroactive. A dense prefix with a held correction whose bound-setter is ABSENT is impossible by construction: absent-target holds with a live bound require the bound-setter among the prefix's effective observations, which is exactly what (b-2) shows and (b-1) leaves vacuous. (c) correction-of-correction — legal iff each target has at most ONE correcting statement (c6-B4): occupancy {1,2,3} contiguous; S2 corrects S1, S3 corrects S2 ⇒ the chain applies in sequence order; S2's value binds nothing once S3 (higher seq) is accepted. (d) second conflicting correction — S4 `correctionOf:"S1"` ($2) AND S5 `correctionOf:"S1"` ($5) (occupancy {1,4,5} — S2@2 and S3@3 MISSING interior positions, so the prefix ALSO fails the P3 density gate: even under single-target-different-value the contract yields unknown twice over), no correction relation between them ⇒ two corrections claim one target: at-most-once violated ⇒ component unresolved unknown (never "pick the later", never "pick the smaller"; the gate's UNKNOWN here is overdetermined — graph contradiction AND gap — either alone suffices). (e) post-release correction (RECOMPUTED v17, cycle-11 audit finding 1 — the v15 vector claimed a $30→$25 leaf correction puts the released Σ $7 ABOVE the corrected picture and charges that $7 as new spend: arithmetic error, $32 released vs $27 corrected is $5 BELOW, and a decrease is never new spend — an implementation following the vector disagreed with the adjacent lifecycle rule): post-release accounting is ONE replay-defined formula. Let `releasedTotal` be the FROZEN Σ recorded by the unit-release event (finding 5's durable record), and `correctedTotal(P)` the Σ over leaves of their terminal amounts as folded by the correction graph over prefix `P`. The post-release charged total is `charged(P) = Σ_{(leaf i, component c)} hw_{i,c}(P)`, where `hw_{i,c}(P)` is the HIGH-WATER MARK of that leaf-component's effective terminal value over every prefix up to P (v19, cycle-12 audit finding 2 — v18's single unit-wide `HW` let a component-scoped reconciliation reset the whole unit's baseline and refund unrelated spend; the high-water is now kept per leaf-component and a reconciliation resets only its own term). At release each `hw_{i,c}` is initialised to that leaf's frozen terminal amount, so `Σ hw` equals `releasedTotal` at release by construction. Corrections only raise a term (a decrease never lowers `hw`), so `charged` is non-decreasing and each prefix's increment is `charged(P) − charged(P_prev)`, so one exceedance is never charged twice. Vector (v19): unit leaves A=$20, B=$12, released Σ $32; B corrected to $20 ⇒ hw_B=20, charged $40 (new spend $8); A's chain tip reconciled at accepted $10 (A's effective floor ≤ $10) ⇒ hw_A=10 only, charged $30 — B's raised $20 is NOT refunded; a reconciliation of A at $25 is refused (the interval rule of the charge paragraph applies: effectiveLowerBound ≤ accepted ≤ hw; raising a term is a provider correction, never an owner act). Counterfactual (v18, forbidden): unit-wide reset to $10 ⇒ $10 charged, which drops B's $20 — refunded without evidence: correction raises a leaf so `correctedTotal` = $40 against `releasedTotal` $32 ⇒ $8 NEW known spend charged at once (admission sees it; if the loop cannot afford it the boundary is `budget-exhausted` by the same precedence as residual overage, v19 finding 7); a further correction then lowers the picture to $36 ⇒ still $8 charged (HW = 40), never a second $8 and never a refund; the $36→$27 case above ⇒ `correctedTotal` $27 < `releasedTotal` $32 ⇒ NO new spend, the $32 stays charged as known spend — a decrease alone NEVER refunds (the refund route is the superseding `spend-reconciliation` of the lifecycle paragraph below, finding 2), the released unit stays released, no verdict is amended. Vectors (v17, normative): V-e1 increase-then-partial-decrease: released $32; corrections lift corrected Σ to $40 ($8 new spend), then drop it to $36 (HW stays $40 ⇒ charged stays $40 — cumulative new spend $8, the drop refunds nothing; a later lift to $38 adds nothing, a lift to $42 adds $2); V-e2 decrease-only: released $32 including a $30 leaf, correction rewrites it $30⇒$25 ⇒ corrected Σ $27 < $32 ⇒ charge stays $32, zero new spend, zero refund absent reconciliation. Absent a graph-accepted correction, contradicted leaves stay non-terminal, the UNIT release does not happen at all (release is unit-granular: partial release over surviving contradictions is forbidden), and throughout `heldUsd` keeps its full formula `max(residualCapUsd, Σ effectiveLowerBoundUsd)` — the cap is never dropped from the hold while leaves remain open, and known spend is a permanent floor exactly as at every other point in the ledger. **Post-release lifecycle (v15; durable record + refund route REWRITTEN v17, cycle-11 audit findings 1–2, 5):** the unit release is ONE durable `residual-unit-release` RECORD (kind added to the §14.12.4b introduced-record inventory, v17 — v15 asserted "one durable event" with no kind, fields, producer, or inventory entry, so replay could not distinguish "released once at $32" from "not yet released" in the crash window before the next boundary): producer: supervisor; fields `{ envelope, residualDispositionId, unitId, coveredLeafRecordIds[], terms[] (v20, cycle-13 finding 4: one entry per covered leaf-component `{leafRecordId, component, frozenUsd}`, `frozenUsd` = that component's EFFECTIVE terminal value replayed over the prefix immediately before this record; the sole source of each term's initial hw), releasedUsd (= Σ terms.frozenUsd, validated; the sole source of releasedTotal). A terms[] or releasedUsd that disagrees with the replay is a `disproven-authority` fault (affectedRecordId = the release record, boundaryId null) and the release is treated as NOT made (headroom stays HELD), evidenceRefs[] (the per-leaf terminal records + the §14.10.3 residual-cap disposition record the leaves hang off) }`; append is APPEND-IF-ABSENT keyed by `(residualDispositionId, unitId)`: a second release record for the same key with DIFFERENT bytes is malformed ⇒ `disproven-authority` fault (v18) + needs-owner; with identical bytes it is the idempotent redelivery replay already holds. Fsync order: the release record fsyncs BEFORE any boundary that consumes the released headroom (a boundary whose admission shows headroom released with no release record in the prefix is an `unreleased-headroom` history-integrity-fault (v18, finding 6), fail closed (the headroom counts as still HELD)). Replay after crash: release state is the PRESENCE of the record in the prefix — never a boundary-derived cache. A correction arriving AFTER release applies to the correction graph normally against the terminal record it names; `charged(P) = Σ hw_{i,c}(P)` governs (above): exceedance is NEW known spend charged at once; a decrease is NOT spend and NOT a refund. The released unit is NEVER reopened and no prior verdict retroactively changes (append-only). The ONLY route to charge below `releasedTotal` afterwards (a refund) is a SUPERSEDING `spend-reconciliation` (§14.13.4a one-time-resolution chain, v17 finding 2): a fresh reconciliation naming the chain tip in `supersedesReconciliation`, passing full validation (providerRecovery evidence, TTY act, and the floor rule restated for released units: `acceptedUsd` ≥ the Σ of still-effective leaf observations for the covered component — the released-and-known floor survives until evidence-backed reconciliation replaces it); `charged` falls ONLY through an accepted superseding reconciliation, and ONLY in its own term: it replaces `hw_{t,c}` of the single (targetId, component) it names with the accepted value (v20, cycle-13 finding 3 — the interval is `effectiveLowerBound ≤ acceptedUsd ≤ hw_{t,c}`, checked at append: out-of-interval input is REFUSED, never clamped; exactly-floor is legal; above-hw is refused because raising a term is a provider correction, never an owner act); every other `hw` term is untouched (v19, finding 2). The v11 per-leaf phrase
    ("headroom is released ONLY leaf-by-leaf") is RETRACTED by D2-b
    as inconsistent with holding the unknown whole — what survives
    of the v11 text is the per-leaf EVIDENCE-QUALITY rule (what
    counts as terminal per leaf), never a release schedule;
    a separately owner-authorized adjustment
    (`spend-reconciliation` op) may replace a provisional value
    before terminality with durable justification — and NEVER
    reduces `heldUsd` below its formula while leaves remain open:
    an accepted adjustment BELOW the current hold is recorded and
    takes effect only at the unit release (it can lower the terminal
    figure it reconciles, never the live hold other leaves are
    charged under), so no reconciliation can release headroom while
    a covered request is still running (v15, cycle-10 audit finding
    2); (3) if measured spend exceeds
    the cap, the difference is real spend already counted in `heldUsd` (v13); the next boundary's
    recurrence consumes it, and if the loop can no longer afford the
    difference the boundary is `budget-exhausted` (the cap never
    forgives overage, only postpones its accounting); (4) while the
    provisional charge stands, the boundary carries a standing note
    `residualExposureUsd` — never silently aged out. v9's
    simultaneous "the unknown SPEND component stays separately
    unresolved… admission stays blocked until a
    `spend-reconciliation` fixes each value" is RETRACTED for
    components covered by an accepted residual cap (that pairing made
    the cap both a resolved charge and an unresolved unknown —
    deadlock or free admission depending on which sentence an
    implementation read); admission is blocked while an uncapped
    unknown value exists, and permitted at the cap when the owner
    has carried it. `accept-residual-risk` REQUIRES
    providerRecovery evidence that the provider cannot supply
    terminality — and its SHAPE, provenance and freshness are now
    pinned (v10, c8-M8, replacing "the supervisor queried and it
    failed" as self-proving evidence): the referenced record is a
    `provider-inability-evidence` durable record — producer: the
    supervisor provider path, BUT its authority is the provider's
    own API response captured VERBATIM (the raw response bytes,
    content-addressed, with request endpoint, query parameters,
    timestamp, and a capability-declaration reference from the
    provider's published documentation showing the query scope is the
    ONLY available terminality query); a bare supervisor assertion
    "the query failed" is NOT provider-inability evidence (a network
    blip must not wave away evidence the provider would give).
    **Two distinct evidence questions, two distinct records (v11,
    c9-M9 — v10 conflated them: one record claimed to prove BOTH
    "no call occurred" and "terminality cannot be obtained", and its
    admissible shape ("error body or empty capability") admitted an
    HTTP 500, which proves neither):**
    (a) **no-call evidence** (does THIS intent/dispatch's request
    exist?) — a complete provider session listing for the covering
    window, or the independently-enforced fence coverage (c8-B3
    class (b)); an error response is NEVER no-call evidence;
    (b) **terminality-inability evidence** (can terminality be
    obtained AT ALL from this provider?) — admissible classes are
    CLOSED (v11, c9-M9): (i) a captured provider error response
    whose class is an explicit capability statement (endpoint or
    feature `not-supported`/`not-found` error code per the
    provider's documented error taxonomy — the response body is
    stored verbatim and the taxonomy citation is in the record),
    (ii) a provider documentation citation (fetched, dated,
    content-addressed) showing NO terminality query exists for the
    product, or (iii) **sustained-unreachability**: a bounded retry
    series whose captured transport failures span at least half of
    `reconcileDeadlineS` — admissible ONLY for the residual-cap
    route AND ONLY when the disposition record additionally carries
    `acknowledgment:"unreachable-is-not-non-support"` (the owner
    explicitly acknowledges the requests may still complete and
    bill; `residualCapUsd` is REQUIRED non-null in this class — an
    unreachable provider is exactly the case where unknown spend may
    keep accruing); timeouts, generic 5xx WITHOUT a documented
    not-supported code, and empty local queries are NOT terminality-
    inability evidence. Proof in neither class obtainable ⇒ the
    interval stays UNRESOLVED (fail closed): unreachable is not
    non-support, and the contract states plainly that an episode
    with a persistently unreachable provider cannot converge past
    the interval except by owner risk-acceptance (class iii) or the
    interval staying open forever — the accepted outcome, named.
    In all classes: per dispatchId, fresh (acquired after the
    `remote-terminal-unproven` record's ts). Residual risk is
    reported at every later boundary
    referencing the interval (a standing note, never silently aged
    out). A budget extension NEVER resolves terminality (caps ≠
    facts). The interval never resolves by timeout alone.
- `budget-extension` changes CAPS only; it never records an accepted
  spend/elapsed value (the v2 shape overloading is withdrawn). An
  extension record `{newMaxCycles?|newMaxUsd?|newMaxWallclockS?,
  authority}` requires at least one new cap value and names the
  episode's policy revision it supersedes. **Wallclock is extensible
  like the other caps (v4):** `newMaxWallclockS` is a first-class field
  — an owner may lift an exhausted wallclock cap by explicit act (v3
  listed only the two USD-ish caps, making wallclock exhaustion
  unliftably terminal while the section claimed the owner has "a
  bounded, recorded place to extend a loop", c2). An accepted elapsed
  value NEVER raises the cap: reconciliation records what was spent;
  only extension changes what may be spent — an owner cannot disguise
  a known overrun by "reconciling" it away.

#### 14.13.5 Extension

Extending a loop is an **owner act**: `kind:"budget-extension"` with
`authority` (TTY-confirmed channel reference, §14.10.3) and an explicit
new `maxCycles`/`maxUsd`/`maxWallclockS` (v5: the wire shape and the
at-least-one-cap validation include the wallclock cap, matching the
14.13.4a extension rule — v4's summary omitted it, c3 minor). The
orchestrator may never extend its own budget. This is the formal version of the AUD51 "user budget extension".

#### 14.13.6 Interaction with the verdict

`budget-exhausted` (§14.12.3) is terminal for the round and closes it
UNCONFIRMED. A round ended by budget is never recorded as converged.

#### 14.13.7 Owner decisions for the cycle budget

- **O-G4-1** Enforcement at cycle boundary only (drafted above). The
  alternative — kill in-flight work at the cap — was rejected: it converts
  a clean boundary into partially-applied fixes.
- **O-G4-2** Estimate-overshoot is disclosed, not bounded. A hard bound
  would require holding spend in reserve across concurrent cycles, which
  the single-episode loop does not need yet.
- **O-G4-3 (v2)** Recovery spend of cycle-dispatched tasks counts toward
  the cycle cap (drafted; closes the v1 escape in 14.13.3). The owner may
  instead ring-fence recovery dollars under §14.7 only — but then the
  cycle cap must be understood as covering audit+implement spend alone,
  and that scope must be stated in `maxUsd`'s policy line, not left
  ambiguous as v1 did.
- **O-G4-4 (v2)** Unknown spend consumes ALL remaining headroom
  (14.13.2), unlocked only by reconciliation or an owner-recorded value.
  The v1/count-at-estimate alternative is withdrawn: it could grant a
  next cycle that a crashed cycle had already paid for.

#### 14.13.8 What this section does NOT do

No per-task budget changes (§14.7 unchanged). No accounting of provider
billing (P8 owns usage capture). No scheduling policy (G5 partitions
work; G4 only gates whether a cycle may start).

### 14.14 Finding partitioning (G5 — which findings may run in parallel)

**Status: DRAFT v34 (2026-11-18), batched with §14.11–§14.13 (v34: c27 consistency audit folded (C27-F1 restoration, see the c27 Change Ledger row); (v33: owner decision D6 folded (shared admission, see the v33 Change Ledger row); v32: v31 audit consistency fixes C25-B1..B5, see the c25 Change Ledger row; v31: v30 internal review C24-F1..F6 folded, see the c24 Change Ledger row; v30: terra cycle-23 findings 1–7 folded, see the c23 Change Ledger row; v29: terra cycle-22 findings 1–5 folded, see the c22 Change Ledger row; v28: terra cycle-21 findings 1–4 folded, see the c21 Change Ledger row; v27: terra cycle-20 findings 1–4 folded, see the c20 Change Ledger row; v26: terra cycle-19 findings 1–5 folded, see the c19 Change Ledger row; v25: terra cycle-18 findings 1–6 folded, see the c18 Change Ledger row; v24: terra cycle-17 findings 1–6 folded, see the c17 Change Ledger row; v17:
terra cycle-11 findings 1–8 folded, see the c11 Change Ledger row; v16:
terra cycle-10 findings folded, see the c10 Change Ledger row; the v13
gitlink fold (D3-a amendment) lives in THIS section though its header
was never bumped — corrected here). v8 (terra
c6): deferral is a NONTERMINAL receipt state — filed XOR refused
stays the only terminal outcome set, deferred blocks clean closure,
laundering rule in body text (14.14.5); task-tip gate record carries
full identity payload + git object-retention obligation, `task-tip-
lost` refuses integration (14.14.4). v7 (terra
c5): gated-commit identity disambiguated — merge-tree consumes the
recorded taskTip `T` itself (object id + tree + recorded parents),
"parent == gated tip" withdrawn; escape obligation state table +
waiver act + disproven-authority ⇒ episode `history-integrity-fault`
(14.14.4); `submission-deferral` record kind + receipt-to-filing
lineage + owed-work quiesce, receipt-membership sentence superseded
(14.14.5). v6 (terra
c4): digest payload excludes the digest field; task-commit identity vs
merge candidate separated; filing-time membership + `windowOf` spec +
safety precedence; retained-set scope function with wildcard handling.
v5 (terra
c3): partition membership = log prefix at its own append; dispatch-
authorization record; candidate-substitution refusal; durable
scope-escape verdict condition. v4 (terra
c2): scope gate on the base-to-task-tip delta pre-integration (not the
merge result); partition snapshot precedes dispatch and is revalidated
per-member at dispatch time; effective scope = partition ∩ episode
authority. v3 (terra
c1): git-conflict overclaim withdrawn (non-overlapping same-file edits
merge CLEANLY) — mandatory rename-aware scope-escape gate at P12;
canonical anchor-stripped scope unions; dispatch-time partition SNAPSHOT
record with cutoff; unscoped group = explicit whole-repo authorization.**

**Purpose.** HANDOFF G5: findings that touch the same file or section must
serialize; independent findings may run in parallel across workers
(§14.7 `maxParallel`). G1 has no file scope today, so G5 needs one field.

#### 14.14.1 Amendment to §14.10.1 (additive, draft-stage)

`audit-finding` gains a closed-shape field:

```jsonc
"scopeRefs":["src/runner/attempt.ts", "docs/21-p9-m3-…#§3"]
```

- Each entry is a repo-relative path, optionally with `#<anchor>` for a
  section. An empty array is **legal but conservative** (see the unscoped
  rule). Entries are validated at intake: no absolute paths, no `..`
  segments, no glob characters (globs are for S3 `scope`, not findings).
- This is an additive amendment to the §14.10 draft; §14.10's status line
  is updated to note it. Recorded in the Change Ledger.

#### 14.14.2 Interaction relation and groups

Two open `code-fix` findings **interact** iff (v2: file-level, not
anchor-level):
- their `scopeRefs` **paths** overlap at file granularity (path-prefix
  overlap counts: `src/` overlaps `src/x.ts`; the same path always
  overlaps, whatever the anchors say — anchors are documentation and norm
  linkage, never a license to run two writers on one file, see 14.14.4),
  **or**
- they share an `affectedNorm` (same `doc` and `anchor`).

Groups are the **connected components** of the interaction graph over the
open `code-fix` findings of a cycle. Within a group, findings run **serially
in intake order**. Across groups, they may run in parallel up to
`maxParallel`.

#### 14.14.3 Unscoped rule

A finding with `scopeRefs: []` interacts with **every** other open finding.
All unscoped findings therefore collapse into one serial group. This is the
conservative default: an unscoped finding cannot be proven disjoint, so it
cannot run beside anything. (Implication: a poorly-scoped auditor makes the
loop slower, not wrong. That is the intended failure direction.)

**Unscoped group authorization (v3):** an unscoped group's canonical scope
union is EMPTY, which the 14.14.4 gate would refuse everything against —
so the unscoped group is dispatched as **whole-repo authorized** (any diff
is in-scope) but is (a) strictly serial (above), (b) integrated ALONE
(last in the cycle, never beside scoped candidates), and (c) recorded on
the partition snapshot with `"scope":["*"]` so the verdict and the
scope-escape gate both see the widened, explicit authorization rather
than an accidental empty allowlist.

#### 14.14.4 Worker disjointness — what is and is NOT enforced (v3)

v1 claimed the S3 disjointness check "enforces, mechanically", that
parallel groups share no files. It does not: S3 (docs/11 §4) says
`scope`/`notFiles` disjointness is **advisory for scheduling**, with
enforcement living in the worker's sandbox + git. v3 states the layers
honestly, including what git DOES NOT catch:

- **Canonical scope:** a group's authorized scope is the union of its
  findings' `scopeRefs` with anchors STRIPPED and paths canonicalized
  (repo-relative, `.`-normalized, case-sensitive as the repo is);
  directory-prefix entries authorize the subtree. Task `scope.files`
  (S3) is set to this canonical union; the advisory check runs before
  the wave as a planning signal only.
- Disjointness by construction: 14.14.2 puts every pair of findings
  touching one path in the same group, and a group is one task, so
  **parallel tasks never share an AUTHORIZED path**.
- **P6/P12 is a corruption backstop, not an escape detector (v3):** each
  task runs in its own P6 worktree pinned at the cycle base commit, so
  parallel writes cannot corrupt each other. A same-file collision then
  surfaces at P12 as a merge conflict (refused, never auto-resolved).
  But git merges NON-overlapping edits of the same file cleanly — so two
  scope escapes into one undeclared third file integrate SILENTLY.
  Conflict-on-merge catches racing edits only; it is NOT the durable
  scope-escape detector (v2's overclaim, withdrawn).
- **The scope-escape gate is MANDATORY, on the TASK DELTA, pre-integration
  (v4; was v3's merge-result diff):** the checked artifact is the
  **base-to-task-tip tree delta** — `git diff --find-renames <taskBase>
  <taskTip>` computed BEFORE integration, independently of any merge
  result — where `taskBase` is the immutable base commit pinned in the
  task's own dispatch record (which MUST equal the cycle's declared
  base; verified, not assumed). v3 checked "the candidate's diff from
  the merge-tree result", which is undefined both ways (c2 blocker):
  diffed from the CYCLE base it flags a clean second task for the first
  task's already-integrated paths (false refusal), and diffed against
  CURRENT HEAD it hides an escape whose content already landed via
  another task (concealment). The task delta includes BOTH rename
  endpoints, additions, deletions, mode changes, type changes, and
  gitlinks (unresolvable/ambiguous renames count as OUT-of-scope,
  conservative), and must be ⊆ the task's canonical authorized scope ∩
  episode authority (14.14.5). The checked `taskTip` sha, `taskBase`
  sha, and scope digest are bound into the P12 tested-candidate and CAS
  request — the tip that passed the gate is the tip that integrates;
  a tip that moved between gate and integration re-runs the gate, never
  inherits a pass. **No silent rewriting (v5, c3):** the P12 request
  carries the candidate's task-PARENT sha and task-TREE sha alongside
  the tip sha; integration verifies, BEFORE merge-tree, the identity of
  the GATED COMMIT itself (v6, c4-M5; disambiguated v7, c5-B4): the
  commit presented to merge-tree is the recorded `taskTip` commit `T`
  — its object id equals the sha bound at the gate, its tree equals the
  recorded task-TREE sha, and its recorded parent list is unchanged
  (for a multi-commit task, `T` is the tip whose full delta from
  `taskBase` was gated, and the gate's delta statement quantifies over
  `T`'s whole ancestry — no child of `T` is created or consumed; the
  "parent == gated tip" phrasing is WITHDRAWN: the parent check is
  against `T`'s own recorded parents, and a NEW commit whose parent is
  `T` would be an unchecked object and is refused). **Gate-record
  identity payload & object retention (v8, c6-m14; v9 c7-m14 —
  tree-field and retention domain DEFINED): the gate record
  names the FULL identity: `{ taskId, taskTip objectId, taskTipTree,
  taskTipParents[] (complete ordered parent list), taskBase }` —
  **`taskTipTree` is the SINGLE commit-tree object id of `taskTip`
  (one git tree sha, NOT a closure list — the v8 `objectIds[]`
  spelling is WITHDRAWN; the full-tree content equality checks
  re-read that tree's entries from the object store on demand, and
  the recorded id pins exactly one object)**, and the complete parent
  list lives IN the gate record itself (log-durable), not only in the
  git object. The episode
  carries an OBJECT-RETENTION obligation: the supervisor MUST keep T
  reachable (a per-episode ref, e.g. `refs/tre/task/<episodeId>/<
  taskTip>`) from gate time until integration completes or the task
  is abandoned — an unreachable, GC-pruned T is not a silent pass.
  **Retention domain (v9, c7-m14):** the obligation EXTENDS through
  the last replay that depends on the gate — i.e. until the episode's
  replay-retention horizon (the ledger's "through integration and
  replay" is the normative bound; this body text is aligned to it):
  T, its recorded tree, and its recorded parents are retained as long
  as any boundary/verdict derived from the gate is inside the episode
  replay window, so a FRESH replay store can always re-verify.
  Migration obligation (v9): pruning the ref before the replay horizon
  requires exporting the identity closure into the
  episode's artifact store under a CHECKABLE artifact contract
  (v10, c8-m16 — "e.g. a git bundle" plus a blob digest proved
  nothing: a digest-valid bundle missing tree or parent closure
  passed the digest check yet failed every replay that needed the
  closure; a blob digest establishes BYTES, never CLOSURE):
  **Format:** exactly ONE accepted form — a git bundle in
  version-3 (v3) header form, PREREQUISITE-FREE (the header lists
  the tip T and NO prerequisite lines: the bundle must be
  self-contained, so "reachable from T" is total by construction,
  not relative to a live object store). **Closure enumeration &
  verification BEFORE the record appends:** the supervisor runs
  `git verify-pack`-equivalent closure enumeration ON THE BUNDLE:
  (1) parse v3 header, confirm the single/prerequisite tip(s) equal
  the gate's recorded tip sha(s) and zero prerequisites; (2) every
  object in the gate's recorded identity (tip commit, its tree,
  every recorded parent commit and their trees — the full recorded
  identity list) is PRESENT and digest-valid inside the bundle;
  (3) the tip commit's parent list resolves entirely to recorded
  parents present in the bundle (a ROOT commit has no parents: the
  check is vacuously satisfied ONLY when the recorded identity also
  declares `parents:[]` — a recorded non-empty parent list with a
  parent missing from the bundle fails; a MERGE tip's SECOND and
  further parents must likewise be present or the recorded identity
  must name them — unrecorded parents present in the bundle are
  fine, recorded parents absent are not); (4) **FULL RECURSIVE
  REACHABILITY — the c9-M12 fix (v11): the recorded-identity checks
  do NOT prove the bundle is usable (a bundle holding tip, its
  tree, recorded parent commits and their trees but MISSING a blob
  under a nested subtree or a grandparent object passes (1)-(3) and
  every digest yet explodes in a fresh replay store): the verifier
  walks, from the recorded tip, EVERY reachable object edge —
  commit→tree, tree→(tree|blob|submodule gitlink), commit→all
  parents — transitively to closure, in an ISOLATED object store
  created from the bundle ALONE (no alternates, no borrow from the
  live repository: reachability proven against a live store proves
  nothing about the bundle), and every walked object must resolve
  to a digest-valid bundle object. Implementation: `git clone --no-
  hardlinks -b <tipRef> <bundle> /tmp/isolated && git -C … rev-list
  --objects --boundary <tip> | git -C … cat-file --batch-check`
  over the isolated store (all objects "present", zero missing);
  equivalence: the enumeration set EQUALS the bundle's object set
  minus unreferenced padding (padding tolerated, missing objects
  never are). **Gitlinks (submodule pointers) ⇒ archival REFUSAL
  (v12, owner decision D3-a):** a gitlink edge names a SEPARATE
  repository whose objects are by definition absent from the bundle,
  so check (4) can never pass over it and a "reachable" submodule is
  unverifiable content the archive would silently under-deliver
  (the isolated clone leaves its worktree empty — replay could not
  reproduce the gated tree's declared contents). A reachability walk
  that encounters ANY gitlink edge in any reachable tree (detected by tree-entry mode `160000` and classified BEFORE any object-presence check — v13: `rev-list --objects` and `cat-file --batch-check` do not classify gitlinks, so a presence-only walk would surface the refusal as a `missing-object` failure) refuses the
  archival (ref KEPT, gate stays ref-backed — the resource-bound
  refusal shape), with the refusing record naming the gitlink's tree
  path; bundling submodule contents or converting the gate is the
  owner's call, not the archiver's silent fallback. The walk is bounded (same `maxArchiveObjects`, plus
  `maxArchiveWalkBytes` for the isolated clone disk); (5) resource
  bounds: bundle ≤
  `maxArchiveBytes` (episode policy, default 2 GiB) and object
  count ≤ `maxArchiveObjects` (default 10^6) — exceed ⇒ archival
  REFUSED (the ref is KEPT, the gate stays ref-backed; failing
  closed on resources never deletes history). The verifying
  component is the **retention lane**: a named supervisor-internal
  component with its own dispatch identity under the S5 writer
  authority (v11, c9-B-seam: "the supervisor retention path" must
  name its providing layer like every other enforcement — it is the
  supervisor's retention lane, single-writer through the same
  append API, no separate authority). Only after (1)-(5)
  pass: write the bundle with the §14.12.3 publication protocol
  (write-temp → fsync(temp) → rename-excl → fsync(dir)), THEN
  append `task-tip-archived { gateId, bundleRef, sha256,
  tipSha, objectCount, verifiedAt }` (v10, c8-m16: `tipSha` = the
  verified tip, `objectCount` from enumeration step 4, `verifiedAt`
  = ts of the passing closure check — a record whose fields were
  never computed cannot be written); fsync the log. **Prune order
  (publication-before-prune, v10, c8-m16):** the per-episode ref
  is deleted ONLY after the task-tip-archived record is durable
  (fsynced) AND its sha256 re-verifies against the stored bytes at
  record time; crash between publication and record ⇒ orphan blob,
  GC-eligible under the same rule as policy blobs (no record names
  it); crash between record and prune ⇒ ref still present, archive
  redundant but harmless (replay prefers the ref, falls back to
  the archive). **Replay verification:** a replay that finds no ref
  loads the named bundle, RE-RUNS closure checks (1)-(4) AND the
  (5) bounds against
  the gate's recorded ids (v11, c9-M12 — v10 replay re-ran (1)-(3)
  only, letting an over-bounds or reachability-broken blob sit on
  disk and load forever), and treats ANY failure — digest,
  missing object, header mismatch, prerequisite line — as T
  unreadable ⇒ `task-tip-lost`, fail-closed. No ref AND no valid
  archive ⇒ replay treats T as unreadable ⇒ `task-tip-lost`,
  fail-closed.
  At integration, if T's object (or any parent/tree the recorded
  identity references) cannot be read from the object store, the
  integration is REFUSED with an actionable fault (`task-tip-lost`:
  surfaces to P13/needs-owner — recovery is re-gating a fresh task
  commit, never reusing the stale gate). The immutable task
  commit / its tree / its parents are distinct
  from the P12 merge candidate — the candidate is merge-tree OUTPUT,
  a fresh object with the episode head among its parents, and the
  candidate's parents are NEVER required to equal the gated tip;
  requiring that would refuse legitimate integration after a disjoint
  task landed on the head). After merge-tree the RESULTING candidate
  sha is what the gate result, the acceptance and the CAS bind to,
  per P12 (a rebased/amended/re-created TASK COMMIT fails
  `candidate-substitution`, refused with no side effect); history
  rewriting between gate and integration is prohibited — any rewritten
  tip re-runs the delta gate from its recorded base. `scopeDigest` is
  computed over the dispatch-authorization record's canonical
  serialization (key-sorted UTF-8 JSON, §0.7) with the `scopeDigest`
  field itself EXCLUDED from the digest input (v6, c4-M5: a digest
  over a document containing that digest is self-referential and
  uncomputable), versioned as `tre-scope-digest/1`; bound with the
  record's id, so a digest always resolves to an exact durable
  authorization. Merge-result changes vs current head are additionally
  confined to the union of the integrated tasks' authorized scopes (an
  integration writing outside every participant's scope is its own
  `scope-escape`). Any out-of-scope path, unreadable tree object, or
  ambiguous classification ⇒ refusal `scope-escape` (fail closed),
  candidate re-queued with evidence, and — because an escape means the
  partition lied — a `needs-owner` signal for THIS cycle (a
  scope-escape in round n makes round n unclean: rule-level, not
  advisory). This is a schema rule, not a ratifiable option; without it
  disjointness is only a scheduling claim and the loop must say so.
  **Durable escape event (v5, c3):** every escape appends
  `{ "kind":"scope-escape", "id":"…", "ts":…, "episodeId":"…",
  "cycle":4, "taskId":"…", "authId":"01J…", "paths":[…],
  "evidenceRef":"…" }` — the verdict table's condition reads THIS
  record: **unresolved escapes are EPISODE-GLOBAL obligations (v6,
  c4-B3)** — every boundary AFTER an escape's line, in every later
  cycle, is `needs-owner` until a valid matching
  `scope-escape-resolution` record (with `authority:"tty:…"` in the
  prefix) appears; a later clean cycle cannot outlive an unresolved
  escape (the v5 wording "of this cycle" let cycle 1's escape vanish
  by cycle 3 — withdrawn). The resolution record:
  `{ "kind":"scope-escape-resolution", "id":"…", "ts":…, "episodeId":
  "…", "escapeId":"01J…", "taskId":"…", "decision":"accepted-widen|
  reverted|rescoped", "authId":"01J…", "authority":"tty:…", "note":
  "…" }` — matching validation: `escapeId` names an existing unresolved
  escape, `taskId`/`authId` equal the escape record's, and the authority
  is the episode owner's (§14.7); mismatches are refused at intake.
  Resolution affects LATER boundaries only — the round it escaped stays
  unclean forever (the escape's own-round rule is separate and
  permanent).
  **Obligation states & close interaction (v7, c5-M3):** an escape's
  obligation has exactly three states — `open` (appended, no resolution),
  `resolved` (valid matching resolution in prefix), `waived` (an owner
  `scope-escape-waiver` act `{ kind:"scope-escape-waiver", id, ts,
  episodeId, escapeId, authority }` — distinct from resolution: the
  escape stays FACTUALLY unresolved, the owner waives its blocking
  effect on FUTURE boundaries only; the escape's own round stays
  unclean under both). What the escape blocks is **CLEAN closure, not
  boundary existence**: a boundary with an open escape appends normally
  with verdict `needs-owner` (the external-obligation gate's "appended
  only when met or waived" constrains clean closure; an unclean
  needs-owner boundary is always appendable — otherwise an unresolved
  escape would deadlock the log). Waiver/resolution acts are consumed
  one-for-one per §14.10.3 (one act, one record) — a waiver never
  leaves an unconsumed authorization dangling. **Disproven
  authority (v7, c5-M12):** if a resolution/waiver's owner-act is later
  shown forged or digest-mismatched, the escape's state RECOMPUTES to
  `open` for every boundary evaluated AFTER the invalid record's line
  (prefix replay skips invalid privileged records); boundaries already
  durable are never rewritten (append-only), but the episode enters
  `history-integrity-fault` under the SHARED definition (14.12.3,
  v8/c6-M5: entry record, gates, per-fault disposition lifecycle, and
  exit rule are defined there — faultKind `disproven-authority`); the
  disposition lifts THIS fault only when it is the last
  undispositioned one.

#### 14.14.5 Partition snapshot — the wave-start event, appended before dispatch (v4)

v2 said the partition is "recomputed from the records at dispatch" —
but records keep moving (findings close mid-wave), so two recomputes
disagree and the verdict's reproducibility claim died (v2 leak). v3
pinned it to a snapshot but placed it at "the wave-start instant (the
`cycle-boundary` cutoff)" — which is appended AFTER completions settle
(§14.12.4b), so the snapshot could not precede the dispatch it authorizes
(c2 blocker). v4: the partition is a **distinct wave-start record**,
appended in the cycle's event order BEFORE the first fix dispatch of
that cycle (§14.12.4b rule 5). **Membership rule (v5, one reproducible
prefix — v4 contradicted itself: prose said "manifest-close of the
previous cycle" while the record field named the previous
cycle-boundary, and manifest-close excludes findings filed by that
cycle's own auditors before their completions, c3):** the partition is
computed over the open `code-fix` set of the FULL LOG PREFIX at the
partition's own append position, taken inside the same S5 critical
section as the append — every finding receipted before this line (from
ANY prior cycle, including the previous cycle's own auditors filing
after their manifest closed) participates; a finding receipted after it
joins the NEXT wave (the boundary freeze protocol's `windowOf` fence
makes the assignment explicit, never silent).
**Membership = durable FILING, not receipt (v6, c4-M13):** the
snapshot's open-findings set is built from `audit-finding` records
FILED in the prefix (a receipt whose finding is not yet filed is
pending, and the quiesce rule — 14.12.2 step 3 — means no boundary
commits with pending receipts, so a snapshot never straddles a
receipted-but-unfiled finding at a boundary). A finding filed later
than its receipt joins waves from the FIRST partition whose
append-position is after the FILING line. **`windowOf` fully specified
(v6):** it is an additive field on the intake-intent classification
the SUPERVISOR writes on the refusal/next-window record
(`{ windowOf:{ cycle:n+1, partitionId:null } }` — producer:
supervisor intake; a submission explicitly assigned to the next window
is INELIGIBLE for the current cycle's partition AND excluded from the
current boundary's rule-3 holder check ONLY if it was never filed in
this episode prefix). **Safety precedence (v6):** a finding that IS
durably filed in the prefix is a holder for rule 3 at EVERY later
boundary regardless of which cycle its dispatch was deferred to —
deferral moves work, never obligations; an already-durable holder is
never excluded from safety because its dispatch waits.
**Next-window lineage (v7, c5-M7; lifecycle corrected v8, c6-B3 —
deferral is a NONTERMINAL state, not an outcome):** the "refusal/
next-window record" is a DEFINED kind — `submission-deferral`
`{ kind:"submission-deferral", id, ts, episodeId, receiptId,
submissionId, deferralOf|null (v9, c7-M10), resetOfLoopId|null
(v17, cycle-11 audit finding 8 — non-null ONLY on a reset head
granted by a `deferral-loop-disposition` `grant-new-window`; names
the `deferral-loop` record; at most one reset head per loop record,
v16), windowOf:{ cycle,
partitionId:null }, reason }`
(supervisor-authored; the chain head has
`deferralOf:null`; appended in
the same critical section as the receipt — re-deferrals append in
their own critical section citing the predecessor, v9, c7-M10). Its
validation: the
`receiptId` exists and is unresolved-at-append. **Receipt lifecycle
(v8):** a receipt's state machine is `open → deferred (nonterminal) →
filed XOR refused (terminal)`, or `open → filed XOR refused` directly.
`filed XOR refused` remains the ONLY terminal outcome set (the
one-receipt-one-outcome invariant of 14.12.4 is untouched): a deferral
MOVES the processing obligation to `windowOf.cycle`; it resolves
NOTHING. Every refusal class applies to a deferred submission later,
UNCHANGED — when the deferred submission is processed in its window,
the three-class table (transport / parse-or-schema / policy) governs
exactly as for a direct submission: malformed or policy-refused input
that was deferred still produces its `intake-refusal` + derived filing
in the deferral's window; the deferral does NOT immunize input from
refusal. Quiescence (14.12.2 step 3): a `deferred` receipt is
**outstanding owed work in `windowOf.cycle`** — the cycle that received
the deferral cannot finalize with it unprocessed (it drains to a
terminal outcome at drain time, before that cycle's quiesce check
passes); the CURRENT cycle counts it as discharged for ITS drain only
in the sense that processing moved out of it — the deferral record
itself is the discharge evidence, and it must be matched by a terminal
outcome no later than the deferral's window's boundary. NEVER may a
boundary close CLEAN (least of all a converged final boundary) while
any receipt is in the nonterminal `deferred` state (v8; closes the v7
stranding counterexample).
**Receipt-to-filing lineage:** when the deferred
submission is later processed, the terminal record (filed finding OR
refusal) names the deferral — a filed finding's `originRef` is
`{ origin:"intake", receiptId, viaDeferralId }`, a refusal carries
`viaDeferralId` in the same field position; the deferral→outcome chain
is checkable end to end.
**Deferral chain linearity (v9, c7-M10 — one active window per
submission):** a submission may accumulate MULTIPLE deferrals
(re-deferral), so the v8 phrasing "exactly one per deferred
submission" is read as (and rewritten to mean) **exactly one
deferral per (submissionId, chain position)** — a chain, not a
per-submission singleton. The chain rules: every deferral after the
first REQUIRES `deferralOf` naming its predecessor deferral record
id; the FIRST deferral has `deferralOf:null`. The chain must be a
LINEAR, ACYCLIC path in the prefix: two deferrals naming the same
`deferralOf` (a branch), a `deferralOf` naming a deferral of a
DIFFERENT submissionId, or a cycle are malformed — refused at append
(`deferral-branch` validation error); no branch can exist, so no
branch arbitration is needed. **Active window — obligations NEVER move
backward (v9, c7-M10; corrected v10, c8-M14 — v9 said owed work
counts against "the tail's window ONLY", so appending a successor
deferral to cycle 3 at cycle 2's finalization appeared to erase
cycle 2's owed terminal outcome, contradicting the paragraph above
binding the outcome no later than the deferral's own window — v11
correction: the deadline transfers with the chain, pinned below):** the
derived ACTIVE window (where the TERMINAL outcome must be produced)
is the tail's `windowOf`, and replay recomputes the tail
deterministically (whichever record landed is the tail). But an
incurred obligation is never erased by a later chain record: EVERY
window from the receipt's original window through the tail's window
carries the deferred receipt as a standing owed-work note in its
boundary (the boundary's standing notes list it while the receipt is
nonterminal), each such boundary is UNCLEAN while deferred (the
deferred-receipt-is-O rule already forces this — O blocks clean, and
draining a deferral into a successor deferral during window W's drain
leaves W closing UNCLEAN, never clean), and elapsed/spend already
consumed processing the receipt in window W stays charged to W —
re-deferral moves the FUTURE terminal-outcome duty, never past
charges and never the visibility of the obligation. **ONE lifecycle,
stated once (v11, c9-M13 — the paragraph above ("must be matched by
a terminal outcome no later than the deferral's window's boundary")
read as a HARD deadline conflicted with this rule (a successor
appended during W's drain moves the duty, yet W's boundary stands
without a terminal outcome): the deadline is CHAIN-relative, not
per-record, and "unprocessed" means "no drain outcome at all":**
(i) a window's drain produces for each deferred receipt EITHER a
terminal outcome OR a successor deferral (the drain outcome — both
are legal dispositions); (ii) the TERMINAL-outcome deadline binds
to the chain TAIL's window ONLY — predecessor windows legally
close (UNCLEAN, standing note carried) with no terminal outcome
once a successor exists; (iii) a window whose drain produced
NEITHER outcome cannot finalize at all (class B until it does —
the "cannot finalize with it unprocessed" sentence means exactly
this and nothing more); (iv) a filed/refused receipt NEVER gains a
successor (a terminal outcome is terminal; a deferral naming a
terminal receipt is refused at append, malformed — v11 c9-M13
closes the "resurrect a filed receipt" window). Serialisation
(v10, c8-M14): a successor deferral is appended ONLY inside the S5
critical section of a drain of the CURRENT active window (the same
lock that appends that window's boundary) — a re-deferral can never
race a boundary append into a window that has already finalized, and
a deferral naming a window not strictly later than its predecessor's
is refused at append (backwards or same-window deferral is a
livelock attempt, malformed).
**Terminal outcome binding (v9; window rule
clarified v10, c8-M14; carried-forward obligation ADDED v15,
cycle-10 audit finding 7 — v10's rule made a terminal outcome
positioned after the tail window's boundary malformed, yet a tail
window may FINALIZE (B→O conversion of the stalled deferral drain,
or a frozen-chain boundary) with no outcome, leaving the obligation
with no admissible future settlement — permanently unresolvable):**
`viaDeferralId` MUST name the
chain TAIL deferral (the active one at processing time). The
terminal outcome is produced no later than the TAIL window's
boundary — processing it EARLIER (in any earlier window of the
chain, including the original receipt window) is LEGAL and good: an
early terminal outcome satisfies every window's standing obligation
simultaneously (the outcome record discharges the whole chain, and
each earlier window's standing note clears at the first boundary
appended after the outcome lands); what is malformed is a terminal
record naming a NON-TAIL deferral as the discharged obligation while
a later deferral is still active (citing stale lineage), or (with
the exception defined next) a terminal outcome whose timestamp
position is after the tail window's boundary.
**Carried-forward obligation & forward settlement (v15):** when the
tail window FINALIZES without a terminal outcome — by B→O conversion
of the stalled condition (unclean boundary appended) or while the
chain is frozen by a `deferral-loop` record — the obligation does
NOT evaporate and the past boundary is NEVER retroactively cleaned.
The obligation is carried forward as the receipt's derived state
(`deferred`, active window = the closed tail, `settled:false`) plus
the standing note every later boundary reports, and the malformed-
position rule above gets ONE named exception: after the tail window
has finalized, a terminal outcome is appended against the ORIGINAL
chain (`viaDeferralId` still naming the last-active deferral — valid
ONLY while no reset head exists, v17 finding 8; superseded reading
below) as a
**forward settlement** — it settles the obligation at append time,
discharges the loop record if one exists, clears the standing note
at the NEXT boundary, and does NOT alter the finalized UNCLEAN
boundary's recorded cleanliness or verdict (history stays as
recorded; the forward settlement is the durable reason the ledger
now agrees). The owner dispositions of the two-exit rule operate the
same way across a finalized window: `close-terminal-outcome` directs
the next drain to produce exactly such a forward settlement,
`waive-receipt` closes the chain by waiving (never by backdating),
and `grant-new-window` after a FINALIZED tail appends its new chain
head as an ACTIVE window with no boundary of its own yet — the
obligation re-enters normal window processing forward. Conformance
vector (v15): deferred receipt → tail drain produces neither
outcome → B→O conversion appends the UNCLEAN boundary → laundering
cap freezes the chain → owner `close-terminal-outcome` → next drain
appends the terminal outcome as a forward settlement ⇒ obligation
settled, original UNCLEAN boundary byte-unchanged in replay, the
boundary AFTER the settlement reports the note cleared (v11's
"terminal outcome after the tail window's boundary is malformed"
holds ONLY for windows not yet finalized).
**One active chain across generations (v17, cycle-11 audit finding
8 — v15 left a contradiction across a reset: the forward-settlement
rule said a late terminal outcome settles "against the ORIGINAL
chain" naming the last-active deferral, while the terminal-outcome
binding rule requires `viaDeferralId` to name the ACTIVE tail and
refuses a non-tail citation — after `grant-new-window` the OLD tail
is not active, so a delayed drain's forward settlement was simultaneously
legal and malformed; and the reset head is itself a second deferral
of the submission with `deferralOf:null`, violating the v9 linearity
rule that every deferral after the first names its predecessor.
ONE receipt-level state machine, replay-defined, spanning chain
generations):**
- **Generation:** a maximal chain segment delimited by reset heads.
  Generation 0 is the original chain (head with `deferralOf:null`
  and no `resetOfLoopId`); each `grant-new-window` reset head starts
  generation k+1. The ACTIVE generation is the one containing the
  chain tip (latest appended deferral of the submission); ACTIVE
  TAIL = the tail of the active generation. Reset of a generation
  SUPERSEDES every unfinalized fact of prior generations: their
  obligations, standing-note drivers, drain directions, and loop
  records derive from the active generation only.
- **Reset-head exemption, explicit (v16):** a deferral record with
  `deferralOf:null` is valid IFF (a) no other deferral of the same
  `submissionId` exists in the prefix, OR (b) it carries
  `resetOfLoopId` naming a `deferral-loop` record whose
  `grant-new-window` disposition is the act authorizing THIS record
  (consumption-bound one-for-one), and no prior reset head names the
  same loop record — at most ONE reset head per loop record; a
  second is refused at append (`deferral-branch`). Every other
  deferral requires `deferralOf` naming its predecessor as before.
- **Stale-direction invalidation (v16):** every terminal-outcome
  append (including a forward settlement) and every pending drain
  direction validates its `viaDeferralId` against the ACTIVE tail at
  append time: a citation of a superseded generation's tail is
  refused as malformed (`stale-deferral-lineage` validation error —
  a refused append, not a history-integrity-fault: the prefix stays
  clean; the loop record it cites is closed, so no obligation
  evokes). The counterexample resolves: tail finalizes without an
  outcome → owner `grant-new-window` appends reset head G1 → a
  delayed drain attempts the forward settlement naming the OLD tail
  ⇒ REFUSED stale lineage; the obligation now rides G1, and the next
  drain produces its outcome against G1.
- **Serialized transitions (v16):** the three receipt-level
  transitions — forward settlement (drain), `waive-receipt`, and
  `grant-new-window` reset — are appended ONLY inside the S5
  critical section, one per section, and the derived state machine
  consumes them in append order (first-admitted wins; concurrent
  directives arriving after a transition are validated against the
  post-transition state and refused if stale, per the rule above).
  Race vectors (v16, normative): (i) reset vs forward settlement —
  reset lands first ⇒ the settlement naming the old tail is refused
  (above); settlement lands first ⇒ the loop record is already
  discharged by the terminal outcome, so the `grant-new-window`
  disposition targeting it is refused (disposition of a closed loop
  record is malformed) and the receipt is terminal; (ii) waiver vs
  directed drain — `waive-receipt` lands first ⇒ the receipt is
  terminal (`refused`, `waived:true`), any later outcome append for
  the submission is refused (rule (iv) covers waived receipts: a
  terminal outcome never attaches to a terminal receipt); directed
  drain lands first ⇒ the receipt is terminal via filing/refusal and
  the waiver disposition is refused (waiving a terminal receipt is
  malformed); (iii) second loop after reset — a laundering cap hit
  in generation k+1 appends a NEW `deferral-loop` record (its own
  `chainTipId`, own disposition); old-generation loop state never
  re-arms, and laundering counters are per generation
  (`deferralRecordsSince` the active generation's head).
**Clean-predicate integration (v9, c7-M10):** the clean/needs-owner
predicates consume the DERIVED receipt state (`open`, `deferred`
(active window = tail's), `filed`, `refused`), never the count of
deferral records: any receipt in `deferred` — one deferral or ten —
blocks clean per the v8 rule, and the laundering bound
counts distinct deferral RECORDS in the chain — see the cap rule
below for the ONE representation (v10, c8-M14). **Laundering rule (v8, explicit body text —
v7 stated it in the ledger only):** a deferred submission may NOT be
re-receipted into any window by a fresh receipt; re-admission of a
deferred `submissionId` reuses the ORIGINAL receipt + deferral, and a
second deferral of the same submissionId requires `deferralOf` naming
the prior deferral (a deferral chain is finite — ONE
representation, v10, c8-M14, replacing v9's simultaneously-derived
AND-refused state: a successor deferral whose append would make
chain length > `maxConfirmingCycles + 1` is REFUSED at append, and
the refusal is itself durably observable — the supervisor appends a
`deferral-loop` record `{ envelope, submissionId, chainTipId,
limit: maxConfirmingCycles + 1, receiptId }` in the SAME critical
section as the refusal (producer: supervisor; this record is the
SOLE trigger of the `deferral-loop` state — replay derives it from
this durable record, never from counting a chain the append refused,
closing the counterexample where the triggering record could be
invisible to replay). While any `deferral-loop` record lacks a
disposition: needs-owner, every later boundary unclean (standing
note citing it), and the chain is FROZEN — no further deferral of
that submission may append. **The frozen chain has exactly two
exits (v11, c9-M13 — vocabulary unified with the §14.10.3 op schema;
v10 spelled the op decisions `close-terminal-outcome|
grant-new-window|waive-receipt` HERE but `force-file|force-refuse|
reset-chain-with-new-window` THERE — two vocabularies for one
validator, so the op enum §14.10.3 is normative and is restated
HERE):** (1) the terminal outcome itself (filing or refusal of the
submission) discharges the loop record; or (2) an owner disposition
via the `deferral-loop-disposition` op (§14.10.3: `{ loopRecordId,
decision: "close-terminal-outcome" | "grant-new-window" |
"waive-receipt", newWindowId|null, explanationDigest|null }`,
consumption-bound; `close-terminal-outcome` DIRECTS the next drain
to file or refuse (direction named in `explanationDigest`'s note —
the op itself files nothing; the drain does), `waive-receipt`
terminates the receipt itself (receipt state `refused` with
`waived:true` + ownerActRef — the ONLY owner route to refuse after
freeze; the loop record closes with it), and `grant-new-window`
(reset): the ORIGINAL receipt is RETAINED (same submissionId, same
receiptId — a receipt is never recreated), a NEW chain head appends
with `deferralOf:null` PLUS `resetOfLoopId` naming the loop record
(sole lineage link), the laundering counter restarts ONLY on that
head (the counter is `deferralRecordsSince(resetOfLoopId)` —
ONE counter, chain records since the last reset head, bounded by
`maxConfirmingCycles + 1`; the v10 dual naming
`maxDeferralLaundering`/`maxConfirmingCycles + 1` is collapsed to
the latter as the single cap), and the prior chain's standing notes
are NOT carried into the active generation (v18, cycle-11 self-audit finding 8): the obligation rides the reset head; prior-generation standing notes remain only in the historical boundaries that reported them, and the reset head's boundary reports the ACTIVE generation's notes only. Deferral
cannot livelock findings out of filing forever: without an owner,
the frozen chain drains only to needs-owner (no terminal exit is
forced BY the loop — the two exits above are the exits; `close-
terminal-outcome` and `waive-receipt` are owner DECISIONS, the old
force-file/force-refuse shorthand vocabulary is RETIRED with this
line) —
the owner act is the ONLY reset, and it is recorded.) The v5-era sentence
"every finding receipted before this line … participates" is
superseded by the filing rule above (receipt alone never grants
partition membership; the sentence's intent — include the previous
cycle's late filings — holds via the FILING lines).
Membership is
reproducible because the recorded `computedOverRecordId` names the last
line considered, and replay recomputes the components over exactly that
prefix. At the supervisor's wave-start it appends a **partition
snapshot record** —

```jsonc
{ "kind":"partition", "id":"…", "ts":…, "episodeId":"…", "cycle":4,
  "computedOverRecordId":"01J…",        // last log line included (identity + membership anchor, v5)
  "baseCommit":"<git sha>",             // the cycle's declared base (14.14.4)
  "groups":[ { "members":["findingId",…], "scope":["path",…] } ] },
```

A two-cycle budget can therefore never exhaust without dispatching a
finding its auditors filed (c3 counterexample): cycle 2's partition is
appended at wave-start-2 — after every cycle-1 auditor filing — so the
finding is in wave 2, not deferred to a budget-exhausted wave 3.

and dispatch, integration checks (14.14.4), and the
`convergence-verdict`'s `partitionDigest` all consume THAT record, not
a live recompute. Because the snapshot precedes the dispatches and the
round-end boundary follows them, the snapshot line is INSIDE the prefix
this cycle's verdict is evaluated over (c2 fix). Later finding closures
never re-partition an admitted wave (same freeze principle as 14.12.2);
late findings arriving mid-wave are held for the NEXT wave's snapshot.
**Dispatch-time revalidation (v5, with an explicit authorization
record — v4 left the effective scope ambiguous after drops, c3):**
membership is frozen for reproducibility, but immediately before
dispatching a group the supervisor revalidates each member finding's
CURRENT disposition — closed, rejected, or held members are dropped
(skip event recorded; the snapshot is never rewritten) — and appends a
**`dispatch-authorization` record**: `{ snapshotId, groupIndex,
retainedFindings:[ids], effectiveScope:[paths] (the RETAINED-SET
SCOPE FUNCTION, v6, c4-M14: if ANY retained finding is unscoped
(`scopeRefs:[]` — the whole-repo marker), the scope is the wildcard
`["*"]` ∩ §14.7 episode authority; otherwise the canonical union of
RETAINED members' paths ∩ §14.7 episode authority — the empty-union
refusal trap (an unscoped member yielding scope `[]`) is unreachable
by construction), scopeDigest }`.
Dispatch, the 14.14.4 delta gate, and the verdict's scope check all
consume THIS record — dropped members' paths are NOT authorized (a
worker changing a dropped member's file is a scope-escape, fail
closed). One authorization per dispatch; re-dispatch after a failure
revalidates and re-appends (the latest in the prefix governs). If
revalidation empties the group, it is skipped whole. A group dispatches
only if every retained member is still an open `code-fix` AND the
authorization's intersection covers the retained members' scopes —
otherwise refused and escalated (needs-owner), never silently
widened; **after drops the scope function is RE-RUN from the retained
set (v6) — a wildcard member dropped late narrows the authorization
(dropped paths unauthorized), a wildcard retained widens it to `["*"]`
∩ authority, and either change re-appends a fresh authorization (the
stale one authorizes nothing).** Restart re-reads the snapshot; a
dispatch with
no matching snapshot is refused (log-then-act, §14.3). The snapshot may
be cached for speed; the cache is never an input.

**Effective authorization is an INTERSECTION (v4, c2 major):** a group's
canonical scope (14.14.4) is further intersected with the episode/task
authorized scope of §14.7 — partition uncertainty NEVER grants
authority (§14.7: absence of authority is not permission). The
unscoped-group `"scope":["*"]` (14.14.3) means "partition cannot narrow
this", NOT a whole-repo grant: its effective authorization is
`["*"] ∩ episodeScope`, and if the episode scope does not cover what the
task then needs, the dispatch is refused and the owner asked (O-G5-1
becomes the only way to widen it, as an owner policy act recorded on the
episode, never a partition side effect).

#### 14.14.6 Owner decisions for partitioning

- **O-G5-1** Unscoped findings collapse to one serial group (drafted above)
  vs. be treated as overlapping only with same-`surface` findings. The
  drafted default is the stricter one; the looser variant trades safety for
  throughput and needs evidence first.
- **O-G5-2** File-granular overlap (v2, drafted above): directory-prefix
  overlap still serializes; two anchors in the SAME file never run in
  parallel (v1's anchor rule is gone — see 14.14.4 for why the platform
  cannot grant below-file isolation). A future below-file rule needs a
  merge-layer mechanism, not a schema promise.
- **O-G5-3 (v3)** Scope-escape audit RAISED from optional default-ON to
  a MANDATORY integration rule (14.14.4): candidate diff (rename/
  delete-aware) ⊆ canonical authorized scope, base-commit equality,
  refusal `scope-escape` + `needs-owner` — because terra c1 proved
  non-overlapping same-file escapes merge cleanly and git cannot see
  them. What remains open: whether a scope-escape should ALSO void the
  wave's already-integrated candidates (drafted: no — refusals are
  per-candidate; the cycle just goes unclean).

#### 14.14.7 What this section does NOT do

No dispatch implementation, no worker spawn (P9/P11), no merge of parallel
group outputs (P12 integrates tested candidates; G5 only decides which
groups may run at once).

### 14.15 Batch draft: adversarial-audit scope and ratification order

**Status: DRAFT v34 (2026-11-18; owner decisions D0–D4 + D5-a + D6 (v33, shared admission), the
v13/v14 self-audit folds, the v14 same-session review fold (findings
1–5), the terra cycle-10 fold, the terra cycle-11 fold, the terra cycle-17
fold, the terra cycle-19 fold, the terra cycle-20 fold and the terra
cycle-21 fold, the terra
cycle-22 fold and the terra cycle-23 fold, see the
v13/v14/v15/v16/v17/v24/v26/v27/v28/v29/v30/v31/v32/v33/v34 Change Ledger rows).** The
four sections above are one
contract drafted in one pass and attacked as one contract, with
per-section disposition:

- **Audit order (suggested):** G1 amendment (§14.10.1 `scopeRefs`) →
  G2 (§14.11, supplies the digest ruling G1 deferred) → G3 (§14.12, consumes
  G1+G2 states) → G4 (§14.13, independent) → G5 (§14.14, consumes G1
  `scopeRefs` and G2 norm identity).
- **Ratification:** each section's `O-*` decisions are independent; the owner
  may ratify G4/G5 while G2/G3 are still under audit. A blocker in one
  section reopens only that section — EXCEPT edits to a shared interface
  (v2): `scopeRefs` (G1↔G5), norm identity/digest rules (G2↔G1 intake,
  G2↔G3 verdict), and the verdict table (G3↔G4 precedence) reopen the
  consuming sections for dependency-impact review before ratification.
- **Implementation order (after all four ratified):** G1 → G5 → G2 → G3 → G4
  (dependency order), each with its own test suite and its own Change Ledger
  row, as with P0–P15.
- **Open decisions summary:** O-G2-1…7, O-G3-1…2, O-G4-1…4, O-G5-1…3
  (above; v4-corrected enumeration — v2 text predated O-G2-6/7). All are
  drafted with a default; none is ratified.


x <!--> §99999 -->
