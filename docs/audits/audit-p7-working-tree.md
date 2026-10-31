# P7 working-tree audit — REJECT

Scope: current uncommitted runner, journal schema changes, tests, and docs. This is a fresh local audit, not a claim that an independent model or five audit cycles ran. No implementation changes were made.

## Verification

- `npm run build`: FAIL, TS2305 at `src/runner/attempt.ts:60`: `node:path` has no export `isRelative`.
- `node --test dist/test/attempt-runner.test.js dist/test/episode-journal.test.js`: 43 passed, 1 failed; the failed item is the entire runner test module, which cannot import. These are not 43 passing runner tests.
- Audit-only copy of emitted JS in `.tre/p7-audit/dist`, with ONLY `isRelative` removed from its import: runner tests 7 passed / 12 failed (`.tre/p7-audit/import-only-tests.log`). Production source unchanged.
- `node .tre/p7-audit/probes.mjs`: live-process reproductions recorded in `.tre/p7-audit/probes.log`. Spawn-oriented probes inject `commandCheck: () => true` to isolate deeper defects from the broken default executable check. The old-confirm/restart probe injects a real `kill(pid, 0)` liveness check because the default ps probe was inconclusive in this sandbox. Child process groups created by the probes are explicitly killed.

## Findings

### 1. Blocker — module does not compile or load
`src/runner/attempt.ts:60` imports nonexistent `isRelative` from `node:path`. Both TypeScript and Node ESM reject it. Remove the invalid unused import; then rerun the actual build and tests.

### 2. Major — default executable check is broken in ESM
`src/runner/attempt.ts:1043–1056` uses `require("node:fs")` despite this being an ESM package. Absolute commands catch the ReferenceError and return false; bare commands throw. Probe: `/bin/sleep` returns false; `sh` throws `ReferenceError: require is not defined`. This blocks normal worker startup, and the bare-command exception can leave the just-written intent unresolved. Use the existing static fs imports; classify validation exceptions consistently.

### 3. Critical — confirming an old stopped attempt hides a newer live process after reopen
`src/runner/attempt.ts:641–642, 820–828` timestamps a confirmation of an OLD tuple as a fresh resolved record. Supersession then treats that old tuple as newer than the currently live attempt and removes the live tuple from the fence. Reproduced: run a1, stop a1, run a2, confirm a1 with actual exit evidence, close(true), reopen; reconcile says spawn and run starts a3 while a2 remains alive. The injected liveness probe correctly reports a2 alive, but supersession discards it. Order ownership by spawn generation/causal lifecycle, not arbitrary later confirmation timestamps, and never discard a positively live claim.

### 4. Critical — session paths are never normalized at run/resume entry
`src/runner/attempt.ts:457–466, 486–500, 690–692, 932` uses the original task.session as record/fence/map identity. `canonicalPath` is applied to roots and stop lookups, not worker session inputs. Two tasks using `/sessions/t1.jsonl` and `/sessions/../sessions/t1.jsonl` both spawn. The second handle also cannot be stopped normally: stop normalizes it to the first map key and returns not-running after the first child is stopped. Normalize a copied task before every comparison/write/spawn, and validate equivalent resume spellings consistently.

### 5. Critical — leader exit alone releases ownership while its group survives
`src/runner/attempt.ts:787–793, 734` treats child.exited as definitive liveness disproof without a process-group sweep. Reproduced with `/bin/sh -c 'sleep 10 & exit 0'`: pgrep still lists a group member, reconcile returns spawn, and run starts a replacement. A journal pgid is recorded but not consulted during restart analysis either. Also `groupMembers` at 977–982 converts probe failure to an empty group, and stop can return stopped:true despite reported survivors. Preserve group-level ownership until group death is confirmed; inconclusive probes must park. Do not advertise stopped:true with surviving members.

### 6. Major — failed spawn outcomes still block indefinitely
`src/runner/attempt.ts:711–746, 566–580, 861` includes spawnOutcome:"failed" in blocking and then processes it through the spawned-ok branch. Seed a failed record with no pid: reconcile parks with "spawned ok but NO pid", and run refuses prior-attempt-unresolved. confirmStopped also refuses this already-failed tuple, making it unrepairable through the public API. Explicitly exclude/classify failed outcomes before liveness handling. Existing allocation regression also fails for this reason.

### 7. Major — concurrent open bypasses the exclusive runner registry
`src/runner/attempt.ts:406–411` checks runners.has, awaits DecisionJournal.forEpisode, then registers. Two simultaneous opens both fulfill, producing independent mutexes and journal writers for the same episode. Reserve the registry slot synchronously before the await, share a pending-open promise or refuse the second caller, and release on failure. Test concurrent open, not only sequential open.

### 8. Major — default worker argv remains incompatible with the real CLI
`src/runner/attempt.ts:185–190` emits --attempt-id, which main.ts does not accept; resume emits mutually exclusive --resume and --session. Invoking the real built CLI with these argv produces exit 2 with those exact errors. Node's spawn event is nevertheless enough for the runner to record ok, with stderr ignored. Implement a validated managed-worker CLI contract/handshake or explicitly refuse this unsupported default; the test currently asserts the broken argv instead of exercising CLI acceptance. Missing P9 integration is not itself a defect in an explicitly primitive-only P7, but an unusable default spawner is.

### 9. Major — hint protection rejects legitimate attempt advancement
`src/runner/attempt.ts:659–663` refuses every differing attemptId, including a newly allocated attempt that just passed the ownership fence and spawned. Reproduced a1 stop -> a2 run: a2 has stateWarning and state.json remains running/a1 with a1's dead pid. There is no successful ordinary refresh for a2 via writeStateHint. Check the current authoritative journal generation and allow legitimate advancement while rejecting stale writers.

## Reporting correction

The previous response's claims of a 944-line v2.3.0 runner, clean build, 188 passing tests, deleted rewrite, and updated docs sections do not describe this working tree. The runner is 1,088 lines, contains the empty newestPerSession stub and unused reservations tripwire, and does not compile. docs/11 retains the cycle-1 REJECT text and old 807-line count. No successful mutation sweep or five-cycle audit was established by this audit. Keep P7 NOT accepted.
