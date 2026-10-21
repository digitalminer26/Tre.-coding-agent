/**
 * M4 (audit 2026-10-21) regression: write/edit must sensitive-check their
 * targets, not just the path sandbox. The filed repro: with `~/.tre` as an
 * extra root and mode "yes", write to ~/.tre/telegram.json / models.json
 * was ALLOWED (takeover: swap the bot token / endpoint catalog). Now:
 * sys-sensitive writes BLOCK in every mode, ws-sensitive prompt in "ask" —
 * the same posture the read branch has always had.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSafetyHooks } from "../src/tools/safety.js";
import { writeTool, editTool } from "../src/tools/index.js";
import type { ToolCallBlock } from "../src/types.js";

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

function tmp(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tre-m4-${tag}-`));
}

// ── the filed takeover repro ─────────────────────────────────────────────────
test("M4: with ~/.tre as an extra root, yes-mode write to telegram.json is BLOCKED (was ALLOWED)", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({
      root,
      mode: "yes",
      extraRoots: [path.join(os.homedir(), ".tre")],
    });
    const r = await hooks(writeTool, call("write", {
      path: path.join(os.homedir(), ".tre", "telegram.json"),
      content: '{"token":"attacker","chatId":"evil"}',
    }));
    assert.ok(blockedOf(r), "the bot-token config must not be model-writable (this was ALLOWED pre-fix)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M4: yes-mode write to the machine endpoint catalogs is BLOCKED (apiKeys + default endpoint)", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({
      root,
      mode: "yes",
      extraRoots: [path.join(os.homedir(), ".tre")],
    });
    for (const p of [
      path.join(os.homedir(), ".tre", "models.json"),
      path.join(os.homedir(), ".tre", "tre", "models.json"),
    ]) {
      const r = await hooks(writeTool, call("write", { path: p, content: "{}" }));
      assert.ok(blockedOf(r), `${p} must be blocked (endpoint-catalog takeover)`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M4: edit is covered too (not just write)", async () => {
  const root = tmp("root");
  try {
    const hooks = makeSafetyHooks({
      root,
      mode: "yes",
      extraRoots: [path.join(os.homedir(), ".tre")],
    });
    const r = await hooks(editTool, call("edit", {
      path: path.join(os.homedir(), ".tre", "telegram.json"),
      oldText: "t",
      newText: "x",
    }));
    assert.ok(blockedOf(r), "edit must hit the same gate as write");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── no over-block ────────────────────────────────────────────────────────────
test("M4: a WORKSPACE models.json (no .tre segment) still writes in yes mode — the pattern is .tre-anchored", async () => {
  const root = tmp("root");
  try {
    fs.writeFileSync(path.join(root, "models.json"), "{}");
    const hooks = makeSafetyHooks({ root, mode: "yes" });
    const r = await hooks(writeTool, call("write", { path: "models.json", content: '{"default":"m"}' }));
    assert.equal(blockedOf(r), undefined, "workspace catalog is a normal file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M4: a workspace .env still PROMPTS in ask (ws posture), never silently blocked", async () => {
  const root = tmp("root");
  try {
    fs.writeFileSync(path.join(root, ".env"), "A=1\n");
    let asked = 0;
    const hooks = makeSafetyHooks({
      root,
      mode: "ask",
      ask: async () => {
        asked++;
        return true;
      },
    });
    const r = await hooks(writeTool, call("write", { path: ".env", content: "A=2\n" }));
    assert.equal(blockedOf(r), undefined, "approved → allowed");
    assert.equal(asked, 1, "ws-sensitive write PROMPTED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M4: a normal workspace write is untouched (no prompt, no block, args rewritten to canonical)", async () => {
  const root = tmp("root");
  try {
    let asked = 0;
    const hooks = makeSafetyHooks({
      root,
      mode: "ask",
      ask: async () => {
        asked++;
        return true;
      },
    });
    const r = await hooks(writeTool, call("write", { path: "notes.txt", content: "hi" }));
    assert.equal(blockedOf(r), undefined);
    assert.equal(asked, 0, "no prompt for a plain write");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M4: a symlink INSIDE an authorized extra root pointing at a secret in the same root is caught by the sensitive check (the sandbox passes it — both ends are in-root)", async () => {
  const root = tmp("root");
  const extra = tmp("extra");
  try {
    // Secret + link BOTH inside the extra root: the path sandbox passes
    // (lexical AND realpath in-root), so ONLY the M4 sensitive check can
    // stop the write.
    const secret = path.join(extra, "server.key");
    fs.writeFileSync(secret, "PRIV\n");
    const link = path.join(extra, "notes.txt");
    fs.symlinkSync(secret, link);
    const hooks = makeSafetyHooks({ root, mode: "yes", extraRoots: [extra] });
    const r = await hooks(writeTool, call("write", { path: link, content: "x" }));
    assert.ok(blockedOf(r), "must be blocked");
    assert.match(blockedOf(r)!, /\.key/, "caught by the sensitive pattern, not the sandbox");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("M4 (defense in depth): a workspace symlink pointing INTO another root is refused by the sandbox itself (each root is checked independently)", async () => {
  const root = tmp("root");
  const extra = tmp("extra");
  try {
    const secret = path.join(extra, "notes.txt");
    fs.writeFileSync(secret, "ok\n");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(secret, link);
    const hooks = makeSafetyHooks({ root, mode: "yes", extraRoots: [extra] });
    const r = await hooks(writeTool, call("write", { path: link, content: "x" }));
    assert.ok(blockedOf(r), "cross-root symlink write is a sandbox refusal");
    assert.match(blockedOf(r)!, /outside the working directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});
