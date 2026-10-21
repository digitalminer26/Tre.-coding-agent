/**
 * L1–L4 (audit 2026-10-21) regressions:
 *  L1: read must stat BEFORE materializing (huge file refused, no OOM path;
 *      FIFO/socket/device refused — a FIFO would hang readFile forever).
 *  L2: directory listings are capped (a 100k-entry dir must not flood the
 *      context) with the total count named.
 *  L3: truncation-recovery temp files are written 0600 and stale files
 *      (>7d) are pruned.
 *  L4: `env`/`printenv` are NO LONGER read-only — `bash printenv` must not
 *      be auto-allowed in `no` mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readTool, MAX_READ_BYTES } from "../src/tools/read.js";
import { saveFullOutput, pruneFullOutputDir } from "../src/tools/truncate.js";
import { isReadOnlyBash, makeSafetyHooks } from "../src/tools/safety.js";
import { bashTool } from "../src/tools/index.js";
import type { ToolCallBlock } from "../src/types.js";

const call = (name: string, args: Record<string, unknown>): ToolCallBlock => ({
  type: "toolCall",
  id: "c1",
  name,
  arguments: args,
});
const textOf = (r: Awaited<ReturnType<typeof readTool.execute>>) =>
  (r.content as { text: string }[]).map((c) => c.text).join("\n");

function tmp(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tre-l-${tag}-`));
}

// ── L1: size cap + non-regular-file refusal ─────────────────────────────────
test("L1: a sparse file above the size cap is REFUSED without materializing it", async () => {
  const dir = tmp("l1");
  try {
    const huge = path.join(dir, "huge.bin");
    // Sparse: 1 byte at the cap boundary, no actual disk cost.
    const fd = fs.openSync(huge, "w");
    fs.ftruncateSync(fd, MAX_READ_BYTES + 1);
    fs.closeSync(fd);
    const r = await readTool.execute("c1", { path: huge }, new AbortController().signal);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /too large to read/);
    assert.match(textOf(r), /cap 64 MB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L1: a FIFO is refused outright (a writer-less FIFO would hang readFile)", async (t) => {
  const dir = tmp("l1-fifo");
  try {
    const fifo = path.join(dir, "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      t.skip("mkfifo unavailable");
      return;
    }
    const r = await readTool.execute("c1", { path: fifo }, new AbortController().signal);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not a regular file \(it is a pipe\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L1: a normal file still reads (no regression on the happy path)", async () => {
  const dir = tmp("l1-ok");
  try {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "hello\nworld\n");
    const r = await readTool.execute("c1", { path: f }, new AbortController().signal);
    assert.notEqual(r.isError, true);
    assert.match(textOf(r), /hello/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── L2: listing cap ──────────────────────────────────────────────────────────
test("L2: a 2500-entry directory listing is capped at 2000 with the total named", async () => {
  const dir = tmp("l2");
  try {
    for (let i = 0; i < 2500; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, "0")}`), "");
    const r = await readTool.execute("c1", { path: dir }, new AbortController().signal);
    const out = textOf(r);
    assert.match(out, /listing truncated: showing 2000 of 2500 entries/);
    const lines = out.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("d "));
    assert.equal(lines.length, 2000, "exactly the cap of entry lines");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L2: a small directory listing is unchanged (no truncation note)", async () => {
  const dir = tmp("l2-small");
  try {
    fs.writeFileSync(path.join(dir, "a"), "");
    fs.mkdirSync(path.join(dir, "sub"));
    const r = await readTool.execute("c1", { path: dir }, new AbortController().signal);
    const out = textOf(r);
    assert.ok(!out.includes("listing truncated"), "no note under the cap");
    assert.match(out, /is a directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── L3: temp-file mode + prune ───────────────────────────────────────────────
test("L3: saveFullOutput writes 0600", async () => {
  const file = await saveFullOutput("l3-test", "secret full output");
  try {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("L3: prune removes >7d-old .log files, keeps fresh ones and foreign files", () => {
  const dir = tmp("l3");
  try {
    const stale = path.join(dir, "read-old.log");
    const fresh = path.join(dir, "read-new.log");
    const foreign = path.join(dir, "someone-else.txt");
    for (const f of [stale, fresh, foreign]) fs.writeFileSync(f, "x");
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    execFileSync("touch", ["-a", "-m", String(Math.floor(old)), stale]);
    pruneFullOutputDir(dir);
    assert.equal(fs.existsSync(stale), false, "stale .log pruned");
    assert.equal(fs.existsSync(fresh), true, "fresh .log kept");
    assert.equal(fs.existsSync(foreign), true, "non-.log file untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── L4: env/printenv are not read-only ───────────────────────────────────────
test("L4: env/printenv are NOT read-only verbs", () => {
  assert.equal(isReadOnlyBash("printenv"), false);
  assert.equal(isReadOnlyBash("env"), false);
  assert.equal(isReadOnlyBash("env | grep KEY"), false);
});

test("L4: bash printenv is BLOCKED in no mode (was auto-allowed)", async () => {
  const root = tmp("l4");
  try {
    const hooks = makeSafetyHooks({ root, mode: "no" });
    const r = await hooks(bashTool, call("bash", { command: "printenv" }));
    assert.ok(
      r && "blocked" in r && r.blocked,
      "printenv must not pass the no-mode gate (this was ALLOWED pre-fix)",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("L4: benign read-only bash still passes no mode (ls, cat)", async () => {
  const root = tmp("l4-ok");
  try {
    const hooks = makeSafetyHooks({ root, mode: "no" });
    for (const cmd of ["ls", "cat a.txt", "echo hi"]) {
      const r = await hooks(bashTool, call("bash", { command: cmd }));
      assert.equal(r, undefined, `${cmd} stays allowed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
