# P15 — Investigation & Recovery Agent (contract & as-built surface)

> Status: CONTRACT (drafted 2026-11-05, implemented 2026-11-05). Module:
> `src/investigation/agent.ts`. Consumed by P9/M1 composition (the executor's
> `investigate` dispatch, docs/15 §3 `DispatchPorts.investigate`, calls this
> module) and feeds the P10 planner as its `diagnosis` input (docs/14 §1).
> Parent plan: docs/11 §11 P15 row, §9 (recovery ladder + §9.1 self-healing
> policy), §14.3 (`kind:"diagnosis"` record), §14.7 (episode policy
> `authority.diagnostics`), §14.8 (`workerState` closed set).

## 0. Purpose & boundary

P15 answers exactly one question: **on an interruption signal, over a
bounded evidence packet and a bounded set of diagnostic probes, what
cause class best explains the stopped/blocked worker — recorded as a
§14.3 `diagnosis` record that is ADVICE ONLY (§0.7: no authority
transfer)?**

Normative source sentences (docs/11 §11 P15 row):

- "Event-triggered, tool-capable diagnosis over a bounded evidence
  packet; tools run through P8/P11. Distinguish transient errors,
  premature stops, task defects, environment blockers, and approval
  boundaries. Produce structured diagnosis, uncertainty, strategy,
  expected evidence, and proposed actions."
- "Different strategies may be tried within the aggregate budget;
  repeated generic nudges are not healing."
- §14.3 expectedEvidence for `investigate`: "bounded diagnosis record:
  a causeClass or an explicit exhaustion marker".

Boundary rules:

1. **Advice, never permission.** The diagnosis record grants nothing.
   P10 re-validates it (own fence, `PLANNER_CAUSE_CLASSES`, confidence
   bar 0.7) and P8 gates the chosen action. This module never calls a
   runner, never touches a worktree, never appends to the journal —
   the CALLER (P9) appends the returned record.
2. **Rules-only classification.** The cause class is computed by a
   closed deterministic rule table over validated facts (§3). The
   model judge (JudgePort) is strictly advisory (§4): it may fill in
   ONLY an `unknown` classification, its confidence is clamped below
   the planner's 0.7 bar (`JUDGE_CONFIDENCE_CAP = 0.69`), and it can
   never overwrite a deterministic classification. A model opinion
   therefore can never take the two planner paths that require
   confidence >= 0.7 (`environment-blocker` escalation,
   `approval-boundary` L3) by itself.
3. **Probes, not tools.** The module never executes a caller-named
   tool. It owns a closed probe table (§5) and asks the injected
   `DiagnosticToolPort` for those probes only. Probe RESULTS are
   hostile input: only the closed fact-patch keys (§3.2) at correct
   types are merged; everything else in a probe result is dropped.
   Probe-side effects are the caller's governance problem: every probe
   is read-only BY CONTRACT (§5) and the P9 wiring enforces it through
   P8's `diagnostics` grant (`authority.diagnostics.maxToolCalls` /
   `maxUsd`, §14.7).
4. **Bounded by construction (I7/§9).** Tool calls are capped by
   `limits.maxToolCalls` AND by the number of probes in the table
   (each probe runs AT MOST ONCE per investigation — re-running the
   same probe is the "repeated generic intervention" pattern §9
   prohibits). Spend is capped by `limits.maxUsd`; per-probe estimate
   charges BEFORE the call (a probe is never started when its own
   estimate would cross the cap). Zero/negative limits mean zero port
   calls. Every budget actually spent is reported in the record's
   `limitsRespected`. A NEGATIVE finite `limits.maxUsd` is not bad
   input: it clamps to `$0` (same zero-call rule); only a
   present-but-unusable value (`NaN`, ±`Infinity`, non-number) marks
   `bad-input:limits`.
5. **Fail-closed, never throws (INV-1).** Malformed, hostile, or
   getter-laden input still yields a VALID §14.3 diagnosis record —
   worst case `causeClass:"unknown"`. Rejected input is DISCLOSED, not
   silent: a packet handle that throws when probed (revoked/trapping
   proxy) or a hostile-but-present `limits` handle each contribute a
   `bad-input:*` evidence marker (`bad-input:packet`,
   `bad-input:limits`); a self-check failure degrades to
   `bad-input:self-check`. Fields that are merely absent (including an
   explicit `undefined` VALUE) or the wrong type are dropped WITHOUT a
   marker (a missing optional field is not bad input); only a present
   field whose value is neither absent nor coercible marks
   `bad-input:limits`. A throwing tool port is a failed probe, not a
   failed investigation.
6. **Self-containment (the P10/P14 pattern).** The module imports
   NOTHING at runtime (not even `node:` builtins). Closed-set drift is
   pinned by drift-guard tests against the REAL exports of
   `src/planner/plan.ts` and `src/episode/journal.ts`; output records
   are pinned to pass `validateSupervisorRecord` by test.

## 1. Inputs

```ts
interface InvestigationPacket {
  id: string;                 // caller-stable record id (P9: `${actionId}#diag`)
  episodeId: string;
  taskId?: string;
  attemptId?: string;
  // (no taskRevision: the §14.3 diagnosis shape has none)
  /** The triggering signal (docs/11 §14.3 DECISION_SIGNAL_KINDS). */
  signal?: { kind: DecisionSignalKind };
  /** §14.8 workerState at trigger time (closed set; invalid ⇒ dropped). */
  workerState?: string;
  stale?: boolean;            // envelope-level stale flag (§14.8)
  runEndReason?: string;      // from the runEnd record (free text, bounded)
  signalDetail?: string;      // bounded free text from the signal
  /** Tail error candidates (bounded, each ≤ MAX_STR, first MAX_ERRS kept). */
  errors?: { source: string; text: string }[];
  guardFires?: number;        // same-guard recurrence count
  facts?: FactPatch;          // §3.2 closed fact set (validated on read)
  acceptance?: {              // latest P14 assessment (advisory framing)
    verdict: 'complete' | 'incomplete' | 'blocked' | 'uncertain';
    remainingWork?: string[];
  };
  evidenceRefs?: string[];    // packet refs — copied, never invented from
}

interface InvestigationLimits {   // from episode policy authority.diagnostics
  maxToolCalls?: number;      // [default 20, clamped to probe-table size;
                              //  fractional budgets FLOOR to the integer
                              //  below — a fractional cap never admits an
                              //  extra probe (cycle-A4 audit R2)]
  maxUsd?: number;            // [default $0.50]
}

interface InvestigationPorts {
  now: () => number;                    // REQUIRED — no Date() in the module
  tools?: DiagnosticToolPort;           // §5
  judge?: JudgePort;                    // §4
}
```

All fields are read through an own-data-descriptor fence (the P10
snapshot pattern): accessors are never invoked, inherited properties are
never read, arrays are copied index-wise under a once-observed length.
A hostile `packet`/`ports` handle can make even `Object.getPrototypeOf`
or `getOwnPropertyDescriptor` THROW (a revoked Proxy survives `typeof`
but traps `[[GetPrototypeOf]]`), so every fence read — including the
port method resolution (`tools.run` / `judge.judge`, resolved ONCE and
bound to the handle) — is wrapped: a throwing trap is treated as
"missing" (fail-closed), it never propagates across this boundary
(INV-1). A packet whose `typeof` passes but whose proto read throws is
disclosed as `bad-input:packet`; a `limits` getter that throws is
disclosed as `bad-input:limits` (a throwing getter is distinguishable
from an absent property, so it is NOT silently "missing").

## 2. Output

`investigate()` returns a frozen `DiagnosisRecordFields` — exactly the
docs/11 §14.3 `kind:"diagnosis"` shape (plus `schema`/`kind`/envelope):

```ts
{ schema: "tre-supervisor/1", kind: "diagnosis", id, ts, episodeId, taskId?,
  attemptId?, causeClass, confidence,
  evidenceRefs: string[],           // packet refs (copied) + rule/probe/judge markers
  proposedActions: [ { rung, action, strategyId, authorityNeeded } ],
  limitsRespected: { toolsUsed, spendUsd } }
```

- `evidenceRefs` composition (I3 — copied, never invented): the
  module's OWN observation markers come FIRST — `rule:<id>`, then
  `text:<factKey>` derivation markers (and `packet:stale` when the
  envelope's stale flag is set), then probe markers/evidence refs
  (`probe:<id>:ran` / `:failed` / `:skipped-budget` or the port's own
  `evidenceRef`), then `judge:advisory` / `investigation:exhausted` /
  `bad-input:*` markers — THEN the packet refs that survived
  validation. Markers are reserved before packet refs (cycle-A4 audit
  R4): a packet flooding `evidenceRefs` can evict other packet refs
  but never the record's own provenance. Packet refs may NOT carry
  module-origin prefixes (`rule:`, `text:`, `probe:`, `judge:`,
  `investigation:`, `bad-input:`, `packet:`, `refs:`) — such refs are
  forged provenance, dropped, and disclosed with `refs:spoofed`
  (cycle-A5 F3). The truncation decision counts UNIQUE usable refs
  (duplicates consume no slot, cycle-A5 F5); when packet refs are
  dropped to the `MAX_REFS` cap the record discloses it with
  `refs:truncated` (appended before the surviving refs, so the
  disclosure can never be crowded out). The ingestion window is also
  disclosed: `evidenceRefs` is copied through a `MAX_REFS`-bounded
  fence, and a flood larger than the window that carried content NONE
  of the copied refs had (cycle-A5 R1 — such entries were previously
  dropped at ingestion with NO disclosure) forces `refs:truncated`
  too; pure duplicates past the window disclose nothing (nothing
  unique was lost, cycle-A5 F5). The scan itself is BUDGETED at
  `COPY_SCAN_BUDGET` = 16 × `MAX_REFS` indices (cycle-A6 F1): a packet
  may declare `length` up to 2^32−1 with no entries behind it, and the
  pre-A6 per-index walk over such a sparse array stalled the module
  for minutes. Exhausting the budget with entries unvisited is itself
  disclosed — `bad-input:scan-budget` plus `refs:truncated` (the
  unvisited tail can never be PROVEN duplicate, so F5's
  duplicates-disclose-nothing rule cannot apply). The module never
  fabricates a ref pointing at something it did not see.
- `proposedActions` are built EXCLUSIVELY from the module's closed
  table (§6) keyed on the FINAL cause class. A packet or judge cannot
  inject proposed actions; the table's rungs and strategy ids are the
  planner's own `ACTION_RUNG`/`STRATEGY_TEMPLATES` values (drift-pinned).
- `confidence` is always present, clamped to `[0, 1]`.
- `limitsRespected.toolsUsed/spendUsd` are the ACTUAL consumption.

## 3. Classification (rules-only, closed)

### 3.1 Rule table

Evaluated in PRIORITY order; first hit classifies. Each hit contributes
a `rule:<id>` evidence marker. Confidences split into **confirmed**
(≥ 0.7 = the planner bar; the class came from durable/observed facts
and is actionable as-is) and **tentative** (0.6–0.65 = a signal-only or
TEXT-derived match; investigation must confirm it via a probe before
the confidence crosses the bar — "an uncertain diagnosis triggers
investigation, not immediate escalation", docs/11 §0). `unknown` is 0.3.

| priority | rule id | condition | class | conf |
|---|---|---|---|---|
| 1 | `approval-pending` | `facts.approvalPending` (explicit, 0.95) ∨ text-derived approvalPending (0.6) ∨ `signal.kind = worker-blocked-on-approval` ∨ `workerState = await-approval` | approval-boundary | as shown |
| 2 | `environment-blocker` | EXPLICIT `diskFull` 0.95 / `permissionDenied` 0.9 / `missingBinary` 0.85; TEXT-derived any ⇒ tentative 0.6 | environment-blocker | as shown |
| 3 | `endpoint-failure` | EXPLICIT `rateLimited` 0.9 / `endpointHttp5xx` 0.85 / `endpointUnreachable` 0.85; TEXT-derived any ⇒ tentative 0.6; `signal.kind = endpoint-error` or `runEndReason ∈ {endpoint-error, transport-error}` ⇒ tentative 0.6 | transient-endpoint | as shown |
| 4 | `gate-failed` | EXPLICIT `facts.gatePass === false` | task-defect | 0.85 |
| 5 | `premature-stop` | ended/abnormal state (`workerState ∈ {stopped, warned, dead}` ∨ `signal.kind ∈ {guard-stop, worker-exit, no-advance, verify-gap, semantic-loop, warn-rung}` ∨ `guardFires ≥ 2`) ∧ `acceptance.verdict ≠ complete` | premature-stop | 0.65 if `incomplete`, else 0.55 |
| 6 | `no-evidence` | otherwise | unknown | 0.3 |

Confirmations (applied after merging probe facts, BEFORE the loop's
bar check — they are what the probe loop exists to earn):

- `transient-endpoint` + explicit `endpointReachable === true` ⇒ 0.95
  (endpoint seen ALIVE at investigation time — the retry-able case).
  `endpointReachable === false` ⇒ 0.9 (confirmed-dead endpoint IS an
  endpoint failure). Never changes the class.
- `premature-stop` + explicit `workerClaimedComplete === true` ⇒ 0.8:
  the textbook "stopped early believing it was done" case.
- Any rule upgraded from TEXT-derived to EXPLICIT by a probe takes the
  rule's explicit confidence.

Tentative classes staying below the bar are honest outcomes: the
planner treats sub-bar `environment-blocker`/`approval-boundary` as
"investigate, don't escalate" (docs/14 §2) — fail-closed by design.
A rule hit is NEVER demoted by the judge; only the `unknown` class may
be replaced (§4).

### 3.2 Closed fact set (the ONLY mergeable probe/packet input)

```ts
interface FactPatch {
  approvalPending?: boolean;
  diskFull?: boolean;
  permissionDenied?: boolean;
  missingBinary?: boolean;
  rateLimited?: boolean;
  endpointHttp5xx?: boolean;
  endpointUnreachable?: boolean;
  endpointReachable?: boolean;
  gatePass?: boolean;
  workerClaimedComplete?: boolean;
}
```

Packet `facts` and probe results contribute ONLY these keys at
`boolean` type (own-data descriptor, once read); everything else in
either is dropped. Explicit (packet or probe-observed) facts shadow
text-derived ones.

### 3.3 Text-pattern derivation (deterministic, closed)

`errors[].text` + `signalDetail` (bounded, lowercased) are scanned for
a FIXED substring table — no regexes on caller data, no matching beyond
this table. Each scanned **unit** is ONE error text or the signalDetail
(the first MAX_ERRS errors, accumulated text capped at MAX_TEXT chars;
a unit is itself truncated to MAX_TEXT). A hit derives the named fact
(tentative; explicit facts always shadow it). Substrings: `rateLimited`
← "429" / "rate limit" /
"too many requests" / "quota exceeded"; `endpointHttp5xx` ← "bad
gateway" / "service unavailable" / "overloaded" / "status 500" /
"status 502" / "status 503" / "status 504"; `endpointUnreachable` ←
"econnrefused" / "econnreset" / "socket hang up" / "fetch failed" /
"could not connect" / "name resolution" / "timed out" / "timeout"
(when endpoint context, i.e. the SAME UNIT also carries a rateLimited
or endpointHttp5xx substring hit, OR `signal.kind = endpoint-error`); `permissionDenied` ← "eacces" /
"permission denied"; `diskFull` ← "enospc" / "no space left";
`missingBinary` ← "command not found" / "spawn enoent";
`approvalPending` ← "awaiting approval" / "waiting for approval" /
"approval required". Derivations are recorded as
`text:<factKey>` evidence markers — text matches are visible, not
silent facts.

## 4. JudgePort (advisory ceiling)

```ts
interface JudgePort {
  judge(req: { episodeId: string; taskId?: string; facts: FactPatch;
               workerState?: string; signal?: string }):
    Promise<{ causeClass?: string; confidence?: number } | void>;
}
```

Consulted ONLY when the deterministic classification is `unknown` AND
the probe loop produced no upgrade. The response is hostile:
`causeClass` must be in the closed enum (else dropped), `confidence`
finite (else 0) and is CLAMPED to `JUDGE_CONFIDENCE_CAP = 0.69` —
strictly below the planner's actionable bar (the cap applies to ANY
output, including a reported 1.0; a missing confidence reads as 0).
Success records `judge:advisory` among the module's reserved markers
(§2 composition — never evictable by packet refs). A throwing or
rejecting judge is swallowed (the record stays `unknown`). The judge
never adds facts, proposed actions, or refs, and its model cost is NOT
charged to `limitsRespected.spendUsd` (P8 prices harness model calls
through the usage ledger; `spendUsd` counts probe spend only).

## 5. Probe table (closed, run-once, read-only by contract)

| probe id | charged estimate (usd) | merges facts | intent |
|---|---|---|---|
| `probe-endpoint` | 0.02 | endpointReachable, endpointHttp5xx, rateLimited | is the endpoint alive? |
| `probe-env` | 0.02 | missingBinary, permissionDenied, diskFull | is the sandbox usable? |
| `probe-gate-rerun` | 0.10 | gatePass | does the episode gate fail deterministically? |
| `probe-worker-tail` | 0.01 | workerClaimedComplete | did the worker claim completion? |

Selection order: probes addressing the CURRENT leading candidate
cause's confirmation first (transient→endpoint, env→env,
task-defect→gate-rerun, premature-stop→worker-tail), then all
remaining probes in table order, until confidence ≥ 0.7 or the
loop runs out of affordable/untried probes. The port request is
`run({ probe, episodeId, taskId, attemptId })` — the module sends no
arguments the port can treat as a command channel beyond these.

Port result handling (hostile): `{ facts?, evidenceRef?, usd? }` —
facts filtered per §3.2; `evidenceRef` a non-empty string bounded to
MAX_STR (else the probe contributes `probe:<id>:ran` as its own
marker); `usd` finite non-negative, and applied as
`max(reported, estimate)` (cycle-A5 F2/F4): a report may ADD to the
probe's charged estimate — a genuine overage stands in full in
`limitsRespected.spendUsd` — but may never reduce it, so reporting `0`
cannot refund the charge and re-open the budget. An absent or invalid
`usd` leaves the estimate spent. A throw,
rejection, or non-object result ⇒ marker `probe:<id>:failed`, the
charge stands, loop continues.

Exhaustion: loop ended with `causeClass === "unknown"` ⇒
`investigation:exhausted` appended (the §14.3 exhaustion marker).

## 6. Proposed actions (built-in table, advice only)

Keyed on the FINAL class (values drift-pinned to planner
`ACTION_RUNG` / `STRATEGY_TEMPLATES`):

| class | proposedActions |
|---|---|
| transient-endpoint | `backoff-retry` |
| premature-stop | `evidence-nudge-resume`, then `investigate` |
| task-defect | `repair` (`authorityNeeded:"worktree-local"`) |
| environment-blocker | `investigate` (below bar), `escalate` (at/above bar) |
| approval-boundary | `escalate` |
| unknown | `investigate` |

## 7. Invariants (named tests)

- **INV-1 never-throws:** garbage/hostile/getter/Proxy input and a
  throwing port/judge still yield a record that passes
  `validateSupervisorRecord`.
- **INV-2 advice ceiling:** judge output cannot reach confidence ≥ 0.7
  nor overwrite a deterministic class.
- **INV-3 bounded:** `toolsUsed ≤ min(maxToolCalls, probes)`; each
  probe at most once; no probe started once its estimate would cross
  `maxUsd`; zero limits ⇒ zero port calls.
- **INV-4 closed merge:** probe facts merge only §3.2 keys; a probe
  result cannot inject `causeClass`, proposed actions, or refs.
- **INV-5 refs copied:** every non-marker evidenceRef traces to the
  packet; the module invents no refs (markers are its own observations).
- **INV-6 determinism:** same packet + same scripted ports ⇒ deep-
  equal records except `ts` (injected clock).
- **INV-7 record validity:** output passes the journal's
  `validateSupervisorRecord` for every test-produced record.
- **INV-8 no authority:** the module performs no journal append, no
  runner call, no fs access — asserted by compartment guard.
- **INV-9 compartment:** `src/investigation/agent.ts` imports NOTHING
  (not even `node:`); nothing outside P9/tests imports it yet.

## 8. Wiring notes for P9

- P9 calls `investigate(packet, { now, tools, judge })` from the
  executor's `dispatch.investigate`, appends the returned record with
  `DecisionJournal.append` (it satisfies the journal's `diagnosis`
  schema), then re-enters the P10 planner with it as `diagnosis`.
- `limits` come from graph policy `authority.diagnostics` (§14.7);
  P8's `diagnostic-limit-exceeded` denial at the executor gate is the
  authority enforcement — this module's caps are the SECOND,
  belt-and-braces bound on its own loop.
- Charge spent diagnostic USD to the P8 ledger under the episode
  recovery budget (the record's `limitsRespected.spendUsd` is the
  amount to charge).
