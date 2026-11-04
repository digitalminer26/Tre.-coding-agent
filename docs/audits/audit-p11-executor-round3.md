# Audit round 3 — P11 executor (src/executor/exec.ts)

**Date:** 2026-11-05 · **Predecessors:** `audit-p11-executor.md` (R1),
`audit-p11-executor-round2.md` (R2) · **Method:** new attack surface —
rounds 1–2 hardened the **gate** reads (`allowed`, `denials`); round 3
audits the **act site**, i.e. reads of port-returned data performed
*after* the effect has landed.
**Final state: 2080 pass / 0 fail / 14 skipped · `tsc --noEmit` clean ·
74 executor tests.**

## The round-2 blind spot

Rounds 1 and 2 found the same bug class twice at the gate and fixed it
twice at the gate. Both fixes guarded *reads of port-returned values*
with a local try/catch. The act site does exactly the same reads — and
one of them sits inside a catch that **claims the act had no effect**.
Nobody asked what that claim is worth when the throw happens after
delivery.

## Findings

### R3-B1 (CRITICAL) — a delivered act was reported as "no effect" and re-executed

The act catch journaled `no-effect: act-failed <name>` for **every** throw
inside the act switch. But a port can deliver its effect and *then* fail:
a spawn that succeeded whose returned value cannot even be awaited
(revoked Proxy — the promise rejects), an escalation already sent whose
`channel` read traps. The `no-effect:` marker is precisely what makes an
action **replayable** (§4 step 2), so the executor invited a second
execution of work that had already happened:

```
1st: failed act | 2nd: (re-executed)
SPAWNS = 2
notes: [ 'no-effect: act-failed TypeError', 'no-effect: act-failed TypeError' ]
```

Two workers spawned, two durable records both asserting nothing happened.
This is the E3/I5 violation the whole dedup machinery exists to prevent.

**Fix:** an `effectStarted` flag is set immediately *before* each
delivering port call. A throw with `effectStarted === false` is a
**provable** no-effect and keeps the replayable marker; a throw after it
is UNKNOWN and journals `act-unknown: act-failed <name>` — a note without
the `no-effect:` prefix, which the dedup scan reads as "not replayable".
`kill` and the dispatch actions were the same latent shape and are
covered by the same flag. Post-fix: `SPAWNS = 1`, second call
`refused(already-executed)`.

### R3-B2 (HIGH) — post-delivery result reads could downgrade a delivered act

`runner.run`/`resume`'s `attemptId`, `stop`'s `stopped`, `rewriteTask`'s
`taskRevision` and `escalate`'s `channel` were all read with plain
property access. A hostile (or merely revocable) port value threw, and
the throw was laundered as a failed act. Fixed with `portField()` /
`readAttemptId()` — fence-safe own-property reads that can no longer
fail the act they follow. `reconcile`'s verdict is read the same way.

### R3-B3 (MEDIUM) — the journaled `rationale` was unbounded

`rationale` is validated as ≤ 64 strings of ≤ 512 chars, then joined into
ONE journal field — 32 KiB per record, with no journal-side limit
(`src/episode/journal.ts` validates `rationale` as a bare `str`).

```
B4 rationale length in journal record = 32831
```

Fixed with `MAX_RATIONALE = 4096` at the join. (Not a classic overflow,
but a durable record is an attacker-influenced write into the journal.)

### R3-B4 (LOW) — `portEvidence` accepted sparse arrays

Now `Object.hasOwn`-guarded, matching the P14 S-F3 discipline already
applied to plan arrays.

## Tests

`R3-B1` (double-spawn regression: `spawns === 1`, non-replayable note,
second call refused), `R3-B2` (delivered escalate never says no-effect),
`R3-B4` (bounded rationale). Two pre-existing tests encoded the *old*
contract and were corrected, not weakened:

- `§4: no-effect outcome permits replay…` — now seeds a genuine gate
  denial (the case where no-effect is provable) instead of an act throw.
- `§5: act port throws…` — now asserts the note is `act-unknown:`, i.e.
  the test flipped from pinning the vulnerability to pinning the fix.

## Findings from the round-2 audit review, now corrected

The R2 report overclaimed in three places; `docs/15` §9c records the
truth:

- R2 wrote "a `deepFreeze` helper applied to every record" — the code
  freezes shallowly (intent, `intent.authority`, refs, outcome). Nested
  values are safe because everything is re-copied at snapshot time, but
  the doc sentence was wrong.
- R2 wrote that `resultErrors` "carries the hostile read" — no such
  field exists in `ExecutionResult`.
- R2's "50,000 randomized hostile-plan executions, 14 attack shapes"
  has no artifact in the tree; the fuzz file is not wired to anything.

## Convergence

The fuzz and probe suites now terminate with a single spawn, a
non-replayable record, and no stranded intent. Remaining known-open item
is unchanged and by contract: **N3** (the caller must serialize per task —
dedup is read-then-append without a lock).

Gate: **2080 pass / 0 fail / 14 skipped · tsc clean**.
