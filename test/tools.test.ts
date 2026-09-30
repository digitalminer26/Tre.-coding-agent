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
  isPermissionStallText,
  makeToolExecutor,
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
  assert.equal(reg.size, 4);
  assert.deepEqual(reg.list().map((t) => t.name).sort(), ["bash", "edit", "read", "write"]);
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
  assert.match(resultText(r3), /NOT executed/);
  assert.equal(r3.details?.stall, true, "the loop maps details.stall onto stopReason");
  assert.equal(calls.length, 3, "all three executed (a denial is a harmless no-op)");
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
  const { tool, calls } = makeTool("t", async () => ({
    content: [{ type: "text" as const, text: "bash: exit code 127\ncommand not found" }],
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
