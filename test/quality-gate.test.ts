/**
 * D20 — dependency freeze in the quality gate (scripts/check-deps.mjs): a
 * clean frozen manifest passes, an added runtime package is rejected as
 * unexpected, and lock/package.json drift is rejected as out of sync. The v2
 * lockfile shape (top-level root manifest) is covered as well.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// This file compiles to dist/test/, so two levels up is the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPS_SCRIPT = path.join(repoRoot, "scripts", "check-deps.mjs");

// The same frozen manifest as the real package.json (4 runtime + 4 dev).
const RUNTIME_DEPS: Record<string, string> = {
  "cli-truncate": "^6.1.1",
  ink: "^7.1.1",
  react: "^19.3.0",
  "wrap-ansi": "^10.0.1"
};
const DEV_DEPS: Record<string, string> = {
  "@types/node": "^24.0.0",
  "@types/react": "^19.3.0",
  "ink-testing-library": "^4.0.0",
  typescript: "^5.5.0"
};

function packageJsonDoc(runtime: Record<string, string>): string {
  return `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module", dependencies: runtime, devDependencies: DEV_DEPS }, null, 2)}\n`;
}

// lockfileVersion 3: the root manifest lives in packages[""].
function lockDocV3(runtime: Record<string, string>): string {
  const root = { name: "fixture", version: "0.0.0", dependencies: runtime, devDependencies: DEV_DEPS };
  return `${JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": root } }, null, 2)}\n`;
}

// lockfileVersion 2: the root manifest lives at the top level.
function lockDocV2(runtime: Record<string, string>): string {
  return `${JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 2, requires: true, dependencies: runtime, devDependencies: DEV_DEPS }, null, 2)}\n`;
}

function writeFixture(dir: string, pkgRuntime: Record<string, string>, lockDoc: string): void {
  fs.writeFileSync(path.join(dir, "package.json"), packageJsonDoc(pkgRuntime));
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockDoc);
}

function runGate(cwd: string): { status: number; out: string } {
  const r = spawnSync("node", [DEPS_SCRIPT], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

test("check-deps: clean v3 fixture passes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-checkdeps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, RUNTIME_DEPS, lockDocV3(RUNTIME_DEPS));
  const r = runGate(dir);
  assert.equal(r.status, 0);
  assert.match(r.out, /deps: OK/);
});

test("check-deps: added runtime package is rejected", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-checkdeps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, { ...RUNTIME_DEPS, lodash: "^4.17.21" }, lockDocV3(RUNTIME_DEPS));
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /unexpected/);
});

test("check-deps: lock with an extra dep is out of sync", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-checkdeps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, RUNTIME_DEPS, lockDocV3({ ...RUNTIME_DEPS, lodash: "^4.17.21" }));
  const r = runGate(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /out of sync/);
});

test("check-deps: clean v2 fixture passes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-checkdeps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, RUNTIME_DEPS, lockDocV2(RUNTIME_DEPS));
  const r = runGate(dir);
  assert.equal(r.status, 0);
  assert.match(r.out, /deps: OK/);
});
