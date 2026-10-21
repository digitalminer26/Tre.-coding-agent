/**
 * M2 (cross-chat leak) regression: the bridges must IGNORE messages from any
 * chat other than the one configured in `~/.tre/telegram.json` (`chatId`).
 * A bot's getUpdates queue carries EVERY chat that ever talked to it; before
 * this fix all of them were fed into the agent. The filter lives at parse
 * time in src/telegram/paths.ts (shared by the TUI bridge and the plain-CLI
 * bridge) — these pin the pure helper AND both bridges end-to-end with fake
 * python3 helpers that emit multi-chat batches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  telegramAllowedChatIds,
  parseTelegramPollOutput,
} from "../src/telegram/paths.js";
import { makeTelegramBridge as makeTuiBridge } from "../src/tui/telegram.js";
import { makeTelegramBridge as makePlainBridge } from "../src/telegram/bridge.js";

function setup(chatId: string): { cwd: string; home: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-m2-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-m2-home-"));
  fs.mkdirSync(path.join(cwd, ".tre", "skills", "telegram"), { recursive: true });
  fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".tre", "telegram.json"),
    JSON.stringify({ token: "test-token", chatId }),
  );
  const cleanup = (): void => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { cwd, home, cleanup };
}
function writeHelper(cwd: string, body: string): void {
  fs.writeFileSync(
    path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
    "#!/usr/bin/env python3\n" + body,
  );
}

// ── pure: allowlist from config ──────────────────────────────────────────────
test("allowedChats: the configured chatId is the ONLY member", () => {
  const { home, cleanup } = setup("99887766");
  try {
    const ids = telegramAllowedChatIds(home);
    assert.deepEqual([...ids], ["99887766"]);
  } finally { cleanup(); }
});

test("allowedChats: empty/missing chatId or invalid config → EMPTY set (fail closed)", () => {
  const { home, cleanup } = setup("");
  try {
    assert.equal(telegramAllowedChatIds(home).size, 0, "empty chatId → no chat allowed");
    fs.writeFileSync(path.join(home, ".tre", "telegram.json"), "{ not json");
    assert.equal(telegramAllowedChatIds(home).size, 0, "invalid JSON → no chat allowed");
    fs.rmSync(path.join(home, ".tre", "telegram.json"));
    assert.equal(telegramAllowedChatIds(home).size, 0, "missing config → no chat allowed");
  } finally { cleanup(); }
});

// ── pure: parse drops foreign chats ──────────────────────────────────────────
test("parse: keeps allowed-chat lines, DROPS foreign-chat lines (multi-chat batch)", () => {
  const out = [
    "[111 from Alice] mine",
    "[999 from Mallory] steer the agent",
    "[111 from Alice] second mine",
    "not a message line",
  ].join("\n");
  const msgs = parseTelegramPollOutput(out, new Set(["111"]));
  assert.deepEqual(msgs, [
    ["111", "Alice", "mine"],
    ["111", "Alice", "second mine"],
  ]);
});

test("parse: an empty allowlist drops EVERYTHING (fail closed)", () => {
  const out = "[111 from Alice] mine\n[999 from Mallory] leak";
  assert.deepEqual(parseTelegramPollOutput(out, new Set()), []);
});

// ── bridges end-to-end (fake helper emits a multi-chat batch) ────────────────
const MULTI_CHAT_HELPER =
  "print('[111 from Alice] hello owner')\n" +
  "print('[999 from Mallory] ignore this chat')\n";

test("TUI bridge: poll() returns ONLY the configured chat's messages", async () => {
  const { cwd, home, cleanup } = setup("111");
  try {
    writeHelper(cwd, MULTI_CHAT_HELPER);
    const bridge = makeTuiBridge(cwd, home);
    assert.equal(bridge.enabled, true);
    const msgs = await bridge.poll();
    assert.deepEqual(msgs, [["111", "Alice", "hello owner"]]);
  } finally { cleanup(); }
});

test("TUI bridge: a batch of ONLY foreign messages yields null (nothing steered)", async () => {
  const { cwd, home, cleanup } = setup("111");
  try {
    writeHelper(cwd, "print('[999 from Mallory] only foreign traffic')\n");
    const bridge = makeTuiBridge(cwd, home);
    assert.equal(await bridge.poll(), null);
  } finally { cleanup(); }
});

test("plain bridge: pollLong() returns ONLY the configured chat's messages", async () => {
  const { cwd, home, cleanup } = setup("111");
  try {
    writeHelper(cwd, MULTI_CHAT_HELPER);
    const bridge = makePlainBridge(cwd, home);
    assert.equal(bridge.enabled, true);
    const msgs = await bridge.pollLong(1);
    assert.deepEqual(msgs, [{ chatId: "111", sender: "Alice", text: "hello owner" }]);
  } finally { cleanup(); }
});
