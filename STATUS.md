# STATUS — attempt-lifecycle hardening (kill-window audit workstream)

## 2026-08-04 — cycle 3: post-review fixes (F1 pgid-reuse kill removed, F2 confirmed-evidence attestation)

Source of truth: `~/.tre/audits/killwin2-sol-out.txt` (clean-slate review
of the cycle-2 fixes — 2 findings, both REAL and fixed this cycle).

### F1 (HIGH): group signalling authority is gated at the kill(2) site

- Cycle-2 re-introduced a pgid-reuse kill window: after the leader is
  reaped, the OS may recycle the group number for a stranger group.
- **Central gate:** `signalGroup` is the only place group signals are sent.
  It refuses unless the leader is unreaped AND group death is not latched.
  The check and the `kill(2)` are synchronous.
- **Latch:** `probeGroup` is the only group probe. Once death is confirmed
  (ESRCH) the number is never probed or signalled again. A concurrent stop
  that was already in flight cannot signal or re-probe a latched number.
- **Live path:** no SIGKILL is sent after the leader is reaped. A group that
  is still "alive" then is reported `unknown` (ownership unprovable, W4), not
  swept.
- **Behaviour change:** a leader that dies from the group SIGTERM while a
  TERM-ignoring grandchild survives is no longer SIGKILLed by `stop()`. The
  survivor is reported `unknown` and swept only by the operator path. The
  C1-F7 test was rewritten to this contract.
- **Tests:** three deterministic regressions (concurrent latch, TERM-window
  reap, central gate) use a recording `process.kill` stub and fail on the
  pre-fix code. A real-process test asserts no SIGKILL reaches the reaped
  group.

### F2 (MEDIUM): attempt-confirmed evidence must be attested, not inferred

- `RunnerPort.stop` (and `ExecutorPorts.stop`) declare the contract: the
  result carries the `attemptId` it acted on. `stop:attempt-confirmed` +
  `acked:true` are emitted **only** when the attestation exists and matches
  the pin (or ctx carries no pin). A structurally compatible runner that
  ignores the pin (or attests a successor) yields
  `stop:attempt-unconfirmed` / `act-unknown:` / acked=false / never replayed.
- Tests pin both forgeries: `{stopped:true}` without attestation, and
  attestation naming a different attempt.

### Verification (this cycle)
- `npx tsc` clean; full suite (`node --test dist/test/*.test.js`) green:
  **2,767 tests, 0 fail** (2,753 pass, 14 skipped).

## 2026-08-04 — cycle 2: close re-audit A1/A2/A3 (commit 9b82d74)

- A1: `close()` drains the writer slot (a rejected queued append must never
  strand `writerBusy` and wedge the session against every later open).
- A2: leader-exited-with-live-group stop() previously returned a misleading
  not-running verdict (cycle 1 added the real group sweep; cycle 3 replaced
  it with the verify-only + latch design above).
- A3: `stop()`/`waitForExit()` accept an `attemptId` pin and refuse on a
  successor; executor kill action, host kill-session and host abort-input
  forward the pin; evidence names the pin that applied.
