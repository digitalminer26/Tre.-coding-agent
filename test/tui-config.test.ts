/**
 * C32 — unit tests for the persisted TUI config (~/.tre/tui.json).
 *
 * Pins the load/save contract: the file location, the normalization of a
 * hand-edited `bottom` array (unknown fields dropped, deduped, order
 * preserved), and the I3 behavior — a missing, corrupt, or unwritable
 * file is data, never a crash. All paths go to a temp dir (the kernel
 * sandbox denies ~/.tre to the agent under test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultTuiConfig,
  loadTuiConfig,
  saveTuiConfig,
  tuiConfigPath,
} from "../src/tui/tui-config.js";
import { BOTTOM_FIELDS } from "../src/tui/state.js";

let dir = mkdtempSync(join(tmpdir(), "tre-tui-config-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "tui.json");

test("tuiConfigPath: ~/.tre/tui.json under the given home", () => {
  assert.equal(tuiConfigPath("/home/u"), "/home/u/.tre/tui.json");
});

test("defaultTuiConfig: empty bottom selection", () => {
  assert.deepEqual(defaultTuiConfig(), { bottom: [] });
});

test("loadTuiConfig: a missing file yields the default (I3, no throw)", () => {
  assert.deepEqual(loadTuiConfig(join(dir, "nope.json")), { bottom: [] });
});

test("loadTuiConfig: corrupt JSON yields the default (I3, no throw)", () => {
  const f = join(dir, "corrupt.json");
  writeFileSync(f, "{ not json\n");
  assert.deepEqual(loadTuiConfig(f), { bottom: [] });
});

test("loadTuiConfig: a non-object top level yields the default", () => {
  for (const raw of ['"bottom"', "42", "[\"model\"]", "null"]) {
    const f = join(dir, "bad.json");
    writeFileSync(f, raw);
    assert.deepEqual(loadTuiConfig(f), { bottom: [] }, `raw: ${raw}`);
  }
});

test("loadTuiConfig: bottom is normalized — unknown dropped, deduped, order kept", () => {
  const f = join(dir, "norm.json");
  writeFileSync(
    f,
    JSON.stringify({ bottom: ["tokens", "model", "tokens", "bogus", 7, null, "status", "model"] }),
  );
  assert.deepEqual(loadTuiConfig(f).bottom, ["tokens", "model", "status"]);
});

test("loadTuiConfig: a non-array bottom yields the default selection", () => {
  const f = join(dir, "noarr.json");
  writeFileSync(f, JSON.stringify({ bottom: "model" }));
  assert.deepEqual(loadTuiConfig(f), { bottom: [] });
});

test("loadTuiConfig: every known field survives a round trip", () => {
  const f = join(dir, "all.json");
  const cfg = { bottom: [...BOTTOM_FIELDS] };
  saveTuiConfig(cfg, f);
  assert.deepEqual(loadTuiConfig(f), cfg);
});

test("saveTuiConfig: writes the file, creating the parent dir when missing", () => {
  const nested = join(dir, "deep", "nested", "tui.json");
  assert.equal(saveTuiConfig({ bottom: ["model"] }, nested), true);
  assert.deepEqual(JSON.parse(readFileSync(nested, "utf8")), { bottom: ["model"] });
});

test("saveTuiConfig: an unwritable path fails SOFT (false, no throw)", () => {
  const noDir = join(dir, "no-such-dir");
  mkdirSync(noDir, { recursive: true });
  // A directory in the file's place: writeFileSync must fail.
  const f = join(noDir, "sub");
  mkdirSync(f, { recursive: true });
  assert.equal(saveTuiConfig({ bottom: ["model"] }, f), false);
  rmSync(f, { recursive: true, force: true });
});

test("saveTuiConfig: the file is one JSON object + trailing newline", () => {
  const f = join(dir, "pretty.json");
  assert.equal(saveTuiConfig({ bottom: ["cwd"] }, f), true);
  const raw = readFileSync(f, "utf8");
  assert.equal(raw, '{\n  "bottom": [\n    "cwd"\n  ]\n}\n');
});
