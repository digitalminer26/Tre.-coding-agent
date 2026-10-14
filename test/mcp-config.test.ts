/**
 * WS12 — MCP config: tre.json `mcpServers` validation + the three-layer
 * child env with the non-overridable marker layer (scope:
 * docs/10-mcp-scope.md §4.1 — the single source of truth).
 *
 * The env matrix (scope §4.1 test requirements): `inheritEnv` × `sandbox`
 * on/off — (a) OFF/OFF: baseline + explicit only, parent secrets ABSENT;
 * (b) OFF/ON: parent secrets present, explicit wins; (c) ON/OFF: (a) +
 * markers; (d) ON/ON: (b) + markers, and an explicit var the allowlist
 * would drop survives (no second `buildBwrapChildEnv` scrub). Marker
 * layer: an explicit `env` entry that sets a marker key is IGNORED for
 * that key — the marker wins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMcpChildEnv,
  markerEnv,
  mcpChildEnv,
  resolveMcpCwd,
  validateMcpServers,
} from "../src/mcp/config.js";
import { BWRAP_DEFAULT_PATH } from "../src/tools/sandbox-linux.js";
import type { McpServerConfig } from "../src/config/tre-config.js";

/** A parent env with a SECRET that must never leak by default, plus the
 *  allowlisted baseline keys. */
const PARENT: Record<string, string | undefined> = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  TMPDIR: "/host/tmp",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  ACME_TOKEN: "super-secret",
  MY_PARENT_VAR: "parent-only",
};

function cfg(partial: Partial<McpServerConfig>): McpServerConfig {
  return {
    command: "node",
    args: [],
    env: {},
    cwd: "",
    tools: [],
    disabled: false,
    trust: false,
    sandbox: false,
    inheritEnv: false,
    ...partial,
  };
}

// ───────────────────────────── resolveMcpCwd ─────────────────────────────

test("resolveMcpCwd: empty (parse default) → the launch directory", () => {
  assert.equal(resolveMcpCwd("", "/launch/dir"), path.resolve("/launch/dir"));
});

test("resolveMcpCwd: relative resolves against the launch directory", () => {
  assert.equal(resolveMcpCwd("sub/dir", "/launch"), path.resolve("/launch/sub/dir"));
});

test("resolveMcpCwd: absolute passes through (canonicalized)", () => {
  assert.equal(resolveMcpCwd("/abs/dir", "/launch"), path.resolve("/abs/dir"));
});

// ───────────────────────────── validateMcpServers ─────────────────────────────

test("validateMcpServers: valid entries (default/relative/absolute cwd) → no errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "sub"));
  const abs = path.join(dir, "abs");
  fs.mkdirSync(abs);
  const errors = validateMcpServers(
    {
      a: cfg({ cwd: "" }),
      b: cfg({ cwd: "sub" }),
      c: cfg({ cwd: abs }),
      d: cfg({ disabled: true, cwd: "sub" }), // disabled is still validated
    },
    dir,
  );
  assert.deepEqual(errors, []);
});

test("validateMcpServers: a missing cwd → fail-closed reason naming the server", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = validateMcpServers({ fs: cfg({ cwd: "nope" }) }, dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /mcpServers\["fs"\]\.cwd does not exist/);
});

test("validateMcpServers: a cwd that is a FILE → 'not a directory'", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "afile");
  fs.writeFileSync(f, "x");
  const errors = validateMcpServers({ fs: cfg({ cwd: f }) }, dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /is not a directory/);
});

test("validateMcpServers: a disabled server with a broken cwd is STILL an error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = validateMcpServers({ fs: cfg({ disabled: true, cwd: "nope" }) }, dir);
  assert.equal(errors.length, 1);
});

// ─────────────────────── buildMcpChildEnv (three layers) ───────────────────────

test("combo (a): sandbox OFF + inheritEnv OFF → baseline + explicit only; parent secret ABSENT", () => {
  const env = buildMcpChildEnv(
    { env: { FOO: "bar", NEW_VAR: "declared" }, inheritEnv: false },
    PARENT,
  );
  // Baseline (allowlisted) keys pass through…
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.TMPDIR, "/host/tmp");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.TERM, "xterm-256color");
  // …explicit entries are added (forward-declared vars pass as declared)…
  assert.equal(env.FOO, "bar");
  assert.equal(env.NEW_VAR, "declared");
  // …and NOTHING else from the parent leaks (no spread by default).
  assert.equal(env.ACME_TOKEN, undefined);
  assert.equal(env.MY_PARENT_VAR, undefined);
});

test("combo (b): inheritEnv ON → parent secret present; explicit wins over inherited same-name", () => {
  const env = buildMcpChildEnv(
    { env: { FOO: "bar" }, inheritEnv: true },
    { ...PARENT, FOO: "parent-value" },
  );
  assert.equal(env.ACME_TOKEN, "super-secret");
  assert.equal(env.MY_PARENT_VAR, "parent-only");
  assert.equal(env.FOO, "bar"); // explicit beats inherited
});

test("explicit env wins over the baseline for the same key", () => {
  const env = buildMcpChildEnv(
    { env: { PATH: "/custom/bin" }, inheritEnv: false },
    PARENT,
  );
  assert.equal(env.PATH, "/custom/bin");
});

// ─────────────────────────────── markerEnv ───────────────────────────────

test("marker: linux sandbox → TRE_SANDBOX + GIT_CONFIG_NOSYSTEM + TMPDIR=/tmp, over explicit falsification", () => {
  const out = markerEnv(
    { TRE_SANDBOX: "0", TMPDIR: "/nonexistent", GIT_CONFIG_NOSYSTEM: "0", FOO: "bar" },
    { sandbox: true, inheritedSandbox: false, platform: "linux" },
  );
  assert.equal(out.TRE_SANDBOX, "1"); // explicit "0" ignored — the marker wins
  assert.equal(out.TMPDIR, "/tmp"); // explicit value ignored
  assert.equal(out.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(out.FOO, "bar"); // non-marker keys untouched
});

test("marker: unsandboxed, no inherited sandbox → TRE_SANDBOX REMOVED (a server env cannot claim one)", () => {
  const out = markerEnv(
    { TRE_SANDBOX: "1", FOO: "bar" },
    { sandbox: false, inheritedSandbox: false, platform: "darwin" },
  );
  assert.equal(out.TRE_SANDBOX, undefined);
  assert.equal(out.GIT_CONFIG_NOSYSTEM, "1"); // still set — every child
  assert.equal(out.TMPDIR, undefined); // not forced off-linux-sandbox
  assert.equal(out.FOO, "bar");
});

test("marker: inherited sandbox (parent TRE_SANDBOX=1) → TRE_SANDBOX=1 even with sandbox:false", () => {
  const out = markerEnv({}, { sandbox: false, inheritedSandbox: true, platform: "linux" });
  assert.equal(out.TRE_SANDBOX, "1");
  assert.equal(out.TMPDIR, undefined); // TMPDIR is forced only for DIRECTLY sandboxed linux children
});

test("marker: linux PATH fallback when the merged env has no usable PATH", () => {
  const missing = markerEnv({ FOO: "bar" }, { sandbox: true, inheritedSandbox: false, platform: "linux" });
  assert.equal(missing.PATH, BWRAP_DEFAULT_PATH);
  const empty = markerEnv({ PATH: "" }, { sandbox: true, inheritedSandbox: false, platform: "linux" });
  assert.equal(empty.PATH, BWRAP_DEFAULT_PATH);
  const kept = markerEnv({ PATH: "/custom/bin" }, { sandbox: true, inheritedSandbox: false, platform: "linux" });
  assert.equal(kept.PATH, "/custom/bin");
});

test("marker: darwin sandbox → no TMPDIR forcing, no PATH fallback", () => {
  const out = markerEnv(
    { TMPDIR: "/host/tmp" },
    { sandbox: true, inheritedSandbox: false, platform: "darwin" },
  );
  assert.equal(out.TMPDIR, "/host/tmp");
  assert.equal(out.PATH, undefined);
});

test("markerEnv: returns a NEW object — the input is never mutated", () => {
  const input = { FOO: "bar", TRE_SANDBOX: "0" };
  const out = markerEnv(input, { sandbox: true, inheritedSandbox: false, platform: "linux" });
  assert.notEqual(out, input);
  assert.equal(input.TRE_SANDBOX, "0"); // input untouched
  assert.equal(out.TRE_SANDBOX, "1");
});

// ─────────────────────────────── mcpChildEnv (full) ───────────────────────────────

test("combo (c): sandbox ON + inheritEnv OFF → (a) + markers; explicit marker keys ignored", () => {
  const env = mcpChildEnv(
    { env: { TRE_SANDBOX: "0", TMPDIR: "/nonexistent", FOO: "bar" }, inheritEnv: false, sandbox: true },
    PARENT,
    "linux",
  );
  assert.equal(env.FOO, "bar");
  assert.equal(env.ACME_TOKEN, undefined); // no inheritance
  assert.equal(env.TRE_SANDBOX, "1");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.TMPDIR, "/tmp");
});

test("combo (d): sandbox ON + inheritEnv ON → parent secret present, explicit wins, allowlist-dropped var SURVIVES", () => {
  const env = mcpChildEnv(
    { env: { MY_SERVER_VAR: "1", FOO: "bar" }, inheritEnv: true, sandbox: true },
    { ...PARENT, FOO: "parent-value" },
    "linux",
  );
  assert.equal(env.ACME_TOKEN, "super-secret"); // inherited
  assert.equal(env.FOO, "bar"); // explicit wins
  assert.equal(env.MY_SERVER_VAR, "1"); // would be dropped by a second buildBwrapChildEnv scrub
  assert.equal(env.TRE_SANDBOX, "1");
  assert.equal(env.TMPDIR, "/tmp");
});

test("mcpChildEnv: inherited parent sandbox → TRE_SANDBOX=1 on an unsandboxed child", () => {
  const env = mcpChildEnv(
    { env: {}, inheritEnv: false, sandbox: false },
    { ...PARENT, TRE_SANDBOX: "1" },
    "darwin",
  );
  assert.equal(env.TRE_SANDBOX, "1");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
});

test("mcpChildEnv: unsandboxed child without inherited sandbox → no TRE_SANDBOX, host TMPDIR kept", () => {
  const env = mcpChildEnv(
    { env: {}, inheritEnv: false, sandbox: false },
    PARENT,
    "linux",
  );
  assert.equal(env.TRE_SANDBOX, undefined);
  assert.equal(env.TMPDIR, "/host/tmp"); // not forced — only linux sandbox:true
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
});
