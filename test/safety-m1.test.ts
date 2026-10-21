/**
 * M1 (audit 2026-10-21) regression: the sensitive-path gate must not be
 * bypassable by (1) a symlink, (2) case, or (3) shell quoting. Each test is
 * the audit's VERIFIED repro, now asserting the BLOCK. All go through the
 * real makeSafetyHooks from src — the same gate the loop runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSafetyHooks } from "../src/tools/safety.js";
import { readTool, bashTool } from "../src/tools/index.js";
import type { ToolCallBlock } from "../src/types.js";

function tmp(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tre-m1-${tag}-`));
}
const call = (name: string, args: Record<string, unknown>): ToolCallBlock => ({
  type: "toolCall",
  id: "c1",
  name,
  arguments: args,
});
const blockedOf = (r: unknown): string | undefined =>
  r && typeof r === "object" && "blocked" in (r as object)
    ? (r as { blocked: string }).blocked
    : undefined;

// ── 1. Symlink: read through a benign-named workspace symlink onto a secret ──
test("M1/symlink: read of a workspace symlink whose REAL target is a sys secret is BLOCKED in yes mode", async () => {
  const root = tmp("root");
  const outside = tmp("secret");
  try {
    const secret = path.join(outside, ".env");
    fs.writeFileSync(secret, "SECRET=1\n");
    const link = path.join(root, "readme.txt");
    fs.symlinkSync(secret, link);

    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const direct = await hooks(readTool, call("read", { path: secret }));
    assert.ok(blockedOf(direct), "the DIRECT secret path must be blocked (baseline)");

    const viaLink = await hooks(readTool, call("read", { path: link }));
    assert.ok(
      blockedOf(viaLink),
      "the SAME bytes via a benign-named symlink must ALSO be blocked (this was ALLOWED pre-fix)",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("M1/symlink: a symlink to a NON-sensitive workspace file still reads (no over-block)", async () => {
  const root = tmp("root");
  try {
    fs.writeFileSync(path.join(root, "real.txt"), "hello\n");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const r = await hooks(readTool, call("read", { path: path.join(root, "link.txt") }));
    assert.equal(blockedOf(r), undefined, "a benign symlink read must stay allowed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. Case: macOS's default FS is case-insensitive; patterns must be too ──
test("M1/case: ~/.tre/tmp/.ENV (case variant of .env) is BLOCKED as sys-sensitive", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const upper = await hooks(readTool, call("read", { path: path.join(os.homedir(), ".tre", "tmp", ".ENV") }));
    assert.ok(blockedOf(upper), "uppercase .ENV must hit the .env* pattern (this was ALLOWED pre-fix)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M1/case: bash cat ~/.tre/tmp/.ENV is classified sys-sensitive (blocked in yes)", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const r = await hooks(bashTool, call("bash", {
      command: `cat ${path.join(os.homedir(), ".tre", "tmp", ".ENV")}`,
    }));
    assert.ok(blockedOf(r), "the case-variant bash path must be blocked (this was ALLOWED pre-fix)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. Quoting: a quoted absolute secret path must match like the raw one ──
test("M1/quote: bash cat \"<quoted absolute .env path>\" is BLOCKED like the unquoted form", async () => {
  const root = tmp("root");
  try {
    const secret = path.join(os.homedir(), ".tre", "tmp", "leak", ".env");
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const plain = await hooks(bashTool, call("bash", { command: `cat ${secret}` }));
    assert.ok(blockedOf(plain), "unquoted must be blocked (baseline)");
    const quoted = await hooks(bashTool, call("bash", { command: `cat "${secret}"` }));
    assert.ok(
      blockedOf(quoted),
      'the SAME command with the path quoted must ALSO be blocked (this was ALLOWED pre-fix)',
    );
    const single = await hooks(bashTool, call("bash", { command: `cat '${secret}'` }));
    assert.ok(blockedOf(single), "single quotes must be stripped too");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M1/quote: a quoted NON-sensitive path stays allowed (no over-block)", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const r = await hooks(bashTool, call("bash", { command: `cat "${path.join(root, "notes.txt")}"` }));
    assert.equal(blockedOf(r), undefined, "quoting a benign path must not block it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M1: the workspace .env (ws-sensitive) still PROMPTS in ask mode — not silently auto-blocked", async () => {
  const root = tmp("root");
  try {
    fs.writeFileSync(path.join(root, ".env"), "A=1\n");
    let asked = 0;
    const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => { asked++; return false; } });
    const r = await hooks(readTool, call("read", { path: ".env" }));
    assert.ok(blockedOf(r), "denied answer → blocked");
    assert.equal(asked, 1, "the gate PROMPTED (ws classification preserved)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
