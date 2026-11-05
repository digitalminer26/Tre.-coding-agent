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

console.log(fails === 0 ? "redteam-investigation: ALL PASS" : `redteam-investigation: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
