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
- **Latch:** `probeGroup` is the only probe used on the stop() path. Once
  death is confirmed (ESRCH) the number is never probed or signalled again
  by stop(). A concurrent stop already in flight cannot signal or re-probe a
  latched number. (reconcile/confirm keep their own non-latching probes.)
- **Denied KILL:** an escalation is *attempted* whether or not the kernel
  accepts the KILL; the bounded exit wait keys off the attempt, so a
  permission-denied KILL on an un-exited leader returns `unknown` within
  POST_KILL_EXIT_WAIT_MS instead of hanging.
- **Live path:** no SIGKILL is sent after the leader is reaped. A group that
  is still "alive" then is reported `unknown` (ownership unprovable, W4), not
  swept.
- **Behaviour change:** a leader that dies from the group SIGTERM while a
  TERM-ignoring grandchild survives is no longer SIGKILLed by `stop()`. The
  survivor is reported `unknown` and swept only by the operator path. The
  C1-F7 test was rewritten to this contract.
- **Tests:** deterministic regressions (central gate, TERM-window reap,
  two concurrent real `stop()` calls with one probe, denied-KILL bounded
  return) use a recording `process.kill` stub. The gate and TERM-window
  tests fail on the pre-fix code. A real-process test asserts exact
  `SIGKILL` names are never sent to a reaped group.

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
  **2,769 tests, 0 fail** (2,755 pass, 14 skipped).
- Cycle-5 follow-up (post-commit audit of `6c0e769`): the denied-KILL test
  races an independent 4 s deadline (a hang regression now fails loudly at
  the deadline — verified against the pre-`6c0e769` source); the
  post-exit "sweep while unreaped" branch in `stop()` was removed as
  unreachable (the `signalGroup` gate would refuse it and the bounded
  exit-race returns first) with comments corrected.

## 2026-08-04 — cycle 2: close re-audit A1/A2/A3 (commit 9b82d74)

- A1: `close()` drains the writer slot (a rejected queued append must never
  strand `writerBusy` and wedge the session against every later open).
- A2: leader-exited-with-live-group stop() previously returned a misleading
  not-running verdict (cycle 1 added the real group sweep; cycle 3 replaced
  it with the verify-only + latch design above).
- A3: `stop()`/`waitForExit()` accept an `attemptId` pin and refuse on a
  successor; executor kill action, host kill-session and host abort-input
  forward the pin; evidence names the pin that applied.
