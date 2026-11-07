# W13 audit — refusal-to-send as a channel-level fact (`e0c0e08`)

Scope: the commit that moved the `*:disabled` refusal decision from the host
(`F2_DISABLED_CHANNELS`) into `deliverAndFinish`, plus the three new host
tests. Method: diff read line by line, consumer sweep, and executable probes
against `dist` (deleted afterwards). Every finding below is reproduced by a
probe, not inferred.

## What holds

| Claim | Verdict | Evidence |
|---|---|---|
| A `*:disabled` port return is `delivered:false` + `escalation:refused:<name>` | PASS | probe: `{delivered:false, channel:"escalation:refused:telegram:disabled", delivery:{ok:false,…}, sends:0}` |
| The host's name-set removal leaves no false "dispatched" | PASS | both `escalate`/`park` handlers reduce to the `escalation:` prefix rule; no stale `F2_DISABLED_CHANNELS` / "bridge off" references anywhere in `src/`, `docs/`, `test/`, `HANDOFF.md` |
| The throw case still resolves and stays durable | PASS | park test: `parkTask()` resolves, `state.json` → `parked`, record on disk, log `NOT delivered (recorded)` |
| The fix's tests actually exercise it | PASS | 3 new host tests + reformulated channel test are green; each asserts `sends === 0` so a future wiring slip cannot fake a pass |

## F1 (MAJOR, pre-existing, exposed by this audit) — a refusal quietly burns the human's delivery budget

`deliveredCount` is computed BEFORE the act (`deliveredCount = shouldDeliver ?
baseDelivered + 1 : baseDelivered`, docs/19 "POST-attempt count"), so a send
that is **refused** still writes a delivery to the durable line. Executed
probe (single process, bridge off, then on):

```
raise 1..3 (bridge OFF): delivered:false, channel escalation:refused:…, sends 0
--- bridge enabled ---
raise 4 (bridge ON):     delivered:false, reason redeliver-cap, sends 0
durable counts: [1,2,3,3]
VERDICT: human received 0 messages; 4 questions were raised.
```

Restart-proof (real channel writes the log, then replayed with the bridge on):

```
pendingStatus after restart: {"open":1,"complete":true}
new question -> {delivered:false, reason:"redeliver-cap", sends:0}
```

The escalationId is `(episodeId, taskId, blocker)` and `park()` hardcodes
`blocker:'repeated-strategy'`, so a long bridge-off window spends the default
`DEFAULT_MAX_REDELIVER = 3` for that key; when the bridge returns, the parked
question is never sent and the only trace is `escalation:redeliver-cap` in the
log. Effectively: **bridge off for three park/escalate attempts = a mute
escalation channel with no un-gag path until a human resolves it.**

Mitigating: `force` bypasses `re-notice` but NOT the cap (`force never
defeats the cap` — deliberate anti-spam), so even an explicit operator
"resend" cannot reach a human after this.

Recommended fix (not applied — design-bearing, needs the owner's call):
add a `bootId`-scoped `refused` counter that excludes refusals from the cap
base while keeping the attempt count honest for dedup, e.g.
`baseDeliveredForCap = baseDelivered - refusedInThisLifetime`, or give the
channel an "unbounded retry for refusals" flag (INV-5 still caps real sends).

## F2 (MEDIUM) — the naming convention is the only thing separating "sent" from "refused"

`delivered` is now decided by `chRaw.endsWith(':disabled')`. A port that
refuses for any other reason and returns a name is still reported as
delivered. Probe:

```
refusal named WITHOUT ':disabled'  -> {delivered:true, channel:"telegram:no-chat"}
delivered send                     -> {delivered:true, channel:"telegram"}
```

The shipped bridge is safe today: `makeTelegramDeliver` returns
`telegram:disabled` for the only non-throwing refusal, and every other failure
(helper missing, send error) throws — which the channel converts to
`delivery:{ok:false}`. But `delivery.ok` is **not** derived from `delivered`;
the two now disagree, and the next refusal channel inherits the old bug.
Fix: make `delivered` follow `delivery.ok` (`delivered = delivery.ok`) or add
an explicit `{ refused?: true }` field to `DeliverPort`'s return instead of
inferring from the name.

## F3 (LOW) — double namespacing is not idempotent

Probe: a port returning an already-namespaced
`escalation:refused:telegram:disabled` yields
`escalation:refused:escalation:refused:telegram:disabled`. Cosmetic (the host
slices `escalation:` and prints the rest), but a re-processed refusal reads
badly in the log. Fix: only prefix when the name does not already start with
`escalation:`.

## F4 (LOW) — the throw case drops the error detail on the host log

`delivery: { ok: false, error: describeErr(e) }` is computed and then
discarded by both dispatchers, which return only `{ channel }`. The operator
sees `park: question NOT delivered (recorded)` — the same text a bridge-off
refusal used to produce — with the real cause (`bridge down`) lost. This is
the same class as the original B-F1 defect one level down: the failure is
disclosed as *not delivered* but not *why*. Fix: widen the dispatcher return to
carry `delivery`/`error` and log it (`NOT delivered (error: bridge down)`).

## F5 (INFO) — the path is unreachable in production, and was before this commit

`runHostEpisode` has no caller in `src/` (`grep` for call sites is empty; the
CLI at `src/cli/main.ts` never imports it), and `escalationDeliver` is
referenced only by `supervise.ts` itself, so `makeTelegramDeliver` is wired
only by tests. The real loop (`src/supervisor/compose.ts`) reaches `park` →
executor and `finish('parked')` but never passes an escalation dispatcher.
So W12-F1/F2 and W13-F2c are correct **in the seam** while the seam is not
plugged into the shipped product. Owner should decide whether the host loop
is the intended production path (then wire it, and the bridge-off budget burn
above becomes live) or an integration-test harness only.

## Commit-message accuracy

The message reads "the park survives … and the failure is disclosed". Both are
true, but "disclosed" means the *fact* (NOT delivered), not the *cause* (see
F4). No other claim in the message is contradicted by the probes.

## Dispositions (fixed 2026-11-07, same day as the audit)

| Finding | Disposition |
|---|---|
| F1 | FIXED, via the durable-correction-line shape rather than the bootId counter: refusals append a `deliveryRefused` line (ref = escalationId) and the channel refunds the pre-act reservation in-process (mirror + lifetime ledger, one refund per refusal). Replay subtracts one refund per correction line (clamped ≥ 0; reset by a newer escalation line; consumed by the truncation/unverifiable gates that still fail closed; review round: the LEDGER-scan refund is applied on complete windows only — a truncated window may carry a process-sticky max earned outside it). Chosen because it survives restarts WITHOUT a bootId concept and without changing INV-5's pre-act reservation — a correction whose append fails stays burned (fail closed, disclosed `refusal-correction:failed`). Send THROWS remain burned: the attempt may have reached the human. Tests: in-process probe (3 refusals + bridge-back delivers) and the exact restart probe from this audit (both green). |
| F2 | FIXED via the explicit-field option: `DeliverResult { channel?, refused? }` on `DeliverPort`; refusal = `refused === true` (fence-read, non-boolean disclosed `bad-input:refused`) OR the `:disabled` suffix as documented backstop. `RaiseResult.refused` added. `makeTelegramDeliver` returns `refused: true`. |
| F3 | FIXED: namespacing is idempotent — a name already starting `escalation:` is used as-is. Test pins it. |
| F4 | FIXED: `EscalationDispatcher.escalate/park` return `{ channel, error? }` (carrying `delivery.error`); both host handlers log it (`NOT delivered (recorded: Error) …`), deduped when the error repeats the channel tail (refusals). `DispatchPorts.escalate` widened to match. Host test pins the error in the log line. **Review-round correction:** `delivery.error` for a throw is `describeErr(e)` — the exception's CLASS NAME only, never its message (the thrown value is untrusted; `describeErr` is the hostile-input-safe formatter). So the log shows the class (e.g. `: Error`), not the audit's wished-for `bridge down`. Carrying the message was considered and REJECTED in review: untrusted port text in the operator log was judged not worth the extra disclosure surface. The fact + class is the shipped contract. |
| F5 | DOCUMENTED (owner input not required for the fix, only for wiring): docs/19 §5 now carries the explicit "unreachable in prod today" note — `runHostEpisode` has no `src/` caller, `escalationDeliver` is test-wired only; F1's fix means the budget no longer mutes the channel WHEN the seam is plugged, and the wiring itself (compose loop → dispatcher + a real bridge) is a deliberate product decision, left open. |

## Round-2 finding F4b (MEDIUM, found in the post-fix re-audit) — untrusted
## Error NAME could forge a host-log line

The F4 fix threads `delivery.error` (from `describeErr(e)`) into the host
log. The MESSAGE was never surfaced — but `describeErr` returned
`Error#name` unfiltered up to 64 chars, and a name is attacker-chosen by
the throwing port. Repro (live, dist build):

```js
const e = new Error('x'); e.name = 'Boom\nescalate dispatched via telegram';
// host log line produced:
// escalate NOT delivered (recorded: Boom
// escalate dispatched via telegram)   ← a FORGED second line (false ack)
```

Same class as B-F1 (a false dispatch claim), reached through a different
input. The port-supplied CHANNEL name had the identical exposure on both
the refusal path (`escalation:refused:<name>`) and the delivered path
(`dispatched via <name>`).

**Fix (shipped with this commit):** every log-bound identifier is a
closed token. `describeErr`: `name` passes only
`/^[A-Za-z0-9_.-]{1,64}$/`, else `'Error'`. Channel names: must match
`/^[A-Za-z0-9:._-]+$/` or are DROPPED — the refusal/delivery outcome
stands, only the name dies (`'unknown'` / `undefined`) — and disclosed
`bad-input:channel`. Tests: channel-layer forgery (both paths), a
newline-name Error test, and a host test asserting no log line starts
with a forged prefix and the disclosure shows `: Error)`.
