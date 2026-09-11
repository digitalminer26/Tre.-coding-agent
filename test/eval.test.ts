/**
 * WS8 — tests for the eval harness. Uses fake-stream (no network) to prove
 * the scorer classifies pass / wrong-tool / wrong-args correctly and that the
 * report prints a pass/fail line per task (PLAN WS8 exit criteria).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runEval, formatEvalReport, type EvalTask } from "./eval.js";
import { fakeStream } from "./fake-stream.js";
import type { ModelConfig, Tool } from "../src/types.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

const noOpTool = (name: string, description = `the ${name} tool`): Tool => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

const tasks: EvalTask[] = [
  {
    name: "create file",
    prompt: "Create hello.txt containing 'hi'",
    tools: [noOpTool("write"), noOpTool("bash")],
    expected: { toolName: "write", argsSubset: { path: "hello.txt", content: "hi" } },
  },
  {
    name: "fix typo",
    prompt: "Fix the typo in notes.md",
    tools: [noOpTool("edit"), noOpTool("read")],
    expected: { toolName: "read" }, // model will call edit → wrong-tool case
  },
  {
    name: "run command",
    prompt: "Run pwd and report it",
    tools: [noOpTool("bash")],
    expected: { toolName: "bash", argsSubset: { command: "pwd" } }, // model runs `ls` → wrong args
  },
];

test("eval: scores pass / wrong-tool / wrong-args on a 3-task suite", async () => {
  // Scripted model: one tool-call turn per task, in task order.
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "write", args: { path: "hello.txt", content: "hi" } }] },
    { type: "toolcall", calls: [{ name: "edit", args: { path: "notes.md" } }] },
    { type: "toolcall", calls: [{ name: "bash", args: { command: "ls" } }] },
  ]);

  const results = await runEval({ streamFn, model: MODEL, tasks });
  assert.equal(results.length, 3);

  assert.equal(results[0]!.pass, true, "create file should pass");
  assert.equal(results[0]!.reason, "ok");

  assert.equal(results[1]!.pass, false, "fix typo should fail (wrong tool)");
  assert.match(results[1]!.reason, /wrong tool: expected "read", got "edit"/);

  assert.equal(results[2]!.pass, false, "run command should fail (wrong args)");
  assert.match(results[2]!.reason, /arg "command" mismatch/);
  assert.deepEqual(results[2]!.calls, [{ name: "bash", args: { command: "ls" } }]);
});

test("eval: no tool call emitted → fail with 'no tool call emitted'", async () => {
  const streamFn = fakeStream([{ type: "text", text: "I will do it manually." }]);
  const results = await runEval({
    streamFn,
    model: MODEL,
    tasks: [
      {
        name: "needs tool",
        prompt: "list files",
        tools: [noOpTool("bash")],
        expected: { toolName: "bash" },
      },
    ],
  });
  assert.equal(results[0]!.pass, false);
  assert.equal(results[0]!.reason, "no tool call emitted");
});

test("eval: stream error surfaces in the verdict", async () => {
  const streamFn = fakeStream([{ type: "error", message: "upstream down" }]);
  const results = await runEval({
    streamFn,
    model: MODEL,
    tasks: [
      { name: "t", prompt: "x", tools: [noOpTool("bash")], expected: { toolName: "bash" } },
    ],
  });
  assert.equal(results[0]!.pass, false);
  assert.match(results[0]!.reason, /stream error: upstream down/);
});

test("eval: report prints a PASS/FAIL line per task + totals", async () => {
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "write", args: { path: "a", content: "b" } }] },
    { type: "toolcall", calls: [{ name: "bash", args: { command: "wrong" } }] },
  ]);
  const results = await runEval({
    streamFn,
    model: MODEL,
    tasks: [
      { name: "alpha task", prompt: "p", tools: [noOpTool("write")], expected: { toolName: "write", argsSubset: { path: "a" } } },
      { name: "beta task", prompt: "p", tools: [noOpTool("bash")], expected: { toolName: "bash", argsSubset: { command: "pwd" } } },
    ],
  });
  const report = formatEvalReport(results);
  const lines = report.split("\n");
  assert.match(report, /alpha task\s+PASS/);
  assert.match(report, /beta task\s+FAIL/);
  assert.ok(lines.includes("1/2 passed"), `expected totals line, got:\n${report}`);
});
