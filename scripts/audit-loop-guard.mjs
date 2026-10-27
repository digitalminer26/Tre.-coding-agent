// Loop-guard audit harness (audit re-fix 2026-11-02). Drives the REAL
// runLoop (dist/src) with a scripted stream — no network — and asserts the
// re-audit findings' failure shapes CANNOT reproduce:
//
//   P1 boundary  — blocks ["a","b"] then ["a\0b"] then ["a","b"] (same call
//                  args) must NOT read as 3 identical batches. The old
//                  resultEntryDigest raw-joined block texts with \u0000
//                  BEFORE JSON encoding, so ["a","b"] and ["a\0b"] collided
//                  and the 3rd batch was refused (false positive). Run with
//                  maxGuardRetries: 0 — the default auto-retry MASKS a false
//                  guard hit (that is why the test suite stayed green on the
//                  old bug).
//   P2 stuck     — genuinely identical batches still STOP the run, with
//                  stable evidence (no false negative).
//   P3 failed    — 12 identical-call batches whose results KEEP FAILING
//                  with changing error text: the cap stop must report
//                  capReason "failed" and its text must never claim the
//                  results were changing (they changed — as failures; the
//                  stall guards' domain, not "changing results").
//   P4 cap text  — fresh-result cap stop: text names the pattern size,
//                  never a results claim; evidence.capReason "fresh".
//   P5 headline  — loopStopNote is evidence-driven: cycle stops never say
//                  "3 times in a row", cap stops never say "changing
//                  results", stable stops say "no change in results".
//
// Run after `npm run build`:  node scripts/audit-loop-guard.mjs
// Exit 0 = all probes pass; 1 = a finding reproduces.

import { runLoop } from "../dist/src/loop/agent-loop.js";
import { loopStopNote, guardEvidenceNote } from "../dist/src/types.js";
import { fakeStream } from "../dist/test/fake-stream.js";

const model = {
  id: "probe",
  provider: "probe",
  baseUrl: "http://probe.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

function echoTool(results) {
  let n = 0;
  return {
    name: "exec",
    description: "probe",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() {
      const r = results[n++] ?? results[results.length - 1];
      return r;
    },
    calls: () => n,
  };
}

async function drive(turns, results, opts = {}) {
  const tool = echoTool(results);
  const events = [];
  for await (const ev of runLoop({
    model,
    systemPrompt: "sys",
    initialMessages: [{ role: "user", content: "go", timestamp: 1 }],
    tools: [tool],
    streamFn: fakeStream(turns, { model }),
    signal: new AbortController().signal,
    maxTurns: opts.maxTurns ?? 60,
    maxGuardRetries: opts.maxGuardRetries ?? 0,
  })) {
    events.push(ev);
  }
  const end = events.find((e) => e.type === "agent_end");
  return { end, events, tool };
}

const callTurn = (i) => ({
  type: "toolcall",
  calls: [{ id: `c${i}`, name: "exec", args: { command: "x" } }],
});
const ok = (content) => ({ content, isError: false });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });
const guardFills = (events) =>
  events.filter(
    (e) =>
      e.type === "tool_execution_end" &&
      e.result?.isError === true &&
      String(e.result?.details?.notExecuted) === "true",
  );

const checks = [];
const check = (name, cond, detail) => {
  checks.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// P1 — block-boundary collision must be gone.
{
  const turns = [callTurn(1), callTurn(2), callTurn(3), { type: "text", text: "done" }];
  const results = [
    ok([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    ok([{ type: "text", text: "a\u0000b" }]),
    ok([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
  ];
  const { end, events } = await drive(turns, results);
  check("P1 boundary", end?.stopReason === "stop" && guardFills(events).length === 0,
    `stop=${end?.stopReason} fills=${guardFills(events).length} (old digest: false loop)`);
}

// P2 — a genuinely stuck identical batch still stops (stable evidence).
{
  const turns = [callTurn(1), callTurn(2), callTurn(3)];
  const results = [ok([{ type: "text", text: "same" }])];
  const { end } = await drive(turns, results);
  const ev = end?.evidence;
  check(
    "P2 stuck fires",
    end?.stopReason === "loop" &&
      ev?.guard === "identical-batch" &&
      ev?.stable === true &&
      ev?.repeats === 3,
    `stop=${end?.stopReason} guard=${ev?.guard} repeats=${ev?.repeats} stable=${ev?.stable}`,
  );
}

// P3 — capped FAILED repeats: capReason "failed", no "changing results" lie.
{
  let n = 0;
  const tool = {
    name: "exec",
    description: "probe",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() {
      n += 1;
      return { content: [{ type: "text", text: `boom ${n}` }], isError: true };
    },
  };
  const events = [];
  for await (const ev of runLoop({
    model,
    systemPrompt: "sys",
    initialMessages: [{ role: "user", content: "go", timestamp: 1 }],
    tools: [tool],
    streamFn: fakeStream(Array.from({ length: 20 }, (_, i) => callTurn(i + 1)), { model }),
    signal: new AbortController().signal,
    maxTurns: 60,
    maxGuardRetries: 0,
  })) {
    events.push(ev);
  }
  const end = events.find((e) => e.type === "agent_end");
  const ev = end?.evidence;
  const fillText = guardFills(events)
    .map((e) => e.result.content.map((c) => c.text ?? "").join(" "))
    .join(" ");
  check(
    "P3 failed-cap",
    end?.stopReason === "loop" &&
      ev?.stable === false &&
      ev?.capReason === "failed" &&
      !/changing results/i.test(fillText),
    `stop=${end?.stopReason} stable=${ev?.stable} capReason=${ev?.capReason} fill="${fillText.slice(0, 60)}…"`,
  );
}

// P4 — fresh-result identical cap: capReason "fresh", neutral text.
{
  let n = 0;
  const tool = {
    name: "exec",
    description: "probe",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() {
      n += 1;
      return { content: [{ type: "text", text: `rev ${n}` }], isError: false };
    },
  };
  const events = [];
  for await (const ev of runLoop({
    model,
    systemPrompt: "sys",
    initialMessages: [{ role: "user", content: "go", timestamp: 1 }],
    tools: [tool],
    streamFn: fakeStream(Array.from({ length: 20 }, (_, i) => callTurn(i + 1)), { model }),
    signal: new AbortController().signal,
    maxTurns: 60,
    maxGuardRetries: 0,
  })) {
    events.push(ev);
  }
  const end = events.find((e) => e.type === "agent_end");
  const ev = end?.evidence;
  const fillText = guardFills(events)
    .map((e) => e.result.content.map((c) => c.text ?? "").join(" "))
    .join(" ");
  check(
    "P4 fresh-cap",
    end?.stopReason === "loop" &&
      ev?.stable === false &&
      ev?.capReason === "fresh" &&
      ev?.repeats === 12 &&
      !/changing results|no change in results/i.test(fillText),
    `stop=${end?.stopReason} repeats=${ev?.repeats} capReason=${ev?.capReason}`,
  );
}

// P5 — the headline is evidence-driven on every shape.
{
  const stable = loopStopNote({ guard: "identical-batch", signature: "x", repeats: 3, stable: true, guardRetries: 0 });
  const cap = loopStopNote({ guard: "identical-batch", signature: "x", repeats: 12, stable: false, capReason: "fresh", guardRetries: 0 });
  const cycle = loopStopNote({ guard: "cycle-batch", signature: "a\u0001b", cycleLength: 2, repeats: 5, stable: true, guardRetries: 0 });
  const legacy = loopStopNote({ guard: "identical-batch", signature: "x", repeats: 3, guardRetries: 0 });
  const none = loopStopNote(undefined);
  check(
    "P5 headline",
    /3 times in a row with no change in results/.test(stable) &&
      /12 times in a row without progress/.test(cap) && !/changing results/.test(cap) &&
      /two tool-call batches alternated/.test(cycle) && !/3 times in a row/.test(cycle) &&
      !/no change in results|without progress/.test(legacy) &&
      !/3 times/.test(none),
    `stable="${stable.slice(0, 60)}…" cap="${cap.slice(0, 60)}…"`,
  );
  const note = guardEvidenceNote({ guard: "cycle-batch", signature: 'a:{"q":1}\u0001b:{"q":1}', cycleLength: 2, repeats: 5, stable: true, guardRetries: 1 });
  check("P5b trigger line", /alternating ×5 batches, same results, after 1 auto-retry/.test(note), note);
}

const failed = checks.filter((c) => !c.pass).length;
console.log(failed === 0 ? "ALL PROBES PASS" : `${failed} PROBE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
