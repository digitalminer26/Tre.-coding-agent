# Plan: responsive input and cancellation during workstreams

Status: stream-render coalescing and immediate interactive paints implemented. Worker-job cancellation remains out of scope.

## Implementation (2026-10-09)

Stream taps route through the coalescer; interactive and lifecycle state
changes bypass it and paint immediately. Slow paints begin a fresh coalescing
window on completion. Deterministic routing tests assert the distinct stream
(schedule) and interactive (paint-now) paths, alongside paint timing tests.
Worker-job cancellation (ownership/cancel propagation across detached and
parallel jobs; plan steps 2, 4, and 5) remains explicitly out of scope.

## Goal and scope

Keep typing, steering, scrolling, and Ctrl-C usable while tre. orchestrates
workers. Separate a terminal-input freeze from a command that is accepted but
cannot affect detached work. No runtime changes are part of this assessment.

This file is deliberately under `docs/workstream-input/`: on this macOS
filesystem, root `plan.md` and the tracked `PLAN.md` resolve to the same inode.
Do not overwrite the historical build plan.

Baseline before assessment (`git status --short`):

```text
 M README.md
 M docs/04-skill-authoring.md
```

Those documentation edits belong to the preceding task and must be preserved.

## Findings and evidence

### 1. Busy is not an intentional keyboard lock (confirmed)

- `src/tui/state.ts:571` (`inputChar`) allows typing while busy. Approval and
  the model picker intentionally lock ordinary text input instead.
- `src/tui/app.tsx:120` handles Ctrl-C before those modal guards; scrolling
  keys also have explicit routes. `useInput` is not disabled during work.
- `src/tui/run.tsx:581` queues ordinary busy submissions as steering.
  `:644` aborts the active controller on the first Ctrl-C and force-exits
  on a second interrupt within two seconds. The signal fallback at `:838`
  implements equivalent behavior.
- A direct state probe preserved `hello` with `busy: true`. Existing
  App, bash-kill, and worker-render tests passed: 47/47, no skips.

These checks rule out a simple busy-state lock, NOT a real-terminal freeze.
Approval/picker state and the terminal's actual raw mode must still be
captured when reproducing the incident.

### 2. Full-history layout on every update can starve input (strong candidate)

`src/tui/run.tsx:346` requests a render on each state update, including every
text/thinking delta (`tap` at `:430`). `src/tui/app.tsx:106` calls
`fitItemsScrollable`; `src/tui/state.ts:974` rebuilds rendered lines for ALL
items, including off-screen history. The visible-item renderer also invokes
`itemLines` again (`app.tsx:370`). Accumulated thinking and text survive in
TUI items; context compaction is not a UI-history performance reset.

Offline measurements using the built layout function (100 columns, 24 rows,
five passes; these are observations, not performance guarantees):

| History | Text + thinking characters | Mean layout time |
|---|---:|---:|
| 20 synthetic assistant items | 76,800 | 2.3 ms |
| 200 synthetic assistant items | 768,000 | 8.1 ms |
| 1,000 synthetic assistant items | 3,840,000 | 34.1 ms |

Reconstructing ONLY the user/assistant display items from the preceding long
session (`tre-20261007-222449-42536.jsonl`) produced 299 items. Ten-pass mean
layout time was 34.5 ms at 80 columns and 34.7 ms at 120 columns. This excludes
React reconciliation, terminal output, and tools, and is not the exact live
state. Frequent stream updates can consume the event-loop budget at that
cost. In raw mode Ctrl-C arrives as an input event, so a saturated event loop
can delay it just like printable keys. Even the second-interrupt escape
requires the event loop to run.

There is also synchronous registry read/prune I/O every five seconds
(`src/cli/workers.ts`, `src/tui/run.tsx:800`). A small normal registry is not
proven to freeze input; large/corrupt files or a slow filesystem warrant
measurement and bounded handling.

### 3. Worker visibility is not worker control (confirmed design gap)

`src/cli/workers.ts` is a status registry, not a cancellation/steering API.
`WorkerStatus` has no ownership/control capability. The TUI's abort signal
controls its current run, not an explicit set of workstream jobs.

The bash tool spawns asynchronously, with stdin ignored and stdout/stderr
captured (`src/tools/bash.ts:103–121`, `src/tools/sandbox.ts:373`). It kills
its own process group on abort. This does NOT imply reliable cancellation
of a worker tre. process that launches its own detached bash descendants.
The installed parallel-delegation and implement-audit skills explicitly use
`nohup ... &` followed by polling. Once a launch call has completed, a later
Ctrl-C can abort the poll/parent run without stopping the background job.
Changing model guidance is also consumed at loop boundaries, not immediately
by a running worker or a long shell call.

Thus an accepted Ctrl-C may appear ineffective while a detached worker keeps
running. That alone does not explain inability to type; treat the symptoms
as separate until the PTY trace distinguishes them.

### 4. Terminal takeover is possible but not established here

Normal bash tools do not inherit terminal stdin. The blocking `spawnSync`
path in `src/tui/run.tsx:390` is the intentional `/restart` terminal handoff,
not normal worker launching. Do not replace it as a speculative fix.
Custom launch scripts explicitly opening `/dev/tty`, or nested interactive
programs changing terminal state, remain reproduction checks, not findings.
The installed `tre.` symlink resolves to this checkout's built CLI.

## Implementation plan (approval required before runtime edits)

| # | Owner | Work | Depends on | Acceptance criteria |
|---|---|---|---|---|
| 1 | Debugger / Tester | Build deterministic PTY reproduction and capture input latency | — | Busy typing, Enter steering, Ctrl-U/D, arrows, Ctrl-C work or fail reproducibly under normal streaming, large history, foreground worker wait, and detached worker polling |
| 2 | Architect | Define run/job ownership and cancellation policy | 1 | Written contract distinguishing aborting orchestrator, cancelling owned workers, and explicitly persistent jobs; no global worker-kill behavior |
| 3 | Implementer | Bound rendering cost and preserve immediate input handling | 1 | Coalesced stream renders; cached item layout; lossless state/session events; PTY input latency meets target with long history |
| 4 | Implementer / Ops | Add owned-job lifecycle and noninteractive launch protocol | 2 | Cancellation acknowledged, worker/tool descendants exit within bounded grace, terminal remains usable, unrelated jobs unaffected |
| 5 | Implementer | Add immediate interruption/queue feedback and explicit worker controls | 2, 3, 4 | UI shows cancelling/queued guidance; `/workers` and scoped cancellation are deterministic without waiting for an LLM reply |
| 6 | Reviewer / Tester | Stress, lifecycle, and integration verification | 3, 4, 5 | Full quality gate plus PTY suite; no input loss, invalid session history, orphaned owned jobs, or regressions in restart/modals |
| 7 | Scribe | Document controls, latency semantics, and detached-job behavior | 6 | Help, README, and deployment skill launch recipes agree with implemented policy |

### Step 1: reproduce before choosing the fix

Use local mock SSE endpoints (no GPU dependency) and a real PTY. Extend the
existing mock/PTY test infrastructure rather than relying only on
ink-testing-library callbacks. The harness should timestamp injected bytes,
handler entry, state mutation, render completion, abort propagation, worker
acknowledgement, and process exit. Avoid writing raw debug lines into the UI.

Matrix:

- Idle, busy streaming text/thinking, active bash `sleep`, active approval,
  and model picker; test modal expectations rather than calling them freezes.
- Small history versus 300+ multi-kilobyte items; sustained fast deltas;
  simultaneous worker-status updates, terminal resize, and scrollback.
- Foreground wrapper, `nohup` background wrapper, and a worker running a
  nested long-lived bash child. Log PID/PGID ownership without secrets.
- Raw Ctrl-C byte (`0x03`) AND externally delivered SIGINT; first interrupt
  versus a second within the current grace window.
- Verify terminal mode/foreground process group and whether any worker ever
  opens `/dev/tty`. Capture actual launch command and UI mode in a live repro.

Initial local targets: p95 printable-key visible latency below 100 ms and
Ctrl-C handler/acknowledgement below 250 ms under the specified mock load.
Use generous correctness deadlines in CI and report latency separately to
avoid flaky tests; calibrate stricter gates on measured runners. A worker
cancellation target is acknowledgement within one second and termination
within a documented five-second grace, then escalation.

### Step 3: rendering changes

- Update authoritative state immediately; schedule streamed visual updates at
  a bounded cadence (start with 20–30 fps). Do not debounce key handling,
  signals, approval, lifecycle events, or session persistence behind streaming.
- Cache rendered item lines by item identity, width, and predecessor/separator
  semantics. Unchanged history must not be re-wrapped every token/key.
  Reuse line lists in the visible renderer, with prefix-height indexing for
  scroll slicing; invalidate correctly on resize and streaming-item changes.
- Avoid rerendering on events returning the same state reference. Keep timers
  and late events safe after quit/restart; flush final state on settlement.
- Measure registry I/O before rewriting it. Bound file sizes/counts and use
  asynchronous read/prune or incremental scanning if it is material. Maintain
  best-effort failure behavior. Do not silently discard conversation history
  or session data as a performance shortcut.

### Steps 2 and 4: cancellation and launch ownership

Introduce a supervisor/control abstraction, not `pkill tre.` or killing all
entries in the machine-wide registry. Associate each managed job with its
orchestrator run/session, unique job id, process identity and lifecycle.
Workers must be launched with stdin `/dev/null`/`ignore`, captured logs, and
no terminal-control access through the launch protocol.

Recommended policy: the first Ctrl-C immediately acknowledges cancellation,
aborts the current request/tool, and requests graceful stop of jobs owned by
that run. A second interrupt retains the force-exit escape but performs
best-effort owned-job cleanup first. Jobs intentionally allowed to outlive
an orchestrator must be explicit and visible; do not silently change legacy
`nohup` semantics without a migration policy.

A graceful worker control request should abort the worker's own controller,
letting its active bash executor terminate its separate process group and
complete in-band tool results. Escalation must account for nested detached
groups; killing only a wrapper PID/PGID is insufficient. Use registered job
identities and a per-job control capability/IPC channel with restrictive
permissions and replay/ownership checks. Do not trust an arbitrary PID in a
status file (PID reuse/cross-session signalling). Resolve the exact local
IPC design in step 2, including sandbox reachability and crashed-supervisor
recovery. Persist final cancelled/failed outcome even if wrapper cleanup
interrupts the normal `.rc` write. Add heartbeats independent of model turns
so a slow legitimate request is not mistaken for a dead worker.

Worker-specific steering is a separate optional operation: report accepted
versus delivered guidance, and do not imply it interrupts a running tool.

## Verification and boundaries

Assessment checks already run:

```text
node --test dist/test/tui-app.test.js dist/test/bash-kill.test.js dist/test/workers-tui.test.js
47 pass / 0 fail / 0 skip
```

The layout probes above ran against existing `dist/`; no production source
was edited. This assessment has NOT reproduced the user's exact frozen
terminal and does not claim a single proven incident root cause.

After implementation: `npm test`, `git diff --check`, offline PTY matrix on
macOS and Linux, inherited-sandbox coverage, worker descendant canaries, and
manual live workstream verification. Verify restart terminal handoff,
approval/picker Ctrl-C, scroll pinning, steering ordering, abort in-band
results and replay, and no late rendering after unmount.

Scope is TUI state/render/lifecycle, CLI worker lifecycle/registry, tests,
and deployment worker recipes. Preserve unrelated WIP. `src/tools/bash.ts`
and `src/tools/sandbox.ts` are guardrail-zone files: any required edits need
explicit human approval and the established protocol; do not bypass the
hook or weaken confinement to make cancellation easier. No dependency or
endpoint-config changes are proposed.
