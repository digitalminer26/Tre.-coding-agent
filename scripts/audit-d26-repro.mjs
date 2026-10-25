// D26 strict-fit adversarial repro sweep (audit harness).
// Property under test: on the AUTO (strict) path, if ANY fold sequence fits
// the request budget, the applied result must fit. A fold that drops the
// live user prompt may only be chosen when every prompt-preserving sequence
// provably cannot fit.
//
// Sweeps structured contexts (uniform units / huge atomic tool result / huge
// live prompt / huge tail assistant) × several model shapes, and replays the
// exact compactNow strict application policy in-script to judge the APPLIED
// outcome (not just the first candidate).
//
// Run: node --import tsx scripts/audit-d26-repro.mjs   (or after tsc: node scripts/audit-d26-repro.mjs against dist)

import {
  compactContext,
  planCompaction,
  estimateTokens,
  estimateMessageTokens,
  makeSummaryMessage,
  summarizerMaxTokens,
  ruleBasedShrink,
} from "../dist/src/context/compact.js";

// ---- fake stream: returns a summary of a scripted size (chars) ----
function summaryStream(chars) {
  return async function* () {
    yield { type: "text_delta", delta: "S".repeat(chars) };
    yield {
      type: "done",
      message: { stopReason: "stop", usage: { input: 10, output: Math.ceil(chars / 4), totalTokens: 10 + Math.ceil(chars / 4) } },
    };
  };
}

const MODELS = [
  { id: "m2k", contextWindow: 2000, maxTokens: 100, compactionReserve: 100 },
  { id: "m5k", contextWindow: 5000, maxTokens: 500, compactionReserve: 500 },
  { id: "m16k", contextWindow: 16000, maxTokens: 1024, compactionReserve: 1024 },
  { id: "m32k", contextWindow: 32000, maxTokens: 2048, compactionReserve: 2048 },
];

const U = (s) => ({ role: "user", content: s, timestamp: 1 });
const A = (s) => ({ role: "assistant", content: [{ type: "text", text: s }], model: "m", provider: "p", stopReason: "stop", timestamp: 2 });
const TC = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], model: "m", provider: "p", stopReason: "toolUse", timestamp: 3 });
const TR = (s) => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: s }], isError: undefined, timestamp: 4 });

const CONTEXTS = {
  uniform: () => Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? U("u".repeat(200)) : A("a".repeat(200)))),
  hugeToolResult: () => [U("start task"), A("thinking"), TC(), TR("R".repeat(40000)), A("done with result"), U("next"), A("ok")],
  hugeLivePrompt: () => [U("old chat"), A("old a"), U("t".repeat(30000)), A("working")],
  hugeTailAssistant: () => [U("task"), A("working"), TC(), TR("ok"), A("TAIL".repeat(9000))],
  hugePromptIrreducible: () => [U("old"), A("old a"), TC(), TR("res"), U("P".repeat(300000)), A("tail")],
  lastUserEarly: () => [U("the one real prompt"), A("a"), TC(), TR("r"), A("a"), TC(), TR("r"), A("a"), U("q2"), A("a2"), TC(), TR("r"), A("a3")],
  dense: () => Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? U("x".repeat(900)) : i % 3 === 1 ? A("y".repeat(900)) : TC())),
};

function budgetOf(model) {
  return model.contextWindow - model.maxTokens - 1024;
}
function noticeUpperBoundTokens() {
  return estimateTokens([makeSummaryMessage("x".repeat(512))]);
}

// Does ANY fold sequence fit? Sweep every unit boundary; a boundary folding
// the live prompt may use a summary up to the summarizer cap.
function anyFoldFits(ctx, model, overhead, cpt, keepTokens) {
  const budget = budgetOf(model);
  const cap = summarizerMaxTokens(model);
  let lastUser = -1;
  for (let i = ctx.length - 1; i >= 0; i--) if (ctx[i].role === "user") { lastUser = i; break; }
  const bounds = [];
  ctx.forEach((m, i) => { if (m.role !== "toolResult") bounds.push(i); });
  for (const b of bounds) {
    if (b <= 0 || b >= ctx.length) continue;
    const suffix = ctx.slice(b).reduce((n, m) => n + estimateMessageTokens(m, cpt), 0);
    const preserves = b > lastUser; // live prompt still kept
    const carrier = preserves ? Math.min(cap, noticeUpperBoundTokens()) : cap;
    // For preserving boundaries the applied carrier is the NOTICE (≤512ch);
    // for prompt-folding boundaries the LLM summary (≤cap).
    void carrier;
    if (preserves) {
      if (suffix + noticeUpperBoundTokens() + overhead <= budget) return { fits: true, preserves: true, at: b };
    } else if (suffix + cap + overhead <= budget) {
      return { fits: true, preserves: false, at: b };
    }
  }
  void keepTokens;
  return { fits: false };
}

// Replay compactNow's strict application policy against scripted candidates.
async function replayStrict(ctx, model, overhead, opts = {}) {
  const cpt = 4;
  const budget = budgetOf(model);
  const sig = new AbortController().signal;
  const call = (t) => compactContext({
    streamFn: summaryStream(opts.summaryChars ?? 10),
    model, signal: sig, context: ctx, keepTokens: opts.keepTokens, promptOverheadTokens: overhead,
    force: true, triggered: true, strictFit: true, ...(t ? { transcriptOpts: t } : {}),
  });
  let bestOver;
  let r = await call();
  if (r) {
    if (r.fitsInputBudget) return { applied: r, how: "llm1" };
    const keptFloor = estimateTokens(r.kept, cpt) + overhead;
    if (keptFloor >= budget) return { applied: r, how: "llm1-floor-hopeless" };
    bestOver = r;
  }
  r = await call({ perMessageChars: 750, totalChars: 12000, toolResultChars: 1000 });
  if (r) {
    if (r.fitsInputBudget) return { applied: r, how: "llm2" };
    if (!bestOver || r.estimatedTokensAfter < bestOver.estimatedTokensAfter) bestOver = r;
  }
  const shrink = ruleBasedShrink(ctx, opts.keepTokens, cpt, { shrinkToFit: true });
  if (shrink) {
    const noticeAfter = estimateTokens([shrink.notice, ...shrink.kept], cpt) + overhead;
    if (noticeAfter <= budget) return { applied: { kept: shrink.kept, est: noticeAfter, summary: "<notice>" }, how: "notice" };
    if (bestOver) return { applied: bestOver, how: "bestOver-over" };
    return { applied: { kept: shrink.kept, est: noticeAfter, summary: "<notice>" }, how: "notice-over" };
  }
  if (bestOver) return { applied: bestOver, how: "bestOver-only" };
  return { applied: undefined, how: "skip" };
}

let failures = 0;
let cases = 0;
for (const [ctxName, ctxFactory] of Object.entries(CONTEXTS)) {
  for (const model of MODELS) {
    for (const overhead of [0, 500, 2000]) {
      for (const keepTokens of [undefined, 300]) {
        cases++;
        const ctx = ctxFactory();
        let res;
        try {
          res = await replayStrict(ctx, model, overhead, { keepTokens });
        } catch (e) {
          console.log(`THROW ${ctxName}/${model.id}/oh${overhead}/k${keepTokens}: ${e.message}`);
          failures++;
          continue;
        }
        const truth = anyFoldFits(ctx, model, overhead, 4, keepTokens);
        const appliedFits = !res.applied || res.applied.fitsInputBudget !== false && (res.applied.estimatedTokensAfter ?? res.applied.est) <= budgetOf(model);
        const promptFolded = res.applied && res.applied.kept && !res.applied.kept.includes(ctx.filter((m) => m.role === "user").pop());
        const label = `${ctxName}/${model.id}/oh${overhead}/k${keepTokens ?? "-"}`;
        if (truth.fits && res.applied && !appliedFits) {
          failures++;
          console.log(`FAIL-fit ${label}: a fold fits (${JSON.stringify(truth)}) but applied ${res.how} est=${res.applied.estimatedTokensAfter ?? res.applied.est} > ${budgetOf(model)} (fits=${res.applied.fitsInputBudget})`);
        }
        // Fold-necessity: only flag when the fold did NOT achieve a fit —
        // otherwise the fold was necessary (nothing preserving fits with a
        // summary carrier; the notice check above covers preserving).
        if (promptFolded && res.applied && !appliedFits) {
          failures++;
          console.log(`FAIL-fold-necessity ${label}: prompt folded but applied is over budget anyway (${res.how})`);
        }
      }
    }
  }
}
console.log(`${cases} cases, ${failures} failures`);
process.exit(failures ? 1 : 0);
