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
| P3b | **File-backed steering delivery**: `--steer-file <path>` + `FileSteeringQueue` (offset-tolerant incremental drain, malformed lines skipped+counted, scoped-request validation, transcript-scan dedup by request id with scope/provenance conflict rejection, sync-before-ack per §13.1). **Claims deduplicated transcript insertion only — never exactly-once execution** (I6). Tests: §13.3 rows 1/2/4 | S1, S2 | not started |
| P4 | **Episode journal & projections**: typed graph.json / state.json / decisions.jsonl readers-writers, schema validation, atomic-rename, dir scaffold (S4), intent/outcome append records (§6 lifecycle), state trichotomy applied (S6). No process ever writes these yet | S3, S5, S6 | **done (2026-11-01)** — `src/episode/journal.ts`: typed `EpisodeGraph`/`EpisodeState`/§14.3 record classes; `writeEpisodeGraph`/`writeEpisodeState` atomic-rename (tmp+fsync+rename) with schema validation on BOTH write and read (`tre-graph/1`, `tre-episode-state/1`); `DecisionJournal` append-only JSONL — validate-before-append, sync-before-return, §13.1 torn-tail repair on open (truncate partial tail / terminate newline-lost record; mid-file corruption throws), duplicate-id reporting; `createEpisodeLayout` S4 scaffold (idempotent, seeds graph); I2 projections `openIntents`/`latestAttempt`/`unresolvedSpawns`; `defaultEpisodesRoot` = `~/.tre/episodes` (Q3). Enforced test: no module outside `src/episode/` may reference these files until the supervisor (P6+) lands |
| P5 | **Read-only ingestion & fleet projection**: persistent-offset JSONL tailer (reporter pattern), §13.1-*aware* (reconcile cursor on truncation/replacement — see §11.2 boundary note), entry-id dedup, deterministic replay, envelope emission (S7) with explicit `unknown`/`stale` (I3) | S1, S7 | not started |
| P6 | **Worktree provisioning**: `git worktree add/remove`, episode-branch pin at `baseCommit`, isolated task branches/dirs, safe cleanup. **No integration logic here** (that is P12) | S4 | not started |
| P7 | **Attempt runner & ownership recovery**: controlled spawn/stop with attempt identity tracked in durable records (not PIDs); lost-supervisor reconcile — the old worker is not our child after a supervisor restart and `waitpid` is not generally available, so PID checks are insufficient: **discover-or-park** is the conservative fallback (I1/I2). Independently testable kill/spawn/reconcile unit *before* any scheduler uses it | §13.2 I1/I2, S6 | not started |
| P8 | **Durable accounting & authority enforcement.** Gate worker, observer, diagnostic, repair, and spawn actions independently of model judgment. Track total time/spend/turns, recovery attempts, strategy fingerprints, progress and new diagnostic evidence across restarts. Reserve/account for outstanding usage and unknown cost. Stable action ids and reconciliation prevent blind duplicate actions. Authority covers paths, commands, environment changes, approved endpoints, spending, and external effects; absence of authority is not permission. | §9, §13.2 I5/I7, S5 | not started |
| P9 | **Supervisor composition in two stages.** M1: one worker with P14 acceptance, P15 diagnosis, P10 planning, and P11 execution in a closed recovery loop; basic status and escalation included. M2: add DAG scheduling, two or N workers, measured endpoint capacity, shared recovery supervision, and resource/budget isolation. Observe-only mode is a validation switch, not the product milestone. | S1, S3–S7 | not started |
| P10 | **Evidence classification & recovery planner.** Pure functions combine persisted evidence, P14 assessments, validated P15 diagnoses, authority, and ledger facts into finish/continue/investigate/repair/change-approach/escalate recommendations. No model calls or side effects here; recommendations are checked by P8 and executed by P11. Golden fixtures cover uptake versus progress and repeated-strategy detection. Advanced semantic classifiers can follow M1. | S1, S5, S7, §9 | not started |
| P11 | **Recovery action executor.** Executes authorized plans through P7/P8 with durable intent/outcome records: backoff/retry, confirmed-stop resume, scoped in-flight steer (P3b), diagnostic/repair dispatch, and later model/session/task transitions. Owns no independent permission grant. Bounded diagnostics and task-local repair are core M1 capabilities, not late ladder additions. P7 remains the process-control primitive; neither observer nor worker may bypass the control plane. | S2, S5, S6, §9 | not started |
| P12 | **Tested candidate integration** (initially unwired): the §5 merge-action contract as a module — candidate construction, trusted gate bound to the exact candidate SHA, CAS advance on episode-branch head, acceptance record, conflict/head-movement → reconcile-or-park | S4, S5 | not started |
| P13 | **Human escalation and richer viewers.** M1 includes an actionable escalation channel with evidence, attempts, blocker, and exact decision needed; Telegram has one orchestrator-owned consumer. Independent tasks may continue while one is parked. Rich matrix lanes, dashboard transport, episode replay UI, and meta-telemetry are deferred. Core observer judgment moves to P15, not an optional late LLM judge. | S5, S7, §9 | not started |
| P14 | **Acceptance evaluator.** Classify complete/incomplete/blocked/uncertain against approved criteria and artifact-bound evidence. Prefer deterministic checks; validated model assessment handles semantic criteria without replacing required gates. Return evidence refs and remaining work, and invalidate stale assessments after relevant artifact changes. Normal stop or model self-report alone never proves completion. | S3, S5, S7, §9 | not started |
| P15 | **Investigation & recovery agent.** Event-triggered, tool-capable diagnosis over a bounded evidence packet; tools run through P8/P11. Distinguish transient errors, premature stops, task defects, environment blockers, and approval boundaries. Produce structured diagnosis, uncertainty, strategy, expected evidence, and proposed actions. Bounded investigation and task-local repair ship in M1; unrestricted recursive delegation does not. Different strategies may be tried within the aggregate budget; repeated generic nudges are not healing. | S1, S3, S5, §9 | not started |

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
