# P7 audit — attempt runner & ownership recovery (REJECT)

Date: 2026-11-01 · Target: `src/runner/attempt.ts` (807 lines) + `test/attempt-runner.test.ts` (431 lines)
Method: implementer probe harness (10 live-process runs) + two independent audits on different model
families (anthropic/claude-haiku-5.5 → `audit-p7-indep-claude.txt`; meta/muse-spark-1.3-contributor →
`audit-p7-indep-spark.txt`). Channel note: `tre. run` with `--model` prints the TUI banner into the
output file; the reports below were read from the tail.

**Verdict: REJECT.** Both independent audits and the probe harness converge on the same four
contract violations, plus five more defects the audits found that the probes had not yet reached.
The unit suite is green because it only ever calls one method at a time and always stops each
attempt before the next — it never exercises the states that break.

Probes are re-runnable: `docs/audits/p7-probes/*.mjs` (run with `node`, after `tsc`).

---

## Confirmed by probe (empirical, not inspection)

### F1 — HIGH — a task cannot be retried a third time, in ONE process, no restart
`probe13.mjs`. Fresh runner, one task, sequential `run` → `stop` → `run` → `stop` → `run`:

```
attempt 1: spawned t1-a1
attempt 2: spawned t1-a2
attempt 3: REFUSED prior-attempt-unresolved — attempt t1-a1 was observed spawned ok but its liveness is unprovable
```

The `state.json` hint holds ONE attemptId per task, so on the third call only `t1-a2` has a
matching hint row; `t1-a1` has no hint, no own-child entry and therefore no probe. The spawned-ok
loop treats "no probe" as unprovable ⇒ `park` forever. **Normal recovery (retry after a failed
attempt) dies on the second retry**, before any restart is involved. Fixing this is the same fix as
F2 (bound the liveness gate to the latest tuple per session and record `pid`/`pgid` in the resolve
record), so they must land together.

### F2 — HIGH — restart recovery is O(attempt history) manual evidence
`probe1.mjs`. Two clean attempts, then a restart (empty `children`, probe says the pids are gone):

```
AFTER RESTART: REFUSED prior-attempt-unresolved
reconcile: park [ "attempt t1-a1 spawned ok but no matching pid hint exists — liveness UNPROVEN" ]
```

Every historical `spawnOutcome:"ok"` attempt becomes an independent park. Recovery costs one
`confirmStopped()` per historical attempt, per restart, and each of those appends a `"failed"`
record over a process that really did run — so the recovery ritual **falsifies the log it is
recovering from** (§14.1: `"ok"` already resolves the attempt).

### F3 — HIGH — `stop()` reports `stopped: true, escalated: false` while the group is still alive
`probe8.mjs`. Worker group = `sh -c "sh -c 'trap "" TERM; sleep 30' & wait"`:

```
group before: [ 95713, 95714, 95715 ]
stop(): {"stopped":true,"escalated":false,"code":null,"signal":"SIGTERM"}
group after : [ 95714, 95715 ]   !! LEAKED
```

`terminate()` decides escalation from the DIRECT child's `exit` event. When the leader dies on
SIGTERM, `entry.exited` is true and escalation is skipped — but the SIGTERM-ignoring grandchild in
the same detached group survives and keeps writing the session file that the next attempt is now
authorised to open. I1's "confirmed stopped" is violated, silently. (`probe7.mjs` shows the benign
case works: a TERM-respecting grandchild is reaped by the group signal.)

### F4 — HIGH — cross-task session claims are invisible when there is no live child
`probe5.mjs`. Task t2 crashed between intent and resolve on `sessions/shared.jsonl`; task t1 now
wants that same path:

```
!! t1 SPAWNED t1-a1 on a session path claimed by unresolved t2-a1
!! t1 SPAWNED t1-a2 alongside spawned-ok t2-a2 (foreign task, same session)
```

`analyze()` filters records to `r.taskId === task.taskId` and reads only `state.tasks[task.taskId]`.
§14.5 joins ownership on the (session, worktree) pair, not on the task. The only cross-task gate is
the in-memory live-child check, which does not survive a restart.

### F5 — HIGH — two concurrent `run()` calls spawn two workers with the SAME attemptId
`probe10.mjs`. Both calls pass the async fence before either registers its child:

```
run#1: SPAWNED t1-a1 pid 95741
run#2: SPAWNED t1-a1 pid 95742
both alive? [ true, true ]
after single stop(): [ '95741->true', '95742->false' ]   <- untracked worker still running
```

`children` is keyed by session, so the second spawn overwrites the first entry: the first worker is
now invisible to `stop()`, to `hasLiveChildren` and to `reconcile`, and two processes write one
session under one attemptId. The fence is `await`-heavy (`records()`, `readState()`, ps probe)
before anything is registered, so there is a wide window. A P9 that issues per-task recovery
without its own mutex reaches this immediately.

### F6 — HIGH — `confirmStopped()` repoints the pid hint backwards and can erase a live worker's hint
`probe4.mjs`. Attempt a2 is LIVE (pid captured in the hint); the supervisor confirms the OLDER,
already-stopped a1:

```
hint with a2 live:            {"attemptId":"t1-a2","pid":95651}
hint AFTER confirming old a1: {"attemptId":"t1-a1","status":"paused"}
=> a2 (pid 95651) is STILL RUNNING: true
reconcile now: running | latest= t1-a1  live= [ 't1-a2' ]
```

`writeStateHint()` is called unconditionally. After the call the hint names the worse attempt and
the live worker's pid is gone: `analyze()` no longer probes it, `reconcile()` reports the stale
attempt as `latest`, and a restarting supervisor has lost its only discovery evidence for a2. (It
still parks — fail-closed — but it parks on the wrong tuple with the wrong reason.)

### F7 — HIGH — the default spawner emits argv the real CLI rejects
`probe6.mjs` + `src/cli/main.ts`:

```
fresh : args ["--session","/x/s.jsonl","--attempt-id","t1-a1"]
resume: args ["--resume","--session","/x/s.jsonl","--attempt-id","t1-a1"]

$ tre. run --session /tmp/x.jsonl --attempt-id t1-a1 hi   -> error: unknown option: --attempt-id
$ tre. run --resume --session /tmp/x.jsonl hi             -> session: cannot read --session: ENOENT '--session'
```

There is no `--attempt-id` flag at all; `--resume` TAKES A PATH and is mutually exclusive with
`--session` (main.ts:386). `stdio: "ignore"` hides the immediate exit, and the `spawn` event still
fires, so every attempt is durably recorded `spawnOutcome:"ok"` for a worker that never ran.

### F8 — MEDIUM — `close(true)` does not release the single-writer invariant; roots are not normalized
`probe11.mjs`:

```
A) close(true)+open: second runner opened, old child alive
B) relative-root open ALSO succeeded -> two runners for one episode
```

`open()` keys on `episodeDir(root, id)` while `close()` deletes `join(root, id)`; different
spellings of the same root (relative vs absolute, trailing separator) yield different keys, and
`close(true)` unrefs live children and drops the registry entry, so a second writer can be opened
over a live worker.

---

## Confirmed by both audits (not yet probed, or not probeable without a P9)

| # | Sev | Location | Defect | Minimal fix |
|---|-----|----------|--------|-------------|
| F9 | High | `open()` | `runners.has()` check precedes `await DecisionJournal.forEpisode` — two concurrent opens both succeed | insert the placeholder **before** the first `await` |
| F10 | Med | `writeStateHint()` | unlocked read-modify-write; concurrent hint writes for different tasks drop a row | serialize under the same mutex |
| F11 | Med | `stop()` | two concurrent stops both signal and both await; `escalated` may disagree | memoize the stop promise per entry |
| F12 | Med | `stop()`, child self-exit | hint row is never updated on exit — stale `status:"running"` + dead pid survive until something else writes | rewrite the row (`paused`, no pid) on exit, under the mutex |
| F13 | Med | `writeStateHint()` | `supervisorPid: state.supervisorPid ?? process.pid` never refreshes — a restarted supervisor leaves the dead pid forever (probed: stays stale) | write `process.pid` unconditionally |
| F14 | Med | `treWorkerSpawner` / spawn stdio | `stdio:"ignore"` discards every diagnostic; the worker-failed-to-start path is invisible | per-attempt log file in the episode dir |
| F15 | Med | `confirmStopped()` | accepts `spawnOutcome:"ok"` and rewrites it `"failed"` — contradicts §14.1 | distinct outcome/decision record, or document the exception in the Change Ledger |
| F16 | Low | `defaultPidProbe` | ps exit-1-with-empty-stdout is treated as an authoritative "gone" | keep, but document the assumption (pid reuse) in the row |

## PASS areas (both audits)

Intent-before-act ordering (I2); `spawn-failed` resolving the intent as `"failed"`; numeric
attemptId allocation across all sources including the caller proposal; `resume()` session-binding
check; child-registration ordering after `spawn` but before the resolve append (no lost exit
event — `exit` is a later macrotask than `spawn`); process-group SIGTERM reaping for
TERM-respecting grandchildren.

---

## Why the suite is green

Every test stops each attempt before running the next, calls one method at a time, uses a fresh
episode per case, and never simulates a restart with history. The failures above live exactly in
the gaps: **concurrency, attempt history, group lifetime, cross-task claims, and hint staleness.**
The tests pin behaviour the code gets right and never ask the questions that matter. This is the
same failure mode as the P6 cycle-4 ACCEPT that a later independent audit overturned.

## Required remediation (ordered)

1. **Mutex + synchronous reservation** (F5, F9, F10, F11): per-instance async mutex around every
   mutating method; reserve the session slot synchronously (pending placeholder) before the first
   `await` in `run`/`resume`; use one mutex for confirm/stop/hint writes.
2. **Group-level stop evidence** (F3): after child exit, poll `kill(-pgid, 0)` until ESRCH with a
   bounded deadline; SIGKILL the group and set `escalated:true` when it survives; resolve
   `stopped:true` only on group-empty, else throw (`stop-unconfirmed`) so callers park. Document
   that a `setsid` escapee is invisible to any group probe.
3. **Durable ownership joins on session+worktree** (F4): build the claim set from ALL attempt
   records and ALL `state.tasks` rows whose `sessionPath`/`session` matches the requested session
   (and worktree when present), and refuse on any unresolved/unprovable foreign tuple.
4. **Bounded, history-aware liveness** (F1, F2): gate on the **latest durable tuple per session**,
   and treat an older `ok` tuple as superseded when a later fenced spawn exists on that session
   (that spawn could only have passed the fence if the earlier one was disproven). This makes the
   restart O(1) and kills the "manual confirm per historical attempt" ritual and its log
   falsification.
5. **Record the pid in the journal, not just the cache** (F1, F2, F6): stamp `pid`/`pgid` into the
   `ok` resolve record (sync-before-ack, authoritative) and probe from the journal; keep
   state.json as a cache only. This separates "never started" (no resolve record) from "started,
   hint lost" (resolve record, no hint) without violating I3.
6. **Hint integrity** (F6, F12, F13): only rewrite the hint when `row.attemptId === attemptId &&
   row.session === task.session`; clear/refresh on exit; always write `process.pid`.
7. **Spawner contract** (F7): fail loudly — `treWorkerSpawner` must throw `RunnerError("bad-input")`
   until the CLI has a matching flag, or the runner must require an explicit spawner; capture
   stderr to a per-attempt log; never record `"ok"` for an argv the CLI rejects.
8. **Instance key discipline** (F8): compute the key once in `open()` (`resolve()`-normalized),
   store it on the instance, use it in `close()`; `close(true)` must not release the slot while a
   child is live.
9. **Tests for every fix**, mutation-swept: the new tests must fail when the guard is reverted
   (the P6 discipline). Minimum new set: concurrent run/run, run with grandchild-ignoring-TERM,
   cross-task session claim (all three hint variants), restart with 3+ historical attempts,
   third-retry in one process, hint-integrity on old-attempt confirm, `close(true)` then open.

## Change Ledger note

The P7 row and this audit's remediation must be folded into `docs/11` §11.1 and the ledger. Until
then **the P7 row must not read "done"** — it is implemented but not accepted.
