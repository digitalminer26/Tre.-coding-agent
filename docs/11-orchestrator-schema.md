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
cite the row):

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
  "invalidatedBy":null,                  // later record id that invalidates this one
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

**Status: DRAFT v4 (2026-11-17), batched draft of G2–G5 (§14.11–§14.14).
v4 fixes terra audit cycle 2 (see §14.15 ledger).
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
  the S5 lock** — an `atomic-group` framing the S5 writer guarantees:
  lines carry a shared `atomicGroupId` and the writer emits the group
  with one buffer flush (bytes are contiguous in the file), and the
  replay rule is group-aware — a half-group (successor `ratified`
  without the paired predecessor `superseded` inside the same
  complete-line group, delimited by the trailing newline of the group's
  last line) is a torn tail: the reader discards the incomplete group
  entirely (the successor stays drafted) and re-derives, exactly as S5
  treats a torn final line. A group appearing mid-log (not at the tail)
  that is still half ⇒ malformed log ⇒ fail closed, `needs-owner`.
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
  digest the worker actually saw; (3) compare that pin against the
  CURRENT ratified norm (successors included via `supersedes`): pin ==
  current ratified ⇒ admit, supervisor stamps the pin's
  `{normId, sha256}` onto the finding; pin ≠ current ⇒ `stale-norm`
  refusal (the worker saw old text — a successor's freshness is NEVER
  substituted for the pinned predecessor's); no pin at all, or a locant
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
  §14.11.3), and its audit completion still counts — it audited the
  pinned text the verdict's rule-5 digest comparison expects; the
  successor applies to the NEXT wave.
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
  deterministic follow-up id `refusalId+"#filing"`. The supervisor's
  `human-review` filing is DETERMINISTICALLY DERIVED from it (pure
  function of the refusal record). Restart between refusal and filing
  re-derives the filing from the payload — a content hash alone could
  not reconstruct it (v3 defect, c2); replay verifies the payload
  validates against the finding schema and its digest matches the
  source-line hash before re-filing (corrupt/missing payload ⇒ fail
  closed, `needs-owner`). Exactly-one filing per `refusalId` — the
  derived follow-up id makes redelivery idempotent; a second refusal
  with identical (source hash, code, refusalId) is the same event, not
  a new one. Until the filing is durable the item sits in a fail-closed
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
- **O-G2-6 (v3, v4-corrected)** Intake resolves against the dispatch PIN
  ONLY (locants are owner-facing); pin≠current ⇒ `stale-norm`, **no pin
  at all (or a locant matching no pin) ⇒ `norm-unpinned`** — these are
  distinct codes: `stale-norm` = a pin exists but names a non-current
  norm; `norm-unpinned` = no pin to check (v4 closes the v2/v3
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

**Status: DRAFT v4 (2026-11-17), batched with §14.11/§14.13/§14.14. v4
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
   evidence (v4, c2): the update MUST carry `reproRunRef` — a durable
   record id of a re-run of THIS finding's repro against
   `postFixExpected`, observed green, bound to the same repro
   definition. `repro.kind:"none"` (unfalsifiable — typical
   opinion/human-review) ⇒ `accepted-fix` is REFUSED at the transition
   check; owner dispositions only.
   **Chains preserve obligations GLOBALLY, not only for opinion basis
   (v4, c2):** `rejected-duplicate`/`superseded` is valid ONLY if the
   survivor is open-or-owner-closed, of severity ≥ the source's, and of
   the same `route` — a major may NOT retire into a minor (refused;
   needs owner disposition or an independent fix). Chains are validated
   acyclic at EVERY boundary and re-checked after survivor disposition
   and holds; a dangling/closed-survivor/downgrade/cross-route chain is
   refused, and if already in history, makes the round unclean.
5. **Minors (v3):** never hold a round unclean BY DEFAULT — **unless** an
   owner escalation record `finding-hold` (14.12.4; authority REQUIRED)
   names the finding and is not lifted. `finding-hold` keeps the finding
   OPEN (it is not a disposition); a held minor counts as a sign-off
   holder for rule 3 until the owner lifts it (`finding-hold-lift`,
   owner-authorized).

**Boundary freeze (v4, membership fix):** prefix membership is **log
POSITION, not timestamps and not a chosen cutoffRecordId**: the
evaluated prefix is the whole episode log up to (not including) this
`cycle-boundary` line — the boundary record's append position fixes
membership, so it cannot be raced. Under the supervisor's S5
single-writer lock, any append that was waiting lands AFTER the
boundary line and belongs to the next window: a concurrently-appended
`finding-hold` or finding can never be "skipped" — rule 3's GLOBAL
check catches it at boundary n+1, which still precedes any `converged`
it could affect. Two boundaries for one cycle, a boundary with no
manifest window between it and the previous boundary, or any evaluation
that re-derives differently over the same prefix ⇒ malformed ⇒ cycle
unclean + `needs-owner` (fail closed). Crash reconstruction replays up
to the last boundary line; evaluation is deterministic over that prefix,
so a later disposition can never re-clean (the boundary line, not the
disposable verdict, is the freeze). The `convergence-verdict` stays a
derived, recorded projection — the authoritative history is the log
itself plus its boundary lines.

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
| `needs-owner` | any open `norm-ratification` blocker (G2), any `route:human-review` finding awaiting disposition, any opinion-basis blocker/major awaiting owner decision, any active `finding-hold`, any intake-refusal whose supervisor filing is not yet durable (v4), any unresolved unknown spend/elapsed of the current cycle, or undecidable diversity (14.12.2 rule 2) |
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
alone (the verdict is simply re-derived). A budget extension (14.13.5)
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
// 2. per-assignment completion — one terminal completion per attempt:
{ "kind":"auditor-round-completion", "id":"…", "ts":…, "episodeId":"…",
  "cycle":4, "manifestId":"01J…", "assignmentId":"01J…",
  "attempt":1,                           // state machine: 14.12.2 rule 1
  "state":"completed | incomplete",      // the ONLY predicate field
  "targetDigest":"sha256:…",
  "submissionAccounting":{ "received":2, "filed":["01J…","01J…"],
                            "refused":[] } }  // every intake receipt accounted
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
  "policyRevision":7,                    // effective policy at this prefix (v4)
  "admissionEvidenceIds":["01J…"],       // cycle admit/close records consumed
  "partitionSnapshotId":"01J…" },        // the 14.14.5 snapshot this cycle ran (v4)
// (membership = log position up to this line — no cutoffRecordId to race, v4)
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

1. Close the cycle-manifest (append the closing manifest record — no
   more assignments for `n`).
2. Wait for all completions/retries to settle (crash here ⇒ restart
   reconciles `assigned`→`incomplete` per S3; retry budget per 14.12.2
   rule 1).
3. Append `cycle-boundary` **inside the S5 single-writer critical
   section** (14.12.2 freeze, v4): the boundary line's log position IS
   the cutoff — every append queued behind the lock lands after it and
   belongs to the next window; nothing selects or races a cutoff id.
   **This append is the boundary commit point.**
4. Evaluate cleanliness over the prefix (all lines before the boundary);
   append `convergence-verdict`. A crash between 3 and 4 is repaired on
   restart by re-evaluating over the same boundary line — deterministic
   (the counters recurrence, 14.12.3), so the verdict cannot drift and
   no verdict is ever needed to recover one.
5. **Cycle event ordering (v4, c2):** per cycle `n`, append order is
   `cycle admit` (14.13.4) → **`partition` snapshot (§14.14.5, the
   wave-start event)** → fix dispatches → auditor manifest (open…closed)
   → completions/retries → `cycle-boundary` → `convergence-verdict`.
   The partition is a WAVE-START event that precedes every dispatch of
   `n`; the boundary is the ROUND-END event after all completions
   settle. They are distinct records with distinct roles — v3's
   conflation ("wave-start instant = the cycle-boundary cutoff") made
   cycle-4 dispatch impossible before cycle-4's own boundary and left
   the verdict's `partitionDigest` referencing a record outside its
   prefix (c2 blocker). Out-of-order records ⇒ malformed ⇒ unclean.

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

**Status: DRAFT v4 (2026-11-17), batched with §14.11/§14.12/§14.14. v4
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
- **Elapsed time resolves too (v4, durable endpoints):** interval start =
  the `admit` record ts; interval end = the ts of the LAST of (a) the
  last terminal dispatch record, (b) the cycle's `cycle-boundary` line,
  (c) the last usage record attributable to the cycle — so a
  zero-dispatch or late-action cycle still has a defined,
  non-understated interval (v3's "last terminal dispatch record" alone
  was undefined for exactly those cycles, c2). Clock source: supervisor
  monotonic reference stamped as wall time on the records themselves; a
  clock discontinuity (recorded ts going backwards beyond tolerance)
  makes elapsed UNKNOWN (fail closed). A cycle whose endpoints cannot
  be read consumes remaining wallclock like an unresolved spend (14.13.2),
  and only an owner reconciliation record (below) may fix it.
- **Owner reconciliation is a DISTINCT record from extension (v4,
  precise targeting):**
  `{ "kind":"spend-reconciliation", "id":"…", "episodeId":"…",
     "targetKind":"cycle|worker", "targetId":"…",
     "component":"spend|elapsed",                    // exactly ONE unresolved component
     "acceptedUsd":1.5, "acceptedElapsedS":null,     // value for that component only
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
  `acceptedElapsedS`; both null or the wrong pair ⇒ refused); TTY-
  confirmed act bound to these exact values (§14.10.3 posture; the
  orchestrator may append a validated owner act, never originate one).
  **One-time resolution (v4):** a component may be reconciled at most
  once; a second reconciliation for the same (targetId, component) —
  including a replayed or reordered one — is refused; redelivery of the
  same record id is idempotent, any differing payload is refused.
- **`parked` is NOT proof of stopped spend (v4, c2):** interval closure
  requires, regardless of task status, **independent liveness proof per
  dispatch identity** — the recorded attempt/session process is gone
  (pid+start-time identity check) or provably dead (§7 trichotomy) —
  AND provider-usage reconciliation of every dispatch the cycle made.
  A task recorded `parked` whose process liveness is unknown keeps the
  interval OPEN and blocks admission (fail closed): "close then admit
  the next cycle while the old one spends" stays unreachable.
  Delayed provider usage observed AFTER close appends a
  `usage-late-arrived` record that reopens the cycle's spend figure —
  the close record was a `closed`-with-unknown, never a claim of known
  spend — and the added spend counts against the cap at the next
  admission check.
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
new `maxCycles`/`maxUsd`. The orchestrator may never extend its own
budget. This is the formal version of the AUD51 "user budget extension".

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

**Status: DRAFT v4 (2026-11-17), batched with §14.11–§14.13. v4 (terra
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
  inherits a pass. Merge-result changes vs current head are additionally
  confined to the union of the integrated tasks' authorized scopes (an
  integration writing outside every participant's scope is its own
  `scope-escape`). Any out-of-scope path, unreadable tree object, or
  ambiguous classification ⇒ refusal `scope-escape` (fail closed),
  candidate re-queued with evidence, and — because an escape means the
  partition lied — a `needs-owner` signal for THIS cycle (a
  scope-escape in round n makes round n unclean: rule-level, not
  advisory). This is a schema rule, not a ratifiable option; without it
  disjointness is only a scheduling claim and the loop must say so.

#### 14.14.5 Partition snapshot — the wave-start event, appended before dispatch (v4)

v2 said the partition is "recomputed from the records at dispatch" —
but records keep moving (findings close mid-wave), so two recomputes
disagree and the verdict's reproducibility claim died (v2 leak). v3
pinned it to a snapshot but placed it at "the wave-start instant (the
`cycle-boundary` cutoff)" — which is appended AFTER completions settle
(§14.12.4b), so the snapshot could not precede the dispatch it authorizes
(c2 blocker). v4: the partition is a **distinct wave-start record**,
appended in the cycle's event order BEFORE the first fix dispatch of
that cycle (§14.12.4b rule 5), computed over the open `code-fix` set as
of the **manifest-close of the PREVIOUS cycle** (or the episode's intake
baseline for cycle 1). At the supervisor's next wave-start it appends a
**partition snapshot record** —

```jsonc
{ "kind":"partition", "id":"…", "ts":…, "episodeId":"…", "cycle":4,
  "computedOverBoundary":"01J…",        // previous cycle-boundary (identity, not membership)
  "baseCommit":"<git sha>",             // the cycle's declared base (14.14.4)
  "groups":[ { "members":["findingId",…], "scope":["path",…] } ] },
```

and dispatch, integration checks (14.14.4), and the
`convergence-verdict`'s `partitionDigest` all consume THAT record, not
a live recompute. Because the snapshot precedes the dispatches and the
round-end boundary follows them, the snapshot line is INSIDE the prefix
this cycle's verdict is evaluated over (c2 fix). Later finding closures
never re-partition an admitted wave (same freeze principle as 14.12.2);
late findings arriving mid-wave are held for the NEXT wave's snapshot.
**Dispatch-time revalidation (v4, c2 major):** membership is frozen for
reproducibility, but immediately before dispatching a group the
supervisor revalidates each member finding's CURRENT disposition and
authorization — a finding closed, rejected, or held since the snapshot
is dropped from dispatch (a skip event is recorded; the snapshot itself
is never rewritten); if revalidation empties the group, it is skipped
whole. A group dispatches only if every member is still an open
`code-fix` AND its effective scope passes the authority intersection
below — otherwise the group is refused and escalated (needs-owner),
never silently widened. Restart re-reads the snapshot; a dispatch with
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

**Status: DRAFT v4 (2026-11-17).** The four sections above are one
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
