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
  makeToolExecutor,
  readTool,
  writeTool,
} from "../src/tools/index.js";
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
  const cmd = 'node -e "for(let i=1;i<=5000;i++) console.log(\'line-\'+i)"';
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
  const cmd = 'node -e "for(let i=0;i<1000;i++) process.stdout.write(\'x\'.repeat(59)+\'\\n\')"';
  const r = await runBash(cmd);
  assert.equal(r.isError, undefined);
  const fop = r.details?.fullOutputPath as string;
  assert.ok(fop, "should be byte-truncated");
  const text = resultText(r);
  assert.match(text, /\[truncated: showing last \d+ of 1000 lines/);
  assert.match(text, /full output saved to/);
});
