// P15 investigation-agent red-team suite (audit cycles A5 + A6, promoted
// from the throwaway .tre probe harnesses). Every check is a HOSTILE
// packet/port against the built agent (dist/) with an asserted
// disclosure/behavior — these are the probes that FOUND the A5/A6
// findings; run them after touching src/investigation/ (scripts/redteam.sh
// also runs the mutation harness that proves the probes are discriminating).
//
// Run: node scripts/redteam-investigation.mjs   (needs `tsc` output; npm run build)
import { investigate } from "../dist/src/investigation/agent.js";
import { validateSupervisorRecord } from "../dist/src/episode/journal.js";

let fails = 0;
const check = (n, c, extra) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra !== undefined ? `  [${extra}]` : ""}`); if (!c) fails++; };
const has = (rec, s) => rec.evidenceRefs.includes(s);
const clock = { now: () => 1700000000000 };
const basePacket = (o) => ({ episodeId: "e1", taskId: "t1", attemptId: "a1", ...o });
const valid = (rec) => { try { validateSupervisorRecord(JSON.parse(JSON.stringify(rec))); return true; } catch { return false; } };

// ── A5-R1 / A5-F5: ingestion-window disclosure ────────────────────────────
{
  // Unique refs past the 64-entry copy window must be disclosed...
  const flood = Array.from({ length: 200 }, (_, i) => `pkt:r-${i}`);
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: flood }), clock);
  check("A5-R1: >64 unique flood discloses refs:truncated", has(rec, "refs:truncated") && rec.evidenceRefs.length <= 64 && valid(rec));

  // ...and the discriminating case: window itself fits capacity (2 distinct
  // refs), the hidden uniques are past it. This is the case a mutation of
  // the overflow OR would otherwise hide.
  const win = Array.from({ length: 64 }, (_, i) => `pkt:win-${i % 2}`);
  const hidden = Array.from({ length: 100 }, (_, i) => `pkt:hidden-${i}`);
  const rec2 = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: [...win, ...hidden] }), clock);
  check("A5-R1: unique refs hidden past a duplicate-filled window are disclosed", has(rec2, "refs:truncated"));

  // F5 still rules: pure duplicates past the window lost nothing.
  const dupes = Array.from({ length: 200 }, (_, i) => `pkt:d-${i % 5}`);
  const rec3 = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: dupes }), clock);
  check("A5-F5: pure-duplicate flood discloses NOTHING (no phantom truncation)",
    !has(rec3, "refs:truncated") && rec3.evidenceRefs.filter((r) => r.startsWith("pkt:")).length === 5);

  // Boundary: exact fit is not an overflow.
  const exact = Array.from({ length: 63 }, (_, i) => `pkt:b-${i}`);
  const rec4 = await investigate(basePacket({ evidenceRefs: exact }), clock);
  check("A5-R1: exact 63-ref fit does not misfire refs:truncated", !has(rec4, "refs:truncated"));

  const rec5 = await investigate(basePacket({ evidenceRefs: "not-an-array" }), clock);
  check("A5-R1: non-array evidenceRefs stays clean", !has(rec5, "refs:truncated") && valid(rec5));
}

// ── A6-F1: scan-budget DoS (sparse length = 2^32-1) ───────────────────────
{
  const sparse = []; sparse.length = 4294967295; // declared, zero entries
  const t0 = Date.now();
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: sparse }), clock);
  const ms = Date.now() - t0;
  check("A6-F1: sparse 2^32-1 array returns bounded (<1s) and discloses the unvisited tail",
    ms < 1000 && has(rec, "bad-input:scan-budget") && has(rec, "refs:truncated") && valid(rec), `${ms}ms`);

  // 1024 dense = exactly the budget: visited, so no budget marker (capacity truncation still applies).
  const dense = Array.from({ length: 1024 }, (_, i) => `pkt:db-${i}`);
  const rec2 = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: dense }), clock);
  check("A6-F1: exact-budget array is not budget-exhausted", !has(rec2, "bad-input:scan-budget") && has(rec2, "refs:truncated"));

  // One declared entry past the budget: the tail cannot be proven duplicate.
  const d2 = Array.from({ length: 1024 }, () => "pkt:x"); d2.length = 1025;
  const rec3 = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: d2 }), clock);
  check("A6-F1: 1 unvisited entry past the budget still discloses", has(rec3, "bad-input:scan-budget") && has(rec3, "refs:truncated"));
}

// ── limits parsing matrix (A5 F1/F6 + A6 docs) ────────────────────────────
{
  const p = basePacket({ workerState: "running" });
  const cases = [
    ["limits='abc'",            "abc",             true],
    ["limits=7",                7,                 true],
    ["limits=null (absent)",    null,              false],
    ["maxToolCalls=null",       { maxToolCalls: null },  true],
    ["maxToolCalls='2'",        { maxToolCalls: "2" },   true],
    ["maxToolCalls=NaN",        { maxToolCalls: NaN },   true],
    ["maxUsd=Infinity",         { maxUsd: Infinity },    true],
    ["maxUsd=-1 (clamps, no marker)", { maxUsd: -1 },    false],
  ];
  for (const [name, lim, want] of cases) {
    const rec = await investigate(p, clock, { limits: lim });
    check(`limits: ${name} -> bad-input:limits = ${want}`, has(rec, "bad-input:limits") === want && valid(rec));
  }
}

// ── spend accounting: estimate is the floor, over-charge stands ────────────
{
  const t = (report) => ({ run: async () => ({ facts: { endpointReachable: true }, usd: report }) });
  const epErr = basePacket({ errors: [{ source: "fetch", text: "429 rate limited" }] });
  const z = await investigate(epErr, { now: () => 1, tools: t(0) });
  check("spend: usd:0 report never refunds below the 0.02 estimate", z.limitsRespected.spendUsd === 0.02);
  const low = await investigate(epErr, { now: () => 1, tools: t(0.005) });
  check("spend: below-estimate report keeps the estimate", low.limitsRespected.spendUsd === 0.02);
  const over = await investigate(epErr, { now: () => 1, tools: t(3) });
  check("spend: over-report stands (charge the max, never the estimate)", over.limitsRespected.spendUsd === 3);
  const huge = await investigate(
    basePacket({ workerState: "running", signal: { kind: "endpoint-error" }, errors: [{ source: "fetch", text: "429" }] }),
    { now: () => 1, tools: t(Number.MAX_VALUE) });
  check("spend: MAX_VALUE report clamps to MAX_SAFE_INTEGER and the record stays valid",
    huge.limitsRespected.spendUsd === Number.MAX_SAFE_INTEGER && valid(huge));
}

// ── no-refund budget fit (A5 audit probe) ─────────────────────────────────
{
  const log = [];
  const tools = { run: async (req) => { log.push(req.probe); return { usd: 0 }; } };
  const rec = await investigate(
    basePacket({ workerState: "stopped", errors: [{ source: "x", text: "connection refused" }] }),
    { now: () => 0, tools }, { limits: { maxUsd: 0.04 } });
  check("budget: maxUsd=0.04 fits endpoint+env probes and reports spend against ESTIMATES",
    rec.limitsRespected.spendUsd <= 0.04 + 1e-9 && rec.limitsRespected.toolsUsed === log.length && valid(rec),
    `probes=${log.join(",") || "none"} spend=${rec.limitsRespected.spendUsd}`);
}

// ── A7-F1: revoked arrays must never throw out of investigate() ───────────
{
  const mk = () => { const { proxy, revoke } = Proxy.revocable([], {}); revoke(); return proxy; };
  let threw = false, rec;
  try { rec = await investigate(basePacket({ evidenceRefs: mk() }), clock); } catch { threw = true; }
  check("A7-F1: revoked array as evidenceRefs does not throw and marks bad-input:packet",
    !threw && rec !== undefined && has(rec, "bad-input:packet") && valid(rec));
  threw = false; rec = undefined;
  try { rec = await investigate(basePacket({ errors: mk() }), clock); } catch { threw = true; }
  check("A7-F1: revoked array as errors does not throw and marks bad-input:packet",
    !threw && rec !== undefined && has(rec, "bad-input:packet") && valid(rec));
  // A plain non-array stays benign (no phantom marker).
  const rec5 = await investigate(basePacket({ evidenceRefs: { 0: "a", length: 1 } }), clock);
  check("A7-F1: array-like plain object is NOT flagged hostile", !has(rec5, "bad-input:packet") && valid(rec5));
}

// ── A7-F2: discarded refs (lying length) are disclosed, never silent ──────
{
  const arr = Array.from({ length: 100 }, (_, i) => `pkt:liar-${i}`);
  let reads = 0;
  const liar = new Proxy(arr, { get(t, k) { if (k === "length") { reads++; return reads === 1 ? t.length : t.length + 1; } return Reflect.get(t, k); } });
  const rec = await investigate(basePacket({ evidenceRefs: liar }), clock);
  check("A7-F2: length-mismatch discard discloses refs:dropped",
    has(rec, "refs:dropped") && rec.evidenceRefs.filter((r) => r.startsWith("pkt:")).length === 0 && valid(rec));
  // A per-index descriptor trap mid-scan discloses too.
  const trap = Array.from({ length: 10 }, (_, i) => `pkt:tb-${i}`);
  const trapProxy = new Proxy(trap, { getOwnPropertyDescriptor(t, k) { if (String(k) === "5") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec2 = await investigate(basePacket({ evidenceRefs: trapProxy }), clock);
  check("A7-F2: mid-scan descriptor trap discloses refs:dropped", has(rec2, "refs:dropped") && valid(rec2));
}

// ── A7-F3: trapping descriptor on a budget field fails CLOSED ─────────────
{
  let n = 0;
  const tools = { run: async () => { n++; return { facts: {}, usd: 0 }; } };
  const trapUsd = new Proxy({ maxUsd: 0 }, { getOwnPropertyDescriptor(t, k) { if (k === "maxUsd") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec = await investigate(basePacket({ workerState: "running" }), { ...clock, tools }, { limits: trapUsd });
  check("A7-F3: maxUsd descriptor trap -> zero probes, zero spend, bad-input:limits",
    n === 0 && rec.limitsRespected.toolsUsed === 0 && has(rec, "bad-input:limits") && valid(rec),
    `probes=${n} spend=${rec.limitsRespected.spendUsd}`);
  let m = 0;
  const tools2 = { run: async () => { m++; return { facts: {}, usd: 0 }; } };
  const trapCalls = new Proxy({}, { getOwnPropertyDescriptor(t, k) { if (k === "maxToolCalls") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec2 = await investigate(basePacket({ workerState: "running" }), { ...clock, tools: tools2 }, { limits: trapCalls });
  check("A7-F3: maxToolCalls descriptor trap -> zero probes, bad-input:limits",
    m === 0 && rec2.limitsRespected.toolsUsed === 0 && has(rec2, "bad-input:limits") && valid(rec2),
    `probes=${m}`);
}

// ── A7-F7: packet descriptor-trap (proto passes) is disclosed ─────────────
{
  const packetTrap = new Proxy({ episodeId: "e1" }, { getOwnPropertyDescriptor(t, k) { if (k !== "episodeId") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec = await investigate(packetTrap, clock);
  check("A7-F7: packet getOwnPropertyDescriptor trap marks bad-input:packet", has(rec, "bad-input:packet") && valid(rec));
}

// ── A7-F9: cumulative spend clamps to MAX_SAFE_INTEGER ─────────────────────
{
  // Each probe reports 0.75*MSI: one report can never exceed MSI, but
  // the SUM over two probes reaches 1.5*MSI — the clamp must hold at
  // MSI (cycle-A8: MSI/2 reports land EXACTLY on MSI after FP rounding
  // and cannot discriminate the clamp from the F4 saturation stop).
  const t = { run: async () => ({ facts: {}, usd: Number.MAX_SAFE_INTEGER * 0.75 }) };
  const rec = await investigate(basePacket({ workerState: "running" }), { now: () => 1, tools: t }, { limits: { maxUsd: Number.MAX_SAFE_INTEGER } });
  check("A7-F9: summed over-reports clamp to MAX_SAFE_INTEGER",
    // Cycle-A8 F4: two probes at MSI/2 saturate the ledger exactly;
    // admission stops at saturation (a clamped total re-admits nothing).
    rec.limitsRespected.toolsUsed >= 2 && rec.limitsRespected.spendUsd === Number.MAX_SAFE_INTEGER &&
      rec.evidenceRefs.some((r) => r.includes("skipped-budget")) && valid(rec),
    `spend=${rec.limitsRespected.spendUsd} tools=${rec.limitsRespected.toolsUsed}`);
}

// ── A8-F1: ANY hostile limits input fails the budget CLOSED ───────────────
{
  const n = { hits: 0 };
  const t = { run: async () => { n.hits++; return { facts: {}, usd: 0 }; } };
  const mkRevoked = () => { const { proxy, revoke } = Proxy.revocable({ maxUsd: 0 }, {}); revoke(); return proxy; };
  const cases = [
    ["maxUsd:'0' (string)", { maxUsd: "0" }],
    ["maxUsd:NaN", { maxUsd: NaN }],
    ["maxToolCalls:'2' (string)", { maxToolCalls: "2" }],
    ["revoked limits handle", mkRevoked()],
  ];
  for (const [name, lim] of cases) {
    n.hits = 0;
    const rec = await investigate(basePacket({ workerState: "running" }), { now: () => 1, tools: t }, { limits: lim });
    check(`A8-F1: ${name} -> zero probes, zero spend, bad-input:limits`,
      n.hits === 0 && rec.limitsRespected.toolsUsed === 0 && rec.limitsRespected.spendUsd === 0 &&
        has(rec, "bad-input:limits") && valid(rec),
      `hits=${n.hits} spend=${rec.limitsRespected.spendUsd}`);
  }
  const recD = await investigate(basePacket({ workerState: "running" }), { now: () => 1, tools: t });
  check("A8-F1 no-phantom: absent limits keep the documented default budget",
    recD.limitsRespected.toolsUsed > 0 && !has(recD, "bad-input:limits") && valid(recD),
    `tools=${recD.limitsRespected.toolsUsed}`);
}

// ── A8-F2: nested hostile handles disclose, never silently flip ───────────
{
  const mkRevoked = (o) => { const { proxy, revoke } = Proxy.revocable(o, {}); revoke(); return proxy; };
  const factsTrap = mkRevoked({ approvalPending: true });
  const rec = await investigate({ ...basePacket({ workerState: "running" }), facts: factsTrap }, { now: () => 1 });
  check("A8-F2: revoked facts handle -> bad-input:packet (silently flipped class pre-A8)",
    has(rec, "bad-input:packet") && valid(rec));
  const factKeyTrap = new Proxy({ approvalPending: true }, { getOwnPropertyDescriptor(t, k) { if (k === "gatePass") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec2 = await investigate({ ...basePacket({ workerState: "running" }), facts: factKeyTrap }, { now: () => 1 });
  check("A8-F2: descriptor trap on a closed fact key -> bad-input:packet",
    has(rec2, "bad-input:packet") && valid(rec2));
  const sigRec = await investigate({ ...basePacket({ workerState: "running" }), signal: mkRevoked({}) }, { now: () => 1 });
  check("A8-F2: revoked signal handle -> bad-input:packet", has(sigRec, "bad-input:packet") && valid(sigRec));
  const accRec = await investigate({ ...basePacket({ workerState: "running" }), acceptance: mkRevoked({}) }, { now: () => 1 });
  check("A8-F2: revoked acceptance handle -> bad-input:packet", has(accRec, "bad-input:packet") && valid(accRec));
  const errsTrap = mkRevoked([{ text: "429" }]);
  const rec3 = await investigate({ ...basePacket({ workerState: "running" }), errors: errsTrap }, { now: () => 1 });
  check("A8-F2: revoked errors handle -> bad-input:packet", has(rec3, "bad-input:packet") && valid(rec3));
  // plain garbage stays harmless
  const clean = await investigate({ ...basePacket({ facts: { approvalPending: true } }), evidenceRefs: "not-an-array" }, { now: () => 1 });
  check("A8-F2 no-phantom: plain non-array refs is NOT hostile input",
    !has(clean, "bad-input:packet") && !has(clean, "refs:dropped") && valid(clean));
}

// ── A8-F6: trap-discard on refs marks the handle hostile too ──────────────
{
  const arr = ["pkt:a", "pkt:b"];
  const idxTrap = new Proxy(arr, { getOwnPropertyDescriptor(t, k) { if (k === "1") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  const rec = await investigate({ ...basePacket({ facts: { approvalPending: true } }), evidenceRefs: idxTrap }, { now: () => 1 });
  check("A8-F6: mid-scan descriptor trap -> refs:dropped AND bad-input:packet",
    has(rec, "refs:dropped") && has(rec, "bad-input:packet") && valid(rec));
  const arr2 = Array.from({ length: 30 }, (_, i) => `pkt:f6-${i}`);
  let reads = 0;
  const liar = new Proxy(arr2, { get(t, k) { if (k === "length") { reads++; return reads === 1 ? t.length : t.length + 1; } return Reflect.get(t, k); } });
  const rec2 = await investigate({ ...basePacket({ facts: { approvalPending: true } }), evidenceRefs: liar }, { now: () => 1 });
  check("A8-F6: lying length -> refs:dropped AND bad-input:packet",
    has(rec2, "refs:dropped") && has(rec2, "bad-input:packet") && valid(rec2));
}

// ── A8-F4: a saturated ledger stops admission (clamped total re-admits nothing) ──
{
  let hits = 0;
  const t = { run: async () => { hits++; return { facts: {}, usd: Number.MAX_SAFE_INTEGER / 2 }; } };
  const rec = await investigate(basePacket({ workerState: "running" }), { now: () => 1, tools: t },
    { limits: { maxUsd: Number.MAX_SAFE_INTEGER, maxToolCalls: Number.MAX_SAFE_INTEGER } });
  check("A8-F4: saturated ledger stops admission with budget-skip disclosure",
    rec.limitsRespected.spendUsd === Number.MAX_SAFE_INTEGER && hits <= 3 &&
      rec.evidenceRefs.some((r) => r.includes("skipped-budget")) && valid(rec),
    `hits=${hits} spend=${rec.limitsRespected.spendUsd}`);
}

console.log(fails === 0 ? "redteam-investigation: ALL PASS" : `redteam-investigation: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
