// D26 strict-fit adversarial repro sweep (audit harness, REWRITTEN 2026-10-25
// per audit finding 4). Two structural fixes over the previous version:
//
//   1. ORACLE CORRECTED. The old oracle computed prompt preservation as
//      `b > lastUser` for a kept suffix ctx.slice(b) — REVERSED: the live
//      prompt (index lastUser) is retained iff b <= lastUser. It also used a
//      hypothetical 512-char notice bound and required the FULL summary cap
//      to fit. The oracle below uses the REAL rule-based notice
//      (ruleBasedShrink, measured as-is), the real preserving/fold plans
//      (planCompaction with the same inputs compactContext derives), and the
//      SCRIPTED summary sizes — deterministic streams mean the achievable
//      carriers are exactly computable, not bounded hypothetically.
//
//   2. DRIVES THE REAL compactNow (src/cli/main.ts) — no policy replay in
//      the script. The applied context and the emitted events are judged
//      directly, so the sweep validates the whole ladder (LLM rung →
//      transcript retry → rule-based notice), not a copy of it.
//
// Invariants on the APPLIED outcome (strict/auto path):
//   INV-A  a prompt-losing application is illegal whenever a preserving
//          carrier (the real notice, or a preserving plan with the scripted
//          summary) would have FIT. (Finding 2's failure shape.)
//   INV-B  an over-budget application despite a FITTING real notice is
//          illegal — the notice rung owns that fit.
//   INV-C  no false skip: when a carrier fits (notice / preserving-scripted
//          / fold-scripted with a usable summary budget) the outcome is an
//          application, not undefined.
//   INV-D  any application is a STRICT REDUCTION of the old context.
//   INV-E  an aborted stream yields NO application and NO event (finding 3).
//
// Run after `tsc`:  node scripts/audit-d26-repro.mjs

import {
  planCompaction,
  estimateTokens,
  estimateMessageTokens,
  makeSummaryMessage,
  summarizerMaxTokens,
  ruleBasedShrink,
} from "../dist/src/context/compact.js";
import { compactNow } from "../dist/src/cli/main.js";

// ---- scripted streams (deterministic; sizes are known to the oracle) ----
function textStream(chars) {
  return async function* () {
    yield { type: "text_delta", delta: "S".repeat(chars) };
    yield {
      type: "done",
      message: {
        role: "assistant", content: [{ type: "text", text: "S".repeat(chars) }],
        model: "sweep", provider: "sweep", stopReason: "stop", timestamp: 1,
        usage: { input: 10, output: Math.ceil(chars / 6), totalTokens: 10 + Math.ceil(chars / 6) },
      },
    };
  };
}
function errorStream(msg) {
  return async function* () {
    yield {
      type: "done",
      message: {
        role: "assistant", content: [], model: "sweep", provider: "sweep",
        stopReason: "error", errorMessage: msg, timestamp: 1,
      },
    };
  };
}
function abortStream() {
  return async function* () {
    yield {
      type: "done",
      message: { role: "assistant", content: [], model: "sweep", provider: "sweep", stopReason: "aborted", timestamp: 1 },
    };
  };
}

const MODELS = [
  { id: "m2k", contextWindow: 2000, maxTokens: 100 },
  { id: "m5k", contextWindow: 5000, maxTokens: 500 },
  { id: "m16k", contextWindow: 16000, maxTokens: 1024 },
  { id: "m32k", contextWindow: 32000, maxTokens: 2048 },
];

const U = (s) => ({ role: "user", content: s, timestamp: 1 });
const A = (s) => ({ role: "assistant", content: [{ type: "text", text: s }], model: "m", provider: "p", stopReason: "stop", timestamp: 2 });
const TC = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], model: "m", provider: "p", stopReason: "toolUse", timestamp: 3 });
const TR = (s) => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: s }], isError: undefined, timestamp: 4 });

const CONTEXTS = {
  uniform: () => Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? U("u".repeat(200)) : A("a".repeat(200)))),
  hugeToolResult: () => [U("start task"), A("thinking"), TC(), TR("R".repeat(40000)), A("done with result"), U("next"), A("ok")],
  hugeLivePrompt: () => [U("old chat"), A("old a"), U("t".repeat(30000)), A("working")],
  // The finding-2 geometry: a LIVE prompt whose preserving floor FITS the
  // budget but barely, behind a huge folded prefix — fold-after-demonstration
  // runs, and a cap-compliant fold response can drift over the estimate.
  bigLivePromptFitsFloor: () => [U("old"), A("x".repeat(40000)), U("u".repeat(11800)), A("w".repeat(1620))],
  // TIGHT floor (model-aware): the preserving suffix sits ~30 tokens under
  // the budget, so the FLOOR fits but the real rule-notice (≈55-130 tokens)
  // does NOT — exactly the corner where a drift-busted fold that is adopted
  // anyway gets APPLIED (over budget, live prompt lost) instead of the
  // preserving candidate. Discriminates the finding-2 fix from the bug.
  tightFloor: (model, overhead) => {
    const budget = model.contextWindow - model.maxTokens - 1024;
    const liveChars = Math.max(400, (budget - overhead - 436) * 4);
    return [U("old"), A("x".repeat(40000)), U("u".repeat(liveChars)), A("w".repeat(1620))];
  },
  hugeTailAssistant: () => [U("task"), A("working"), TC(), TR("ok"), A("TAIL".repeat(9000))],
  hugePromptIrreducible: () => [U("old"), A("old a"), TC(), TR("res"), U("P".repeat(300000)), A("tail")],
  lastUserEarly: () => [U("the one real prompt"), A("a"), TC(), TR("r"), A("a"), TC(), TR("r"), A("a"), U("q2"), A("a2"), TC(), TR("r"), A("a3")],
  dense: () => Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? U("x".repeat(900)) : i % 3 === 1 ? A("y".repeat(900)) : TC())),
};

// Scripts: uniform text sizes (deterministic carriers), a cap-compliant but
// estimate-busting shape (finding 2's unit drift: 6 chars per provider
// token), all-error, and abort-first.
const SCRIPTS = [
  { name: "txt10", stream: textStream(10), kind: "text", chars: 10 },
  { name: "txt400", stream: textStream(400), kind: "text", chars: 400 },
  { name: "txt4000", stream: textStream(4000), kind: "text", chars: 4000 },
  { name: "drift3978", stream: textStream(3978), kind: "text", chars: 3978 },
  // A heavily DRIFTED response: within any sane provider cap story (the
  // audit's repro respected max_tokens) while its chars/cpt estimate busts
  // both the preserving and the fold candidates — the shape finding 2 needs.
  { name: "txt12000", stream: textStream(12000), kind: "text", chars: 12000 },
  { name: "err", stream: errorStream("down"), kind: "error" },
  { name: "abort", stream: abortStream(), kind: "abort" },
];

// Mirror compactNow/compactContext's keepTokens derivation exactly.
function keepTokensOf(model, overhead, compactKeepTokens) {
  const summaryBudget = summarizerMaxTokens(model);
  const windowCap = model.contextWindow - model.maxTokens - 1024 - overhead - summaryBudget;
  return Math.min(compactKeepTokens ?? 8192, windowCap);
}

async function runCase(ctxFactory, model, overhead, compactKeepTokens, script) {
  const cpt = 4;
  const ctx = ctxFactory(model, overhead);
  const budget = model.contextWindow - model.maxTokens - 1024;
  const keepTokens = keepTokensOf(model, overhead, compactKeepTokens);
  const summaryText = "S".repeat(script.chars ?? 0);

  // ── ORACLE: the achievable carriers under this exact script ──
  // Preserving plans (same inputs compactContext uses).
  const p1 = planCompaction(ctx, keepTokens, cpt, { preserveLastUser: true, shrinkToFit: false });
  const p2 = planCompaction(ctx, keepTokens, cpt, { preserveLastUser: true, shrinkToFit: true });
  const p3 = planCompaction(ctx, keepTokens, cpt, { preserveLastUser: false, shrinkToFit: true });
  // A carrier is only ACHIEVABLE if it fits AND strictly reduces: both
  // compactContext and ruleBasedShrink refuse to grow the context, so a
  // "fitting" candidate on a context too short to fold is a legitimate skip.
  // (Audit round 2, finding 2) Production's strict-fold growth exemption
  // (a fitting candidate that may be LARGER than the original when the live
  // prompt was genuinely folded) never conflicts with this check: when the
  // context actually needs compaction (before > budget), a fitting
  // candidate is ≤ budget < before and shrinks by construction; the
  // exemption can only bite on already-fitting contexts, where needsCompaction
  // is false and the candidate is never applied (INV-C is gated on it).
  // Production additionally rejects EVERY over-budget strictFoldRung
  // result, so no applied non-shrink can reach INV-D.
  const strictShrink = (candidateMsgs) =>
    estimateTokens(candidateMsgs, cpt) < estimateTokens(ctx, cpt);
  const carrierFits = (p) =>
    p !== undefined && script.kind === "text" &&
    estimateTokens([makeSummaryMessage(summaryText), ...p.kept], cpt) + overhead <= budget &&
    strictShrink([makeSummaryMessage(summaryText), ...p.kept]);
  const preserveFit = carrierFits(p1) || carrierFits(p2);
  // The preserving FLOOR (smallest possible preserving candidate) — the
  // same impossibility proof compactContext uses to justify fold-after-
  // demonstration. Floor fits ⇒ a preserving candidate EXISTS in hand at
  // fold time ⇒ a prompt-losing application must have bought the fit.
  const floorFitsPreserving =
    p2 !== undefined &&
    p2.kept.reduce((s, m) => s + estimateMessageTokens(m, cpt), 0) +
      estimateMessageTokens(makeSummaryMessage(""), cpt) + overhead <= budget;
  // The REAL rule-based notice (measured as-is, the deepest preserving plan).
  const notice = ruleBasedShrink(ctx, keepTokens, cpt, { shrinkToFit: true });
  const noticeFits =
    notice !== undefined &&
    estimateTokens([notice.notice, ...notice.kept], cpt) + overhead <= budget &&
    strictShrink([notice.notice, ...notice.kept]);
  // The fold carrier: usable summary budget over its kept tail (the same
  // MIN_FOLD gate compactContext applies), plus the scripted fit. NOTE the
  // fold plan compactContext derives carries the live prompt in the
  // TRANSCRIPT (priorityLastUser) and is emitted with one leading newline —
  // the prompt is inside SUMMARIZER INPUT, not the kept context, so the
  // oracle's fit/shrink math must use compactContext's exact construction.
  const foldHeadroom = p3
    ? budget - (p3.kept.reduce((s, m) => s + estimateMessageTokens(m, cpt), 0) +
        estimateMessageTokens(makeSummaryMessage(""), cpt) + overhead)
    : -Infinity;
  // A fold candidate that does not STRICTLY SHRINK its own transcript is not
  // achievable: compactContext refuses non-reducing candidates (a fold whose
  // kept tail is all that remains of a context the preserving plans could
  // only shrink slightly — with the live prompt carried in the transcript
  // instead of kept — is such a case; skipping it is honest, not a bug).
  const foldShrinks = p3 !== undefined && strictShrink([makeSummaryMessage(summaryText), ...p3.kept]);
  const foldFit =
    carrierFits(p3) && foldShrinks && foldHeadroom >= 64 && p3 !== undefined && p3.keepFrom > (p2 === null || p2 === undefined ? 0 : p2.keepFrom);

  // ── ACT: the real compactNow (strict/auto policy) ──
  const events = [];
  let applied;
  try {
    applied = await compactNow({
      streamFn: script.stream,
      model: { ...model, baseUrl: "http://sweep.invalid/v1", provider: "sweep" },
      signal: new AbortController().signal,
      context: ctx,
      session: null,
      ids: new Map(),
      systemPrompt: "sys",
      promptOverheadTokens: overhead,
      compactKeepTokens,
      force: true,
      strictFit: true,
      sinks: { out: { write: () => true }, err: { write: () => true } },
      onEvent: async (ev) => { events.push(ev); },
    });
  } catch (e) {
    return [`THROW ${e.message}`];
  }

  // ── JUDGE ──
  const problems = [];
  const livePrompt = ctx.filter((m) => m.role === "user").pop();
  const keptLive = applied === undefined || applied.includes(livePrompt);
  const compactEv = events.find((e) => e.type === "context_compacted");
  const estAfter = applied ? estimateTokens(applied, cpt) + overhead : 0;
  const overBudget = applied !== undefined && estAfter > budget;

  if (script.kind === "abort") {
    if (applied !== undefined) problems.push(`INV-E applied despite abort (${events.length} events)`);
    if (events.length > 0) problems.push(`INV-E events emitted despite abort (${events.map((e) => e.type).join(",")})`);
    return problems;
  }
  if (applied !== undefined && !compactEv) problems.push("applied without context_compacted event");
  if (applied === undefined && compactEv) problems.push("event without application");
  // INV-A: prompt lost while a preserving carrier fits.
  if (applied !== undefined && !keptLive && (noticeFits || preserveFit))
    problems.push(`INV-A prompt lost though preserving carrier fits (notice=${noticeFits} preserve=${preserveFit} est=${estAfter}/${budget})`);
  // INV-B: over-budget application despite a fitting notice.
  if (overBudget && noticeFits)
    problems.push(`INV-B over-budget application (${estAfter}) though the notice fits (${budget})`);
  // INV-C: no false skip.
  // INV-C: no false skip. Only meaningful when the context ACTUALLY needs
  // compaction (before > budget): compacting an already-fitting context is
  // optional, and both compactContext and ruleBasedShrink correctly refuse a
  // forced fold that would not even shrink it (the hugeLivePrompt/m32k
  // corner: before ≈ 7.5k ≪ budget 29k, folding would grow the context).
  const needsCompaction = estimateTokens(ctx, cpt) + overhead > budget;
  if (needsCompaction && applied === undefined && (noticeFits || preserveFit || foldFit))
    problems.push(`INV-C skipped though a carrier fits (notice=${noticeFits} preserve=${preserveFit} fold=${foldFit})`);
  // INV-D: strict reduction — with the production exemption (audit round 3):
  // a FITTING application that folded the live prompt may legitimately be
  // larger than the original (the live prompt alone can exceed the budget;
  // carrying it in a fitting summary is strictly better than an
  // over-budget request). Production rejects every over-budget fold
  // candidate, so a fitting live-fold application is the ONLY non-shrinking
  // outcome the pipeline can produce; on already-fitting contexts the
  // carriers are gated by needsCompaction (INV-C) and nothing is applied.
  const fittingLiveFold = applied !== undefined && estAfter <= budget && !keptLive;
  if (applied !== undefined && !fittingLiveFold && estAfter >= estimateTokens(ctx, cpt) + overhead)
    problems.push(`INV-D applied context did not shrink (${estAfter} >= ${estimateTokens(ctx, cpt) + overhead})`);
  // INV-F (finding 2): a prompt-losing (fold) application must have BOUGHT
  // the fit — est ≤ budget. The fold cap is provider tokens; the estimate is
  // chars/cpt; a capped response can still drift over. This is the exact
  // failure the buys-the-fit check exists to prevent, judged on the applied
  // context (the fold's whole justification is the fit; without it the
  // preserving candidate in hand was strictly better).
  if (applied !== undefined && !keptLive && overBudget && floorFitsPreserving)
    problems.push(`INV-F prompt lost AND over budget (${estAfter} > ${budget}) while the preserving floor fit (fold bought nothing)`);
  // INV-A second shape (from the audit): over-budget AND prompt lost needs
  // the impossibility exemption (no preserving carrier fits at all).
  if (overBudget && !keptLive && !compactEv?.degraded) {
    // non-degraded over-budget fold loss is only legal under impossibility —
    // and even then it must not be flagged as a normal (informative-summary)
    // application... impossibility checked by INV-A already; this pins the
    // event honesty:
    if (noticeFits || preserveFit) problems.push("over-budget prompt-losing application with a preserving fit available");
  }
  return problems;
}

let failures = 0;
let cases = 0;
for (const [ctxName, ctxFactory] of Object.entries(CONTEXTS)) {
  for (const model of MODELS) {
    for (const overhead of [0, 500, 2000]) {
      for (const keepTokens of [undefined, 300]) {
        for (const script of SCRIPTS) {
          cases++;
          const problems = await runCase(ctxFactory, model, overhead, keepTokens, script);
          const label = `${ctxName}/${model.id}/oh${overhead}/k${keepTokens ?? "-"}/${script.name}`;
          for (const p of problems) {
            failures++;
            console.log(`FAIL ${label}: ${p}`);
          }
        }
      }
    }
  }
}
console.log(`${cases} cases, ${failures} failures`);
process.exit(failures ? 1 : 0);
