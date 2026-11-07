# P13/M1 — Human escalation channel (contract & as-built surface)

> Status: CONTRACT (drafted 2026-12-11, implemented 2026-12-11). Modules:
> `src/escalation/channel.ts` (pure record/queue logic),
> `src/telegram/escalation.ts` (the ONE orchestrator-owned Telegram consumer).
> Consumed by P9/M1 composition: the module's dispatcher conforms to the
> executor's `DispatchPorts.escalate/park` (docs/15 §3) and is injected by
> the host as `executorPorts.dispatch`. Parent plan: docs/11 §11 P13 row
> (M1 slice: "an actionable escalation channel with evidence, attempts,
> blocker, and exact decision needed; Telegram has one orchestrator-owned
> consumer"), §9 (rung 5: park + escalate — "Telegram digest with evidence
> refs; human decides"), §9 hygiene (no repeat spam — the supervisor obeys
> anti-loop rules too), §13.2 I5 (ambiguous effects escalate), §11.2
> (compartment rules). Deferred P13 slices (NOT in this contract): matrix
> lanes, dashboard transport, episode replay UI, meta-telemetry.

## 0. Purpose & boundary

P13/M1 answers exactly one question: **when automated recovery stops and a
human must decide, is there a durable, actionable, non-spammy escalation
record — blocker, evidence, attempts, and the exact decision needed —
delivered to exactly one consumer, with the answer path recorded?**

Boundary rules (invariants, pinned by tests):

1. **INV-1 record-only.** The channel module never sends anything itself:
   delivery is an injected `DeliverPort`; the module builds records,
   appends them through an injected `AppendPort`, and calls the deliver
   port. It never imports node: beyond `node:crypto`, never touches fs,
   process, or a network API (guarded by source scan).
2. **INV-2 append-before-deliver (durability precedes delivery).** The
   escalation record is appended BEFORE any deliver call. A deliver throw
   (or a non-record return) is disclosed on the result as
   `delivery: { ok:false, error:<name> }` — the record stands, `raise`
   never rejects, and the human-visible failure surfaces in `pending()`.
   This is docs/15 §4 "intent-before-act" inverted: the durable record is
   the promise; delivery is the act whose failure never erases it.
3. **INV-3 closed sets.** `blocker` ∈ the §2 blocker table; a missing,
   non-string, or unknown blocker becomes `'unknown'`. `resolution.decision`
   ∈ the §4 closed set; anything else is rejected (returns null, record
   untouched). Schema string is the fixed `'tre-escalation/1'`.
4. **INV-4 hostile input fails closed, never throws.** Every caller-supplied
   handle is read through the P10/P11/P15 fence (own-data descriptors only,
   accessors never invoked, arrays copied under once-observed re-verified
   length, throwing getters → the field drops or, for the top object, a
   minimal honest `unknown` escalation). **Replayed lines are the same
   hostile class** (`read()` output may carry foreign/appended lines):
   schema/kind and every field pass the same fence; a trapping line is
   skipped like a corrupt one — `pending()`/dedup never throw (audit A1).
   Bounds: `evidence` ≤ 16 entries PLUS a possible 17th `'truncated'`
   marker, `attempts` ≤ 10 entries, each string ≤ 240 chars; overflow
   truncates and appends the marker `'truncated'` to evidence. A record
   that survives the fence is always a VALID record (total function).
5. **INV-5 dedup & re-notice (§9 anti-spam).** The dedup key is
   `(episodeId, taskId, blocker)`. `raise` for a key with an OPEN
   escalation does NOT deliver again by default: it appends an updated
   open record carrying `reNotice: n` (n = prior count + 1) and reports
   `delivered: false, reason: 're-notice'`. Delivery on a re-notice happens
   ONLY when `evidenceDigest` differs from the open record (new evidence =
   genuinely new state) OR `force: true` was passed — and never past
   `maxRedeliver` (default 3) total deliveries for the key. The count is
   kept in a process-lifetime LEDGER (cycle-3 F2): a resolve clears the
   open mirror but NOT the ledger, and replay re-seeds it from the durable
   `deliveredCount`s, so re-raising a resolved question does not restart
   the budget. The cap is checked UNCONDITIONALLY before composing (cycle-3
   F2): `maxRedeliver: 0` means "record, never deliver" — the first raise
   is capped too. Silence after
   the cap is deliberate: §9 — repeated notices of the same unresolved
   blocker are spam, and the episode stays parked.
6. **INV-6 stable ids.** `escalationId = 'esc-' + sha256(len(ep)+ep+len(tk)+tk+blocker)[0..16]`
   — fields are LENGTH-PREFIXED (cycle-2 F4: with an unescaped `|`,
   `('a|b','c')` and `('a','b|c')` hashed to ONE id and merged two
   distinct questions into one dedup key).
   — the dedup key IS the identity hash: the same open question always
   has the same id across raises (the consumer resolves by id). Record-line
   `id` is distinct per append (`escalationId + '#' + reNotice`). The
   reNotice sequence is monotonic per key FOR THE CHANNEL'S LIFETIME —
   a re-raise after resolution continues the sequence (the floor survives
   the resolve; cycle-1 F6: content-derived ids would otherwise regenerate
   `esc…#0` and collide on two log lines).
7. **INV-7 no wall clock of its own.** `now()` is REQUIRED from the host
   (P15 INV-6); a throwing / non-finite clock reads as ts 0. Records are
   deterministic given (input, now) — the ONE exception is the resolution
   line's `id` suffix, which mixes a per-process random salt so two
   processes resolving the same id in the same tick cannot mint identical
   log lines (cycle-3 F10); no other field depends on randomness.
8. **INV-8 compartment guards.** `src/escalation/*` imports ONLY
   `node:crypto` (nothing else — not even node:fs). Nothing outside
   `src/escalation/` imports it EXCEPT exactly one allow-listed consumer
   file, `src/telegram/escalation.ts` (the §11 P13 row's "one
   orchestrator-owned consumer"); the guard pins the allow-list itself, so
   a second importer fails the suite.

## 1. The record (JSONL lines appended through the port)

```json
{ "schema": "tre-escalation/1", "kind": "escalation",
  "id": "esc-9f2c…#0", "escalationId": "esc-9f2c…", "ts": 1730231300,
  "episodeId": "ep1", "taskId": "t2", "attemptId": "a7",
  "blocker": "repeated-strategy",
  "decisionNeeded": "approve model-swap beyond budget, rewrite t2, or abort",
  "evidence": ["journal:act-abc", "session:w1", "gate:eslint"],
  "attempts": [{ "action": "backoff-retry", "strategyId": "backoff:v1", "detail": "denied: budget-usd" }],
  "reNotice": 0, "deliveredCount": 1,
  "provenance": "P13/M1" }
```

- `attemptId` optional (a budget-exhausted stop may have none).
- `countUnverifiable: true` (optional, loop-c3/c4) — written on a line whose
  deliveredCount could NOT be verified (window truncated with no in-process
  proof, or a carried-in refusal). The line's `deliveredCount` is then NOT
  budget proof: replay treats the key as cap-spent (fail closed). The field
  is additive and monotone — ANY present value other than an absent field,
  `undefined`, or `false` (including a forged non-boolean or an accessor)
  refuses; it can never grant delivery.
- `decisionNeeded` is free text (bounded, INV-4) — it names the EXACT
  decision the human must make (docs/11 P13 row). The planner/loop fills
  it; the channel never invents one (absent → the blocker's §2 default).
- Resolution lines (§4): `{ "schema": "tre-escalation/1", "kind": "resolution",
  "id": "res-…", "ref": "<escalationId>", "decision": "…", "by": "…",
  "note"?: "…", "disclosed"?: [ … ], "ts": … }`. The resolution `id` hashes a
  per-process random salt into `by|decision|ts|note|seq` (cycle-3 F10): two
  processes resolving the same escalation in the same second with the same
  fields cannot collide. `disclosed` lists what the answer carried that the
  fence would not accept (cycle-3 F5: e.g. `bad-input:note` — an accessor
  `note` is dropped WITH disclosure, not silently).

## 2. Blockers (closed set) — the "why a human is needed"

| blocker | meaning (source) | default decisionNeeded |
|---|---|---|
| `budget-exhausted` | recovery budget spent (docs/11 §13 I5 row "recovery budget exhausted → escalate") | "raise the budget, rewrite the task, or abort" |
| `repeated-strategy` | strategies exhausted / loop stopped (rung-5 hygiene) | "approve a new approach, rewrite the task, or abort" |
| `approval-boundary` | the work needs authority the agent was not granted (§14.7) | "grant the approval or deny it" |
| `environment-blocker` | environment defect (P15 class) | "fix the environment or abort" |
| `gate-defect` | the gate itself is broken/unavailable (P15 class) | "repair the gate or override with evidence" |
| `ambiguous-effect` | side effect outside the worktree, outcome unprovable (I5 reconcile-or-escalate) | "confirm the effect landed or authorize the retry" |
| `bad-input` | planner/config bottomed out at escalate (docs/14 PC5) | "correct the task inputs" |
| `unknown` | anything else (the floor) | "review the evidence and decide" |

An escalation whose blocker is unknown is still a valid, actionable
record — `unknown` is the floor, never a suppressed message.

## 3. The queue (append-port backed)

```ts
interface EscalationDeps {
  append(rec: object): Promise<void>;      // durable append (journal-style; a THROW fails the raise)
  read?(): Promise<unknown[]>;             // host-side replay (for pending() and dedup); absent → pending() reports the in-process open set
  deliver?(rec: object): Promise<{ channel?: string } | void>;  // the delivery act (INV-1: the module never sends); a primitive return is a port defect — disclosed as a FAILED delivery (INV-2)
  now(): number;                           // REQUIRED host clock (INV-7)
  maxRedeliver?: number;                   // default 3 (INV-5)
}
```

- `raise(req)` → `{ record, delivered, reason?, channel?, delivery?, disclosed? }`
  (audit drift fix: `channel` and `disclosed` were missing from this list).
  Order of
  operations (normative): fence input → prior-state lookup (mirror +
  successful replay) → dedup decision → build record (its
  `deliveredCount` is the POST-attempt count, so the INV-5 cap survives
  restarts) → **append** → deliver (if allowed) → return. An append throw
  REJECTS the raise (durability is non-negotiable); a deliver failure
  never does (INV-2).
- `resolve(escalationId, { decision, by, note? })` → appends the
  resolution line and returns it; `null` (nothing appended) for a bad
  decision, a malformed id, a malformed `by`, or an id that was **never
  raised** — in this lifetime or in the durable log (audit B4: an answer
  to a question nobody asked is a fabrication, not a decision).
  Resolving twice: the second resolution appends (durable, timestamped) —
  `pending()` takes the LAST line per escalationId; late answers are
  legitimate.
- `pending()` — replay via `read()` when the host offers it: lines are
  validated (schema+kind) AND SELF-CONSISTENT: a replayed line is believed
  only when its `escalationId` equals the hash of its own
  `episodeId|taskId|blocker` — a planted line claiming someone else's id
  whitelists nothing (cycle-2 F7, fabrications-guard vs the log). A
  resolution closes its escalation; corrupt lines are skipped silently.
  The replay copy is TAIL-first over `REPLAY_CAP` (100,000) lines: for an
  append-only log the NEWEST lines are the current state, so a truncation
  drops stale history, never open work (cycle-1 F1/F2). A line carrying
  `countUnverifiable` (§1) keeps its key cap-spent on replay — and so does
  a TRUNCATED window holding a `reNotice > 0, deliveredCount: 0` line for
  a key no in-process ledger proves delivered (legacy logs predate the
  marker, loop-c4 F1): neither line may be read as budget proof — the cap
  fails closed (INV-5). TRADE-OFF (loop-c5): the same window shape also
  occurs HONESTLY — a host that ran with no deliver port raises the key
  twice, then the log truncates. A restarted host with a deliver port then
  sees one refused raise (`delivery:unverifiable-count`); the next raise
  carries the marker and stays refused for the key's life. This is the
  required direction (a false refuse under an unprovable budget beats a
  false grant; INV-5 fails closed), and it is DISCLOSED, never silent.
  Hardening note (loop-c5): a hand-written count-0/reNotice-0 line forged
  INTO a truncated window can grant a first-delivery budget — the log is
  trusted storage (docs/19 §3) and a legitimate first raise is
  indistinguishable from that forgery without a log MAC; out of scope. `pendingStatus()`
  returns the same view plus `complete: boolean` — `false` whenever the
  replay was truncated, unreadable, or absent; a host must present an
  incomplete queue AS incomplete (cycle-1 F4: exactly one replay per call).
  Without `read()` — or when the read FAILS — `pending()` falls back to
  the channel's in-process open state (records it appended this lifetime):
  never a crash, never a stale ghost presented as the truth, and a host
  that restarts gets the replay path. `pending()` carries no completeness
  flag by design — hosts that must know use `pendingStatus()` (cycle-2 F1:
  the two views are documented to differ; pending() is the convenience view). NOTE: with no `read()` wired,
  `resolve()` can only accept ids raised in this lifetime — a restarted
  host that wants to accept answers MUST wire `read` (cycle-3 audit:
  accepting unverifiable ids would re-open the B4 fabrication hole).
- `raise` with an invalid identity (`episodeId`/`taskId` missing, empty,
  not a string, or LONGER than the 240-char bound — cycle-3 F1: identity
  is never silently truncated, a truncated key would merge distinct
  questions) returns `null` and appends NOTHING — the compose
  R3/F16 rule: an invalid identity writes nothing (a record without a
  key would poison the dedup ledger).

## 4. Resolution decisions (closed set)

`approve` | `deny` | `rewrite` | `abort` | `resume-with-note`

The consumer parses human text into exactly one of these (or rejects with
no record); what a decision MEANS operationally is the host's problem
(P9/M2 scheduling may act on it; M1 only records it durably).

## 5. The consumer (exactly one, Telegram)

`src/telegram/escalation.ts` (the only file outside the module allowed to
import it):

- `makeTelegramDeliver(bridge)` → `DeliverPort`: renders the record into
  ONE bounded message (≤ 1500 chars) — blocker, decision needed,
  episode/task/attempt, evidence (≤ 6), and the resolve line
  (`/resolve <escalationId> <decision> [note]`) — and sends via the
  injected bridge seam (`{ enabled, send }`). The resolve line is
  STRUCTURE (the human's only way to answer), so its length is RESERVED
  before the cut: over-bound evidence drops whole entries (the `(+N)`
  note keeps the count honest) and only as a last resort the text
  hard-trims with `…` — the rendered message ALWAYS ends with the
  resolve line (audit B5). All record-authored text is whitespace-
  flattened: a raw `\n/resolve …` inside decisionNeeded or evidence
  renders as visible text and can never forge a second command line.
  Returns `{ channel: 'telegram' }`. `enabled:false` → returns
  `{ channel: 'telegram:disabled' }` WITHOUT sending (the record still
  stands — INV-2). W13-F2c: the channel layer reads any port return whose
  channel ends in `:disabled` as the documented REFUSAL-to-send — the
  raise RESULT becomes `delivered:false` with `channel:
  'escalation:refused:<name>'` and `delivery:{ok:false,…}` (the durable
  line is untouched: the append precedes the act, so the attempt count
  stands while the success does not). A send throw propagates to `raise`,
  which discloses it per INV-2.
- `parseTelegramResolution(text, by)` → `null | { escalationId, decision, by, note?, noteClipped? }`:
  accepts `/resolve <esc-id> <decision>[: note]` (`by` = the message
  sender, passed by the host and bounded). Anything else parses to null —
  the consumer NEVER free-forms a decision, and a hostile/oversized input
  yields null, never a record. A note over the consumer's 240-char bound
  is clipped WITH `noteClipped: true` (INV-4 reaches the consumer).
- The consumer imports NO escalation-module logic bypass: it builds
  nothing, appends nothing; it renders records and parses answers.

## 6. Composition (host wiring, not a code dependency)

The demo/test host (and any M2 `bin/`) wires:

```ts
const deliver = makeTelegramDeliver(bridge);            // the one consumer
const channel = makeEscalationChannel({ append, read, now, deliver });
const dispatch = makeEscalationDispatcher({ channel }); // + optional blockerOf
// composeRun(cfg, { ...ports, executorPorts: { ...executorPorts, dispatch }, ... })
```

`makeEscalationDispatcher` conforms to docs/15 `DispatchPorts`
(`escalate(req) → { channel }`, `park(req) → { channel }` — the park return
was `void` until W12-F1: the audit found the host discarded a delivery it
could never inspect, so park now answers with the SAME delivery record as
escalate): `escalate` raises with
`blocker: 'unknown'` unless the request names one (the executor's escalate
payload carries `rationale`, not a blocker — the P10 decision detail maps
to a blocker by the host's own `blockerOf` callback when it has one);
`park` records a `'repeated-strategy'` escalation with
`decisionNeeded: 'the task is parked — approve a new approach, rewrite it, or abort'`.
In both paths a delivered send carries the port's channel name and every
NON-delivery is namespaced `escalation:…` (`invalid` / `recorded` /
`re-notice` / `redeliver-cap` / `refused:<channel>`). A channel named
`*:disabled` (e.g. `telegram:disabled`) is the port's documented
refusal-to-send, and since W13-F2c the NAMESPACING HAPPENS AT THE SOURCE:
`raise` turns any `:disabled` return into `delivered:false` + `channel:
'escalation:refused:<name>'`, so the host needs ONE rule (the
`escalation:` prefix means the human was NOT asked) and no new refusal
channel can ever log as dispatched.
The executor keeps its intent/outcome journaling around the dispatch call
(docs/15 §4): the escalation record is the OUTSIDE-world artifact; the
journal line remains the loop's own proof.

## 7. Testing doctrine

- Fence suite (P15 pattern): revoked proxy / throwing getters / hostile
  arrays on `raise` and `resolve` — always a valid record or a clean null,
  never a throw out of the module except an APPEND throw (INV-2).
  Includes the REPLAY path (audit A1): a logged line with a trapping
  `schema`/`kind` getter is skipped like a corrupt line — `pending()` and
  dedup never throw.
- Port-return discipline (audit B3): a deliver port resolving with a
  primitive is disclosed as a failed delivery; an untrusted accessor
  `channel` drops the NAME but the act stands (fence doctrine).
- B4 (audit): resolve rejects a well-formed id that was never raised
  (in-process or in the log); double-resolve and late answers after a
  restart stay legal.
- INV-2 order test: append happens-before deliver (call-order log), and a
  deliver throw leaves the record appended + disclosed.
- INV-5 dedup matrix: same-key re-notice no delivery; new evidence digest
  delivers; force delivers; cap blocks; different blocker = different key.
- INV-6 stability: same question → same escalationId across raises;
  distinct record ids.
- pending()/resolve matrix incl. double-resolve and corrupt-line skip.
- Guards: import allow-list (module → node:crypto only; exactly one
  external consumer file), fs/process/source-scan.
- Consumer tests with a FAKE bridge seam: render bound, disabled bridge,
  send-throw → raise discloses; parse matrix (valid, bad decision,
  injection attempt, oversized).
- Integration test: real executor + real channel via
  `executeRecoveryAction(escalate-plan, …, { dispatch })` → durable
  record + one delivery, journal intent/outcome intact.
