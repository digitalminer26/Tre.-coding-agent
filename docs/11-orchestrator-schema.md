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
| P9 | **Supervisor composition in two stages.** M1: one worker with P14 acceptance, P15 diagnosis, P10 planning, and P11 execution in a closed recovery loop; basic status and escalation included. M2: add DAG scheduling, two or N workers, measured endpoint capacity, shared recovery supervision, and resource/budget isolation. Observe-only mode is a validation switch, not the product milestone. | S1, S3–S7 | **M1 done (2026-11-06)** — `src/supervisor/compose.ts` (`5beb538`, contract docs/18, six audit rounds) + the host episode layer on top (W1–W10 identity/acceptance observation stack, P16 park/escalation wiring, P17 `tre.-episode` activation, P18–P20 lease/activation hardening) + the P12 merge port wired (`738b8e9`); see the 2026-11-06…10 Change Ledger rows. **M2 not started** — the next milestone (scheduler/capacity contract first, then code) |
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

P0 is **closed** by this section; P0-dependent compartments may start.
Wire-shape changes after closure require a Change Ledger row before code.
