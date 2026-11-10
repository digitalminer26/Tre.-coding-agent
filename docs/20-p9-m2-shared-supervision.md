# 20. P9/M2 — Shared supervision: DAG scheduler, N workers, measured endpoint capacity

Status: **M2 spec (docs-first round) — this document is the contract M2
implements.** No M2 code exists yet; nothing here pre-implements, and this
round changes no module. Code lands only after Hong signs off the open
decisions (§13).
Scope: P9/M2 ONLY (docs/11 §11.4: "shared supervision for two or N
workers"). M3 (broader autonomy, fleet budget layer) and M4 (dashboard,
multi-episode fleet, CLI attach) are NOT in scope.
Depends on (all shipped): P9/M1 `src/supervisor/compose.ts`
(`runSupervisorEpisode`, docs/18), host episode layer
`src/host/supervise.ts` + `src/host/activate.ts` (P16–P20: lease, park/
escalation, activation, identity observation stack), P7 `src/runner/`
(attempt fence per (session, worktree), reconcile), P6
`src/worktree/provision.ts` (WorktreeProvisioner — shipped, NOT yet wired
into the host), P8 `src/budget/` (BudgetLedger: caps incl. the per-task
`perTask` slice — see §6 for what M1 derives today — aggregates, attempt
slots, coverage mode), P4 `src/episode/` (graph read/
validate incl. cycle guard), P3b `src/steer/`, P13 `src/escalation/`,
P15 `src/investigation/`, P12 `src/integration/` (merge CAS).
Doctrine: docs/11 §0 (measured capacity, files over processes, one lease),
§4 S3 (waves, desired-vs-derived), §7 S6 (slots, trichotomy), §13.2 I1–I7,
§11.2 compartment rules.

## 0. Milestone numbering ruling

docs/18 §10 parked "Telegram bridge (M2)" under its own numbering; docs/11
§11.4 is the **canonical milestone table** (M2 = shared supervision for
2..N workers; the Telegram escalation consumer already shipped inside M1
as P13). Where the two labels disagree, §11.4 wins and docs/18 §10 is read
as stale labels, not scope. This ruling is recorded once, here, so future
rows never re-litigate it.

## 1. What M2 is, in one paragraph

M2 keeps every M1 invariant true **per task** and adds one new component:
a **scheduler** that holds the episode lease, reads the S3 graph, computes
the ready set topologically, admits tasks up to measured endpoint
capacity, and runs one M1 recovery loop per admitted task in one
supervisor process. M2 does NOT change the loop body (docs/18 §10 held:
"the signal could come from… the fleet tail; nothing changes in the loop
body") — it instantiates it N times. Everything already per-task stays
per-task and needs no change: the ledger (one file per episode, one
writer, per-task caps + episode aggregates + coverage mode), P7's
ownership fence (keyed by (session, worktree) pair), per-task session
JSONL, per-task steer queue, per-task escalation topics (P13 already
carries `episodeId`+`taskId`). The three genuinely new obligations are:
**(a) admission** — deterministic, capacity-governed, refusal-disclosed;
**(b) measured endpoint capacity** — a closed contract over a file the
scheduler reads passively, never a hardcoded slot count;
**(c) fairness of recovery inference** — the shared observer resource is
allocated across tasks by a named deterministic rule, never first-come-by-
accident.

### 1.1 What explicitly does NOT change (anti-goals, pinned)

- **One supervisor per episode.** The P18-A4 lease (`host.lease`,
  stage+link publication, token-gated takeover, docs/11 ledger row
  2026-11-07…09) is process ownership, not task ownership: the scheduler
  holds THE lease and is the only component that may drive task loops.
  N workers ≠ N supervisors. A second `runHostEpisode`/scheduler on the
  same episode still refuses up front — unchanged.
- **One ledger, one journal, one escalation bot per episode** — unchanged
  single-writer domains. The scheduler is the host; it serializes through
  the same queues. No new writer appears beside any existing file.
- **The loop's ports, caps, reservation discipline, acceptance gating,
  and stop reasons (docs/18 §2/§3) are untouched.** M2 passes them
  through per task. `maxIterationsPerRun` stays per-loop.
- **Desired-vs-derived authority (docs/11 §4):** the scheduler writes
  ONLY derived fields (`status`, `result`, usage rollups) and only from
  reconcile (trichotomy); it never edits desired inputs. Rung-4 rewrite
  semantics unchanged.
- **No new transport.** Everything the scheduler consumes is a file it
  already has access to; no RPC, no in-memory bus across processes.

## 2. Module shape (mirrors docs/18 §0.1 — the doctrine, not a suggestion)

`src/supervisor/scheduler.ts` — **pure composition, zero imports** (not
even `node:`), same rule as `compose.ts`: every collaborator arrives as
a port, mirrors are local, tests bind the real modules and drift-pin the
mirrors. Guards: nothing outside `src/supervisor/` imports it; the
`scripts/check-deps.mjs` pattern enforces it.

```ts
interface SchedulerDeps {
  graph: { read(): Promise<EpisodeGraphLike> };        // validated by P4 rules (cycle → refuse)
  loop: (cfg: object, ports: object) => Promise<LoopResultLike>; // runSupervisorEpisode, injected
  capacity: { limits(): Map<string, number> };          // §4 admission view (endpoint -> concurrent cap)
  worktrees?: { ensure(taskId): Promise<{path} | {refused: reason}>;   // P6 port
                release(taskId): Promise<void> };
  ledger?: { episodeHeadroom(): {usdOk: boolean; turnsOk: boolean} };  // P8 read-view, §6
  steer?: { forTask(taskId): SteerPortLike };           // P3b per-task queue
  journal?: { append(record): Promise<void> };          // P4; scheduler journals admits/denials/stops only
  clock?: { now(): number };
  log?: (line: string) => void;
}
async function runSchedulerEpisode(episodeInput, deps): Promise<SchedulerResult>
```

The **host** extension (wiring, in `src/host/`) is a thin new entry:
`activate --graph <path> --schedule` (flag on the existing
`tre.-episode` activation, §12) — it holds the lease, constructs the real
singletons ONCE (ledger, journal, fleet observer, escalation channel,
runner), provisions the worktree root, and calls
`runSchedulerEpisode(loop = runSupervisorEpisode, …)`. All N loops
receive views over those singletons. There is exactly one
`BudgetLedger.open` per episode (its own single-flight), one journal
writer, one bot consumer — same as M1, just shared.

Concurrency model: N `runSupervisorEpisode` invocations as concurrent
async calls **in one process** (no threads, no subprocesses). All shared
state is already serialized by its owning queue (journal append, ledger
fold+write, escalation mutex, session file per task exclusive writer).
The scheduler itself is the only component that starts/stops loops, and
it never interleaves within a loop.

## 3. The scheduler contract

### 3.1 Ready-set computation (DAG)

- `ready(t)` = `t.status` is `queued`-eligible AND every `dependsOn`
  task is `done` with `result.acceptance === "complete"`. A dependency
  that **failed, is parked, or finished unaccepted never satisfies**
  `ready` — dependents stay blocked, they do NOT speculatively run.
- **Admission order is deterministic:** ready tasks sorted by
  `(dependsOn-depth, taskId lexicographic)`. No clock, no map-iteration
  order, no arrival order. Two rebuilds of the same graph admit in the
  same order (A7-style determinism; the scheduler has a pure decision
  function over `(graph, live set, capacity)` + a journal).
- **Cycle refusal:** a cyclic graph fails activation BEFORE any spawn
  (the P4 `validateShape` cycle guard is the authority — the scheduler
  never re-implements or bypasses it; a graph reaching the scheduler is
  acyclic by contract, re-verified once at startup, refuse-closed).
- Waves are a **projection**, not a runtime mode: the scheduler is
  event-driven (task terminal → recompute ready → admit while capacity
  allows). The docs/11 §4 wave view (width ≤ slots, ≤1 task per endpoint
  at a time) is exactly what the admission rule produces; it stays
  derivable for reporting, but nothing waits for a "wave to drain".

### 3.2 Admission gate (all four checks, in order, before a loop starts)

1. **Capacity (§4):** the task's target endpoint (graph `model`, or the
   M1 model-swap target — swaps re-admission-check at swap time, §4.3)
   has a free slot per the capacity view. Denied → the task stays ready,
   retry on the next terminal event; the denial is journalized with a
   reason (once per state change, not per poll).
2. **Distinct writable pair:** `(sessionPath, worktreePath)` of this task
   must not equal any live or admitted task's pair. Collision = graph
   refusal at activation (a graph that assigns two tasks the same
   session or worktree path is invalid input — refuse up front, not a
   runtime race). This is the scheduler-side twin of the P7 fence: I1 is
   enforced at admission, proven at spawn.
3. **Worktree provisioning (P6):** `ensureTaskWorktree` per task BEFORE
   the loop starts, at `<ep>/wt/<taskId>` on branch
   `agent/<episodeId>/<taskId>` pinned at `policy.baseCommit` (P6's own
   placement gates, independent-pin rules, and dirty gates apply
   unchanged — the scheduler adds none of its own). Provisioning
   refusal (`path-exists`, `branch-conflict`, …) parks THAT task with
   the P6 reason as evidence; it never blocks other tasks.
4. **Aggregate budget headroom (§6):** the ledger says the episode can
   still cover the task's reservation floor. Denied → task not admitted;
   denial journalized; if nothing else can run either, the episode
   quiesces (§3.4) rather than burning recovery on a dead-end.

Scope-disjointness (`scope.files` / `scope.notFiles`, docs/11 §4) is an
**advisory pre-wave check**: overlapping writable scopes between
concurrently admitted tasks are journalized as `scope-overlap` warnings
and are permitted (enforcement stays with the worker sandbox + git;
worktrees make mutation separation structural — overlap only matters for
merge outcomes, which P12 handles via CAS/gate).

### 3.3 Task lifecycle (S3 statuses are the scheduler's ONLY writes)

`queued → (admit) running → done | failed | parked`, plus `paused` as the
operator-sticky flag consumed like the M1 shutdown steer (a per-task
pause consumed at the loop's next step-4 boundary stops ONLY that loop;
siblings continue). Mapping of loop stop reasons → task status:

| loop stop (docs/18 §3) | task status | scheduler behavior |
|---|---|---|
| `accepted-finish` / `completed` | `done` | dependents re-evaluated; integration already ran inside the loop (`on-finish`) |
| `parked` | `parked` | task's escalation question is outstanding; **siblings unaffected**; scheduler continues admitting others (this IS the §13.3 M2 row) |
| `halt` / `escalation-exhausted` / `initial-run-denied` / `no-initial-signal` | `failed` | dependents stay blocked; episode may still finish others |
| `shutdown` (steer) | `paused` | operator intent; not re-admitted until explicit resume (rung-4) |
| `max-iterations` / `loop-error` | `failed` (with the loop's disclosure as evidence) | same as halt |

A task's loop result is written to `result` (derived) immediately after
the loop settles and its reservation is closed — never from a projection
the loop could have left stale (trichotomy: the ledger/journal records,
not the in-memory result, are re-read to decide `done`).

### 3.4 Quiescence & episode terminal

The scheduler exits when **no loop is running and no admission is
possible** (remaining tasks are all `parked`/`failed`/dependency-blocked
or capacity-denied with nothing running to free capacity). Exit is a
named reason:
`quiesced-complete` (all done) | `quiesced-blocked` (parked/failed with
blocked remainder) | `shutdown` (scheduler-level shutdown steer).
Quiescence re-checks under the scheduler's own serialized decision
queue: a capacity slot freed by a terminal loop is processed BEFORE the
quiesce decision (no TOCTOU "nothing runnable" while a loop just
exited). The lease releases only after quiescence + ledger flush.

`tre.-episode` exit codes extend the existing closed map:
quiesced-complete → 0; quiesced-blocked → distinct code (parked ≠
success); never a new signal, never a hang.

## 4. Measured endpoint capacity (docs/11 §0: "measured, not inferred")

### 4.1 Capacity file (new closed schema, `tre-capacity/1`)

```jsonc
// <episodesRoot>/capacity.json  (machine-level, next to the bot config)
{ "schema": "tre-capacity/1",
  "measuredAt": 1762…, "measuredBy": "bench-<id>",
  "ttlS": 2592000,                          // 30d: staleness fails CLOSED
  "endpoints": {
    "local/llama-qwen": { "maxConcurrent": 2 },
    "local/llama-ds":   { "maxConcurrent": 1 },
    "*":                { "maxConcurrent": 1 }   // required catch-all
  } }
```

Rules, all fail-closed to **serialize** (`maxConcurrent: 1` everywhere):
missing file → serialize + disclose `capacity:missing`; unparseable or
schema-mismatched → serialize + `capacity:invalid` (mid-file corruption
never partially trusts the file — all-or-nothing read, same doctrine as
the ledger fold); expired `ttlS` → serialize + `capacity:stale`;
`maxConcurrent` non-integer/<1 → that endpoint serializes +
`capacity:bad-entry`. The scheduler NEVER invents a number from hardware
observations; the file is the only input. Capacity is an admission
policy, never a budget: it gates concurrency only; spend still flows
exclusively through the ledger gate.

### 4.2 Measurement procedure (operational, host-owned — NOT scheduler code)

A bench script (ops skill, out of repo like other lab ops) runs the
worker model pair N-up against the real endpoints and records the
largest N where BOTH sessions complete without timeout/degradation,
writing the file with `measuredAt`. Acceptance for M2 exit evidence is
that the file's provenance is reproducible (documented command +
expected output shape). Re-measure cadence is an operator decision;
TTL expiry forces the issue mechanically.

### 4.3 Admission accounting & swap re-admission

- A capacity slot is held for exactly the lifetime of the task's loop
  run on that endpoint (admit → loop terminal), tracked in the
  scheduler's in-memory set + re-derived on restart (§8). It is NOT a
  ledger concept; the ledger's attempt slots (§12 A6/A8) stay
  authoritative for spend; the two are reconciled at admission (a task
  holding an endpoint slot but with no ledger headroom is not admitted).
- **M1 model-swap is capacity-checked:** the loop's swap action routes
  through a scheduler-supplied `capacitySlot(modelId, acquire|release)`
  port call before the runner resumes on the new endpoint; refusal
  (`capacity:full`) is returned to the loop as the swap failing — the
  planner treats it like any denied action, never bypasses.
- **Observer/investigation inference consumes NO worker slot** (docs/11
  §0): P15 calls ride a separate budget (§5), never a capacity slot.

## 5. Fair recovery allocation (the shared observer resource)

Per episode: **one global observer slot** (concurrent P15 investigation
across ALL task loops, default 1 — sized so the observer cannot starve
workers of measured capacity; it is not capacity-accounted but the same
GPU reality applies).

- Each task loop's investigate port is a **thunk through the scheduler
  fairness queue**: the loop's request (already locally capped per
  docs/18 §6 — those caps stay per loop) enters a FIFO keyed by
  `(signal seq observed by scheduler, taskId)`; the observer slot is
  granted round-robin across WAITING tasks — a task that already had an
  investigation granted since the last grant to every other waiting
  task is skipped. **No starvation:** any waiting task is granted within
  `W` grants, `W` = number of waiting tasks (bounded by P15 caps per
  task anyway).
- Queued investigations are disclosed in the task's own journal stream
  (`investigation:queued` rides the loop's evidenceRefs; the scheduler
  journalizes grants as `sched-observer-grant` records) — a diagnosis
  that waits is visible, never silently delayed (I3 doctrine for
  scheduler state: pending ≠ running, disclosed).
- Fairness is deterministic (same inputs → same grant order); the
  observer contention benchmark (§11) proves it under adversarial
  simultaneous-unknown signals.

## 6. Budget isolation & aggregates

- **Per-task caps** (S3 `budget`, across attempts, I7): enforced by the
  ledger exactly as in M1 — no M2 change to the engine. Precise "today"
  (M1): the **gate policy** models per-task caps
  (`GatePolicy.perTask?: { usd, turns, attempts }`, with `check()`
  enforcing `task-budget-exceeded`/`task-turns-exceeded`), but
  `gatePolicyFromGraph` returns `caps: {}` and **never populates
  `perTask`** — per-task caps have no host caller yet. M2's slice
  derivation is the first: it mirrors `gatePolicyFromGraph`'s existing
  mapping (authority, allowExternalEffects, maxAttemptsPerTask,
  maxStrategyRepeats) **field-for-field** and adds per-task pass-throughs
  from `EpisodePolicy` (§13 D6), so a single-task episode gates
  byte-identically to M1. Isolation failure mode the ledger already
  prevents: task A burning task B's budget (the fold is per-task scoped).
- **Episode aggregates**
  (`recoveryBudget.maxEpisodeRecoveryUsd`/`maxEpisodeRecoveryTurns`):
  precise "today" (M1): these bind ONLY the P12-W2 planner's strategy
  classification (`src/planner/plan.ts`) — they are **not** a ledger gate
  (no `caps.*` entry is derived from them). M2 decision (§13 D6): either
  (a) the scheduler maps them into the ledger's episode `caps.usd` /
  `caps.turns` so admission checks and every loop's gates enforce them, or
  (b) they stay planner-scoped and the episode ceiling rides explicit
  ledger caps set by the operator. Spec default reading: (a) — docs/11
  §14.7 labels the recoveryBudget fields "I7 aggregate limits" (and
  §4: "the episode budget is the backstop"), so enforcement is the
  doctrine's intent; the aggregate must also be checked BEFORE admitting
  a new task (reserve-first doctrine: admission asks the ledger for the
  standing coverage, never an estimate of its own invention). D6 is for
  Hong's sign-off.
- **Coverage mode (docs/12 §7.7) is the revocation path:** tightening
  policy mid-episode makes redelivered reserves fail `policy-revoked`
  — unchanged; with N loops the only new requirement is that the
  scheduler treats `policy-revoked` on a task's next reserve like any
  denial (task fails its attempt path, siblings unaffected).
- **No new budget surface.** The scheduler never mints reservations,
  never holds spend; it asks (capacity, headroom) and gates. "Budget
  isolation" in M2 means exactly: aggregates hold globally, caps bind
  per task, and admission cannot be used to launder an unaffordable
  task past the gate (test: admission of N+1 tasks each individually
  affordable but collectively over budget must leave the over-budget
  remainder unadmitted with a ledger-cited denial).

## 7. Cross-task isolation (the "no cross-task mutation" exit evidence)

| resource | isolation | enforcement |
|---|---|---|
| writable tree | `git worktree` per task, disjoint dirs, `agent/<ep>/<taskId>` branches | P6 gates + scheduler admission uniqueness check §3.2.2 |
| session JSONL | one file per task; worker is the exclusive writer | path from task id; scheduler refuses path collisions |
| steering | per-task `FileSteeringQueue` (existing per-session derivation) | scheduler hands loop i only queue i |
| escalation | P13 topics carry (episodeId, taskId); one bot, one consumer | unchanged |
| observation/acceptance | `observeIdentity(worktreeDir)` per task, identity per worktree | existing host code takes the dir — M2 passes the per-task path (single-task M1 already does) |
| merge/CAS | P12 CAS on the episode branch; concurrent task merges contend ONLY at the CAS, loser rebuilds+retests (P12's documented behavior) | unchanged; scheduler adds a serialization hint (admission order prefers dependency depth) but correctness never relies on it |
| ledger/journal | single-writer queues per file | unchanged |

Graph-level refusal conditions (activation fails, nothing spawns):
duplicate task ids; duplicate session or worktree paths; task ids
outside P6's `bad-id` grammar (validated BEFORE the first
`worktree add` — the P9 audit cycle-2 F4 pattern: catch at activation
what the deep call would refuse after burning an episode).

## 8. Crash, restart & reconcile (M2 extends I1/I2 per task)

- Scheduler restart = lease takeover (P20 machinery unchanged — the
  takeover is ONE process winning; the loser refuses). After takeover,
  the scheduler rebuilds the live set ONLY from durable evidence:
  per-task P7 `reconcile()` (discover-or-park — a task whose worker may
  still run is parked, never double-spawned), ledger open reservations
  (capacity accounting re-derived: a task with an open run reservation
  is treated as occupying its endpoint slot until reconcile proves
  otherwise), and graph derived statuses (rewritten from reconcile,
  never trusted as input).
- Crash between admit and loop-start: P7's spawn fence + intent records
  handle it exactly as in M1 (the scheduler's admit is not an act — the
  LOOP's reserve/intent is the act boundary; an admitted-but-never-
  started task is simply re-admitted, idempotent).
- Crash between loop-terminal and status-write: on restart, the ledger/
  journal terminal records + acceptance verdict are re-read and the
  derived status rewritten (trichotomy); no double-merge (P12 sticky
  terminals), no double-investigation verdict (docs/18 §6 one-per-
  investigation stays loop-local).
- Capacity file is read-only to the scheduler; corruption is a
  serialize-not-crash condition (§4.1), so a capacity outage degrades
  throughput, never safety.

## 9. Determinism & closed sets (audit-surface, name them before the audit)

Closed sets introduced by M2 (frozen, mirrored, drift-pinned by tests):
scheduler stop reasons (`quiesced-complete`, `quiesced-blocked`,
`shutdown`), capacity disclosure tokens (exactly
`capacity:missing|invalid|stale|bad-entry|full`), scheduler journal
kinds (exactly `sched-admit`, `sched-deny`, `sched-observer-grant`,
`scope-overlap` — additive superset of docs/18 §8.4's three M1 kinds),
admission refusal reasons. Determinism pins: admission order (§3.1),
fairness order (§5), capacity rebuild-from-file (pure), live-set
reconcile (pure function of ledger+journal+P7 verdicts at one `now`).
The scheduler reads NO wallclock inside any pure decision; `now` is
injected once per scheduling decision like the ledger fold does.

## 10. Invariants (the M2 audit surface — each needs a named repro test)

| # | invariant | reproduction |
|---|---|---|
| M2-1 | No double admission: one loop per task at any instant; capacity=1 admits one | concurrent ready set of 3, cap 1 → exactly 1 running; order = §3.1 sort |
| M2-2 | No cross-task mutation: two workers never share (session, worktree); graph collisions refused at activation | same-path graph → zero spawns |
| M2-3 | Parked ≠ blocker: one task parked → independents reach acceptance (§13.3 M2 row) | A parks at step 2; B (independent) completes; C (depends on A) stays blocked |
| M2-4 | Aggregates hold under N: total spend+denials ≤ episode caps; over-budget remainder unadmitted with ledger-cited denial | N=4 tasks, episode cap covers 2.5 |
| M2-5 | Capacity fail-closed: missing/invalid/stale file ⇒ serialize (never more than 1 per endpoint), disclosed | all four §4.1 states |
| M2-6 | Fairness/no-starvation: observer grants round-robin under simultaneous unknown signals | 3 loops, all-signal storm, W bound proven |
| M2-7 | Restart: takeover → live set from reconcile only; discovered-alive worker → park, never respawn (I1/I2); no double merge | kill -9 mid-episode at each window (admit/running/terminal/status-write) |
| M2-8 | Lease unchanged: second scheduler on same episode refuses while lease live (§P18-A4 at N) | two activations |
| M2-9 | Swap re-admission: model-swap denied when target full; loop treats denial as denied action, budget untouched | swap storm into a full endpoint |
| M2-10 | Loop immutability: `compose.ts` and its docs/18 tests pass unchanged with scheduler-supplied ports (the scheduler is an ADDITIVE layer — a diff shows zero loop edits) | guard test + suite diff |

## 11. Test & acceptance strategy (mapped to §11.4 exit evidence)

1. **Unit:** scheduler with fake loop/port clock (compose.ts test style),
   every invariant above named, mutation-swept (each guard reverted →
   exactly its tests fail — the standing doctrine).
2. **Real-git integration:** 2-task and 3-task graphs on real repos +
   PATH-shim workers: worktree provisioning, disjoint writes, dependent
   gating, merge CAS contention (two `on-finish` merges, one rebuild-
   retest), §13.3 M2 row end-to-end.
3. **Concurrency benchmark (the exit-evidence row):** fixed deterministic
   workload, {1, 2, 3} workers × observer contention, measuring accepted
   tasks/human-minutes vs single-worker baseline (docs/11 §11.4
   productivity measures — slot utilization is explicitly NOT a success
   metric). Observer contention: run with 0/1 observer slot vs N loops
   investigating simultaneously under the fairness queue.
4. **Replay/fault fixtures** first, then observe-only, then controlled
   live (§11.4 validation-gate paragraph — engineering release gates,
   not per-action human approval).
5. Full suite green ×2 + `tsc` clean + compartment guards, per doctrine.

## 12. Host surface (thin, pinned)

- `tre.-episode --graph <path> --schedule [--max-parallel N]`: `--task`
  and `--schedule` are mutually exclusive (M1 path unchanged; one flag
  decides whether the host drives one loop or the scheduler drives N).
  `--max-parallel` can only LOWER the capacity-file admission (a policy
  ceiling), never raise it.
- M1's single-task activation remains the supported debugging path
  (per-task loops can be run individually across processes only if the
  lease is held out — documented as forensics mode, NOT concurrency:
  the lease still enforces one supervisor; nothing about the fence
  permits two).
- S6 `state.json` slots: derived projection of the scheduler's live set
  (`{localA: taskId|null, …}` shape stays a projection — rebuilt from
  the scheduler's in-memory live set on each write, never an input;
  a corrupt state.json rebuilds from reconcile, unchanged).

## 13. Open decisions (for sign-off before code)

1. **Global vs per-endpoint observer slot default.** Proposed: one
   global observer slot per episode (§5). Alternative: count P15 calls
   against the endpoint's capacity slot while running (pessimistic;
   proposed design treats the observer as a separate small consumer,
   matching docs/11 §0 "need not consume an inference slot
   continuously"). — **proposed: global 1, revisit after benchmark.**
2. **Capacity file location:** machine-level
   `~/.tre/episodes/capacity.json` (shared across episodes, matches the
   machine-level config doctrine) vs per-episode override. Proposed:
   machine-level only; per-episode override is an explicit non-goal
   (episodes don't own hardware facts).
3. **`failed` semantics granularity:** a failed task currently taints
   only its dependents; episode `quiesced-blocked` covers mixed
   outcomes. Alternative considered: partial-success exit codes per
   failed count — rejected for M2 (closed 3-code map stays; the journal
   carries the breakdown). Confirm.
4. **Worktree retention:** keep finished-task worktrees until episode
   cleanup (proposed — forensics + P12 acceptance refs point at them);
   auto-removal at task `done` is M3 scope at the earliest.
5. **P20 lease scope:** the lease name stays `host.lease` for both paths
   (proposed — the invariant is one supervisor per episode regardless of
   task count; renaming buys nothing and breaks takeover compat).
6. **Episode-recovery caps enforcement (§6):** map
   `recoveryBudget.maxEpisodeRecoveryUsd`/`Turns` into the ledger's
   episode `caps.usd`/`caps.turns` at policy derivation (proposed —
   docs/11 §14.7 labels them "I7 aggregate limits", and a M2 aggregate
   must bind admission before it binds gates), vs leaving them
   planner-only as in M1 with the episode ceiling riding operator-set
   ledger caps. — **proposed: map into ledger caps.**

## 14. Out of scope (explicitly, so the audit doesn't have to guess)

Multi-episode fleet scheduling (M4), dashboard/matrix lanes (M4),
staging/rollback and fleet-level budget pooling (M3), cross-host workers
(docs/11 §8 Q4 transport), per-task leases, dynamic capacity probing
from inside the scheduler (measurement stays operator-side), graph
rewriting/rung-4 automation, in-flight steering beyond P3b's existing
per-task queue, P12 auto-merge policy changes (only concurrency
contention behavior is exercised, the policy itself is untouched), and
any loop-body change to docs/18 (M2-10 makes loop edits a red flag).
