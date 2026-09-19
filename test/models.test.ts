/**
 * D19 — models.json lookup (findModelsFile): --models wins; otherwise walk
 * up from the launch directory, then fall back to ~/.tre/models.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findModelsFile } from "../src/config/models.js";

test("findModelsFile: explicit path wins even if it does not exist", () => {
  // The caller reports the missing file; the lookup must not second-guess it.
  assert.equal(findModelsFile("/nonexistent/nope.json", "/tmp", "/nonhome"), "/nonexistent/nope.json");
});

test("findModelsFile: walks up from the launch directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  const found = path.join(dir, "models.json");
  fs.writeFileSync(found, "{}");
  assert.equal(findModelsFile(undefined, nested, "/nonhome"), found);
});

test("findModelsFile: launch dir itself counts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const found = path.join(dir, "models.json");
  fs.writeFileSync(found, "{}");
  assert.equal(findModelsFile(undefined, dir, "/nonhome"), found);
});

test("findModelsFile: home fallback when nothing above the launch dir", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
  const homeFile = path.join(home, ".tre", "models.json");
  fs.writeFileSync(homeFile, "{}");
  assert.equal(findModelsFile(undefined, dir, home), homeFile);
});

test("findModelsFile: null when neither walk nor home has one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // dir is an empty leaf under /var (macOS) or /tmp — no models.json above it.
  assert.equal(findModelsFile(undefined, dir, path.join(dir, "nohome")), null);
});
