# STATUS — attempt-lifecycle hardening (kill-window audit workstream)

## 2026-08-04 — cycle 3: post-review fixes (F1 pgid-reuse kill removed, F2 confirmed-evidence attestation)

Source of truth: `~/.tre/audits/killwin2-sol-out.txt` (clean-slate review
of the cycle-2 fixes — 2 findings, both REAL and fixed this cycle).

### F1 (HIGH): a post-exit stop() must never treat a historical group number as continuing ownership

- The cycle-2 sweep re-introduced a pgid-reuse kill window: after the leader
  is reaped the OS may reassign the group number to a stranger group, and a
  later `stop()` would SIGTERM/SIGKILL it.
- `stop()` post-exit is now **verify-only** (`verifyExitedGroup`): it probes
  `kill(-pgid,0)` and NEVER signals. Group ESRCH => `reaped` + stopped;
  group alive under a leaderless number => `stopped:false`,
  `groupStatus:"unknown"` — ownership unprovable, honest over complete (W4).
- **Permanent latch** (`groupDeathConfirmed`): once group death is proven
  the number is retired from all signalling authority — later stops answer
  the recorded verdict with ZERO kill(2) calls. The live-path
  SIGKILL-escalation verdict latches too.
- Test pins with a `process.kill` spy: the leaderless stop issues only
  probe-0 (never a signal); the post-latch stop issues NO kill(2) at all.

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
- `npx tsc` clean; full suite (`bash test/run.sh`) green: **2,764 tests,
  0 fail** (2,750 pass, 14 skipped), up from 2,757.

## 2026-08-04 — cycle 2: close re-audit A1/A2/A3 (commit 9b82d74)

- A1: `close()` drains the writer slot (a rejected queued append must never
  strand `writerBusy` and wedge the session against every later open).
- A2: leader-exited-with-live-group stop() previously returned a misleading
  not-running verdict (cycle 1 added the real group sweep; cycle 3 replaced
  it with the verify-only + latch design above).
- A3: `stop()`/`waitForExit()` accept an `attemptId` pin and refuse on a
  successor; executor kill action, host kill-session and host abort-input
  forward the pin; evidence names the pin that applied.
