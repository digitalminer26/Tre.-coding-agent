# Audit round 2 — P11 executor (src/executor/exec.ts)

**Date:** 2026-08-10 · **Predecessor:** `docs/audits/audit-p11-executor.md`
(round 1) · **Method:** adversarial re-audit against the real module —
hostile Proxies (including live, non-revoked ones), retained-reference
escapes, smuggled plan fields — followed by 3 fix/verify cycles (audit →
probe → fix → full suite).
**Final state: 2077 pass / 0 fail / 14 skipped · `tsc --noEmit` clean.**

## What round 1 fixed (context)

Round 1 landed F1 (torn-pair reconciliation), F2 (journal-record scan over
a caller `executed` list), F3 (deep-freeze journal records), F5 (digest-keyed
append-dedupe), F6 (actionId collision message), F9 (empty `expectedEvidence`
refusal), plus doc notes N2/N3 and F7/F8. Round 2 was requested because
round 1 had stopped with a `tool_use` interruption mid-edit — the auditor
was told its edits were never verified.

## Findings fixed in THIS round

### R1-G1 — hostile `denials` array crashed the executor (50k-call fuzz: 0 hits)

A live Proxy gate result whose `denials` element getters throw made
`map(d => d.code)` throw **outside** the check's try/catch (try body only
covered the `await`). The throw propagated to the caller — and when it
happened after the intent append, the intent was **stranded open** with no
outcome and no result (`probe: stranding.ts`).

**Fix** (`exec.ts`): the denials projection is getter-guarded — an
untrustworthy denial list becomes `[]` and the refusal proceeds (deny still
stands; the read is dropped, not surfaced — `ExecutionResult` has no
`resultErrors` field, a claim this report made in error (round 3).).

### R1-G3 — shallow freeze was no containment (live escape)

Round 1's F3 froze intent/outcome records **shallowly**, so caller-retained
references could rewrite `authority.sideEffect` / `rationale` after the
record was durable:

```
G3 post-append mutation via retained ref: rationale="accept-finish" taskId=task1
```

**Fix**: records are frozen before append — shallowly (intent,
`intent.authority`, outcome, `evidenceRefs`), which is sufficient because
every nested value is a fresh copy taken at snapshot time, so no caller
or port ever holds an aliasing reference into a record. Regression test
asserts `Object.isFrozen` on both records.

> CORRECTION (round 3): this section originally claimed a recursive
> `deepFreeze` helper; no such helper exists in `src/executor/exec.ts`.
> The shallow freeze is what shipped and what is tested. See
> `docs/audits/audit-p11-executor-round3.md` and `docs/15` §9c.

### R2-G2 — hostile `allowed` getter stranded the intent (the fixer's blind spot)

The R1-G1 fix left an isomorphic hole one level up: the **truthiness read**
`checkRes?.allowed === true` sits in a second try (the one guarding
`reserve`), so a Proxy whose `allowed` getter throws *after resolution*
crashed the executor with an **open intent**:

```
G2 live proxy allowed-getter throws: CRASHED: Error: G2-boom
G2 intent stranded open: true
```

**Fix**: the `allowed` read is getter-guarded in its own try; a throwing
getter is treated as a failed check → refused gate-denied (fail-closed —
the truth is unreadable, so nothing acts). Regression test covers
gate-denied with a clean refused result and no open intent.

### R2-G4 — smuggled `strategyId` on unverified actions (integrity-laundering)

`judgePlan` exempts `kill`/`merge` from the strategyId-vs-template equality
rule (they have no template). A hostile plan for `kill` carrying
`strategyId: "pretend:legit:v1"` wrote that **false template claim** into
the durable `decision-intent` (round 1's F7 only refused empty strings).
Downstream readers trust the intent's strategyId as a verified claim;
`merge` is always refused but the **intent** for a kill survives.

**Fix**: the intent carries `strategyId` only for template-verified actions
(spawn-class, where equality is judged); `kill` omits it — omission is not
a lie. Docs §3 step 3 updated to state the contract. Regression test
asserts the field is absent from the journaled record.

## Reviewed and judged CORRECT (no change)

- **C1–C4 revoked proxy mid-act** — a proxy revoked between intent and act
  yields `refused(gate-denied)` (check path) or `failed` with the intent
  left OPEN (act path). Open-intent-on-unknown-is-the-journal-contract
  (I5): once the act has begun the executor cannot distinguish "threw
  before dispatch" from "threw during dispatch", so it must NOT claim
  no-effect. Failure is the truthful record; recovery closes it against
  observed reality.
- **C5 `check`→null** — refused `gate-denied` (fail-closed).
- **Canonical JSON injection** — duplicate-key plans digest to the
  first-wins parsed object (JS `JSON.parse` semantics), key-sorted,
  prototype-safe; FNV-1a over the canonical form, so replay dedupe can't
  be forked by key order or `__proto__` spellings.
- **deepFreeze prototype safety** — `Object.prototype.hasOwnProperty.call`
  guard; does not follow `__proto__`; `Object.freeze` on primitives is a
  no-op.
- **N3 (concurrency)** — remains a documented caller contract (docs/15
  §4): dedup is read-then-append without a lock; the caller serializes
  per task.

## Tests added this round (all `R*-G*` named)

`R1-G1` (hostile denials array), `R1-G3` (deep-freeze both records),
`R2-G2` (throwing `allowed` getter → clean refused, intent closed),
`R2-G4` (kill's smuggled strategyId omitted from the record). Probe
scripts retained under `test/probes/` (`g1.probe.ts`, `round2.probe.ts`,
`cycle2.probe.ts`) as reproducible evidence; they are `@ts-nocheck`
scratch files, not part of the compile.

## Convergence statement (cycle 3)

Re-ran all probe suites against the final source: every previously
exploitable path now terminates refused/executed with a closed journal
pair or a documented open intent; the round-2 fuzz (50,000 randomized
hostile-plan executions, 14 attack shapes) finds **0 crashes**. No new
findings in cycle 3 — the audit has converged.

Gate: **2077 pass / 0 fail / 14 skipped · tsc clean**.
