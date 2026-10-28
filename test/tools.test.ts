/**
 * WS3 — tools: registry, execution pipeline (I3: failures are isError
 * results, never throws), and the MVP toolset (read/write/edit/bash)
 * against a temp dir.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ToolRegistry,
  bashTool,
  defaultRegistry,
  editTool,
  familyFailureKey,
  isPermissionStallText,
  makeToolExecutor,
  pruneExpiredFamilyEntries,
  SAME_FAMILY_WINDOW,
  readTool,
  writeTool,
} from "../src/tools/index.js";
import {
  destructiveBashPatterns,
  isReadOnlyBash,
  isReversibleBash,
  makeSafetyHooks,
  sensitiveBashPatterns,
  type ApprovalMode,
} from "../src/tools/safety.js";
import { runLoop } from "../src/loop/agent-loop.js";
import { fakeStream, type FakeTurn } from "./fake-stream.js";
import type {
  AgentEvent,
  ModelConfig,
  Tool,
  ToolCallBlock,
  ToolResult,
  UserMessage,
} from "../src/types.js";

// ────────────────────────────── helpers ──────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws3-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string): string => {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
};

function makeTool(name: string, execute?: Tool["execute"]): { tool: Tool; calls: { id: string; args: Record<string, unknown> }[] } {
  const calls: { id: string; args: Record<string, unknown> }[] = [];
  const tool: Tool = {
    name,
    description: `fake ${name}`,
    parameters: { type: "object" },
    execute: async (id, args, signal, onUpdate) => {
      calls.push({ id, args });
      return (execute ?? (async () => ({ content: [{ type: "text" as const, text: `${name} ran` }] })))
        .call(null, id, args, signal, onUpdate);
    },
  };
  return { tool, calls };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCallBlock => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const exec = (tool: Tool, c: ToolCallBlock) =>
  makeToolExecutor()(tool, c, new AbortController().signal);

const resultText = (r: ToolResult): string => r.content.map((b) => b.text).join("");

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};
const userMsg = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
async function drain(gen: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ────────────────────────────── registry ──────────────────────────────

test("registry: add / get / list / size", () => {
  const reg = defaultRegistry();
  assert.equal(reg.size, 5);
  assert.deepEqual(reg.list().map((t) => t.name).sort(), ["bash", "edit", "read", "subtask", "write"]);
  assert.equal(reg.get("read"), readTool);
  assert.equal(reg.get("nope"), undefined);
  assert.throws(() => reg.add(readTool), /duplicate tool name/);
});

// ────────────────────────────── pipeline ──────────────────────────────

test("pipeline: valid call executes the tool with its args", async () => {
  const { tool, calls } = makeTool("t");
  const r = await exec(tool, call("1", "t", { a: 1 }));
  assert.equal(r.isError, undefined);
  assert.equal(resultText(r), "t ran");
  assert.deepEqual(calls, [{ id: "1", args: { a: 1 } }]);
});

test("pipeline: invalid args → isError result, tool NEVER runs", async () => {
  const { tool, calls } = makeTool("t", undefined);
  const t: Tool = {
    ...tool,
    parameters: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
  };
  const r = await exec(t, call("1", "t", { wrong: true }));
  assert.equal(r.isError, true);
  assert.match(resultText(r), /Invalid arguments/);
  assert.equal(r.details?.notExecuted, true, "F1: a rejected call never ran (docs/08 §9)");
  assert.equal(calls.length, 0);
});

test("pipeline: beforeToolCall can BLOCK (WS7 approval seam) — tool never runs", async () => {
  const { tool, calls } = makeTool("t");
  const executor = makeToolExecutor({
    beforeToolCall: () => ({ blocked: "not approved in this session" }),
  });
  const r = await executor(tool, call("1", "t", {}), new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /blocked: not approved in this session/);
  assert.equal(calls.length, 0);
});

test("pipeline: beforeToolCall can REWRITE args", async () => {
  const { tool, calls } = makeTool("t");
  const executor = makeToolExecutor({
    beforeToolCall: () => ({ args: { rewritten: true } }),
  });
  await executor(tool, call("1", "t", { original: true }), new AbortController().signal);
  assert.deepEqual(calls, [{ id: "1", args: { rewritten: true } }]);
});

test("pipeline: afterToolCall can rewrite the result", async () => {
  const { tool } = makeTool("t");
  const executor = makeToolExecutor({
    afterToolCall: (_t, _c, result) => ({
      ...result,
      content: [{ type: "text" as const, text: "REDACTED" }],
    }),
  });
  const r = await executor(tool, call("1", "t", {}), new AbortController().signal);
  assert.equal(resultText(r), "REDACTED");
});

test("pipeline: tool that throws (I3 violation) → isError result, never throws", async () => {
  const { tool } = makeTool("t", async () => {
    throw new Error("kaboom");
  });
  const r = await exec(tool, call("1", "t", {}));
  assert.equal(r.isError, true);
  assert.match(resultText(r), /threw: kaboom/);
});

test("H2: identical non-permission failure for same tool and args stalls on third within window", async () => {
  const { tool, calls } = makeTool("repeat", async () => ({
    content: [{ type: "text" as const, text: "test failed: expected 1, got 2" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const a = await executor(tool, call("1", "repeat", { test: "x" }), sig);
  const b = await executor(tool, call("2", "repeat", { test: "x" }), sig);
  assert.equal(a.details?.repeatFailure, undefined);
  assert.equal(b.details?.repeatFailure, undefined);
  const c = await executor(tool, call("3", "repeat", { test: "x" }), sig);
  assert.equal(c.details?.repeatFailure, true);
  assert.equal(c.details?.stall, true);
  assert.equal(calls.length, 3, "triggering call executed before its result is replaced");
});

test("H2: changed args or error diagnostics do not combine; permission failures stay on H1", async () => {
  const { tool } = makeTool("repeat", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.n === 2 ? "failure 2" : "failure 1" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  for (let n = 1; n <= 6; n++) {
    const r = await executor(tool, call(String(n), "repeat", { n }), sig);
    assert.equal(r.details?.repeatFailure, undefined);
  }
});

test("H2: same args and error must recur within eight calls of the tool", async () => {
  const { tool } = makeTool("repeat", async () => ({
    content: [{ type: "text" as const, text: "same error" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "repeat", { x: 1 }), sig);
  for (let n = 2; n <= 9; n++) await executor(tool, call(String(n), "repeat", { x: n }), sig);
  const third = await executor(tool, call("10", "repeat", { x: 1 }), sig);
  assert.equal(third.details?.repeatFailure, undefined, "first signature occurrence is outside the window");
});

test("H2: repeat window expires and whitespace-only error differences normalize", async () => {
  const { tool } = makeTool("repeat", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.n === 2 ? "same\\n  error" : "same error" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "repeat", { n: 1 }), sig);
  await executor(tool, call("2", "repeat", { n: 1 }), sig);
  const r = await executor(tool, call("3", "repeat", { n: 1 }), sig);
  assert.equal(r.details?.repeatFailure, true);
});

// ─────────── Family-window warn rung (docs/08 §10, 2026-11-28 audit) ───────────
//
// The 2026-11-28 sed loop: a malformed BSD-sed range, 15 failures, each
// message differing ONLY in the range digit (+18p … +2p) with successes
// interleaved. The exact-key consecutive ladder and H2's args key both
// miss it; the family key (digits masked) + sliding window catches it.
// Warn-only rung — announced when ≥2 DISTINCT texts share the family.

test("familyFailureKey: masks digit runs, keeps shape; normalizeFailure stays exact", () => {
  // EVERY digit run masks — including the line number in "sed: 1:" — so
  // all messages of one command shape collapse to one family key.
  assert.equal(familyFailureKey('sed: 1: ",+18p": invalid command code ,'), 'sed: #: ",+#p": invalid command code ,');
  assert.equal(familyFailureKey('sed: 1: ",+2p": invalid command code ,'), 'sed: #: ",+#p": invalid command code ,');
  // whitespace collapse rides along (trim first, then runs of whitespace
  // → single space); "code 1"'s digit masks too.
  assert.equal(familyFailureKey("exit   code 1\n[stderr]  boom 42 "), "exit code # [stderr] boom #");
  // empty stays empty (an empty failure carries no family)
  assert.equal(familyFailureKey("   "), "");
  // no digits → identity (modulo whitespace)
  assert.equal(familyFailureKey("no digits here"), "no digits here");
});

test("family-window: the sed loop warns at 3 same-family failures despite interleaved successes", async () => {
  const { tool } = makeTool("sedloop", async (_id, args) => ({
    // The real loop: only the range digit changes; successes in between.
    content: [{ type: "text" as const, text: `sed: 1: ",+${args.n}p": invalid command code ,` }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  // failures at calls 1,2 — no warn yet (2 < 3).
  const r1 = await executor(tool, call("1", "sedloop", { n: 18 }), sig);
  const r2 = await executor(tool, call("2", "sedloop", { n: 24 }), sig);
  assert.equal(r1.details?.sameFamilyWarn, undefined);
  assert.equal(r2.details?.sameFamilyWarn, undefined);
  // a SUCCESS between failures does not reset the window (non-consecutive
  // by design) — see the dedicated test below; here the three failures
  // land at calls 1..3 directly.
  const r3 = await executor(tool, call("3", "sedloop", { n: 20 }), sig);
  assert.equal(r3.details?.sameFamilyWarn, 3, "3 same-family failures within 8 calls warns");
  assert.match(resultText(r3), /SAME error family/);
  // the real error still rides through (warn never replaces the result)
  assert.match(resultText(r3), /invalid command code/);
});

test("family-window: success between failures does NOT reset the window", async () => {
  let fail = true;
  const { tool } = makeTool("mixwin", async (_id, args) => ({
    content: [{ type: "text" as const, text: fail ? `boom v${args.n}` : String(args.n) }],
    isError: fail,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "mixwin", { n: 1 }), sig); // fail #1 (boom v1)
  fail = false;
  await executor(tool, call("2", "mixwin", { n: 2 }), sig); // success
  fail = true;
  await executor(tool, call("3", "mixwin", { n: 3 }), sig); // fail #2 (boom v3)
  const r4 = await executor(tool, call("4", "mixwin", { n: 4 }), sig); // fail #3 (boom v4)
  assert.equal(r4.details?.sameFamilyWarn, 3, "success occupies a slot but does not reset");
});

test("family-window: repeats of ONE identical text stay silent (H2/consecutive own that)", async () => {
  const { tool } = makeTool("ident", async (_id, args) => ({
    content: [{ type: "text" as const, text: "exactly the same message" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const r3 = await executor(tool, call("1", "ident", { a: 1 }), sig);
  const r4 = await executor(tool, call("2", "ident", { a: 2 }), sig);
  const r5 = await executor(tool, call("3", "ident", { a: 3 }), sig);
  // DISTINCT-texts >= 2 requirement: one text repeating never triggers the
  // family rung (the consecutive guard warns at 3 IN A ROW; alternating
  // identical texts stay fully silent per the 2026-11-27 audit).
  assert.equal(r3.details?.sameFamilyWarn, undefined);
  assert.equal(r4.details?.sameFamilyWarn, undefined);
  assert.equal(r5.details?.sameFamilyWarn, undefined);
});

test("family-window: window expiry — same-family failures spaced >8 calls apart never warn", async () => {
  const { tool } = makeTool("spread", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.kind === "a" ? `bad-a ${args.n}` : `zzz ${args.n}` }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  // family "bad-#" twice at calls 1,2; then family "zzz #" at 3..9 (seven
  // calls, all outside family "bad-#"'s last-8 window once call 10 lands);
  // call 10 returns to family "bad-#" → the pruned window holds only this
  // call → streak 1, silent.
  await executor(tool, call("1", "spread", { kind: "a", n: 1 }), sig);
  await executor(tool, call("2", "spread", { kind: "a", n: 2 }), sig);
  for (let n = 3; n <= 9; n++) await executor(tool, call(String(n), "spread", { kind: "b", n }), sig);
  const r10 = await executor(tool, call("10", "spread", { kind: "a", n: 10 }), sig);
  assert.equal(r10.details?.sameFamilyWarn, undefined, "family window pruned: indices 1-2 are >8 calls old");
});

test("family-window: a distinct text EXPIRES with its call — stale texts never satisfy the >=2 rule (2026-11-28 audit, finding 2)", async () => {
  // The defect: `texts` lived forever while call indices pruned, so one
  // long-expired distinct text let three SAME-text failures warn — the
  // >=2-distinct-texts rule must hold INSIDE the window, not across
  // history. Sequence: fail "boom 1", expire it with 8 successes, then
  // three "boom 2" failures (distinct args, successes between so the
  // consecutive ladder and H2 stay silent). Inside the window at the
  // third failure only "boom 2" is alive → one distinct text → SILENT.
  let fail = true;
  let text = "boom 1";
  const { tool } = makeTool("staleTxt", async () => ({
    content: [{ type: "text" as const, text }],
    isError: fail,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const executed = await executor(tool, call("1", "staleTxt", { n: 1 }), sig); // "boom 1" (family "boom #")
  assert.equal(executed.details?.sameFamilyWarn, undefined);
  fail = false;
  for (let n = 2; n <= 9; n++) await executor(tool, call(String(n), "staleTxt", { n }), sig); // 8 successes: "boom 1" expires
  fail = true;
  text = "boom 2";
  await executor(tool, call("10", "staleTxt", { n: 10 }), sig);
  fail = false; // 2026-11-28 auditor cycle 1: the "successes" must REALLY
  await executor(tool, call("11", "staleTxt", { n: 0 }), sig); // succeed — a silent failure would climb the consecutive ladder and mask this verdict
  fail = true;
  await executor(tool, call("12", "staleTxt", { n: 12 }), sig);
  fail = false;
  await executor(tool, call("13", "staleTxt", { n: 0 }), sig); // success
  fail = true;
  const r14 = await executor(tool, call("14", "staleTxt", { n: 14 }), sig);
  // Family "boom #": three live failures at calls 10/12/14, all with the
  // SAME text ("boom 2" — args vary so H2 stays silent; successes break
  // the consecutive ladder). "boom 1" left the window, so distinct texts
  // inside the window = 1. With the pre-fix code its text lived forever
  // -> distinct 2 -> a false warn here.
  assert.equal(r14.details?.sameFamilyWarn, undefined, "stale distinct text must expire with its window entry");
  // And pin the whole path: no guard at all may fire here (a passing test
  // that passes because an EARLIER guard short-circuited would hide a
  // stale-text regression — auditor cycle 1).
  assert.equal(r14.details?.sameErrorWarn, undefined, "consecutive ladder must stay silent: successes break it");
  assert.equal(r14.details?.stall, undefined, "no stall on this path");
  assert.equal(r14.isError, true, "the real error still rides through");
});

test("family-window: pruneExpiredFamilyEntries sweeps EVERY family, not just one (round-2 audit, cycle 1 finding 1)", () => {
  // The contract the executor relies on: a prune limited to the
  // currently-recording family passes every behavioral test (round-2
  // cycle-1 mutation "if (k !== famKey) continue" survived all 1,420)
  // yet retains expired pairs/texts of families not currently queried —
  // outcome 31 positions old kept inside an 8-outcome window. This
  // direct test pins the sweep itself: after one call, NO family keeps
  // an entry older than the window and no family keeps zero entries.
  const entries = (from: number, to: number): { call: number; text: string }[] => {
    const out: { call: number; text: string }[] = [];
    for (let c = from; c <= to; c++) out.push({ call: c, text: `boom ${c}` });
    return out;
  };
  const famByTool = new Map<string, { call: number; text: string }[]>();
  // A stale family entirely outside the window at index 20 (window 8:
  // live means call > 12).
  famByTool.set("staleFamily", entries(1, 4));
  // A mixed family: expired head + live tail.
  famByTool.set("mixedFamily", entries(5, 18));
  // A fully-live family.
  famByTool.set("liveFamily", entries(15, 20));
  pruneExpiredFamilyEntries(famByTool, 20);
  assert.equal(famByTool.has("staleFamily"), false, "expired family of a NON-current key is deleted");
  const mixed = famByTool.get("mixedFamily");
  assert.ok(mixed !== undefined && mixed.every((e) => 20 - e.call < SAME_FAMILY_WINDOW), "mixed family keeps only live entries");
  assert.deepEqual(famByTool.get("liveFamily"), entries(15, 20), "live family untouched");
  // Boundary: an entry exactly window-old (index 12 at index 20) is EXPIRED.
  const boundary = new Map<string, { call: number; text: string }[]>();
  boundary.set("edge", [{ call: 12, text: "x" }, { call: 13, text: "y" }]);
  pruneExpiredFamilyEntries(boundary, 20);
  assert.deepEqual(boundary.get("edge"), [{ call: 13, text: "y" }], "expiry is currentIndex - call < window (exactly-old entry drops)");
});

test("family-window: a NEW family is admitted and records its first call (2026-11-28 audit, finding 1)", async () => {
  // The defect: eviction ranked families by newest call and ran BEFORE
  // the first pair was pushed, so the brand-new family (empty history)
  // ranked oldest and self-evicted — a family admitted after 32 other
  // families never warned.
  //
  // 2026-11-28 review, finding 2 (wording fixed after round-2 audit
  // cycle 1) — honest scope note: the global prune (pruneExpiredFamily-
  // Entries, pinned by its own contract test below) drops families with
  // no live pairs, so only <=SAME_FAMILY_WINDOW (8) families are ever
  // concurrently tracked and the FAMILY_MAX_TRACKED eviction is
  // unreachable defensive code under current constants. What THIS test
  // pins is admission+recording after many HISTORICAL families (32, each
  // expired and pruned). It caught the ORIGINAL self-eviction defect as
  // that code shipped (no global prune, families survived, the 33rd
  // self-evicted); re-introducing "evict before push" today would NOT
  // reactivate it unless the global prune were ALSO removed — this test
  // is not that test. The eviction branch itself is pinned only by
  // reading (unreachable), by design.
  // Sequence: 32 distinct single-failure families, then a 33rd family
  // failing 3 times in 3 calls -> must warn on the third.
  const { tool } = makeTool("famCap", async (_id, args) => ({
    content: [{ type: "text" as const, text: `fam ${args.letter} err ${args.n}` }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  // 32 distinct families (distinct LETTERS survive digit masking), one
  // failure each.
  for (let i = 0; i < 32; i++) {
    await executor(tool, call(`o${i}`, "famCap", { letter: String.fromCharCode(65 + i), n: 0 }), sig);
  }
  // The 33rd family: three digit-varying failures back-to-back.
  const r1 = await executor(tool, call("n1", "famCap", { letter: "Z9", n: 1 }), sig);
  const r2 = await executor(tool, call("n2", "famCap", { letter: "Z9", n: 2 }), sig);
  const r3 = await executor(tool, call("n3", "famCap", { letter: "Z9", n: 3 }), sig);
  assert.equal(r1.details?.sameFamilyWarn, undefined);
  assert.equal(r2.details?.sameFamilyWarn, undefined);
  assert.equal(
    r3.details?.sameFamilyWarn,
    3,
    "the newly-admitted family records its first call instead of self-evicting",
  );
});

test("family-window: out-of-order parallel completions cannot fake a window (2026-11-28 auditor cycle 2)", async () => {
  // The defect: the executor recorded guard state on completion but the
  // per-tool call index was allocated on ENTRY, so a parallel batch
  // finishing in reverse order produced NEGATIVE window deltas (never
  // pruned): the family window retained one pair per call (12 completions
  // -> sameFamilyWarn: 12) and H2 stalled on completions no real "last 8"
  // ever contained. Fix: the outcome index is allocated at the single
  // outcome seam (5a / occupyNonPermissionSlot), monotonic per tool.
  // Reverse-finishing batch: 12 same-family failures complete 12..1.
  const releases: (() => void)[] = [];
  const { tool } = makeTool("reverse", async (_id, args) => {
    await new Promise<void>((resolve) => {
      releases[args.n as number] = resolve;
    });
    return {
      content: [{ type: "text" as const, text: `boom ${args.n}` }],
      isError: true,
    };
  });
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const pending: Promise<ToolResult>[] = [];
  for (let n = 1; n <= 12; n++) pending.push(executor(tool, call(String(n), "reverse", { n }), sig));
  for (let n = 12; n >= 1; n--) releases[n]?.();
  const results = await Promise.all(pending);
  const warnCounts = results
    .map((r) => r.details?.sameFamilyWarn)
    .filter((w): w is number => typeof w === "number");
  assert.ok(warnCounts.length > 0, "the loop does warn somewhere in the batch");
  assert.ok(
    warnCounts.every((w) => w <= 8),
    `family warn stays window-bounded under reverse completion (saw ${warnCounts.join(",")})`,
  );
  // H2 sandwich: identical args+text on calls 1,2,9; successes between;
  // call 1 completes LAST. No 8-completion window contains all three
  // failures -> no stall, no repeat warn. Delay/fail/succeed is chosen by
  // the external pending-set (2026-11-28 auditor cycle 3): ALL failing
  // calls share ONE argument shape, or H2's args key would split them and
  // the assertion could never see the regression it pins.
  const failing = new Set(["1", "2", "9"]);
  const held = new Set(["1"]);
  let releaseFirst: () => void = () => {};
  const { tool: par } = makeTool("par2", async (id) => {
    if (held.has(id)) await new Promise<void>((resolve) => (releaseFirst = resolve));
    return failing.has(id)
      ? { content: [{ type: "text" as const, text: "boom" }], isError: true }
      : { content: [{ type: "text" as const, text: "ok" }] };
  });
  const ex2 = makeToolExecutor();
  const p1 = ex2(par, call("1", "par2", {}), sig);
  const rest: Promise<ToolResult>[] = [];
  for (let n = 2; n <= 9; n++) rest.push(ex2(par, call(String(n), "par2", {}), sig));
  const restResults = await Promise.all(rest); // 2..9 complete first
  releaseFirst(); // call 1 completes dead last
  const r1 = await p1;
  assert.equal(r1.details?.stall, undefined, "no false H2/streak stall on out-of-order completion");
  assert.equal(r1.details?.repeatFailure, undefined);
  assert.equal(r1.details?.sameFamilyWarn, undefined);
  assert.ok(!restResults.some((r) => r.details?.stall === true), "no stall among the in-order calls either");
});

test("windowed guards: blocked / invalid / broken-hook calls expire real H1 denials (2026-11-28 auditor cycle 1 follow-up)", async () => {
  // The pre-execution returns must consume their call index AND their H1
  // slot (cycle 1, finding 1) — pinned here for the PERMISSION (H1) guard;
  // the H2/family expiry across all three pre-execution paths is pinned
  // by the matrix test below (the mutation "H1 slot push kept, index
  // advance dropped" left THIS test green yet let H2/family regress).
  const blocked = { active: false };
  const { tool } = makeTool("gate", async () => ({
    content: [{ type: "text" as const, text: "Operation not permitted" }],
    isError: true,
  }));
  const executor = makeToolExecutor({
    beforeToolCall: async (_t, c) => (blocked.active && !c.arguments.allow ? { blocked: "gated" } : undefined),
  });
  const sig = new AbortController().signal;
  // Two real denials, then EIGHT blocked calls, then a third denial:
  // inside the last-8 window at call 11 only ONE denial is alive -> no H1.
  await executor(tool, call("1", "gate", { allow: true }), sig);
  await executor(tool, call("2", "gate", { allow: true }), sig);
  blocked.active = true;
  for (let n = 3; n <= 10; n++) await executor(tool, call(String(n), "gate", {}), sig);
  const r11 = await executor(tool, call("11", "gate", { allow: true }), sig);
  assert.equal(r11.details?.stall, undefined, "8 blocked calls slide the old denials out of H1's window");
  // Invalid-args calls occupy their slots too (validation runs before the
  // hook, so a missing required arg is rejected even when unblocked).
  // 2026-11-28 auditor cycle 3: the SEED denials must really execute -
  // they carry the required arg; only the eight intervening calls omit it.
  const strict: typeof tool = {
    ...tool,
    parameters: {
      type: "object",
      required: ["must"],
      properties: { must: { type: "string" } },
    } as typeof tool.parameters,
  };
  const ex2 = makeToolExecutor();
  const seed1 = await ex2(strict, call("1", "gate", { allow: true, must: "s" }), sig);
  assert.equal(seed1.details?.notExecuted, undefined, "seed denial 1 really executed");
  assert.match(seed1.content.map((c) => c.text).join(""), /not permitted/);
  const seed2 = await ex2(strict, call("2", "gate", { allow: true, must: "s" }), sig);
  assert.equal(seed2.details?.notExecuted, undefined, "seed denial 2 really executed");
  for (let n = 3; n <= 10; n++) {
    const inv = await ex2(strict, call(String(n), "gate", {}), sig); // 8 invalid
    assert.match(inv.content.map((c) => c.text).join(""), /Invalid arguments/);
  }
  const r11b = await ex2(strict, call("11", "gate", { allow: true, must: "s" }), sig);
  assert.equal(r11b.details?.stall, undefined, "8 invalid calls slide the old denials out too");

  // Broken-hook calls occupy their slots as well (the third pre-execution
  // path - completing the matrix the test name claims).
  let hookBroken = false;
  const { tool: hookTool } = makeTool("hooky", async () => ({
    content: [{ type: "text" as const, text: "Operation not permitted" }],
    isError: true,
  }));
  const ex3 = makeToolExecutor({
    beforeToolCall: async (_t, c) => {
      if (hookBroken && c.arguments.broken === true) throw new Error("hook exploded");
      return undefined;
    },
  });
  await ex3(hookTool, call("1", "hooky", {}), sig);
  await ex3(hookTool, call("2", "hooky", {}), sig);
  hookBroken = true;
  for (let n = 3; n <= 10; n++) {
    const bh = await ex3(hookTool, call(String(n), "hooky", { broken: true }), sig);
    assert.match(bh.content.map((c) => c.text).join(""), /hook failed/);
  }
  const r11c = await ex3(hookTool, call("11", "hooky", {}), sig);
  assert.equal(r11c.details?.stall, undefined, "8 broken-hook calls slide the old denials out");
});

// The pre-execution expiry pin for the two NON-permission windowed
// guards (2026-11-28 code review, finding 1): the H1 test above cannot
// cover them (permission failures bypass their bookkeeping), and the
// mutation "H1 slot push kept, shared call-index advance dropped" kept
// the whole suite green while BOTH guards regressed (reproduced: 2
// identical failures + 8 blocked + a 3rd = false H2 stall; 2 same-family
// failures + 8 blocked + a 3rd = false family warn). Each pre-execution
// path x each guard is exercised below: two real seed failures, EIGHT
// intervening calls ending pre-execution, then a third seed-shaped
// failure whose outcome index must be 11 — the seeds (indices 1,2) are
// then outside the last-8 window and no guard may fire.
type PrePath = "blocked" | "invalid" | "broken-hook";

async function preExecExpiryMatrix(kind: "h2" | "family", path: PrePath): Promise<void> {
  const requiresMust = path === "invalid";
  const tool: Tool = {
    name: `prex-${kind}-${path}`,
    description: `pre-execution expiry matrix probe (${kind}/${path})`,
    parameters: requiresMust
      ? ({ type: "object", required: ["must"], properties: { must: { type: "string" } }}) as Tool["parameters"]
      : { type: "object" },
    execute: async (_id, args) => ({
      // h2: identical text for identical args; family: text varies only
      // in a digit (one family key, distinct texts).
      content: [{ type: "text" as const, text: kind === "h2" ? "boom" : `boom ${args.n}` }],
      isError: true,
    }),
  };
  const executor = makeToolExecutor({
    beforeToolCall: async (_t, c) => {
      if (path === "broken-hook" && c.arguments.broken === true) throw new Error("hook exploded");
      if (path === "blocked" && c.arguments.block === true) return { blocked: "gated" };
      return undefined;
    },
  });
  const sig = new AbortController().signal;
  // Seed args carry the required property when the path needs one; the
  // sandwich args deliberately OMIT it (invalid) or trip the gate/hook.
  // For h2 ALL seeds share ONE arg shape (cycle-3 lesson: args that
  // differ split H2's key and the assertion goes vacuous); the family
  // case varies `n` so the TEXT varies within one family key.
  const seedArgs = (n: number): Record<string, unknown> =>
    kind === "h2"
      ? requiresMust
        ? { must: "s" }
        : {}
      : requiresMust
        ? { must: "s", n }
        : { n };
  const seed = (id: string, n: number): ToolCallBlock => call(id, tool.name, seedArgs(n));
  const blocked = (id: string, n: number): ToolCallBlock =>
    call(
      id,
      tool.name,
      path === "invalid" ? {} : path === "blocked" ? { block: true, n } : { broken: true, n },
    );
  const s1 = await executor(tool, seed("s1", 1), sig);
  assert.equal(s1.details?.notExecuted, undefined, `${kind}/${path}: seed 1 executed`);
  assert.match(s1.content.map((c) => c.text).join(""), /boom/);
  const s2 = await executor(tool, seed("s2", 2), sig);
  assert.equal(s2.details?.notExecuted, undefined, `${kind}/${path}: seed 2 executed`);
  for (let j = 0; j < 8; j++) {
    const pre = await executor(tool, blocked(`b${j}`, j), sig);
    assert.equal(pre.details?.notExecuted, true, `${kind}/${path}: sandwich call never ran`);
    if (path === "blocked") assert.match(pre.content.map((c) => c.text).join(""), /was blocked/);
    if (path === "invalid") assert.match(pre.content.map((c) => c.text).join(""), /Invalid arguments/);
    if (path === "broken-hook") assert.match(pre.content.map((c) => c.text).join(""), /hook failed/);
  }
  const r3 = await executor(tool, seed("s3", 3), sig);
  // H2 (identical args+text on seeds 1,2,s3): with the sandwich counted,
  // the seeds are >8 outcomes old → no stall. Without the index advance
  // (the mutation) the seeds sat at indices 1,2 → repeatFailure stall.
  assert.equal(r3.details?.stall, undefined, `${kind}/${path}: no stall after the pre-execution sandwich`);
  assert.equal(r3.details?.repeatFailure, undefined, `${kind}/${path}: H2 window expired the seeds`);
  // Family (seeds share one family key, distinct texts): the same
  // expiry must hold — without the index advance the sandwich left the
  // family window a call behind and the third failure warned 3-in-8.
  assert.equal(r3.details?.sameFamilyWarn, undefined, `${kind}/${path}: family window expired the seeds`);
  assert.equal(r3.isError, true, `${kind}/${path}: the real error still rides through`);
}

test("windowed guards: pre-execution outcomes expire H2 identical-repeat windows (matrix, 2026-11-28 review finding 1)", async () => {
  for (const path of ["blocked", "invalid", "broken-hook"] as const) await preExecExpiryMatrix("h2", path);
});

test("windowed guards: pre-execution outcomes expire family-window failures (matrix, 2026-11-28 review finding 1)", async () => {
  for (const path of ["blocked", "invalid", "broken-hook"] as const) await preExecExpiryMatrix("family", path);
});
//
// Two rungs (the hard stop at 3 false-positived legitimate per-target
// probing — audit finding): warn at 3 IN A ROW (notice appended, run
// continues), stall at 5 IN A ROW. ANY other outcome (success, permission
// denial, different error) resets the streak, so unrelated targets sharing
// a generic error cannot accumulate across unrelated work.

test("same-error: warn at 3 IN A ROW (appends guard notice, run continues)", async () => {
  const { tool } = makeTool("rephrase", async () => ({
    content: [{ type: "text" as const, text: "TypeError: __init__() takes 2-3 args" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  for (const id of ["1", "2"]) {
    const r = await executor(tool, call(id, "rephrase", { cmd: `sed ,+${id}p` }), sig);
    assert.equal(r.details?.stall, undefined);
    assert.equal(r.details?.sameErrorWarn, undefined);
  }
  const c = await executor(tool, call("3", "rephrase", { cmd: "sed ,+99p" }), sig);
  assert.equal(c.details?.stall, undefined, "warn rung does NOT stop the run");
  assert.equal(c.details?.sameErrorWarn, 3, "the warn rung fired at 3 in a row");
  assert.match(resultText(c), /3 times in a row/);
  // the real error is still there (verbatim, not replaced).
  assert.match(resultText(c), /__init__/);
});

test("same-error: stall at 5 IN A ROW with varying args (rephrase-while-stuck)", async () => {
  const { tool } = makeTool("stuck", async () => ({
    content: [{ type: "text" as const, text: "sed: invalid command code ," }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  for (let n = 1; n <= 4; n++) {
    const r = await executor(tool, call(String(n), "stuck", { v: n }), sig);
    assert.equal(r.details?.stall, undefined);
  }
  const e = await executor(tool, call("5", "stuck", { v: 5 }), sig);
  assert.equal(e.details?.stall, true);
  assert.equal(e.details?.sameError, true);
  assert.equal(e.details?.repeatFailure, undefined, "streak guard defers to H2 on exact repeats");
  const ev = e.details?.stallEvidence as { guard: string; repeats: number; consecutive: boolean };
  assert.equal(ev.guard, "same-error-stall");
  assert.equal(ev.repeats, 5);
  assert.equal(ev.consecutive, true, "marks the count as a consecutive streak");
  assert.match(resultText(e), /5 times IN A ROW/);
});

test("same-error: success RESETS the streak (audit finding 1)", async () => {
  let first = false;
  const { tool } = makeTool("mixer", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.ok ? "ok" : "not found" }],
    isError: args.ok !== true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  let n = 0;
  const run = async (ok: boolean) => {
    const r = await executor(tool, call(String(++n), "mixer", { ok, target: n }), sig);
    return r.details?.stall === true || r.details?.sameErrorWarn !== undefined;
  };
  assert.equal(await run(false), false);
  assert.equal(await run(false), false);
  assert.equal(await run(true), false, "success");
  // streak broken: the next two identical failures must NOT warn/stall.
  assert.equal(await run(false), false, "post-success 1");
  assert.equal(await run(false), false, "post-success 2");
  // and on to the warn rung after three consecutive again.
  assert.equal(await run(false), true, "post-success 3 (warn)");
  void first;
});

test("same-error: DIFFERENT error between failures resets the streak (audit finding 4)", async () => {
  const { tool } = makeTool("prog", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.e as string }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  // Args VARY so H2's args-keyed window cannot fire — this isolates the
  // consecutive-streak guard: alternating error texts never reach 3 IN A
  // ROW of the same one, so neither warn nor stall may appear.
  const errs = ["a", "a", "b", "a", "a", "b"];
  for (const [i, e] of errs.entries()) {
    const r = await executor(tool, call(String(i), "prog", { e, i }), sig);
    assert.equal(r.details?.stall, undefined, `no stall across alternating "${e}"`);
    assert.equal(r.details?.sameErrorWarn, undefined, `no warn across alternating "${e}"`);
  }
});

test("same-error: independent targets with the SAME generic error (no success between) DO stall", async () => {
  // By design: back-to-back identical failures — even under the plausible
  // reading of "independent targets" — is exactly the rephrase-while-stuck
  // signature. The warning rung gives the model three clear signals before
  // the hard stop at 5; legitimate per-target work interleaves successes.
  const { tool } = makeTool("probe", async (_id, args) => ({
    content: [{ type: "text" as const, text: "not found" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = await executor(tool, call(String(i), "probe", { target: i }), sig);
    results.push(r.details?.stall === true);
  }
  assert.deepEqual(results, [false, false, false, false, true], "warn×2 then stall@5");
});

test("same-error: exact repeats still belong to H2 (repeatFailure flag preserved)", async () => {
  const { tool } = makeTool("exact", async () => ({
    content: [{ type: "text" as const, text: "boom" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "exact", { x: 1 }), sig);
  await executor(tool, call("2", "exact", { x: 1 }), sig);
  const r = await executor(tool, call("3", "exact", { x: 1 }), sig);
  assert.equal(r.details?.repeatFailure, true);
  assert.equal(r.details?.sameError, undefined, "streak guard defers to H2 on byte-identical repeats");
});

test("same-error: permission denials RESET the streak (H1 owns that pattern)", async () => {
  const { tool } = makeTool("wall", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.perm ? "Operation not permitted" : "sed: bad flag --" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  let n = 0;
  const run = async (perm: boolean) =>
    executor(tool, call(String(++n), "wall", { perm }), sig);
  await run(true); await run(true); await run(true); // 3 denials → H1 stall
  // after H1's stall, the same-error streak must start fresh:
  const a = await run(false); const b = await run(false);
  assert.equal(a.details?.stall, undefined);
  assert.equal(a.details?.sameErrorWarn, undefined, "H1 reset the streak: first non-perm failure is 1");
  assert.equal(b.details?.stall, undefined);
  assert.equal(b.details?.sameErrorWarn, undefined);
});

test("same-error: PRE-EXECUTION outcomes reset the streak (finding 2)", async () => {
  // Validation failure / blocked gate / broken hook never reach the
  // tool — they are "another outcome" and must break the streak, exactly
  // like a success. Before the fix they returned before the streak
  // maintenance, so "boom, boom, <invalid>, boom" reported warn=3.
  // A schema with a REQUIRED arg, so "{}" is a validation failure rather
  // than a pass-through (makeTool's own object schema accepts anything).
  const okTool = (name: string): { tool: Tool } => {
    const { tool } = makeTool(name, async () => ({
      content: [{ type: "text" as const, text: "boom" }],
      isError: true,
    }));
    return {
      tool: {
        ...tool,
        parameters: {
          type: "object",
          properties: { v: { type: "number" } },
          required: ["v"],
        },
      },
    };
  };
  const sig = new AbortController().signal;
  let n = 0;
  const nextId = () => String(++n);

  // (a) validation failure in the middle.
  {
    const { tool } = okTool("v");
    const executor = makeToolExecutor();
    const boom = () => executor(tool, call(nextId(), "v", { v: n }), sig);
    await boom();
    await boom();
    // malformed: required arg missing → validateArgs rejects it.
    const bad = await executor(tool, call(nextId(), "v", {}), sig);
    assert.equal(bad.details?.notExecuted, true, "the malformed call never ran");
    const after = await boom();
    assert.equal(after.details?.sameErrorWarn, undefined, "streak reset by validation failure");
    assert.equal(after.details?.stall, undefined);
  }

  // (b) blocked gate in the middle.
  {
    const { tool } = okTool("b");
    const executor = makeToolExecutor({
      beforeToolCall: (t) =>
        (t as unknown as { name: string }).name === "b" && blockedNext
          ? { blocked: "audit block" }
          : undefined,
    });
    let blockedNext = false;
    const boom = () => executor(tool, call(nextId(), "b", { v: n }), sig);
    await boom();
    await boom();
    blockedNext = true;
    const blocked = await boom();
    blockedNext = false;
    assert.equal(blocked.details?.notExecuted, true);
    const after = await boom();
    assert.equal(after.details?.sameErrorWarn, undefined, "streak reset by the blocked gate");
  }

  // (c) broken hook in the middle.
  {
    const { tool } = okTool("h");
    let throwNext = false;
    const executor = makeToolExecutor({
      beforeToolCall: () => {
        if (throwNext) throw new Error("hook broke");
        return undefined;
      },
    });
    const boom = () => executor(tool, call(nextId(), "h", { v: n }), sig);
    await boom();
    await boom();
    throwNext = true;
    const broke = await boom();
    throwNext = false;
    assert.equal(broke.details?.notExecuted, true);
    const after = await boom();
    assert.equal(after.details?.sameErrorWarn, undefined, "streak reset by the broken hook");
  }
});

test("H1 window advances even when the same-error rung fires (finding 1)", async () => {
  // The warn/stall rungs return before H1's verdict. Before the fix they
  // also returned before H1's BOOKKEEPING, so warned calls never shifted
  // the window: permission denials slid out too slowly and H1 fired on a
  // call whose real last-8 history held only one denial.
  const { tool } = makeTool("mix", async (_id, args) => ({
    content: [{ type: "text" as const, text: args.out as string }],
    isError: args.out !== "success",
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const perm = "bash: exit code 1\nOperation not permitted";
  // Distinct args on every call so H2 never owns the repetition.
  const seq = [
    perm, perm, // two denials, no verdict yet
    "boom", "boom", "boom", "boom", // warn at 3 and 4 — these must still
    // occupy window slots
    "success", "success", "success",
    perm, // the 10th call: its last 8 calls hold ONE denial → no H1 stall
  ];
  const details = [];
  for (const [i, out] of seq.entries()) {
    const r = await executor(tool, call(String(i), "mix", { out, i }), sig);
    details.push(r.details ?? {});
  }
  assert.equal(details[4]?.sameErrorWarn, 3, "warn rung fired at 3 in a row");
  assert.equal(details[5]?.sameErrorWarn, 4, "warn continues at 4");
  assert.equal(
    details[9]?.stallEvidence,
    undefined,
    "H1 must NOT fire: the two early denials slid out of the 8-call window",
  );
});

test("warn rung keeps progressTarget when a hook rewrote the path (2026-11-27 audit)", async () => {
  // F1's unverified-edit scan keys on details.progressTarget, falling back
  // to the model's original path when it is missing (agent-loop.ts:1403-
  // 1407). The progressTarget attach used to sit at the very END of the
  // executor — the warn rung returned before it, splitting a run's edit
  // counts across the effective and model paths. Four varying-arg failures
  // on the SAME effective path: every result, warned or not, must carry
  // the hook-rewritten path.
  const eff = path.join(dir, "effective-target.ts");
  const { tool } = makeTool("edit", async () => ({
    content: [{ type: "text" as const, text: "oldText not found" }],
    isError: true,
  }));
  const executor = makeToolExecutor({
    beforeToolCall: (_t, c) => ({ args: { ...c.arguments, path: eff } }),
  });
  const sig = new AbortController().signal;
  for (let n = 1; n <= 4; n++) {
    const r = await executor(
      tool,
      call(String(n), "edit", { path: "/model/original/target.ts", oldText: `v${n}` }),
      sig,
    );
    assert.equal(r.details?.progressTarget, eff, `call ${n} keeps the effective path`);
    assert.equal(r.details?.sameErrorWarn, n >= 3 ? n : undefined);
  }
});

// ─────────────────────────── stall guard (sandbox wall) ───────────────────────
//
// The kernel sandbox makes permission denials DETERMINISTIC: the same
// operation fails identically forever. The guard keys on the TOOL (not the
// arguments — rephrasing the command is exactly the stall pattern) and
// counts permission failures of that tool within its last STALL_WINDOW (8)
// calls (docs/08 H1 — WINDOWED: interleaved successes must NOT reset the
// count, the probe loop). The failing call is replaced in-band with
// STALL_TEXT + details.stall (I3: every call gets a result); the call WAS
// executed (a denial is a harmless no-op), so a legitimate call that
// SUCCEEDS never trips it.

const permFail =
  "bash: exit code 1\nOperation not permitted"; // the sandbox's EPERM spelling

test("stall guard: same tool, permission failure 3× → 3rd replaced with STALL_TEXT + details.stall", async () => {
  const { tool, calls } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: permFail }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  const r1 = await executor(tool, call("1", "t", { p: "x" }), sig);
  const r2 = await executor(tool, call("2", "t", { p: "x" }), sig);
  assert.equal(r1.isError, true, "1st failure passes through");
  assert.equal(r2.isError, true, "2nd failure passes through (legit retry)");
  const r3 = await executor(tool, call("3", "t", { p: "x" }), sig);
  assert.equal(r3.isError, true, "3rd failure is an in-band error result (I3)");
  assert.match(resultText(r3), /WAS executed.*REPLACED/);
  assert.equal(r3.details?.stall, true, "the loop maps details.stall onto stopReason");
  assert.notEqual(r3.details?.notExecuted, true, "an executed denial gains no marker");
  assert.equal(calls.length, 3, "all three executed (a denial is a harmless no-op)");
});

// F1 (docs/08 §9, sixth audit pass): the execution fact survives result
// rewriting — a redaction hook that drops `details` must not turn a
// never-executed call into apparent ground contact.
test("pipeline: afterToolCall dropping details cannot erase notExecuted", async () => {
  const { tool } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: "spawn failed" }],
    isError: true,
    details: { notExecuted: true, other: "meta" },
  }));
  const executor = makeToolExecutor({
    // the documented redaction shape: new content, keep the error flag,
    // no details at all
    afterToolCall: (_t, _c, r) => ({
      content: [{ type: "text" as const, text: "REDACTED" }],
      isError: r.isError,
    }),
  });
  const r = await executor(tool, call("1", "t", {}), new AbortController().signal);
  assert.equal(resultText(r), "REDACTED", "the hook still rewrites the content");
  assert.equal(r.details?.notExecuted, true, "the execution fact is authoritative, not the hook");
});

// F1 (docs/08 §9, fifth audit pass): the H1 replacement PRESERVES
// notExecuted and its notice says the truth — a never-executed result must
// never read to the loop/TUI as ground contact (a measurement).
test("stall guard: a NOT-EXECUTED permission failure keeps notExecuted through the replacement", async () => {
  const { tool } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: permFail }],
    isError: true,
    details: { notExecuted: true }, // e.g. a bash whose spawn failed EPERM
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "x" }), sig);
  await executor(tool, call("2", "t", { p: "x" }), sig);
  const r3 = await executor(tool, call("3", "t", { p: "x" }), sig);
  assert.equal(r3.details?.stall, true, "still a stall stop");
  assert.equal(r3.details?.notExecuted, true, "the replacement preserves the execution fact");
  assert.match(
    resultText(r3),
    /was NOT executed.*REPLACED/,
    "the notice follows the fact (parameterized stallText, not a string splice)",
  );
});

test("stall guard: REPHRASED arguments do NOT reset the count (the stall pattern)", async () => {
  const { tool } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: permFail }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "git push" }), sig);
  await executor(tool, call("2", "t", { p: "git push origin main" }), sig); // rephrased
  const r3 = await executor(tool, call("3", "t", { p: "git push --set-upstream origin main" }), sig);
  assert.equal(r3.details?.stall, true, "rephrasing the same tool does not reset the count");
});

test("stall guard: DIFFERENT tool has its OWN count (no inheritance, no reset) — docs/08 H1", async () => {
  const mk = (name: string) =>
    makeTool(name, async () => ({
      content: [{ type: "text" as const, text: permFail }],
      isError: true,
    }));
  const a = mk("read");
  const b = mk("write");
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(a.tool, call("1", "read", { p: "x" }), sig); // read fail (read count 1)
  await executor(b.tool, call("2", "write", { p: "x" }), sig); // write fail — write's OWN count (1)
  await executor(a.tool, call("3", "read", { p: "x" }), sig); // read fail (read count 2)
  const r4 = await executor(a.tool, call("4", "read", { p: "x" }), sig); // read fail (read count 3)
  assert.equal(r4.details?.stall, true, "the read chain reached 3 in its OWN window — the write failure neither inherited nor reset it");
});

test("stall guard (H1): an interleaved SUCCESS does NOT reset the count (the probe loop)", async () => {
  const { tool } = makeTool("t", async (_id, args) =>
    args.p === "x"
      ? { content: [{ type: "text" as const, text: permFail }], isError: true }
      : { content: [{ type: "text" as const, text: "ok" }] },
  );
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "x" }), sig); // fail x (count 1)
  await executor(tool, call("2", "t", { p: "y" }), sig); // success y — occupies a slot, does NOT reset
  await executor(tool, call("3", "t", { p: "x" }), sig); // fail x (count 2)
  const r4 = await executor(tool, call("4", "t", { p: "y" }), sig); // success y — still no reset
  assert.equal(r4.details?.stall, undefined, "2 failures within the window is not yet a stall");
  const r5 = await executor(tool, call("5", "t", { p: "x" }), sig); // fail x (count 3 within 8 calls)
  assert.equal(r5.details?.stall, true, "the probe loop (fail/ok/fail/ok/fail) stalls on the 3rd wall-hit");
});

test("stall guard (H1): the window slides — a stale failure does not stall a fresh retry", async () => {
  const { tool } = makeTool("t", async (_id, args) =>
    args.p === "x"
      ? { content: [{ type: "text" as const, text: permFail }], isError: true }
      : { content: [{ type: "text" as const, text: "ok" }] },
  );
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "x" }), sig); // fail x (count 1)
  await executor(tool, call("2", "t", { p: "x" }), sig); // fail x (count 2)
  for (let i = 3; i <= 9; i++) {
    const r = await executor(tool, call(String(i), "t", { p: "y" }), sig); // 7 successes — the window slides past both failures
    assert.equal(r.details?.stall, undefined, `call ${i}: the stale failures have left the window`);
  }
  const r10 = await executor(tool, call("10", "t", { p: "x" }), sig); // fail x — only 1 failure in the window
  assert.equal(r10.details?.stall, undefined, "a stale denial 8+ calls ago must not stall a fresh retry");
});

test("stall guard (H1): a NON-permission failure does not reset the count", async () => {
  const { tool } = makeTool("t", async (_id, args) =>
    args.p === "x"
      ? { content: [{ type: "text" as const, text: permFail }], isError: true }
      : { content: [{ type: "text" as const, text: "bash: exit code 127\ncommand not found" }], isError: true },
  );
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "x" }), sig); // perm fail (count 1)
  await executor(tool, call("2", "t", { p: "y" }), sig); // transient fail — occupies a slot, does NOT reset
  await executor(tool, call("3", "t", { p: "x" }), sig); // perm fail (count 2)
  const r4 = await executor(tool, call("4", "t", { p: "x" }), sig); // perm fail (count 3 within 8 calls)
  assert.equal(r4.details?.stall, true, "the count is wall-hits in the window, not wall-hits in a row");
});

test("stall guard: NON-permission failures never trip it (transient retries allowed)", async () => {
  let attempt = 0;
  const { tool, calls } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: `bash: exit code 127\ncommand not found (${++attempt})` }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  for (let i = 1; i <= 5; i++) {
    const r = await executor(tool, call(String(i), "t", { p: "x" }), sig);
    assert.equal(r.details?.stall, undefined, `repeat ${i} of a transient failure never stalls`);
  }
  assert.equal(calls.length, 5, "all five executed");
});

test("stall guard: permission patterns (unit)", () => {
  assert.equal(isPermissionStallText(["Operation not permitted"]), true);
  assert.equal(isPermissionStallText(["cat: /etc/shadow: Permission denied"]), true);
  assert.equal(isPermissionStallText(["EACCES: permission denied, open '/x'"]), true);
  assert.equal(isPermissionStallText(["EPERM: operation not permitted, mkdir"]), true);
  assert.equal(isPermissionStallText(["bash: exit code 127\ncommand not found"]), false);
  assert.equal(isPermissionStallText(["ok"]), false);
  assert.equal(isPermissionStallText([]), false);
});

test("pipeline: broken hooks never kill the run (I3)", async () => {
  const { tool } = makeTool("t");
  const executorBefore = makeToolExecutor({
    beforeToolCall: () => {
      throw new Error("hook exploded");
    },
  });
  const r1 = await executorBefore(tool, call("1", "t", {}), new AbortController().signal);
  assert.equal(r1.isError, true);
  assert.match(resultText(r1), /beforeToolCall hook failed/);

  const executorAfter = makeToolExecutor({
    afterToolCall: () => {
      throw new Error("hook exploded");
    },
  });
  const r2 = await executorAfter(tool, call("1", "t", {}), new AbortController().signal);
  assert.equal(r2.isError, undefined, "broken afterToolCall keeps the tool's result");
  assert.equal(resultText(r2), "t ran");
});

// ────────────────────────────── read ──────────────────────────────

test("read: file content", async () => {
  const p = write("f.txt", "alpha\nbeta\n");
  const r = await readTool.execute("1", { path: p }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  assert.equal(resultText(r), "alpha\nbeta\n");
});

test("read: offset/limit page with a range header", async () => {
  const p = write("f.txt", "1\n2\n3\n4\n5\n");
  const r = await readTool.execute("1", { path: p, offset: 3, limit: 2 }, new AbortController().signal);
  assert.equal(resultText(r), "lines 3–4 of 5\n3\n4\n");
});

test("read: offset beyond EOF → friendly note, not an error", async () => {
  const p = write("f.txt", "1\n2\n");
  const r = await readTool.execute("1", { path: p, offset: 99 }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  assert.match(resultText(r), /no more lines/);
});

test("read: missing file → isError result (I3)", async () => {
  const r = await readTool.execute("1", { path: path.join(dir, "nope.txt") }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /cannot read/);
});

test("read: binary file → isError result", async () => {
  const p = write("bin.dat", "ab\u0000cd");
  const r = await readTool.execute("1", { path: p }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /binary/);
});

test("read: >2000 lines → head-truncated with fullOutputPath + continue hint", async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
  const p = write("big.txt", lines.join("\n") + "\n");
  const r = await readTool.execute("1", { path: p }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  const text = resultText(r);
  assert.match(text, /\[truncated: showing first 2000 of 3000 lines/);
  assert.match(text, /continue with offset=2001 \(file has 3000 lines\)/);
  const fop = r.details?.fullOutputPath as string;
  assert.ok(fop && existsSync(fop));
  assert.equal(readFileSync(fop, "utf8"), lines.join("\n") + "\n");
  assert.equal(r.details?.truncated, true);
});

test("read: byte-limit truncation (wide lines) → hint suggests a smaller limit", async () => {
  // 500 lines of ~2000 bytes each: the page is cut by the 50 KB byte cap,
  // not the 2000-line cap. Following offset alone would re-truncate, so the
  // hint must also suggest a limit.
  const wide = Array.from({ length: 500 }, () => "x".repeat(2000));
  const p = write("wide.txt", wide.join("\n") + "\n");
  const r = await readTool.execute("1", { path: p }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  const text = resultText(r);
  assert.match(text, /\[truncated: showing first \d+ of 500 lines/);
  assert.match(text, /wide lines hit the byte cap — also pass limit=\d+/);
  const m = text.match(/limit=(\d+)/);
  assert.ok(m, "hint carries a numeric limit");
  assert.ok(Number(m![1]) >= 1, "suggested limit is positive");
  assert.equal(r.details?.truncated, true);
});

test("read: line-limit truncation (many short lines) → hint has NO limit suggestion", async () => {
  // 3000 short lines: cut by the 2000-line cap, not the byte cap. The hint
  // must stay the plain offset continuation (pinned format).
  const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
  const p = write("many.txt", lines.join("\n") + "\n");
  const r = await readTool.execute("1", { path: p }, new AbortController().signal);
  const text = resultText(r);
  assert.match(text, /continue with offset=2001 \(file has 3000 lines\)/);
  assert.ok(!/limit=/.test(text), "no limit suggestion for line-limit truncation");
});

// ────────────────────────────── write ──────────────────────────────

test("write: creates parents and writes content", async () => {
  const p = path.join(dir, "a/b/c.txt");
  const r = await writeTool.execute("1", { path: p, content: "hello\nworld\n" }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(p, "utf8"), "hello\nworld\n");
  assert.match(resultText(r), /Wrote 12 bytes \(2 lines\)/);
});

test("write: overwrites existing files", async () => {
  const p = write("f.txt", "old");
  await writeTool.execute("1", { path: p, content: "new" }, new AbortController().signal);
  assert.equal(readFileSync(p, "utf8"), "new");
});

// ────────────────────────────── edit ──────────────────────────────

test("edit: unique exact match replaces the region", async () => {
  const p = write("f.txt", "aaa\nbbb\nccc\n");
  const r = await editTool.execute("1", { path: p, oldText: "bbb", newText: "BEE" }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(p, "utf8"), "aaa\nBEE\nccc\n");
});

test("edit: multi-line oldText must match exactly (whitespace included)", async () => {
  const p = write("f.ts", "const x = 1;\nconst y = 2;\n");
  // wrong indent → no match
  const bad = await editTool.execute("1", { path: p, oldText: "  const y = 2;", newText: "const y = 3;" }, new AbortController().signal);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad), /no exact match/);
  assert.equal(readFileSync(p, "utf8"), "const x = 1;\nconst y = 2;\n", "failed edit must not touch the file");
  // exact → ok
  const ok = await editTool.execute("2", { path: p, oldText: "const y = 2;", newText: "const y = 3;" }, new AbortController().signal);
  assert.equal(ok.isError, undefined);
  assert.equal(readFileSync(p, "utf8"), "const x = 1;\nconst y = 3;\n");
});

test("edit: oldText matching >1 times fails (uniqueness required)", async () => {
  const p = write("f.txt", "dup\ndup\n");
  const r = await editTool.execute("1", { path: p, oldText: "dup", newText: "one" }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /matches 2 times/);
  assert.equal(readFileSync(p, "utf8"), "dup\ndup\n");
});

test("edit: empty oldText is rejected", async () => {
  const p = write("f.txt", "x");
  const r = await editTool.execute("1", { path: p, oldText: "", newText: "y" }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /must not be empty/);
});

test("edit: newText \"\" deletes the region", async () => {
  const p = write("f.txt", "keep1\ngone\nkeep2\n");
  const r = await editTool.execute("1", { path: p, oldText: "gone\n", newText: "" }, new AbortController().signal);
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(p, "utf8"), "keep1\nkeep2\n");
});

test("edit: missing file → isError result", async () => {
  const r = await editTool.execute("1", { path: path.join(dir, "nope"), oldText: "a", newText: "b" }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.match(resultText(r), /cannot read/);
});

// ────────────────────────────── bash ──────────────────────────────

const runBash = (command: string, opts: { signal?: AbortSignal; timeout?: number } = {}) =>
  bashTool.execute(
    "1",
    { command, ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}) },
    opts.signal ?? new AbortController().signal,
  );

test("bash: stdout is returned", async () => {
  const r = await runBash("echo hello");
  assert.equal(r.isError, undefined);
  assert.equal(resultText(r), "hello\n");
});

test("bash: stderr is appended under [stderr]", async () => {
  const r = await runBash("echo out; echo err 1>&2");
  assert.equal(resultText(r), "out\n\n[stderr]\nerr\n");
});

test("bash: empty output → (no output)", async () => {
  const r = await runBash("true");
  assert.equal(resultText(r), "(no output)");
});

test("bash: non-zero exit → isError result with the exit code", async () => {
  const r = await runBash("exit 3");
  assert.equal(r.isError, true);
  assert.match(resultText(r), /exit code 3/);
});

test("bash: timeout kills the command and reports it", async () => {
  const r = await runBash("sleep 5", { timeout: 1 });
  assert.equal(r.isError, true);
  assert.match(resultText(r), /timed out after 1s/);
});

test("bash: AbortSignal mid-run → aborted result, no throw", async () => {
  const controller = new AbortController();
  const p = runBash("sleep 5", { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(resultText(r), /aborted/);
});

test("bash: pre-aborted signal → aborted immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = await runBash("echo hi", { signal: controller.signal });
  assert.equal(r.isError, true);
  assert.match(resultText(r), /aborted/);
});

test("bash: >2000 lines → tail-truncated, full output saved to temp file", async () => {
  // process.execPath (absolute) — a bare `node` on PATH fails when the test
  // runs under a kernel sandbox that cannot stat the nvm bin dir (exit 127).
  const cmd = `${process.execPath} -e "for(let i=1;i<=5000;i++) console.log('line-'+i)"`;
  const r = await runBash(cmd);
  assert.equal(r.isError, undefined);
  const text = resultText(r);
  assert.match(text, /\[truncated: showing last 2000 of 5000 lines/);
  // Tail semantics: the FINAL line is present, early ones are not.
  assert.ok(text.trimEnd().endsWith("line-5000"));
  assert.ok(!text.includes("line-1\n"));
  const fop = r.details?.fullOutputPath as string;
  assert.ok(fop && existsSync(fop));
  const full = readFileSync(fop, "utf8");
  assert.match(full, /^line-1\n/);
  assert.match(full, /line-5000\n$/);
  assert.equal(full.split("\n").filter(Boolean).length, 5000);
});

// ───────────────────────── loop ↔ pipeline integration ─────────────────────────

test("loop + pipeline: a blocked tool becomes an isError toolResult in context (D7)", async () => {
  const { tool, calls } = makeTool("t");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "t", args: {} }] },
    { type: "text", text: "recovered" },
  ];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn: fakeStream(turns, { model: MODEL }),
    signal: new AbortController().signal,
    executeToolCall: makeToolExecutor({
      beforeToolCall: () => ({ blocked: "denied by test" }),
    }),
  });
  const events = await drain(gen);
  const end = events[events.length - 1]!;
  assert.equal(end.type, "agent_end");
  if (end.type !== "agent_end") throw new Error("unreachable");
  assert.equal(end.stopReason, "stop", "the run survives a blocked tool");
  assert.equal(calls.length, 0, "the tool itself never ran");
  const result = end.messages.find((m) => m.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, true, "D7: pipeline's isError flows into the context");
  assert.match(result.content[0]!.text, /blocked: denied by test/);
});

test("bash: byte limit (1000 × 60B lines ≈ 60KB) truncates even under 2000 lines", async () => {
  const cmd = `${process.execPath} -e "for(let i=0;i<1000;i++) process.stdout.write('x'.repeat(59)+'\\n')"`;
  const r = await runBash(cmd);
  assert.equal(r.isError, undefined);
  const fop = r.details?.fullOutputPath as string;
  assert.ok(fop, "should be byte-truncated");
  const text = resultText(r);
  assert.match(text, /\[truncated: showing last \d+ of 1000 lines/);
  assert.match(text, /full output saved to/);
});

// ─────────────────────────── WS7: safety ───────────────────────────

// Pure classifiers (destructive → sensitive → read-only → reversible).

test("safety: destructive patterns — recursive rm, git push/reset/clean/branch -D/checkout ./restore", () => {
  // recursive rm (any flag form)
  assert.deepEqual(destructiveBashPatterns("rm -r build/"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm -rf node_modules"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm -Rv out"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm --recursive dist"), ["recursive rm"]);
  // plain rm is NOT destructive (it's mutating, not irreversible-by-design)
  assert.deepEqual(destructiveBashPatterns("rm file.txt"), []);
  // ANY git push (force or not)
  assert.deepEqual(destructiveBashPatterns("git push origin main"), ["git push (publishes to a remote)"]);
  assert.deepEqual(destructiveBashPatterns("git push"), ["git push (publishes to a remote)"]);
  assert.deepEqual(destructiveBashPatterns("git push --force origin main"), ["git push --force"]);
  assert.deepEqual(destructiveBashPatterns("git push -f main"), ["git push --force"]);
  // git reset --hard
  assert.deepEqual(destructiveBashPatterns("git reset --hard HEAD~1"), ["git reset --hard"]);
  assert.deepEqual(destructiveBashPatterns("git reset --soft HEAD~1"), []);
  // forced git clean
  assert.deepEqual(destructiveBashPatterns("git clean -fd"), ["git clean (removes untracked files)"]);
  assert.deepEqual(destructiveBashPatterns("git clean -x"), ["git clean (removes untracked files)"]);
  assert.deepEqual(destructiveBashPatterns("git clean -n"), []);
  // git branch -D (force-delete)
  assert.deepEqual(destructiveBashPatterns("git branch -D feature"), ["git branch -D (force-delete a branch)"]);
  assert.deepEqual(destructiveBashPatterns("git branch --delete feature"), ["git branch -D (force-delete a branch)"]);
  assert.deepEqual(destructiveBashPatterns("git branch -d feature"), []);
  // git checkout . / checkout -- <path> / restore (without --source)
  assert.deepEqual(destructiveBashPatterns("git checkout ."), ["git checkout . / -- <path> (discards uncommitted work)"]);
  assert.deepEqual(destructiveBashPatterns("git checkout -- src/main.ts"), ["git checkout . / -- <path> (discards uncommitted work)"]);
  assert.deepEqual(destructiveBashPatterns("git checkout feature"), []);
  assert.deepEqual(destructiveBashPatterns("git restore src/main.ts"), ["git restore (discards uncommitted work)"]);
  assert.deepEqual(destructiveBashPatterns("git restore --source HEAD~1 src/main.ts"), []);
  // dd to /dev/*, raw-device redirects, mkfs, fork bomb, shutdown
  assert.deepEqual(destructiveBashPatterns("dd if=disk.img of=/dev/sda"), ["dd writing to a raw device"]);
  assert.deepEqual(destructiveBashPatterns("dd if=disk.img of=/dev/nvme0n1"), ["dd writing to a raw device"]);
  assert.deepEqual(destructiveBashPatterns("dd if=disk.img of=copy.img"), []);
  assert.deepEqual(destructiveBashPatterns("cat iso > /dev/sdb"), ["write to a raw block device"]);
  assert.deepEqual(destructiveBashPatterns("echo x > /dev/null"), []);
  assert.deepEqual(destructiveBashPatterns("mkfs.ext4 /dev/sdb1"), ["mkfs (filesystem creation)"]);
  assert.deepEqual(destructiveBashPatterns("mkfs /dev/sdb1"), ["mkfs (filesystem creation)"]);
  assert.deepEqual(destructiveBashPatterns(":(){ :|:& };:"), ["fork bomb"]);
  assert.deepEqual(destructiveBashPatterns("sudo shutdown -h now"), ["system shutdown/reboot"]);
  assert.deepEqual(destructiveBashPatterns("reboot"), ["system shutdown/reboot"]);
  // unrecognized → not destructive (it may still be mutating)
  assert.deepEqual(destructiveBashPatterns("mv a b"), []);
});

test("safety: sensitive patterns — bash token scan + read path", () => {
  // PATH patterns (need a path-like token)
  assert.deepEqual(sensitiveBashPatterns("cat ~/.ssh/id_rsa"), ["id_rsa*", "~/.ssh/"]);
  assert.deepEqual(sensitiveBashPatterns("cat /etc/shadow"), ["/etc/shadow"]);
  assert.deepEqual(sensitiveBashPatterns("ls ~/.aws/credentials"), ["~/.aws/"]);
  assert.deepEqual(sensitiveBashPatterns("cat ~/.netrc"), ["~/.netrc"]);
  assert.deepEqual(sensitiveBashPatterns("cat ~/.docker/config.json"), ["~/.docker/config.json"]);
  // FILENAME patterns (match ANY token, no path context)
  assert.deepEqual(sensitiveBashPatterns("cat server.key"), ["*.key"]);
  assert.deepEqual(sensitiveBashPatterns("cat .env"), [".env*"]);
  assert.deepEqual(sensitiveBashPatterns("cat .env.production"), [".env*"]);
  assert.deepEqual(sensitiveBashPatterns("cat prod.env"), [".env*"]);
  assert.deepEqual(sensitiveBashPatterns("openssl req -in cert.pem"), ["*.pem"]);
  assert.deepEqual(sensitiveBashPatterns("cat id_ed25519"), ["id_ed25519*"]);
  // plain commands are not sensitive
  assert.deepEqual(sensitiveBashPatterns("ls -la"), []);
  assert.deepEqual(sensitiveBashPatterns("cat README.md"), []);
  // a bare token that is not a path and not a sensitive filename
  assert.deepEqual(sensitiveBashPatterns("echo hello"), []);
});

test("safety: read-only verbs + git/kubectl/docker subcommands", () => {
  assert.equal(isReadOnlyBash("ls -la"), true);
  assert.equal(isReadOnlyBash("cat src/main.ts"), true);
  assert.equal(isReadOnlyBash("grep -r foo src/"), true);
  assert.equal(isReadOnlyBash("pwd"), true);
  assert.equal(isReadOnlyBash("git status"), true);
  assert.equal(isReadOnlyBash("git log --oneline -5"), true);
  assert.equal(isReadOnlyBash("git diff"), true);
  assert.equal(isReadOnlyBash("git branch"), true); // list
  assert.equal(isReadOnlyBash("git tag"), true); // list
  assert.equal(isReadOnlyBash("git stash list"), true);
  assert.equal(isReadOnlyBash("git -C /tmp/repo status"), true);
  // cd is what most model commands start with — it must not poison the
  // compound's read-only classification (the user's exact prompt trigger).
  assert.equal(isReadOnlyBash("cd /Users/me/proj && ls"), true);
  assert.equal(isReadOnlyBash("cd"), true); // bare cd = $HOME
  assert.equal(isReadOnlyBash("cd -P /tmp && pwd"), true);
  assert.equal(
    isReadOnlyBash('cd /Users/me/proj && git status --short && echo "---" && ls && echo "---" && ls src'),
    true,
  );
  assert.equal(isReadOnlyBash("cd /x && rm -rf /y"), false); // mutating segment
  assert.equal(isReadOnlyBash("cd ~/.ssh && ls"), true); // sensitivity is a separate check
  assert.equal(isReadOnlyBash("test -f x && cat x"), true);
  assert.equal(isReadOnlyBash("[ -f x ] && pwd"), true);
  assert.equal(isReadOnlyBash("sleep 2 && ls"), true);
  assert.equal(isReadOnlyBash("kubectl get pods"), true);
  assert.equal(isReadOnlyBash("docker ps"), true);
  assert.equal(isReadOnlyBash("ip addr"), true);
  // git subcommand BOUNDARIES: anything beyond the listed form is not read-only
  assert.equal(isReadOnlyBash("git branch -D feature"), false);
  assert.equal(isReadOnlyBash("git branch feature"), false); // create = mutating
  assert.equal(isReadOnlyBash("git tag v1.0"), false); // create = mutating
  assert.equal(isReadOnlyBash("git stash push"), false); // push = mutating
  assert.equal(isReadOnlyBash("git push"), false);
  assert.equal(isReadOnlyBash("git commit -m x"), false);
  assert.equal(isReadOnlyBash("kubectl apply -f x.yaml"), false);
  assert.equal(isReadOnlyBash("docker run nginx"), false);
  assert.equal(isReadOnlyBash("ip link set eth0 down"), false);
  // non-verbs are not read-only (fail-closed)
  assert.equal(isReadOnlyBash("mv a b"), false);
  assert.equal(isReadOnlyBash("curl https://example.com"), false);
  assert.equal(isReadOnlyBash("npm install"), false);
  assert.equal(isReadOnlyBash(""), false);
});

test("safety: compound commands, redirects, $( ), backticks, sudo disqualify read-only", () => {
  assert.equal(isReadOnlyBash("ls && cat x"), true); // every segment read-only
  assert.equal(isReadOnlyBash("ls; pwd"), true);
  assert.equal(isReadOnlyBash("cat x | grep y"), true);
  assert.equal(isReadOnlyBash("ls && rm -rf x"), false); // a mutating segment
  assert.equal(isReadOnlyBash("ls && git push"), false);
  // output redirect to a real path
  assert.equal(isReadOnlyBash("echo hi > out.txt"), false);
  assert.equal(isReadOnlyBash("ls > /dev/null"), true); // /dev/null is fine
  assert.equal(isReadOnlyBash("cat x 2>&1"), true); // fd dup is fine
  // command substitution / backticks / sudo — a substitution is SAFE only
  // when its inner command is read-only or reversible; an unsafe inner
  // (mutating / destructive) or sudo still disqualifies read-only.
  assert.equal(isReadOnlyBash("echo $(date)"), true); // safe inner (read-only)
  assert.equal(isReadOnlyBash("echo $(pwd)"), true); // safe inner (read-only)
  assert.equal(isReadOnlyBash("echo `id`"), true); // safe backtick inner
  assert.equal(isReadOnlyBash("echo $(rm -rf x)"), false); // unsafe inner
  assert.equal(isReadOnlyBash("echo `rm -rf x`"), false); // unsafe backtick inner
  assert.equal(isReadOnlyBash("echo $(curl -s x)"), false); // unsafe inner
  assert.equal(isReadOnlyBash("sudo ls"), false);
});

test("safety: reversible git/npm ops", () => {
  assert.equal(isReversibleBash("git add ."), true);
  assert.equal(isReversibleBash("git commit -m 'msg'"), true);
  assert.equal(isReversibleBash("git stash"), true);
  assert.equal(isReversibleBash("git stash push -m wip"), true);
  assert.equal(isReversibleBash("git stash list"), true);
  assert.equal(isReversibleBash("git switch feature"), true);
  assert.equal(isReversibleBash("git checkout feature"), true);
  assert.equal(isReversibleBash("git branch feature"), true); // create
  assert.equal(isReversibleBash("git tag v1.0"), true); // create
  assert.equal(isReversibleBash("npm run build"), true);
  assert.equal(isReversibleBash("npm test"), true);
  // undoable in-workspace filesystem verbs
  assert.equal(isReversibleBash("mv a b"), true);
  assert.equal(isReversibleBash("cp -r src dest"), true);
  assert.equal(isReversibleBash("mkdir -p a/b"), true);
  assert.equal(isReversibleBash("rmdir a"), true);
  assert.equal(isReversibleBash("touch f.txt"), true);
  assert.equal(isReversibleBash("ln -s t l"), true);
  assert.equal(isReversibleBash("chmod 755 s.sh"), true);
  assert.equal(isReversibleBash("chown u:g f"), true);
  assert.equal(isReversibleBash("sed -i 's/a/b/' f"), true);
  assert.equal(isReversibleBash("echo x | tee out.txt"), true);
  assert.equal(isReversibleBash("sed 's/a/b/' f"), false); // no -i → not a mutation
  assert.equal(isReversibleBash("curl https://example.com"), false); // not provably reversible
  assert.equal(isReversibleBash("rm file.txt"), false); // destructive
  // boundaries
  assert.equal(isReversibleBash("git checkout ."), false); // destructive
  assert.equal(isReversibleBash("git checkout -- x"), false); // destructive
  assert.equal(isReversibleBash("git branch -D x"), false); // destructive
  assert.equal(isReversibleBash("git branch -d x"), false); // delete = mutating
  assert.equal(isReversibleBash("git tag -d v1.0"), false); // delete = mutating
  assert.equal(isReversibleBash("git stash pop"), false); // mutating
  assert.equal(isReversibleBash("git switch"), false); // needs a branch
  assert.equal(isReversibleBash("npm install"), false);
  assert.equal(isReversibleBash("npm run"), false); // needs a script
  assert.equal(isReversibleBash("git add && git push"), false); // push is not reversible
  assert.equal(isReversibleBash("ls"), false);
  // compounds of reversible/read-only segments: the model's standard commit
  // flow and test pipelines must not prompt in ask mode.
  assert.equal(isReversibleBash("git add -A && git commit -m 'msg'"), true);
  assert.equal(isReversibleBash("git commit -m 'x' && git add ."), true);
  assert.equal(isReversibleBash("npm run build 2>&1 | tail -3"), true);
  assert.equal(isReversibleBash("git add . && ls"), true);
  assert.equal(isReversibleBash("cd /tmp/r && git add . && git commit -m 'x'"), true);
  // a merely unknown-mutating (or non-reversible) segment keeps it gated
  assert.equal(isReversibleBash("git commit -m x && git push"), false);
  assert.equal(isReversibleBash("npm run build && npm install"), false);
  assert.equal(isReversibleBash("git add . && node script.js"), false);
  assert.equal(isReversibleBash("git commit -m x > log.txt"), false); // redirect to real path
});

// The mode matrix, exercised through makeSafetyHooks.

const FAKE_TOOL: Tool = { name: "bash", description: "", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }) };
const FAKE_READ: Tool = { name: "read", description: "", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }) };
const FAKE_WRITE: Tool = { name: "write", description: "", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }) };

async function gateDecision(
  mode: ApprovalMode,
  tool: Tool,
  args: Record<string, unknown>,
  answer: boolean,
): Promise<{ blocked?: string; asked: string[] }> {
  const asked: string[] = [];
  const hook = makeSafetyHooks({ root: dir, mode, ask: async (q) => { asked.push(q); return answer; } });
  const decision = await hook(tool, { type: "toolCall", id: "1", name: tool.name, arguments: args });
  return { blocked: decision && "blocked" in decision ? decision.blocked : undefined, asked };
}

test("safety: mode matrix — bash (yes/ask/no × readonly/sensitive/destructive/reversible/mutating)", async () => {
  const ro = "ls -la";
  const sensSys = "cat ~/.ssh/id_rsa"; // sys sensitive (outside the workspace)
  const sensWs = "cat .env"; // ws sensitive (a project .env in the cwd)
  const destrWs = "git push origin main"; // ws destructive (workspace-scoped)
  const destrSys = "dd if=x of=/dev/sda"; // sys destructive (raw device)
  const rev = "git add .";
  const revFs = "mv a b"; // undoable filesystem verb → reversible
  const mut = "curl -s https://example.com"; // not provably reversible → gated

  // yes (default): read-only/reversible/mutating + ws sensitive + ws
  // destructive are auto-approved; sys sensitive + sys destructive are
  // BLOCKED (across the board, no prompt).
  for (const [label, cmd] of [["read-only", ro], ["reversible", rev], ["reversible fs", revFs], ["mutating", mut], ["ws sensitive", sensWs], ["ws destructive", destrWs]] as const) {
    const d = await gateDecision("yes", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `yes: ${label} is auto-approved`);
    assert.equal(d.blocked, undefined, `yes: ${label} is allowed`);
  }
  for (const [label, cmd] of [["sys sensitive", sensSys], ["sys destructive", destrSys]] as const) {
    const d = await gateDecision("yes", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `yes: ${label} is never prompted`);
    assert.ok(d.blocked, `yes: ${label} is blocked`);
  }

  // ask: read-only/reversible run free; mutating + ws sensitive + ws
  // destructive prompt; sys sensitive + sys destructive are BLOCKED.
  for (const [label, cmd] of [["read-only", ro], ["reversible", rev], ["reversible fs", revFs]] as const) {
    const d = await gateDecision("ask", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `ask: ${label} runs without a prompt`);
    assert.equal(d.blocked, undefined, `ask: ${label} is allowed`);
  }
  const askMut = await gateDecision("ask", FAKE_TOOL, { command: mut }, true);
  assert.equal(askMut.asked.length, 1, "ask: mutating prompts");
  assert.equal(askMut.blocked, undefined, "ask: mutating is allowed when approved");
  const askMutDenied = await gateDecision("ask", FAKE_TOOL, { command: mut }, false);
  assert.equal(askMutDenied.asked.length, 1);
  assert.match(askMutDenied.blocked!, /denied/i, "ask: a denied mutating call is blocked");
  for (const [label, cmd] of [["ws sensitive", sensWs], ["ws destructive", destrWs]] as const) {
    const d = await gateDecision("ask", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 1, `ask: ${label} prompts`);
    assert.equal(d.blocked, undefined, `ask: ${label} is allowed when approved`);
  }
  // ask: denying a ws destructive/sensitive call blocks it with a denial reason.
  const denied = await gateDecision("ask", FAKE_TOOL, { command: destrWs }, false);
  assert.equal(denied.asked.length, 1);
  assert.match(denied.blocked!, /DENIED.*destructive/);
  const deniedSens = await gateDecision("ask", FAKE_TOOL, { command: sensWs }, false);
  assert.match(deniedSens.blocked!, /DENIED.*sensitive/);
  // ask: sys sensitive + sys destructive are BLOCKED (across the board).
  for (const [label, cmd] of [["sys sensitive", sensSys], ["sys destructive", destrSys]] as const) {
    const d = await gateDecision("ask", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `ask: ${label} is never prompted`);
    assert.ok(d.blocked, `ask: ${label} is blocked`);
  }

  // no: ONLY read-only, non-sensitive bash is allowed; no prompts, ever.
  for (const [label, cmd] of [["reversible", rev], ["reversible fs", revFs], ["sys sensitive", sensSys], ["ws sensitive", sensWs], ["ws destructive", destrWs], ["sys destructive", destrSys], ["mutating", mut]] as const) {
    const d = await gateDecision("no", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `no: ${label} never prompts`);
    assert.match(d.blocked!, /no-approve|systemic|system-level/, `no: ${label} is blocked`);
  }
  const noRo = await gateDecision("no", FAKE_TOOL, { command: ro }, true);
  assert.equal(noRo.asked.length, 0);
  assert.equal(noRo.blocked, undefined, "no: read-only bash is allowed");
});

test("safety: ask mode — standard commit forms with safe substitution/heredoc do NOT prompt", async () => {
  // the model's everyday commit shapes must run without a prompt in ask mode
  const commitDate = 'git commit -m "$(date)"';
  const commitStatus = 'git commit -m "$(git status --short)"';
  const commitHeredoc = 'git add -A && git commit -m "$(cat <<\'EOF\'\nfix: a change\nEOF\n)"';
  for (const cmd of [commitDate, commitStatus, commitHeredoc]) {
    const d = await gateDecision("ask", FAKE_TOOL, { command: cmd }, true);
    assert.equal(d.asked.length, 0, `ask: ${JSON.stringify(cmd.slice(0, 40))}... runs without a prompt`);
    assert.equal(d.blocked, undefined, `ask: ${JSON.stringify(cmd.slice(0, 40))}... is allowed`);
  }
  // a commit with an UNSAFE inner substitution still prompts (mutating)
  const commitUnsafe = 'git commit -m "$(rm -rf x)"';
  const d = await gateDecision("ask", FAKE_TOOL, { command: commitUnsafe }, true);
  assert.equal(d.asked.length, 1, "ask: a commit with an unsafe inner substitution prompts");
});

test("safety: mode matrix — write/edit (sandboxed, no prompt in ask/yes, blocked in no)", async () => {
  const args = { path: "notes.md", content: "hi" };
  // ask: in-workspace write/edit runs without a prompt (path-sandboxed).
  const ask = await gateDecision("ask", FAKE_WRITE, args, true);
  assert.equal(ask.asked.length, 0, "ask: in-workspace write is not prompted");
  assert.equal(ask.blocked, undefined);
  // yes: same.
  const yes = await gateDecision("yes", FAKE_WRITE, args, true);
  assert.equal(yes.asked.length, 0);
  assert.equal(yes.blocked, undefined);
  // no: blocked without prompting.
  const no = await gateDecision("no", FAKE_WRITE, args, true);
  assert.equal(no.asked.length, 0);
  assert.match(no.blocked!, /no-approve/);
});

test("safety: mode matrix — read (plain unrestricted; sys sensitive blocked, ws sensitive prompts in ask)", async () => {
  const plain = { path: path.join(dir, "plain.txt") };
  const secretSys = { path: "~/.ssh/id_rsa" }; // sys (outside the workspace)
  const secretWs = { path: path.join(dir, ".env") }; // ws (inside the workspace)
  // yes (default): plain + ws sensitive are allowed; sys sensitive is BLOCKED.
  const yesPlain = await gateDecision("yes", FAKE_READ, plain, true);
  assert.equal(yesPlain.asked.length, 0);
  assert.equal(yesPlain.blocked, undefined, "yes: plain read is unrestricted");
  const yesWs = await gateDecision("yes", FAKE_READ, secretWs, true);
  assert.equal(yesWs.asked.length, 0, "yes: ws sensitive read is auto-approved");
  assert.equal(yesWs.blocked, undefined);
  const yesSys = await gateDecision("yes", FAKE_READ, secretSys, false);
  assert.equal(yesSys.asked.length, 0, "yes: sys sensitive read is never prompted");
  assert.match(yesSys.blocked!, /system-level sensitive/);
  // ask: plain is unrestricted; ws sensitive prompts; sys sensitive is BLOCKED.
  const askPlain = await gateDecision("ask", FAKE_READ, plain, true);
  assert.equal(askPlain.asked.length, 0, "ask: plain read is unrestricted");
  assert.equal(askPlain.blocked, undefined);
  const askWs = await gateDecision("ask", FAKE_READ, secretWs, true);
  assert.equal(askWs.asked.length, 1, "ask: ws sensitive read prompts");
  assert.match(askWs.asked[0]!, /SENSITIVE/);
  assert.equal(askWs.blocked, undefined);
  const askSys = await gateDecision("ask", FAKE_READ, secretSys, true);
  assert.equal(askSys.asked.length, 0, "ask: sys sensitive read is never prompted");
  assert.match(askSys.blocked!, /system-level sensitive/);
  // no: even plain reads are blocked (only read-only BASH is allowed).
  const noPlain = await gateDecision("no", FAKE_READ, plain, true);
  assert.equal(noPlain.asked.length, 0);
  assert.match(noPlain.blocked!, /no-approve/);
});

test("safety: no ask function → sensitive/destructive are denied (fail-closed)", async () => {
  const hook = makeSafetyHooks({ root: dir, mode: "ask" }); // no ask
  const d = await hook(FAKE_TOOL, { type: "toolCall", id: "1", name: "bash", arguments: { command: "git push" } });
  assert.ok(d && "blocked" in d, "destructive without a human is blocked");
  const d2 = await hook(FAKE_READ, { type: "toolCall", id: "2", name: "read", arguments: { path: "~/.ssh/id_rsa" } });
  assert.ok(d2 && "blocked" in d2, "sensitive read without a human is blocked");
  // read-only still passes (no human needed).
  const d3 = await hook(FAKE_TOOL, { type: "toolCall", id: "3", name: "bash", arguments: { command: "ls" } });
  assert.equal(d3, undefined, "read-only bash needs no human");
});

// ─────────────── D33: stall evidence on details (docs/08 §10) ───────────────

import { guardExcerpt, GUARD_EXCERPT_MAX } from "../src/tools/pipeline.js";

test("D33: the permission-stall guard attaches details.stallEvidence (tool, count, window, excerpt)", async () => {
  const { tool } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: permFail }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "t", { p: "x" }), sig);
  await executor(tool, call("2", "t", { p: "x" }), sig);
  const r3 = await executor(tool, call("3", "t", { p: "x" }), sig);
  assert.equal(r3.details?.stall, true, "the legacy flag is unchanged");
  assert.deepEqual(r3.details?.stallEvidence, {
    guard: "permission-stall",
    tool: "t",
    denials: 3,
    window: 8,
    // The RAW denial text (not the STALL_TEXT boilerplate), one line.
    errorExcerpt: guardExcerpt(permFail),
  });
});

test("D33: the repeat-failure guard attaches details.stallEvidence with the normalized error", async () => {
  const { tool } = makeTool("repeat", async () => ({
    content: [{ type: "text" as const, text: "test failed: expected 1, got 2" }],
    isError: true,
  }));
  const executor = makeToolExecutor();
  const sig = new AbortController().signal;
  await executor(tool, call("1", "repeat", { test: "x" }), sig);
  await executor(tool, call("2", "repeat", { test: "x" }), sig);
  const c = await executor(tool, call("3", "repeat", { test: "x" }), sig);
  assert.deepEqual(c.details?.stallEvidence, {
    guard: "repeat-failure",
    tool: "repeat",
    repeats: 3,
    window: 8,
    errorExcerpt: "test failed: expected 1, got 2",
  });
});

test("D33: guardExcerpt collapses to one line and caps at GUARD_EXCERPT_MAX", () => {
  assert.equal(guardExcerpt("  line one  \nline two  "), "line one line two");
  assert.equal(guardExcerpt("a\nb\nc"), "a b c");
  const huge = "x".repeat(GUARD_EXCERPT_MAX + 500);
  const capped = guardExcerpt(huge);
  assert.equal(capped.length, GUARD_EXCERPT_MAX, "capped at the persisted size");
  assert.equal(guardExcerpt(""), "", "empty stays empty");
});
