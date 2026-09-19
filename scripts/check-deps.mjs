#!/usr/bin/env node
// check-deps.mjs — dependency freeze for the quality gate (check 6 of
// scripts/quality-check.sh).
//
// Rejects any change that adds a package: the agent being improved must not be
// able to "fix" bugs by npm-installing new dependencies (supply-chain vector).
// Reads package.json and package-lock.json from the CURRENT WORKING DIRECTORY.
//
// Embedded allowlist (the complete frozen set — anything else fails):
//   dependencies:    cli-truncate, ink, react, wrap-ansi
//   devDependencies: @types/node, @types/react, ink-testing-library, typescript
//
// Checks, in order:
//   a. every key of package.json's dependencies / devDependencies is on the
//      allowlist — else `deps: unexpected <kind> package "<name>"` (one line per
//      offending package), exit 1.
//   b. package-lock.json exists (`deps: package-lock.json missing`, exit 1 if
//      not) and its root manifest matches package.json per kind. The root
//      manifest lives in packages[""].<kind> for lockfileVersion 3 and at the
//      top-level <kind> key for v2; any other version is rejected. On mismatch:
//      `deps: lock/package.json out of sync (<kind>)`, exit 1. Missing keys count
//      as empty objects; matching is exact (same names AND same ranges), so a
//      hand-edited manifest that never went through npm also fails.
//
// Success: prints `deps: OK (<n> runtime, <m> dev)` and exits 0.
// Plain node ESM — no npm dependencies, node >= 18.

import { readFileSync } from "node:fs";

const KINDS = ["dependencies", "devDependencies"];

const ALLOWLIST = {
  dependencies: new Set(["cli-truncate", "ink", "react", "wrap-ansi"]),
  devDependencies: new Set([
    "@types/node",
    "@types/react",
    "ink-testing-library",
    "typescript"
  ])
};

function fail(msg) {
  process.stdout.write(`${msg}\n`);
  process.exit(1);
}

function asObj(x) {
  return x !== null && typeof x === "object" ? x : {};
}

// Canonical form for the deep comparison: sorted keys, exact values.
function canon(manifest) {
  const m = asObj(manifest);
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return JSON.stringify(out);
}

// --- package.json -----------------------------------------------------------

let pkgRaw;
try {
  pkgRaw = readFileSync("package.json", "utf8");
} catch {
  fail("deps: package.json missing (run from the repository root)");
}
let pkg;
try {
  pkg = JSON.parse(pkgRaw);
} catch {
  fail("deps: package.json is not valid JSON");
}
pkg = asObj(pkg);

// a. every declared package must be on the allowlist.
for (const kind of KINDS) {
  const manifest = asObj(pkg[kind]);
  for (const name of Object.keys(manifest).sort()) {
    if (!ALLOWLIST[kind].has(name)) {
      fail(`deps: unexpected ${kind} package "${name}"`);
    }
  }
}

// --- package-lock.json ------------------------------------------------------

let lockRaw;
try {
  lockRaw = readFileSync("package-lock.json", "utf8");
} catch {
  fail("deps: package-lock.json missing");
}
let lock;
try {
  lock = JSON.parse(lockRaw);
} catch {
  fail("deps: package-lock.json is not valid JSON");
}
lock = asObj(lock);

// b. the lock's root manifest must match package.json per kind.
const version = lock.lockfileVersion;
if (version !== 3 && version !== 2) {
  fail(`deps: unsupported lockfileVersion ${String(version)} (expected 2 or 3)`);
}
for (const kind of KINDS) {
  const rootEntry = version === 3 ? asObj(asObj(lock.packages)[""]) : lock;
  if (canon(rootEntry[kind]) !== canon(pkg[kind])) {
    fail(`deps: lock/package.json out of sync (${kind})`);
  }
}

const nRuntime = Object.keys(asObj(pkg.dependencies)).length;
const nDev = Object.keys(asObj(pkg.devDependencies)).length;
process.stdout.write(`deps: OK (${nRuntime} runtime, ${nDev} dev)\n`);
