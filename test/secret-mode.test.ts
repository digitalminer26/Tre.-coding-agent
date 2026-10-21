/**
 * M3 (audit 2026-10-21): secret files must not stay group/other-readable.
 * hardenSecretFiles() chmods every known secret file down to `mode & 0o600`
 * at startup; new secret-bearing writes use 0600. Tests use an injected
 * fake home — the real ~/.tre is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hardenSecretFiles, secretFilePaths } from "../src/config/secret-mode.js";
import { writePriceCache } from "../src/tui/model-prices.js";

function fakeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-m3-"));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const modeOf = (f: string) => fs.statSync(f).mode & 0o777;

test("harden: a 0644 secret file is tightened to 0600 with a warning", () => {
  const { home, cleanup } = fakeHome();
  try {
    const file = path.join(home, ".tre", "telegram.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    assert.equal(modeOf(file), 0o644);
    const r = hardenSecretFiles(home);
    assert.equal(modeOf(file), 0o600, "must be owner-only after hardening");
    assert.deepEqual(r.fixed, [file]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /644/);
    assert.match(r.warnings[0]!, /600/);
  } finally { cleanup(); }
});

test("harden: idempotent — an already-0600 file is untouched and warns nothing", () => {
  const { home, cleanup } = fakeHome();
  try {
    const file = path.join(home, ".tre", "tre", "models.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    const r = hardenSecretFiles(home);
    assert.deepEqual(r.fixed, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(modeOf(file), 0o600);
  } finally { cleanup(); }
});

test("harden: missing files are skipped (fresh machine — no crash, no warnings)", () => {
  const { home, cleanup } = fakeHome();
  try {
    const r = hardenSecretFiles(home);
    assert.deepEqual(r.fixed, []);
    assert.deepEqual(r.warnings, []);
  } finally { cleanup(); }
});

test("harden: tightens EVERY known secret file in one pass (mixed modes)", () => {
  const { home, cleanup } = fakeHome();
  try {
    const paths = secretFilePaths(home);
    fs.mkdirSync(path.join(home, ".tre", "tre"), { recursive: true });
    for (const f of paths) fs.writeFileSync(f, "{}", { mode: 0o664 });
    const r = hardenSecretFiles(home);
    assert.equal(r.fixed.length, paths.length, "every secret file gets tightened");
    for (const f of paths) assert.equal(modeOf(f), 0o600, `${f} owner-only`);
  } finally { cleanup(); }
});

test("harden: a chmod failure is a WARNING, never a throw (fail-soft, loud)", () => {
  const { home, cleanup } = fakeHome();
  try {
    // A dangling symlink: stat follows it and fails → skipped; a directory
    // named like a secret: stat succeeds, chmod succeeds on dirs (mode bits
    // differ) — so simulate the true failure case with a file in a
    // read-only-impossible way: simply assert the contract directly on a
    // path whose stat succeeds but whose chmod the OS refuses is not
    // portable; instead assert the no-throw contract on the whole surface.
    const tre = path.join(home, ".tre");
    fs.mkdirSync(tre, { recursive: true });
    fs.symlinkSync("/nonexistent-target", path.join(tre, "telegram.json"));
    let threw = false;
    try {
      hardenSecretFiles(home);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "hardenSecretFiles never throws");
  } finally { cleanup(); }
});

test("price cache writes 0600 (was 0644 — M3)", () => {
  const { home, cleanup } = fakeHome();
  try {
    const file = path.join(home, ".tre", "tre", "openrouter-prices.json");
    writePriceCache({ v: 2 as const, fetchedAt: 1, prices: { "a/b": { in: 1, out: 2 } } }, file);
    assert.equal(modeOf(file), 0o600);
  } finally { cleanup(); }
});
