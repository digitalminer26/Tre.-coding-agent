// Black-box re-probe of the A4 audit findings against dist/src/investigation/agent.js
import { investigate } from '../dist/src/investigation/agent.js';
import { validateSupervisorRecord } from '../dist/src/episode/journal.js';

const clock = () => 1700000000000;
const base = { id: 'act-1#diag', episodeId: 'ep-1', taskId: 't1', attemptId: 'a1' };
let crashes = 0, invalid = 0, pass = 0;

async function probe(name, packet, ports, options, extra) {
  try {
    const rec = await investigate(packet, ports, options);
    try { validateSupervisorRecord(rec); } catch (e) { invalid++; console.log(`INVALID ${name}: ${e.message}`); return; }
    if (extra) { const m = extra(rec); if (m) { invalid++; console.log(`CLAIM-FAIL ${name}: ${m}`); return; } }
    pass++;
  } catch (e) {
    crashes++;
    console.log(`CRASH ${name}: ${e && e.message}`);
  }
}

// R1: revoked proxy packet (getPrototypeOf trap)
{
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  await probe('revoked-packet', proxy, { now: clock }, undefined,
    (r) => r.evidenceRefs.includes('bad-input:packet') ? null : 'missing bad-input:packet');
}
// R1: trapping proxy packet (every trap throws)
{
  const p = new Proxy({}, { get() { throw 1; }, getOwnPropertyDescriptor() { throw 1; }, getPrototypeOf() { throw 1; }, has() { throw 1; }, ownKeys() { throw 1; } });
  await probe('trap-all-packet', p, { now: clock }, undefined);
}
// R1: tools:null
await probe('tools-null', { ...base, workerState: 'stopped' }, { now: clock, tools: null }, undefined);
// R1: throwing run getter (must resolve once, never crash)
await probe('run-getter-throw', { ...base, workerState: 'stopped' }, { now: clock, tools: { get run() { throw new Error('nope'); } } }, undefined);
// R1: throwing judge getter
await probe('judge-getter-throw', base, { now: clock, judge: { get judge() { throw new Error('nope'); } } }, undefined);
// R1: options with throwing limits getter
await probe('limits-getter-throw', base, { now: clock }, { get limits() { throw new Error('x'); } },
  (r) => r.evidenceRefs.includes('bad-input:limits') ? null : 'missing bad-input:limits');
// R1: per-index descriptor trap on errors/refs arrays
{
  const arr = new Proxy([], { getOwnPropertyDescriptor(t, k) { if (k === '0') throw new Error('idx'); return Reflect.getOwnPropertyDescriptor(t, k); }, get(t, k) { if (k === 'length') return 3; return Reflect.get(t, k); } });
  await probe('idx-trap-errors', { ...base, errors: arr, evidenceRefs: arr }, { now: clock }, undefined);
}
// R2: fractional maxToolCalls
{
  let calls = 0;
  const tools = { run: async () => { calls++; return { facts: {} }; } };
  await probe('frac-maxcalls', base, { now: clock, tools }, { limits: { maxToolCalls: 2.5 } },
    () => calls === 2 ? null : `expected 2 probes, got ${calls}`);
}
// R3: negative usd refund attempt
{
  const tools = { run: async (req) => req.probe === 'probe-endpoint' ? { facts: { endpointReachable: true }, usd: -5 } : { facts: {} } };
  await probe('neg-usd', { ...base, errors: [{ source: 'fetch', text: '429 rate limited' }] }, { now: clock, tools }, undefined,
    (r) => r.limitsRespected.spendUsd >= 0.02 ? null : `refund leaked: spend ${r.limitsRespected.spendUsd}`);
}
// R4: 200-ref flood must not evict markers
{
  const flood = Array.from({ length: 200 }, (_, i) => `pkt:${i}`);
  await probe('ref-flood', { ...base, facts: { approvalPending: true }, evidenceRefs: flood }, { now: clock }, undefined,
    (r) => r.evidenceRefs.includes('rule:approval-pending:explicit') && r.evidenceRefs.includes('refs:truncated') ? null : 'marker evicted or disclosure missing');
}
// R4: exactly-64 flood
{
  const flood64 = Array.from({ length: 64 }, (_, i) => `pkt:${i}`);
  await probe('ref-flood-64', { ...base, evidenceRefs: flood64 }, { now: clock }, undefined,
    (r) => r.evidenceRefs.includes('refs:truncated') ? null : 'exactly-filling flood undisclosed');
}
// Prototype pollution attempt
{
  Object.prototype.approvalPending = true;
  await probe('proto-pollution', base, { now: clock }, undefined,
    (r) => r.causeClass === 'unknown' ? null : `inherited fact leaked: ${r.causeClass}`);
  delete Object.prototype.approvalPending;
}
console.log(`\nRESULT: pass=${pass} crashes=${crashes} invalid/claim-fail=${invalid}`);
process.exit(crashes + invalid === 0 ? 0 : 1);
