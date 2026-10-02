/**
 * Telegram helper-path resolution (src/telegram/paths.ts) — the 2026-10-02
 * "message sat undelivered" fix. The bridges must find the helper in EITHER
 * canonical skill root (project `<cwd>/.tre/skills` OR user
 * `~/.tre/agent/skills`), not just the project one. `home` is injected so
 * the user-root case is hermetic (never touches the real home dir).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTelegramHelper } from "../src/telegram/paths.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-paths-"));
}
function writeHelper(root: string): string {
  const dir = path.join(root, "telegram");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "telegram.py");
  fs.writeFileSync(p, "# helper\n");
  return p;
}

test("resolver: finds the helper in the PROJECT root (<cwd>/.tre/skills)", () => {
  const cwd = tmpdir();
  const home = tmpdir();
  const p = writeHelper(path.join(cwd, ".tre", "skills"));
  try {
    assert.equal(resolveTelegramHelper(cwd, home), p);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolver: finds the helper in the USER agent-skills root (~/.tre/agent/skills) — the reported case", () => {
  const cwd = tmpdir(); // no .tre at all in the workspace
  const home = tmpdir();
  const p = writeHelper(path.join(home, ".tre", "agent", "skills"));
  try {
    assert.equal(resolveTelegramHelper(cwd, home), p);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolver: project SHADOWS user when both exist (loader precedence)", () => {
  const cwd = tmpdir();
  const home = tmpdir();
  const proj = writeHelper(path.join(cwd, ".tre", "skills"));
  const user = writeHelper(path.join(home, ".tre", "agent", "skills"));
  try {
    assert.equal(resolveTelegramHelper(cwd, home), proj);
    assert.notEqual(resolveTelegramHelper(cwd, home), user);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolver: null when the helper is in NO root (bridge stays disabled)", () => {
  const cwd = tmpdir();
  const home = tmpdir();
  // A skills dir that exists but has no telegram helper must NOT enable.
  fs.mkdirSync(path.join(cwd, ".tre", "skills", "other"), { recursive: true });
  try {
    assert.equal(resolveTelegramHelper(cwd, home), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
