# Spec — Orchestrated multi-agent flow: schemas & contracts

**Status: DRAFT — schema-first document. No implementation has started.**
This document is the *ground truth* for the orchestrator workstream: every
artifact the system reads or writes is defined here as a schema, and the
development ledgers (below) reference schema sections by id. The rule of
development: **code follows a documented schema; a schema change is made
here first** (edit → bump the Change Ledger → then implement). This is the
same discipline the repo already uses for `docs/02` (event contracts) and
`docs/05` (extra-roots spec).

## 0. Purpose & principles

An **orchestrator** process supervises **N worker** `tre.` sessions
(N = 2 on the current host: two parallel local-slot semaphores + public LLM
endpoints as needed). The orchestrator's job is *observation → judgment →
intervention*: watch worker behavior streams, detect bad behaviors (looping,
stalling, drifting, distress), steer workers back (nudge, resume, swap,
rewrite, escalate), and present the fleet to a human through views more
expressive than a single TUI.

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
   orchestrator ⇄ worker steering rides the steer-file seam (→ S4). The bot
   is never wired worker-side in this system.

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

**Change Ledger** (append one row per schema edit; implementation commits
cite the row):

| date | schema | change | driver |
|------|--------|----------------------------------------------|----------|
| 2026-10-30 | — | initial draft of S1–S7 | design discussion |
| 2026-10-30 | §12 | added build-vs-buy prior-art appendix (herdr evaluation) | internet research |
| 2026-10-30 | §2 §3 §7 §8 §9 §10 | stress-test rounds 2–4: dropped the `steer`-entry-ack premise (no such entry type exists — steer persists as a plain user message); S1 pins `progress_nudge` as a to-be-persisted contract and the toolResult-detail warn fields; S2 gains request-scoped dedup rules; §7 gains ownership-fence + reconciliation rules; §9 budgets span attempts; Q1/Q3/Q4/Q5 decided, Q2 half-decided, Q6 reopened, Q8 reframed | adversarial stress tests |
| 2026-10-30 | §13 | NEW normative recovery/durability section: append-torn-tail bug (repro: resumed append after a torn tail makes the session permanently unloadable) → tail repair is an L1 precondition; recovery invariants I1–I7; recovery test matrix as L1/L2 acceptance | round-4 stress test + repro on built code |

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
| `message` (toolResult) | `isError`, `details.sameErrorWarn` / `details.sameFamilyWarn` (persisted today — pipeline.ts ~753/786) | error-family window (mirrors pipeline family key), verify-gap |
| `message` (user) | injected text | **a steer arrives as a plain user message** — the loop emits a `steer` *event*, and the driver persists `ev.message` only (main.ts ~1119–1128). There is **no `steer` session-entry type**; provenance is absent unless S2's envelope metadata lands |
| `guardStop` | D33 `GuardEvidence` union (identical-batch / permission-stall / repeat-failure) | stop classification → ladder (→ S5 action) |
| `progress_nudge` | kind (`no-success` \| `no-verification`), mode | early warning before a stop — **NOT persisted today** (live event only, consumed at main.ts ~614); persisting it is contract work (Q2a, decided: persist) |
| `compaction` | fold boundary | context-size pressure signal |
| usage-carrying assistant entries | input/output tokens | cost burn, budget % |
| `modelChange` | model id | swap accounting |

What the log does **not** record (stress tests R2/R3 — load-bearing for
every consumer):

- **No general completion record.** `agent_end` persists *only* its guard
  evidence (`guardStop` when present, main.ts ~1112–1116). A clean run end
  leaves no terminal entry; crash classification must come from process
  exit + tail analysis (Q6, reopened).
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
{"id":"steer-7f3a","ts":1730230000,"text":"…","source":"orchestrator","priority":"steer"}
```

| field | type | notes |
|-------|------|-------|
| `id` | string | client-assigned, unique per file; used for ack correlation |
| `ts` | number | unix seconds, informational |
| `text` | string | injected exactly as given (no harness templating) |
| `source` | string | free-form label (`orchestrator`, `human-tty`, …) — persisted into the steer entry provenance if/when added |
| `priority` | `"steer"` | v1 only `"steer"`; follow-up/queue semantics deliberately excluded (matches current runLoop: no follow-up queue) |

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
      "acceptance": "gate green + <criteria>",
      "budget": { "maxTurns": 40, "maxUsd": 2.0 },
      "status": "done",
      "result": { "verdict": "ALL VERIFIED - NO FINDINGS", "artifacts": [] }
    }
  ]
}
```

Rules:
- `status` ∈ `queued | ready | running | paused | done | failed | parked`.
  The **supervisor** is the only writer; workers never see this file.
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
| `decision.rung` | integer 1–5 (see §9 ladder); `action` ∈ `nudge` \| `evidence-nudge-resume` \| `model-swap` \| `task-rewrite` \| `escalate` \| `kill` \| `park` \| `merge` |
| `outcome.acked` | steer-file path: correlated `steer` entry seen; resume path: run accepted; swap: new worker spawned |
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
- same guard fires ≥2 times across respawns → task jumps to rung 4/5, never
  retried into a slot indefinitely (poison-job parking).
- Warnings do not auto-escalate: local reflexes act first; the cortex
  intervenes on patterns the reflex cannot see (cross-run, cross-worker),
  unless escalation policy explicitly says otherwise.

## 10. Open questions

| id | question | status |
|----|----------|--------|
| Q1 | Does the steer persist gain provenance for direct ack, or stay correlation-by-ordering? | **decided (R2): envelope metadata.** The premise was fiction — no `steer` entry type exists; steering persists as a plain user message (main.ts ~1119). Ordering can't ack interleaved/multi-source steers. Resolution: optional `steering:{requestId,source}` on the message envelope (not model-visible content); promise deduplicated transcript insertion only. L1 ships the `--steer-file` seam; envelope metadata rides the same seam (S2). |
| Q2 | Should warn-rungs be persisted entries (supervisor semantics depend on them)? | **half-decided (R2):** pipeline family warns are *already* persisted (toolResult.details — contract pinned in §2); `progress_nudge` (F1) is *not* persisted and must become a persisted entry. Remaining open: exact entry shape vs toolResult-style piggyback. |
| Q3 | `<episodesRoot>` location | **decided (R2): `~/.tre/episodes`** — organizational only; grants no isolation and no automatic collection (§5 caveats). |
| Q4 | Fleet envelope → tokenomics ingest vs file-only first? | open — lean file-only; cross-host needs explicit transport (§8). |
| Q5 | Worktree integration: auto-merge or stage for human? | **decided (R2, narrowed):** episode-branch integration is **automatic for identified, tested artifacts under approved policy** — per the S5 merge-action contract above (pin base, tested SHA+parents, CAS advance, trusted gate, episode-scoped auto-resolution). *Promotion episode→main stays human by default but is delegable under explicit policy* — "always human" is governance default, not technical necessity. |
| Q6 | Is exit code + session tail sufficient for completion classification, or does one-shot need `--emit-events`? | **reopened (R2):** the old rationale was wrong — `agent_end` is *not* a persisted general completion record (only guard evidence is). Crash/exit classification is underspecified; decide after §13.4 recovery states are implemented. Stdout mirror remains one option, not the only one. |
| Q7 | Adopt herdr as S7 second transport / supervisor as socket client? | **narrowed (R2):** optional adapter only; herdr is not S7 authority, not remote-JSONL transport, and PTY `agent prompt` is not a trusted steer fallback. |
| Q8 | Implement the herdr agent contract in tre. harness as cheap reversible work? | **reframed (R2):** bounded *spike*, not "~a day": state reporting is small, but restart/approval/release/resume correctness (incl. `--resume` = file path) needs tests before any estimate. Not a supervisor prerequisite. |

## 11. Development ledgers

The build sequence agreed in design (each step cites the schemas it
consumes; update status here AND in the Change Ledger when a step lands):

| # | step | new surface | schemas consumed | status |
|---|------|-------------|------------------|--------|
| L0 | this doc | — | — | **done (draft)** |
| L1 | `--steer-file` seam in tre. (turn-boundary drain, steer entry ack) | one SteeringQueue impl + flag | S2, S1 | not started |
| L2 | supervisor v0: graph parse → spawn (worktrees, semaphore=2) → tail → rung-2 evidence-nudge-resume → decisions.jsonl; `watch`-style terminal matrix single-column | one stdlib script | S1, S3–S7 | not started |
| L3 | semantic-loop + verify-gap classifiers (command-family window, edit-no-verify across episodes) | rules in supervisor | S1, S7 | not started |
| L4 | steer-file nudges (rung 1) + hygiene ledger enforcement | supervisor | S2, S5, §9 | not started |
| L5 | fleet envelope emitter + terminal matrix (lanes) | tailer + tmux/grid viewer | S7 | not started |
| L6 | dashboard extension (web lanes + drill-down links) | tokenomics container page | S7, S1 | not started |
| L7 | episode-record viewer (interleaved timeline) | viewer over S1+S5 | not started |
| L8 | LLM judge role (public endpoint, event-triggered, verdict → ladder) | supervisor + judge adapter | S5, S7 | not started |
| L9 | meta-telemetry: outcome-correlated stats → threshold recommendations | analyst script | S5 | not started |

Guardrail note: L1 touches `src/loop`/`src/cli` (not the guardrail zone as
currently defined) but **is an in-run behavior seam** — treat its commit
with the same human-review gravity; docs/02 gains the steer-file contract
row with the implementation.

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

### 13.1 The torn-tail bug (repro-verified 2026-10-30, shipped code)

`loadSession` tolerates a partial final line (drops it, `droppedTornTail`
= true), **but nothing repairs the file**: `Session.open` after such a
crash appends *behind* the partial line, and the session then fails to
reload (`corrupt line N`) — a survivable crash becomes a permanently
unreadable session. Reproduced against the built dist: append a truncated
JSON line to a closed session → load (tolerated) → `Session.open` + one
append → reload fails. No caller truncates or repairs (grep: no
truncate/repair path exists in session handling).

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
| I4 | **Append-only queues + valid boundary:** queue files are never rewritten under a live reader; consumers repair-then-append (§13.1). Offsets are optimizations, not authority. | lost/duplicated steers |
| I5 | **Ambiguous external effects never auto-retry.** A worker action with side effects outside its worktree (push, deploy, message, spend) is only replayed if idempotent/reconcilable; otherwise reconcile-or-escalate. v1 default: workers contain effects in the worktree; publishing paths are separately controlled. | double-push, double-spend |
| I6 | **Three claims, three proofs:** recorded (transcript entry) ≠ available (context-construction evidence) ≠ followed (task-relevant result). Ack grants only the first. | "steered" ≠ "fixed" |
| I7 | **Budgets span attempts:** per-task/per-episode intervention + spend budgets survive respawn/swap/restart (§9). | intervention storm |

### 13.3 Recovery test matrix (acceptance for L1; extended at L2)

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

### 13.4 Exit classification (Q6 parking spot)

Until a durable completion record is specified (candidate: a terminal
`runEnd {reason}` entry appended by the driver at agent_end — *must* be
added to §2 via Change Ledger before implementation), worker outcome =
process exit code + last entries + torn-tail status, classified only as
`clean | stopped-by-guard | crashed | unknown`. Anything finer is a
Q6 implementation decision informed by this matrix.
