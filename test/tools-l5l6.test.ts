/**
 * L5/L6 (audit 2026-10-21) regressions:
 *  L5: the pipeline caps a tool call by wall clock (default 30s for the
 *      file tools) — a hung read returns a timeout error result instead of
 *      wedging the loop; bash/subtask/MCP are exempt (own timeouts).
 *  L6: tre.'s own credential files (telegram.json, tokenomics.json) and the
 *      shell rc files are in the sensitive pattern list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeToolExecutor,
  defaultToolTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
} from "../src/tools/pipeline.js";
import { makeSafetyHooks, sensitivePathPatterns } from "../src/tools/safety.js";
import { readTool } from "../src/tools/index.js";
import type { Tool, ToolResult } from "../src/types.js";

const call = (name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall" as const,
  id: "c1",
  name,
  arguments: args,
});

// ── L5: the pipeline timeout ─────────────────────────────────────────────────
const hangingTool: Tool = {
  name: "read", // same name as the capped file tool
  description: "test tool that never settles",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    await new Promise((r) => setTimeout(r, 2_000)); // beyond the test cap, settles fast
    return { content: [{ type: "text", text: "too late" }] };
  },
};

test("L5: a hung tool call returns a timeout error result (the loop moves on)", async () => {
  const exec = makeToolExecutor({ toolTimeoutMs: () => 150 });
  const started = Date.now();
  const r = await exec(hangingTool, call("read"), new AbortController().signal);
  const elapsed = Date.now() - started;
  assert.equal(r.isError, true);
  assert.match(
    (r.content as { text: string }[]).map((c) => c.text).join("\n"),
    /timed out after 0s|timed out/,
  );
  assert.ok(elapsed < 5_000, `must return at the cap, took ${elapsed}ms`);
});

test("L5: a fast tool is unaffected by the cap", async () => {
  const fast: Tool = {
    ...hangingTool,
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text", text: "quick" }] };
    },
  };
  const exec = makeToolExecutor({ toolTimeoutMs: () => 5_000 });
  const r = await exec(fast, call("read"), new AbortController().signal);
  assert.notEqual(r.isError, true);
});

test("L5: default mapping — file tools capped at 30s, bash/subtask/MCP exempt", () => {
  assert.equal(defaultToolTimeoutMs({ name: "read" } as Tool), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(defaultToolTimeoutMs({ name: "write" } as Tool), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(defaultToolTimeoutMs({ name: "edit" } as Tool), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(defaultToolTimeoutMs({ name: "bash" } as Tool), undefined, "bash has its own timeout");
  assert.equal(defaultToolTimeoutMs({ name: "subtask" } as Tool), undefined, "runs for minutes");
  assert.equal(defaultToolTimeoutMs({ name: "mcp__fs__read" } as Tool), undefined, "MCP per-call timeouts");
});

// ── L6: pattern-list additions ───────────────────────────────────────────────
test("L6: tre.'s own credential files + shell rc files are sensitive patterns", () => {
  const home = os.homedir();
  const cases: [string, string][] = [
    [path.join(home, ".tre", "telegram.json"), "telegram.json"],
    [path.join(home, ".tre", "tokenomics.json"), "tokenomics.json"],
    [path.join(home, ".bashrc"), "~/.bashrc"],
    [path.join(home, ".zshrc"), "~/.zshrc"],
    [path.join(home, ".profile"), "~/.profile"],
  ];
  for (const [p, label] of cases) {
    assert.ok(
      sensitivePathPatterns(p).includes(label),
      `${p} must match ${label} (got: ${sensitivePathPatterns(p).join(",")})`,
    );
  }
});

test("L6: reading the bot-token config is BLOCKED as sys-sensitive in yes mode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tre-l6-"));
  try {
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const r = await hooks(readTool, call("read", { path: path.join(os.homedir(), ".tre", "telegram.json") }));
    assert.ok(r && "blocked" in r && r.blocked, "the bot token file must not be model-readable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("L6: a workspace file named telegram.json still PROMPTS (ws), not sys-blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tre-l6-ws-"));
  try {
    fs.writeFileSync(path.join(root, "telegram.json"), "{}");
    let asked = 0;
    const hooks = makeSafetyHooks({
      root,
      mode: "ask",
      ask: async () => {
        asked++;
        return true;
      },
    });
    const r = await hooks(readTool, call("read", { path: "telegram.json" }));
    assert.equal(r, undefined, "approved → allowed");
    assert.equal(asked, 1, "it PROMPTED (workspace-scoped, not sys)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
