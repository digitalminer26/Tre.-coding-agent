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
import { drainTurnBounded, restartTeardownAborted, runRestartSequence } from "../src/tui/run.js";
import { makeInitialState } from "../src/tui/state.js";
import { ActiveWork } from "../src/tui/active-work.js";

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

// ── AUDIT CYCLE 2 — NEW-F3: the active-turn drain barrier ─────────────────
// A busy /restart aborts the run (a signal, not completion). Before tearing
// down MCP + spawning the replacement, the aborted run's async
// tool-result/session/event work must settle. drainTurnBounded races the turn
// promise against a bound: it returns true when the turn settled (safe to
// proceed) and false when it did not (the caller must NOT spawn a replacement
// against a still-live turn). A SETTLED (rejected) turn is still settled — it
// counts as drained.
test("drainTurnBounded: null turn → true (nothing to drain)", async () => {
  assert.equal(await drainTurnBounded(null, 50), true);
});

test("drainTurnBounded: an already-settled turn → true (immediate)", async () => {
  const settled = Promise.resolve("done");
  assert.equal(await drainTurnBounded(settled, 50), true);
});

test("drainTurnBounded: a turn that settles within the bound → true", async () => {
  const turn = new Promise((r) => setTimeout(() => r("done"), 20));
  const t0 = Date.now();
  const ok = await drainTurnBounded(turn, 500);
  assert.equal(ok, true);
  assert.ok(Date.now() - t0 < 400, "resolved as soon as the turn settled, not at the bound");
});

// AUDIT CYCLE 3 — a turn that settles quickly must not leave its bound timer
// alive: the helper clears it, so the process can exit without waiting it out.
test("drainTurnBounded: clears its timeout when the turn settles first", async () => {
  const { spawnSync } = await import("node:child_process");
  const code = `import("./dist/src/tui/run.js").then(async (m) => {
    await m.drainTurnBounded(Promise.resolve(), 3000);
  });`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 2500, "process exited without waiting out the 3s bound");
});

test("drainTurnBounded: a turn that REJECTS is still settled → true", async () => {
  const turn = new Promise((_r, r) => setTimeout(() => r(new Error("boom")), 20));
  // A rejected turn is SETTLED — the abort landed; the caller may proceed.
  assert.equal(await drainTurnBounded(turn, 500), true);
});

test("drainTurnBounded: a turn that does NOT settle within the bound → false", async () => {
  // A run that ignores the abort: the promise never settles.
  const never = new Promise<never>(() => {});
  const t0 = Date.now();
  const ok = await drainTurnBounded(never, 40);
  assert.equal(ok, false, "timed out — the caller must not spawn a replacement");
  assert.ok(Date.now() - t0 >= 35, "waited out the bound");
});

// ── AUDIT CYCLE 3 — restart ORDERING (drain → teardown → spawn) ────────────
// The ordering is the regression surface: removing the drain, reordering the
// teardown after the spawn, or spawning after a failed/timed-out step would
// each be caught here (runRestartSequence is the production code path).
function recorder(over: Partial<Parameters<typeof runRestartSequence>[0]> = {}) {
  const log: string[] = [];
  let turn: Promise<unknown> | null = null;
  const steps = {
    activeTurn: () => turn,
    drainTimeoutMs: 40,
    abortTurn: () => log.push("abort"),
    teardown: async () => {
      log.push("teardown");
    },
    isMounted: () => true,
    spawn: () => log.push("spawn"),
    ...over,
  };
  return { log, steps, setTurn: (t: Promise<unknown> | null) => (turn = t) };
}

test("runRestartSequence: idle → teardown then spawn, in that order", async () => {
  const r = recorder();
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "spawned" });
  assert.deepEqual(r.log, ["teardown", "spawn"]);
});

test("runRestartSequence: waits for the active turn to settle BEFORE teardown", async () => {
  const r = recorder({ drainTimeoutMs: 500 });
  r.setTurn(new Promise((res) => setTimeout(() => { r.log.push("turn-settled"); res("ok"); }, 20)));
  await runRestartSequence(r.steps);
  // abort is signalled first, then the drain waits for the turn to settle.
  assert.deepEqual(r.log, ["abort", "turn-settled", "teardown", "spawn"]);
});

test("runRestartSequence: drain timeout → abort again, NO teardown, NO spawn", async () => {
  const r = recorder({ drainTimeoutMs: 20 });
  r.setTurn(new Promise<never>(() => {}));
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "drain-timeout" });
  assert.deepEqual(r.log, ["abort"]);
});

// PRODUCTION WIRING (not a stand-in promise): the same ActiveWork tracker run.tsx
// uses for both runs and manual /compact. A compaction-shaped operation is
// tracked with its real AbortController, and its "session append" completes
// only after the signal. A restart must abort it, wait for the persistence,
// and only then tear down and spawn.
test("production wiring: tracked compaction is aborted, persisted, then teardown → spawn", async () => {
  const work = new ActiveWork();
  const log: string[] = [];
  const compactAbort = new AbortController();
  // Session persistence: resolves shortly after the abort (like compactNow's
  // awaited appendCompaction), never before it.
  const persisted = new Promise<void>((resolve) => {
    compactAbort.signal.addEventListener("abort", () => {
      setTimeout(() => {
        log.push("compaction-persisted");
        resolve();
      }, 15);
    });
  });
  work.track(persisted, compactAbort);
  const out = await runRestartSequence({
    activeTurn: () => work.current()?.promise ?? null,
    drainTimeoutMs: 2000,
    abortTurn: () => {
      log.push("abort");
      (work.current()?.abort ?? new AbortController()).abort();
    },
    teardown: async () => { log.push("teardown"); },
    isMounted: () => true,
    spawn: () => log.push("spawn"),
  });
  assert.deepEqual(out, { kind: "spawned" });
  assert.deepEqual(log, ["abort", "compaction-persisted", "teardown", "spawn"]);
  assert.equal(work.current(), null, "the tracker clears once the work settles");
});

// Settled-then-replaced: the first operation settles, and during that gap a
// second one starts (a run/compaction began in the window). The restart must
// drain the SECOND too — abort it, wait, and only then tear down and spawn.
test("runRestartSequence: an operation started in the gap after a settle is drained before teardown", async () => {
  const work = new ActiveWork();
  const log: string[] = [];
  const first = new AbortController();
  const second = new AbortController();
  const firstP = new Promise<void>((res) => first.signal.addEventListener("abort", () => res()));
  work.track(firstP, first);
  // When the first settles, a NEW operation takes the slot (not yet settled).
  void firstP.then(() => {
    const secondP = new Promise<void>((res) =>
      second.signal.addEventListener("abort", () => {
        setTimeout(() => {
          log.push("second-settled");
          res();
        }, 10);
      }),
    );
    work.track(secondP, second);
  });
  const out = await runRestartSequence({
    activeTurn: () => work.current()?.promise ?? null,
    drainTimeoutMs: 2000,
    abortTurn: () => {
      log.push("abort");
      (work.current()?.abort ?? new AbortController()).abort();
    },
    teardown: async () => { log.push("teardown"); },
    isMounted: () => true,
    spawn: () => log.push("spawn"),
  });
  assert.deepEqual(out, { kind: "spawned" });
  // The second operation was drained (aborted and settled) before teardown.
  assert.ok(log.indexOf("second-settled") < log.indexOf("teardown"), "teardown waited for the replacement");
  assert.equal(log[log.length - 1], "spawn");
});

// Timed-out-then-replaced: the first operation never settles and is replaced by
// a second that never settles either. The overall deadline must still block
// teardown and spawn — no replacement is spawned against live work.
test("runRestartSequence: a stuck operation replaced by another stuck one → drain-timeout, no teardown", async () => {
  const work = new ActiveWork();
  const log: string[] = [];
  work.track(new Promise<never>(() => {}), new AbortController());
  // The first operation's abort "replaces" it with a second stuck operation.
  const out = await runRestartSequence({
    activeTurn: () => work.current()?.promise ?? null,
    drainTimeoutMs: 60,
    abortTurn: () => {
      log.push("abort");
      work.track(new Promise<never>(() => {}), new AbortController());
    },
    teardown: async () => { log.push("teardown"); },
    isMounted: () => true,
    spawn: () => log.push("spawn"),
  });
  assert.deepEqual(out, { kind: "drain-timeout" });
  assert.ok(!log.includes("teardown") && !log.includes("spawn"), "no teardown or spawn against live work");
});

test("ActiveWork: an OLDER operation's completion does not clear a NEWER one", async () => {
  const work = new ActiveWork();
  let finishOld!: () => void;
  const old = new Promise<void>((r) => (finishOld = r));
  const newer = new Promise<void>(() => {});
  work.track(old, null);
  work.track(newer, null);
  finishOld();
  await old;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(work.current()?.promise, newer, "the newer operation is still tracked");
});

test("ActiveWork: a REJECTED operation also clears its slot", async () => {
  const work = new ActiveWork();
  const failing = Promise.reject(new Error("compact failed"));
  work.track(failing, null);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(work.current(), null);
});

// Abort-aware active work must settle promptly after the abort (no five-second
// stall), and the restart proceeds to teardown + spawn.
test("runRestartSequence: abort-aware active work is aborted FIRST and the restart proceeds", async () => {
  const ctl = new AbortController();
  const work = new Promise<void>((res) => ctl.signal.addEventListener("abort", () => res()));
  const log: string[] = [];
  const t0 = Date.now();
  const out = await runRestartSequence({
    activeTurn: () => work,
    drainTimeoutMs: 2000,
    abortTurn: () => { log.push("abort"); ctl.abort(); },
    teardown: async () => { log.push("teardown"); },
    isMounted: () => true,
    spawn: () => log.push("spawn"),
  });
  assert.deepEqual(out, { kind: "spawned" });
  assert.deepEqual(log, ["abort", "teardown", "spawn"]);
  assert.ok(Date.now() - t0 < 1000, "settled on the abort, not at the drain bound");
});

test("runRestartSequence: abortTurn is invoked for the active work on drain timeout", async () => {
  const r = recorder({ drainTimeoutMs: 20 });
  r.setTurn(new Promise<never>(() => {}));
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "drain-timeout" });
  assert.equal(r.log.filter((x) => x === "abort").length, 1);
});

test("runRestartSequence: teardown throws → NO spawn (old servers may be alive)", async () => {
  const boom = new Error("survivor");
  const r = recorder({ teardown: async () => { r.log.push("teardown"); throw boom; } });
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "teardown-failed", error: boom });
  assert.deepEqual(r.log, ["teardown"]);
});

test("runRestartSequence: unmounted during teardown → NO spawn", async () => {
  const r = recorder({ isMounted: () => false });
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "unmounted" });
  assert.deepEqual(r.log, ["teardown"]);
});

test("runRestartSequence: no teardown hook → spawn directly", async () => {
  const r = recorder({ teardown: undefined });
  assert.deepEqual(await runRestartSequence(r.steps), { kind: "spawned" });
  assert.deepEqual(r.log, ["spawn"]);
});
