/**
 * /restart — the pure restart core: the spawn spec (restartCommand) and the
 * direct-invocation check (isDirectInvocation). The driver owns the actual
 * re-exec + unmount; this file pins only the pure spec builder (argv →
 * execPath/args/env, with the TRE_RESTARTED env copy) and the realpath-based
 * detection (a real temp file + a symlink to it). No processes are spawned,
 * no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirectInvocation, restartCommand } from "../src/tui/restart.js";
import { restartTeardownAborted } from "../src/tui/run.js";
import { makeInitialState } from "../src/tui/state.js";

// ── restartCommand: the spawn spec ─────────────────────────────────────────

test("restartCommand: empty argv → null (nothing to re-exec)", () => {
  assert.equal(restartCommand([], { PATH: "/usr/bin" }), null);
});

test("restartCommand: argv without an entry script (argv[1] undefined) → null", () => {
  assert.equal(restartCommand(["node"], { PATH: "/usr/bin" }), null);
});

test("restartCommand: happy path — execPath, args (argv minus node), TRE_RESTARTED env", () => {
  const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/u" };
  const cmd = restartCommand(["node", "tre.", "tui", "--session", "s.jsonl"], baseEnv);
  assert.ok(cmd !== null, "a full argv yields a spec");
  assert.equal(cmd!.execPath, process.execPath);
  assert.deepEqual(cmd!.args, ["tre.", "tui", "--session", "s.jsonl"]);
  assert.equal(cmd!.env.TRE_RESTARTED, "1");
  // the base env is carried through
  assert.equal(cmd!.env.PATH, "/usr/bin");
  assert.equal(cmd!.env.HOME, "/home/u");
});

test("restartCommand: the env is a COPY — mutating the returned env never touches baseEnv", () => {
  const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const cmd = restartCommand(["node", "tre."], baseEnv)!;
  // baseEnv must not gain TRE_RESTARTED from the call itself
  assert.equal(baseEnv.TRE_RESTARTED, undefined);
  // mutating the returned env must not leak back into baseEnv
  cmd.env.TRE_RESTARTED = "tampered";
  cmd.env.EXTRA = "1";
  assert.equal(baseEnv.TRE_RESTARTED, undefined, "baseEnv did not gain TRE_RESTARTED");
  assert.equal(baseEnv.EXTRA, undefined, "baseEnv did not gain the mutation");
  // and the returned env keeps its own values
  assert.equal(cmd.env.TRE_RESTARTED, "tampered");
});

// ── isDirectInvocation: realpath-based detection ───────────────────────────

test("isDirectInvocation: undefined processArgv1 → false", () => {
  assert.equal(isDirectInvocation(undefined, "/some/entry.js"), false);
});

test("isDirectInvocation: nonexistent path → false (realpath fails)", () => {
  assert.equal(isDirectInvocation("/no/such/file/entry.js", "/no/such/file/entry.js"), false);
});

test("isDirectInvocation: real file match, symlink match, different file mismatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tre-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, "entry.js");
  await writeFile(entry, "entry");
  const other = join(dir, "other.js");
  await writeFile(other, "other");
  const link = join(dir, "link.js");
  await symlink(entry, link);

  const entryReal = realpathSync(entry);

  // The process was launched directly as the entry file → true.
  assert.equal(isDirectInvocation(entry, entryReal), true, "real file matches its own realpath");
  // Launched through a SYMLINK to the entry file → the realpath resolves to
  // the entry → true (this is how a bin/ shim or a renamed link behaves).
  assert.equal(isDirectInvocation(link, entryReal), true, "a symlink to the entry resolves true");
  // A DIFFERENT file → false, even though it exists and resolves cleanly.
  assert.equal(isDirectInvocation(other, entryReal), false, "a different file resolves false");
});

// ── Finding #2 (audit): /restart ABORTS (does not spawn) when the MCP
//    teardown cannot confirm every server exited. The pure transition
//    (restartTeardownAborted) is what the driver applies on a rejected
//    teardownMcp(); it must yield an `error` item (not a benign `info`
//    warning) and NOT mutate the input state.
test("restartTeardownAborted: a rejected teardown → an error item (abort, not a warning)", () => {
  const base = makeInitialState("test");
  const next = restartTeardownAborted(base, new Error("2 server(s) still running after SIGKILL bound"));
  // The input state is NOT mutated (a pure transition).
  assert.equal(base.items.length, 0, "the input state is untouched");
  // Exactly one item is appended, and it is an ERROR (the restart is aborted),
  // not an info/warning (which would imply the restart proceeded).
  assert.equal(next.items.length, 1, "one item appended");
  const item = next.items[0] as { kind: string; text: string };
  assert.equal(item.kind, "error", "the abort is surfaced as an error, not a warning");
  assert.match(item.text, /restart aborted/i, "the text says the restart was aborted");
  assert.match(item.text, /still running after SIGKILL bound/i, "the teardown reason is included");
  assert.match(item.text, /quit and re-run/i, "the recovery path is stated");
});

test("restartTeardownAborted: a non-Error rejection is stringified, not thrown", () => {
  const base = makeInitialState("test");
  let next: ReturnType<typeof restartTeardownAborted>;
  try {
    next = restartTeardownAborted(base, "a plain string failure");
  } catch (e) {
    assert.fail(`a non-Error rejection must not throw: ${String(e)}`);
  }
  const item = next.items[0] as { kind: string; text: string };
  assert.equal(item.kind, "error");
  assert.match(item.text, /a plain string failure/i, "the string reason is embedded");
});

// ── Audit fix: a failed teardown must not wedge the TUI forever ──────────
// The failed-restart transition leaves the app alive: the abort message is an
// error item, and the caller (run.tsx) keeps `restartFailed` set so /quit and
// /restart remain reachable. This pins that the transition itself keeps the
// earlier history intact (no state loss on a failed restart).
test("restartTeardownAborted keeps prior items and appends (no state loss)", () => {
  const base = makeInitialState("test");
  base.items.push({ kind: "info", text: "earlier" });
  const next = restartTeardownAborted(base, new Error("unconfirmed"));
  assert.deepEqual(next.items[0], { kind: "info", text: "earlier" }, "prior items preserved");
  assert.equal(next.items.length, 2);
});
