/**
 * Background Telegram driver (plain CLI) — loop prevention + routing +
 * main.ts wiring.
 *
 * The CORE of this feature is that the background poll loop CANNOT hot-spin:
 * a naive `while (true) { poll(); }` spins hundreds of times/second when a
 * poll fails fast (network down, bad token). These tests prove the three
 * loop-prevention mechanisms (long-poll self-pacing, the min-interval hard
 * cap, and capped exponential backoff on failure) with a FAKE bridge (no
 * network, controlled timing) plus the steer-vs-idle routing and the turn
 * mutex. The bottom section covers the main.ts wiring itself (the D31 tests):
 * one-shot steer + no idle turn + no reply, REPL idle-turn start + reply +
 * pre-prompt poll start + user/telegram serialization, and the disabled
 * no-telegram path (must be unchanged).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { TelegramDriver } from "../src/telegram/driver.js";
import { makeTelegramBridge } from "../src/telegram/bridge.js";
import type { TelegramBridge, TelegramMessage } from "../src/telegram/bridge.js";
import { main, finalAssistantText } from "../src/cli/main.js";
import { readWorkerStatuses } from "../src/cli/workers.js";
import { fakeStream } from "./fake-stream.js";
import type { AgentMessage, ModelConfig } from "../src/types.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, maxMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > maxMs) throw new Error(`waitUntil timeout: ${what}`);
    await sleep(5);
  }
}

/** A controllable bridge: `behavior(i)` decides the i-th poll's result. */
class FakeBridge implements TelegramBridge {
  enabled = true;
  times: number[] = []; // poll START timestamps (the loop-prevention observable)
  sent: string[] = [];
  constructor(private behavior: (i: number) => TelegramMessage[] | null | Promise<TelegramMessage[] | null>) {}
  async pollLong(_timeoutSec: number, _signal?: AbortSignal): Promise<TelegramMessage[] | null> {
    this.times.push(Date.now());
    return this.behavior(this.times.length - 1);
  }
  async send(text: string): Promise<void> {
    this.sent.push(text);
  }
}
const MSG = (n: string): TelegramMessage[] => [{ chatId: "1", sender: "user", text: n }];

const noopHandlers = {
  onSteer: () => {},
  onIdle: async () => {},
};

// ── LOOP PREVENTION ──────────────────────────────────────────────────────────

test("backoff: a persistent fast-failure backs off exponentially and caps (no hot spin)", async () => {
  const bridge = new FakeBridge(() => {
    throw new Error("network down (fast fail)");
  });
  const driver = new TelegramDriver(bridge, noopHandlers, {
    failBaseMs: 40,
    failCapMs: 120,
    minIntervalMs: 10,
  });
  const p = driver.start();
  await waitUntil(() => bridge.times.length >= 5, 3000, "5 poll starts");
  driver.stop();
  await p;
  const gaps = bridge.times.slice(1).map((t, i) => t - bridge.times[i]!);
  // The backoff curve: base, 2·base, cap, cap, … (grows then flattens at the cap).
  assert.ok(gaps[0]! >= 30, `gap[0] ${gaps[0]} should be ~base (40), not a hot spin`);
  assert.ok(gaps[1]! >= 60, `gap[1] ${gaps[1]} should be ~2·base (80)`);
  assert.ok(gaps[2]! >= 100, `gap[2] ${gaps[2]} should be ~cap (120)`);
  // The KEY property: no gap is near-zero (a hot spin would be ~0ms gaps).
  for (const g of gaps) assert.ok(g >= 30, `gap ${g} is a hot spin (< 30ms)`);
  // And the cap holds: no gap wildly exceeds it.
  assert.ok(Math.max(...gaps) <= 200, `gap ${Math.max(...gaps)} exceeds the cap`);
});

test("backoff: a SUCCESS (even 'no message') resets the failure counter", async () => {
  const bridge = new FakeBridge((i) => {
    // fail, fail, SUCCESS (no message), fail, fail
    if (i === 2) return null;
    throw new Error("fail");
  });
  const driver = new TelegramDriver(bridge, noopHandlers, {
    failBaseMs: 40,
    failCapMs: 120,
    minIntervalMs: 10,
  });
  const p = driver.start();
  await waitUntil(() => bridge.times.length >= 5, 3000, "5 poll starts");
  driver.stop();
  await p;
  const gaps = bridge.times.slice(1).map((t, i) => t - bridge.times[i]!);
  // gap[0]=40 (fail1), gap[1]=80 (fail2), gap[2]≈10 (success, no backoff),
  // gap[3]=40 (fail1 AGAIN — reset, NOT 160 which is what 4·base would be).
  assert.ok(gaps[3]! < 100, `gap[3] ${gaps[3]} should be ~base (40) after the reset, not continued exponential`);
});

test("min-interval guard: a poll that returns INSTANTLY cannot hot-spin", async () => {
  // Simulates a helper that ignores --timeout and returns null immediately.
  // Without the min-interval guard, this would spin ~1000s of polls in 150ms.
  const bridge = new FakeBridge(() => null);
  const driver = new TelegramDriver(bridge, noopHandlers, { minIntervalMs: 50 });
  const p = driver.start();
  await sleep(150);
  driver.stop();
  await p;
  assert.ok(bridge.times.length <= 5, `hot spin: ${bridge.times.length} polls in 150ms (should be ~3)`);
  const gaps = bridge.times.slice(1).map((t, i) => t - bridge.times[i]!);
  for (const g of gaps) assert.ok(g >= 35, `gap ${g} is below the min-interval guard (50ms)`);
});

// ── ROUTING ──────────────────────────────────────────────────────────────────

test("routing: a message STEERS the in-flight turn (onSteer, not onIdle)", async () => {
  const bridge = new FakeBridge(() => MSG("steer me"));
  const steered: string[] = [];
  let idleCalled = false;
  const driver = new TelegramDriver(
    bridge,
    { onSteer: (m) => steered.push(m.text), onIdle: async () => { idleCalled = true; } },
    { minIntervalMs: 1000 },
  );
  // Hold a turn FIRST, then start the driver (so the poll sees turnInFlight).
  const turn = driver.withTurn(async () => sleep(120));
  await sleep(10);
  driver.start();
  await waitUntil(() => steered.length >= 1, 1000, "steer delivered");
  await turn;
  driver.stop();
  assert.equal(steered[0], "steer me");
  assert.equal(idleCalled, false, "onIdle must NOT fire while a turn is in flight");
});

test("routing: a message when IDLE runs an idle turn (onIdle, not onSteer)", async () => {
  const bridge = new FakeBridge(() => MSG("hello"));
  let idleText = "";
  let steeredCount = 0;
  const driver = new TelegramDriver(
    bridge,
    {
      onSteer: () => steeredCount++,
      onIdle: async (msgs) => { idleText = msgs[0]!.text; },
    },
    { minIntervalMs: 1000 },
  );
  driver.start();
  await waitUntil(() => idleText !== "", 1000, "idle turn ran");
  driver.stop();
  await sleep(10);
  assert.equal(idleText, "hello");
  assert.equal(steeredCount, 0, "onSteer must NOT fire when idle");
});

test("routing: allowIdleTurns=false (one-shot) never starts an idle turn", async () => {
  const bridge = new FakeBridge(() => MSG("hello"));
  let idleCalled = false;
  const driver = new TelegramDriver(
    bridge,
    { onSteer: () => {}, onIdle: async () => { idleCalled = true; } },
    { allowIdleTurns: false, minIntervalMs: 1000 },
  );
  driver.start();
  await sleep(60);
  driver.stop();
  await sleep(10);
  assert.equal(idleCalled, false, "one-shot must not turn a message into a new run");
});

// ── ERROR CONTAINMENT ───────────────────────────────────────────────────────

test("containment: a THROWING onSteer does not reject start() and does not stop the loop", async () => {
  const bridge = new FakeBridge(() => MSG("boom"));
  const boom = new Error("onSteer exploded");
  let steerCount = 0;
  const handlerErrors: unknown[] = [];
  const driver = new TelegramDriver(
    bridge,
    {
      onSteer: () => {
        steerCount += 1;
        throw boom; // throws EVERY steer — the loop must survive and keep polling
      },
      onIdle: async () => {},
    },
    { minIntervalMs: 10, onHandlerError: (err) => handlerErrors.push(err) },
  );
  const p = driver.start();
  // Hold a turn so the messages route to onSteer (not onIdle).
  const turn = driver.withTurn(async () => sleep(120));
  await sleep(10);
  // The loop must keep steering across iterations (the throw must not kill it).
  await waitUntil(() => steerCount >= 3, 3000, "onSteer called repeatedly");
  assert.equal(handlerErrors.length, steerCount, "onHandlerError fires per throwing steer");
  assert.equal(handlerErrors[0], boom, "onHandlerError gets the thrown error");
  driver.stop();
  await turn;
  await p; // RESOLVES — a throwing onSteer must never reject start()'s promise
});

test("containment: an unexpected loop error is contained — start() resolves, loop stops", async () => {
  // A throw from `onPollError` (called inside the poll's catch block) escapes
  // the poll's own try/catch and hits the loop boundary — the unguarded
  // code path the boundary must contain.
  const bridge = new FakeBridge(() => {
    throw new Error("network down (fast fail)");
  });
  const boom = new Error("unexpected loop error");
  const handlerErrors: unknown[] = [];
  const driver = new TelegramDriver(bridge, noopHandlers, {
    failBaseMs: 10,
    minIntervalMs: 10,
    onPollError: () => {
      throw boom; // unguarded: escapes the poll's try/catch
    },
    onHandlerError: (err) => handlerErrors.push(err),
  });
  const p = driver.start();
  await waitUntil(() => handlerErrors.length >= 1, 2000, "onHandlerError called");
  assert.equal(handlerErrors[0], boom, "onHandlerError gets the unexpected error");
  await p; // RESOLVES — the loop boundary must never let start() reject
  const countAtEnd = bridge.times.length;
  assert.ok(countAtEnd >= 1, "at least one poll ran before the error");
  await sleep(40);
  assert.equal(bridge.times.length, countAtEnd, "the loop is stopped after the unexpected error");
});

// ── LIFECYCLE ────────────────────────────────────────────────────────────────

test("lifecycle: stop() ends the loop promptly and no further polls run", async () => {
  const bridge = new FakeBridge(() => null);
  const driver = new TelegramDriver(bridge, noopHandlers, { minIntervalMs: 1000 });
  const p = driver.start();
  await sleep(30);
  driver.stop();
  await p; // resolves after stop
  const countAtStop = bridge.times.length;
  await sleep(40);
  assert.equal(bridge.times.length, countAtStop, "no polls after stop()");
});

test("lifecycle: a disabled bridge makes start() a no-op (no polls)", async () => {
  let polled = false;
  const bridge: TelegramBridge = {
    enabled: false,
    pollLong: async () => {
      polled = true;
      return null;
    },
    send: async () => {},
  };
  const driver = new TelegramDriver(bridge, noopHandlers);
  const p = driver.start();
  await sleep(30);
  await p;
  assert.equal(polled, false, "a disabled bridge must never poll");
});

test("mutex: two turns run SERIALLY, never concurrently", async () => {
  const bridge: TelegramBridge = {
    enabled: false,
    pollLong: async () => null,
    send: async () => {},
  };
  const driver = new TelegramDriver(bridge, noopHandlers);
  let inA = false;
  let inB = false;
  let overlap = false;
  const a = driver.withTurn(async () => {
    inA = true;
    await sleep(40);
    if (inB) overlap = true;
    inA = false;
  });
  const b = driver.withTurn(async () => {
    inB = true;
    await sleep(40);
    if (inA) overlap = true;
    inB = false;
  });
  await Promise.all([a, b]);
  assert.equal(overlap, false, "two turns must not run concurrently on the shared context");
});

// ── LIFECYCLE CANCELLATION (F2) ────────────────────────────────────────────

test("F2: stop() cancels a reserved-but-unstarted body — its fn never runs and the promise resolves undefined", async () => {
  const bridge: TelegramBridge = {
    enabled: false,
    pollLong: async () => null,
    send: async () => {},
  };
  const driver = new TelegramDriver(bridge, noopHandlers);
  let bodyRan = false;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  // Hold the mutex with an explicit barrier, so the second body is certainly
  // reserved-but-unstarted when stop() fires (no timer-order dependency).
  const a = driver.withTurn(async () => {
    firstStarted();
    await firstGate;
  });
  await started;
  const b = driver.withTurn(async () => {
    bodyRan = true;
  });
  driver.stop();
  const draining = driver.stopAndDrain();
  releaseFirst();
  await Promise.all([a, draining]);
  assert.equal(await b, undefined, "a reserved-but-unstarted body at stop time resolves undefined");
  assert.equal(bodyRan, false, "the cancelled body must never run");
  assert.equal(driver.turnInFlight, false, "drain leaves no reserved turns");
});

// ── STEER HANDOFF BUFFER (attach/detach/steer) ──────────────────────────────

// P3a: driver pushes may be plain strings or envelopes — `seen` records
// the TEXT either way so the pre-P3a assertions read unchanged.
function mkQueue(): { push(t: string): void; drain(): string[]; seen: string[] } {
  const seen: string[] = [];
  const q: unknown[] = [];
  const textOf = (x: unknown): string => (typeof x === "string" ? x : (x as { text: string }).text);
  return {
    push(t: string) { q.push(t); seen.push(textOf(t)); },
    drain() { const d = q.map(textOf); q.length = 0; return d; },
    seen,
  };
}



test("handoff buffer: a steer with NO attached queue is buffered, claimed in order by the next labeled attach", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  const driver = new TelegramDriver(bridge, noopHandlers);
  // Pre-attach (the one-shot window between driver.start() and the turn body):
  driver.steer("first");
  driver.steer("second");
  assert.deepEqual(driver.steerClaims, [], "nothing claimed yet");
  const q = mkQueue();
  const claimed = driver.attachSteerTarget(q, "run");
  assert.deepEqual(claimed.map((s) => s.text), ["first", "second"], "the buffer drains in ARRIVAL order");
  assert.deepEqual(driver.steerClaims, [
    { text: "first", claimedBy: "run" },
    { text: "second", claimedBy: "run" },
  ], "the claim log tags each message with the claiming body");
  // After attach: steers route DIRECTLY to the queue, not the buffer.
  driver.steer("live");
  assert.deepEqual(claimed.map((s) => s.text), ["first", "second"], "the buffer was not refilled");
  assert.deepEqual(q.seen, ["live"], "attached → direct routing");
});

test("P3a (§14.2): routed steers are envelopes — source \"telegram\" survives the handoff buffer; requestId rides through", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  const driver = new TelegramDriver(bridge, noopHandlers);
  // Buffered pre-attach: provenance must survive the handoff into the claim.
  driver.steer("buffered");
  driver.steer("supervised", "req-42");
  const q = mkQueue();
  const claimed = driver.attachSteerTarget(q, "run");
  assert.deepEqual(
    claimed.map((s) => ({ text: s.text, source: s.source, requestId: s.requestId })),
    [
      { text: "buffered", source: "telegram", requestId: "" },
      { text: "supervised", source: "telegram", requestId: "req-42" },
    ],
    "the claim carries the full envelope, in order",
  );
  // Direct routing while attached: the queue receives the envelope itself.
  const items: unknown[] = [];
  driver.attachSteerTarget(
    { push: (x: unknown) => items.push(x), drain: () => { const d = items.splice(0); return d as never; } } as never,
    "user",
  );
  driver.steer("live", "req-43");
  assert.deepEqual(items, [{ text: "live", source: "telegram", requestId: "req-43" }],
    "a direct push is the envelope, not the bare text");
});

test("handoff buffer: a steer racing the turn END is detached to the buffer and reaches the NEXT body", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  const driver = new TelegramDriver(bridge, noopHandlers);
  const q1 = mkQueue();
  driver.attachSteerTarget(q1, "user");
  driver.detachSteerTarget(); // the turn body finished; the mutex may not have released yet
  driver.steer("raced-the-end"); // lands in the buffer, NOT q1
  assert.deepEqual(q1.seen, [], "a detached steer must not enter the dead queue");
  const q2 = mkQueue();
  assert.deepEqual(driver.attachSteerTarget(q2, "telegram-idle").map((s) => s.text), ["raced-the-end"],
    "the next body claims it before its first drain");
  assert.deepEqual(driver.steerClaims, [{ text: "raced-the-end", claimedBy: "telegram-idle" }],
    "the claim records WHICH body rescued the steer");
});

test("handoff buffer: a steer WHILE A LABELED BODY RUNS goes straight to its queue, claimed tagged", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  const driver = new TelegramDriver(bridge, noopHandlers);
  const q = mkQueue();
  driver.attachSteerTarget(q, "user");
  driver.steer("mid-turn"); // body is in flight: direct, never buffered
  assert.deepEqual(q.seen, ["mid-turn"], "live queue receives the steer directly");
  assert.deepEqual(driver.steerClaims, [{ text: "mid-turn", claimedBy: "user" }],
    "the claim log names the body that owned the steer");
  assert.equal(driver.pendingSteers(), 0, "nothing sits in the buffer");
});

test("follow-up: a steer stranded in the buffer at a labeled body's END manufactures ONE idle follow-up with it", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  const idles: { msgs: number; pending: string[] }[] = [];
  const driver = new TelegramDriver(
    bridge,
    // P3a: pendingSteers are envelopes — the test keeps asserting on texts.
    { onSteer: () => {}, onIdle: async (msgs, pendingSteers = []) => { idles.push({ msgs: msgs.length, pending: pendingSteers.map((s) => s.text) }); } },
  );
  // A user-typed body (label "user") attaches a queue; a steer arrives, the
  // body DRAINS nothing, and the body settles → the queue's undrained steer
  // must trigger exactly one follow-up onIdle([], pending).
  await driver.withTurn(async () => {
    const q = mkQueue();
    driver.attachSteerTarget(q, "user");
    driver.steer("left-behind"); // goes to q, but the body never drains it
    driver.detachSteerTarget(); // detach pushes q's undrained items to the buffer
  });
  await waitUntil(() => idles.length >= 1, 500, "follow-up scheduled");
  await sleep(50); // let any (buggy) second follow-up fire
  assert.deepEqual(idles, [{ msgs: 0, pending: ["left-behind"] }],
    "exactly ONE follow-up carrying the stranded steer, no duplicates");
});

test("follow-up: allowIdleTurns=false never manufactures a follow-up (buffer waits for the next typed turn)", async () => {
  const bridge: TelegramBridge = { enabled: false, pollLong: async () => null, send: async () => {} };
  let idleCount = 0;
  const driver = new TelegramDriver(
    bridge,
    { onSteer: () => {}, onIdle: async () => { idleCount++; } },
    { allowIdleTurns: false },
  );
  await driver.withTurn(async () => {
    const q = mkQueue();
    driver.attachSteerTarget(q, "run");
    driver.steer("stranded");
    driver.detachSteerTarget();
  });
  await sleep(60);
  assert.equal(idleCount, 0, "one-shot must never manufacture an idle turn");
  assert.equal(driver.pendingSteers(), 1, "the steer stays buffered for the next body to claim");
});

// ── STOP-AND-DRAIN (restart safety) ─────────────────────────────────────────

test("stopAndDrain: stops polling AND waits for the in-flight turn to settle", async () => {
  const bridge: TelegramBridge = {
    enabled: false,
    pollLong: async () => null,
    send: async () => {},
  };
  const driver = new TelegramDriver(bridge, noopHandlers);
  let turnDone = false;
  const turn = driver.withTurn(async () => {
    await sleep(60);
    turnDone = true;
  });
  // Give the turn body a beat to start, then drain from "outside".
  await sleep(10);
  const t0 = Date.now();
  await driver.stopAndDrain();
  const drainedMs = Date.now() - t0;
  await turn;
  assert.equal(turnDone, true, "the turn settled");
  // The drain must have WAITED for the ~50ms the turn had left, not returned
  // instantly (a plain stop() would).
  assert.ok(drainedMs >= 40, `the drain waited for the in-flight turn (${drainedMs}ms)`);
});

test("stopAndDrain: resolves immediately when nothing is in flight", async () => {
  const bridge: TelegramBridge = {
    enabled: false,
    pollLong: async () => null,
    send: async () => {},
  };
  const driver = new TelegramDriver(bridge, noopHandlers);
  const t0 = Date.now();
  await driver.stopAndDrain();
  assert.ok(Date.now() - t0 < 50, "no in-flight turn → the drain resolves fast");
});

// ── BRIDGE ENABLEMENT (helper resolution across skill roots) ────────────────

test("bridge: enabled when the helper is in the USER agent-skills root (the 2026-10-02 case)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  try {
    // Config is MACHINE-LEVEL (~/.tre/telegram.json) — written to the fake
    // home, not the workspace …
    fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
    fs.writeFileSync(path.join(home, ".tre", "telegram.json"), JSON.stringify({ token: "t", chatId: "1" }));
    // … and the helper lives ONLY in the user agent-skills root.
    const helper = path.join(home, ".tre", "agent", "skills", "telegram");
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(helper, "telegram.py"), "# helper\n");

    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, true, "helper in ~/.tre/agent/skills must enable the bridge");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bridge: enabled when the config is in the HOME root even with NO workspace .tre (machine-level, any launch dir)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  try {
    // The workspace has NO .tre at all — the bot is configured once at the
    // machine level and must work from any launch dir.
    fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
    fs.writeFileSync(path.join(home, ".tre", "telegram.json"), JSON.stringify({ token: "t", chatId: "1" }));
    const helper = path.join(home, ".tre", "agent", "skills", "telegram");
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(helper, "telegram.py"), "# helper\n");

    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, true, "machine-level config + helper must enable the bridge from any cwd");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bridge: disabled when the config is missing (even if the helper exists)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  try {
    const helper = path.join(home, ".tre", "agent", "skills", "telegram");
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(helper, "telegram.py"), "# helper\n");
    // No ~/.tre/telegram.json in the fake home (and none in the workspace).
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, false, "no config → disabled");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bridge: disabled when the helper is in NO root (config present)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-en-"));
  try {
    fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
    fs.writeFileSync(path.join(home, ".tre", "telegram.json"), JSON.stringify({ token: "t", chatId: "1" }));
    // No helper anywhere.
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, false, "no helper in any root → disabled");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── main.ts wiring (regression + pure helper) ───────────────────────────────

test("finalAssistantText: returns the last assistant text, empty when none", () => {
  const ctx: AgentMessage[] = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      model: "fake-model",
      provider: "fake",
      content: [{ type: "text", text: "first reply" }],
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "assistant",
      model: "fake-model",
      provider: "fake",
      content: [{ type: "text", text: "  " }, { type: "text", text: "final answer" }],
      stopReason: "stop",
      timestamp: 3,
    },
  ];
  assert.equal(finalAssistantText(ctx), "final answer");
  assert.equal(finalAssistantText([{ role: "user", content: "hi", timestamp: 1 }]), "");
});

async function workspace(): Promise<{ dir: string; models: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-"));
  const models = path.join(dir, "models.json");
  fs.writeFileSync(models, JSON.stringify({ default: MODEL.id, models: [MODEL] }));
  return { dir, models };
}
const mkSinks = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    sinks: {
      // The callback MUST be invoked: main()'s flushSinks awaits write("", cb).
      out: { write: (s: string, cb?: () => void) => { out.push(s); cb?.(); return true; } },
      err: { write: (s: string, cb?: () => void) => { err.push(s); cb?.(); return true; } },
    },
    out,
    err,
  };
};
const pipedStdin = (lines: string[]): NodeJS.ReadableStream => {
  const r = new Readable({ read: () => {} });
  for (const l of lines) r.push(l);
  r.push(null);
  return r;
};

test("regression: one-shot runs and exits 0 when the telegram bridge is DISABLED (no config)", async () => {
  const { dir, models } = await workspace();
  const S = mkSinks();
  const code = await main(["run", "say hello", "--tools", "none", "--models", models, "--cwd", dir], {
    streamFn: fakeStream([{ type: "text", text: "Hello there" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.ok(S.out.join("").includes("Hello there"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("regression: the REPL runs a turn and /quit exits 0 when the bridge is DISABLED", async () => {
  const { dir, models } = await workspace();
  const S = mkSinks();
  const code = await main(["--tools", "none", "--models", models, "--cwd", dir], {
    streamFn: fakeStream([{ type: "text", text: "hi there" }]),
    sinks: S.sinks,
    stdin: pipedStdin(["say hi\n", "/quit\n"]),
  });
  assert.equal(code, 0);
  assert.ok(S.out.join("").includes("hi there"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── main.ts WIRING (D31) ─────────────────────────────────────────────────────
// The tests above cover the driver in isolation; these drive main() itself
// with an injected fake bridge (no network, no machine-level telegram config
// needed). THE GATE: the loop drains the steering queue BEFORE each LLM call,
// so a steer pushed while a turn is open must be IN THE CONTEXT at the next
// stream call — the assertion reads the captured context, not the rendered
// output. Every wait is bounded (waitUntil) so a broken wiring fails loudly
// instead of hanging. The fake poll returns instantly, so the driver's
// min-interval guard paces the loop; deps.telegramDriverOpts lowers it to
// test speed (production keeps the 15s long-poll defaults).

/** A bridge with a wake-able long-poll: pushMessage() either answers the
 *  poll currently blocking (exactly like the real helper returning a message
 *  mid-window) or queues it for the next poll. `pendingDelayMs` adds a real
 *  (macrotask) delay before a QUEUED message is delivered — modeling the
 *  real helper's process spawn, which always lands after the synchronous
 *  driver/turn wiring has settled. `events` records send order (shared with
 *  the stream wrapper to assert turn serialization). */
class GateBridge implements TelegramBridge {
  enabled = true;
  sent: string[] = [];
  pollCount = 0;
  /** Polls that RETURNED a batch (the delivery-observable). */
  delivered = 0;
  private pending: TelegramMessage[][] = [];
  private waiting: ((m: TelegramMessage[] | null) => void) | null = null;
  constructor(
    private readonly pendingDelayMs = 0,
    private readonly events?: string[],
  ) {}
  pushMessage(msg: TelegramMessage): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      this.delivered += 1;
      w([msg]);
      return;
    }
    this.pending.push([msg]);
  }
  async pollLong(timeoutSec: number, signal?: AbortSignal): Promise<TelegramMessage[] | null> {
    this.pollCount += 1;
    if (this.pending.length > 0) {
      const batch = this.pending.shift()!;
      if (this.pendingDelayMs > 0) {
        // A real poll is a process spawn — it never resolves in the same
        // microtask batch as driver.start()/withTurn. The delay models that.
        await sleep(this.pendingDelayMs);
      }
      this.delivered += 1;
      return batch;
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (m: TelegramMessage[] | null): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        this.waiting = null;
        resolve(m);
      };
      const onAbort = (): void => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting = finish;
      // Safety: a bridge that never wakes must not hang the test forever.
      setTimeout(() => finish(null), Math.max(timeoutSec * 1000, 5_000)).unref?.();
    });
  }
  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.events?.push("sent");
  }
}

const TG_MSG = (text: string): TelegramMessage => ({ chatId: "1", sender: "tester", text });

/** Per-stream-call context snapshots (the observable: what the LLM was ABOUT
 *  to see). A drain that works lands the steer in call #2's messages.
 *  `opts.classify` + `opts.order`: also record a labeled ORDER of stream
 *  calls / bridge sends (serialization evidence — e.g. an idle reply must
 *  complete before a user turn's first call). */
function snapshotStream(
  base: ReturnType<typeof fakeStream>,
  opts?: { classify?: (msgs: AgentMessage[]) => string; order?: string[] },
): {
  fn: NonNullable<Parameters<typeof main>[1]>["streamFn"];
  calls: AgentMessage[][];
  releaseGate: () => void;
} {
  const calls: AgentMessage[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let released = false;
  const fn: NonNullable<NonNullable<Parameters<typeof main>[1]>["streamFn"]> = (model, ctx, o) => {
    const msgs = ctx.messages ?? [];
    calls.push([...msgs]);
    if (opts?.classify && opts.order) opts.order.push(opts.classify(msgs));
    const inner = base(model, ctx, o)[Symbol.asyncIterator]();
    if (calls.length === 1 && !released) {
      // Turn 1: emit its first event, then HOLD the turn open (mid-run)
      // until the harness has handed the steer to the driver's poll.
      return (async function* () {
        const first = await inner.next();
        if (!first.done) yield first.value;
        await gate;
        for (;;) {
          const r = await inner.next();
          if (r.done) return;
          yield r.value;
        }
      })();
    }
    return (async function* () {
      for (;;) {
        const r = await inner.next();
        if (r.done) return;
        yield r.value;
      }
    })();
  };
  return {
    fn,
    calls,
    releaseGate: () => {
      released = true;
      release();
    },
  };
}

const hasSteer = (msgs: AgentMessage[], needle: string): boolean =>
  msgs.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(needle));

test("wiring: one-shot — a message arriving MID-RUN steers the loop; nothing is replied via the bot", async () => {
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const bridge = new GateBridge();
    const st = snapshotStream(
      fakeStream([
        { type: "text", text: "first answer" },
        { type: "text", text: "final answer after steer" },
      ]),
    );
    const code = main(
      ["run", "do the thing", "--tools", "none", "--models", models, "--cwd", dir],
      {
        streamFn: st.fn,
        sinks: S.sinks,
        telegramBridge: bridge,
        workerDir: dir,
        telegramDriverOpts: { minIntervalMs: 40, failBaseMs: 10, failCapMs: 50 },
      },
    );
    // 1. The turn must be RUNNING before the message arrives (else one-shot
    //    would correctly drop it) — wait for the first stream call.
    await waitUntil(() => st.calls.length >= 1, 5000, "turn 1 started (stream called)");
    // 2. Push + release in ONE synchronous block: pushMessage resolves the
    //    driver's blocked poll first (its continuation — the onSteer push —
    //    queues before the generator's release continuation), so the steer is
    //    in the queue before the loop drains for call #2.
    bridge.pushMessage(TG_MSG("STEERMARK fold that in"));
    st.releaseGate();
    // 3. GATE: the steer reached the LOOP — it is a user message in the
    //    context of the next LLM call (not merely polled).
    await waitUntil(() => st.calls.length >= 2, 5000, "turn 2 stream call");
    assert.ok(hasSteer(st.calls[1]!, "STEERMARK"), `steer injected into the context (calls: ${st.calls.length})`);
    assert.equal(await code, 0);
    const out = S.out.join("");
    assert.ok(out.includes("final answer after steer"));
    assert.deepEqual(bridge.sent, [], "one-shot never replies via the bot (steer only)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: one-shot — a message already queued at STARTUP (the boot backlog) steers the run", async () => {
  // The user texted while tre. was still booting: the message sits in
  // Telegram's queue BEFORE the driver starts. The first poll round must
  // return it (a real helper answers instantly when updates await —
  // pendingDelayMs models the process spawn so delivery lands AFTER the
  // synchronous start()/withTurn wiring, exactly like the real thing) and
  // steer it into the in-flight run — NOT drop it, NOT start a second run.
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const bridge = new GateBridge(25); // queued messages deliver after ~25ms
    bridge.pushMessage(TG_MSG("STEERMARK queued during boot")); // BEFORE main()
    const st = snapshotStream(
      fakeStream([
        { type: "text", text: "first answer" },
        { type: "text", text: "final answer after backlog steer" },
      ]),
    );
    const code = main(
      ["run", "do the thing", "--tools", "none", "--models", models, "--cwd", dir],
      {
        streamFn: st.fn,
        sinks: S.sinks,
        telegramBridge: bridge,
        workerDir: dir,
        telegramDriverOpts: { minIntervalMs: 40, failBaseMs: 10, failCapMs: 50 },
      },
    );
    await waitUntil(() => st.calls.length >= 1, 5000, "run started (stream called)");
    // Wait for the poll to have DELIVERED the backlog batch (the steer is
    // pushed by the loop in the same continuation), THEN let turn 1 finish.
    await waitUntil(() => bridge.delivered >= 1, 5000, "startup backlog delivered by the first poll");
    st.releaseGate();
    await waitUntil(() => st.calls.length >= 2, 5000, "turn 2 stream call");
    assert.ok(hasSteer(st.calls[1]!, "STEERMARK"), "the boot-time backlog was steered into the run (not dropped)");
    assert.equal(await code, 0);
    assert.ok(S.out.join("").includes("final answer after backlog steer"));
    assert.deepEqual(bridge.sent, [], "one-shot never replies via the bot (steer only)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: REPL — a mid-run message STEERS the user turn (no bot reply); a later /quit exits 0", async () => {
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const bridge = new GateBridge();
    const st = snapshotStream(
      fakeStream([
        { type: "text", text: "first answer" },
        { type: "text", text: "final answer after steer" },
      ]),
    );
    const stdin = new Readable({ read: () => {} });
    stdin.push("do the thing\n");
    const code = main(["--tools", "none", "--models", models, "--cwd", dir], {
      streamFn: st.fn,
      sinks: S.sinks,
      telegramBridge: bridge,
      stdin,
      telegramDriverOpts: { minIntervalMs: 40, failBaseMs: 10, failCapMs: 50 },
    });
    await waitUntil(() => st.calls.length >= 1, 5000, "user turn started");
    bridge.pushMessage(TG_MSG("STEERMARK fold that in"));
    st.releaseGate();
    await waitUntil(() => st.calls.length >= 2, 5000, "turn 2 stream call");
    assert.ok(hasSteer(st.calls[1]!, "STEERMARK"), "telegram steer reached the REPL user turn's context");
    // Close stdin only AFTER the steer round-trip: the REPL then reads /quit.
    stdin.push("/quit\n");
    stdin.push(null);
    assert.equal(await code, 0);
    assert.ok(S.out.join("").includes("final answer after steer"));
    assert.deepEqual(bridge.sent, [], "a steered REPL turn is not replied via the bot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: REPL idle — typed guidance during reply send reaches the queued user turn", async () => {
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const bridge = new GateBridge();
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendEntered = new Promise<void>((resolve) => { sendStarted = resolve; });
    let firstSend = true;
    const actualSend = bridge.send.bind(bridge);
    bridge.send = async (text: string): Promise<void> => {
      if (firstSend) {
        firstSend = false;
        sendStarted();
        await sendGate;
      }
      await actualSend(text);
    };
    const st = snapshotStream(fakeStream([
      { type: "text", text: "first idle reply" },
      { type: "text", text: "user turn reply" },
    ]));
    const stdin = new Readable({ read: () => {} });
    const code = main(["--tools", "none", "--models", models, "--cwd", dir], {
      streamFn: st.fn,
      sinks: S.sinks,
      telegramBridge: bridge,
      stdin,
      telegramDriverOpts: { minIntervalMs: 40, failBaseMs: 10, failCapMs: 50 },
    });
    await waitUntil(() => bridge.pollCount >= 1, 5000, "driver polling started");
    bridge.pushMessage(TG_MSG("initial idle message"));
    // snapshotStream holds the first stream call until the harness releases it.
    await waitUntil(() => st.calls.length >= 1, 5000, "first idle stream call");
    st.releaseGate();
    // Type guidance when the REPL's user-prompt consumer is waiting. It is
    // queued as the user turn behind the idle turn (the serialization
    // contract); then release the turn so the gated reply send is entered.
    stdin.push("USERMARK consume prompt and reserve user turn\n");
    await sendEntered;
    // The second reply-window line must steer into the idle turn, not become
    // the next user prompt.
    stdin.push("STEERMARK replied-window typed guidance during the send\n");
    await waitUntil(() => S.err.join("").includes("steered into the running turn: STEERMARK replied-window typed guidance during the send"), 5000, "reply-window line is steered, not queued as a prompt");
    releaseSend();
    await waitUntil(() => bridge.sent.length >= 1, 8000, "idle turn replied via the bot");
    assert.equal(bridge.sent[0], "first idle reply");
    // Only the reply-window guidance must steer; the reservation line becomes
    // the queued user prompt itself.
    assert.ok(S.err.join("").split("steered into the running turn: ").length - 1 === 1, "exactly one typed line is steered as guidance");
    // The steered guidance must survive detach: the queued user turn claims
    // it from the handoff buffer before its first LLM call.
    await waitUntil(() => st.calls.length >= 2, 8000, "queued user turn consumed the reply-window steer");
    assert.ok(hasSteer(st.calls[1]!, "USERMARK"), "reserved user prompt runs in the follow-up turn");
    assert.ok(hasSteer(st.calls[1]!, "STEERMARK replied-window typed guidance"), "reply-window typed guidance reaches the follow-up user turn context");
    stdin.push("/quit\n");
    stdin.push(null);
    assert.equal(await code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: REPL — a telegram idle-turn and typed input SERIALIZE (never concurrent turns)", async () => {
  // THE SERIALIZATION GATE: a telegram message arrives while the REPL is
  // idle (its onIdle turn starts, holding the driver's turn mutex); a line
  // TYPED at the prompt during that window must WAIT for the idle turn to
  // fully settle — reply sent — before its own first LLM call. The order
  // observable: ["idle" call, "sent", "user" call]. An unserialized wiring
  // would run the user turn against the shared context WHILE the idle turn
  // is still writing to it (its call lands before "sent").
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const order: string[] = [];
    const bridge = new GateBridge(25, order);
    const classify = (msgs: AgentMessage[]): string => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role !== "user" || typeof m.content !== "string") continue;
        if (m.content.includes("USERMARK")) return "user";
        if (m.content.includes("TGIDLEMARK")) return "idle";
      }
      return "other";
    };
    const st = snapshotStream(
      fakeStream([
        { type: "text", text: "Idle reply via bot" },
        { type: "text", text: "User turn reply" },
      ]),
      { classify, order },
    );
    const stdin = new Readable({ read: () => {} });
    const code = main(["--tools", "none", "--models", models, "--cwd", dir], {
      streamFn: st.fn,
      sinks: S.sinks,
      telegramBridge: bridge,
      stdin,
      telegramDriverOpts: { minIntervalMs: 40, failBaseMs: 10, failCapMs: 50 },
    });
    // The telegram message is queued before main(); the FIRST poll delivers
    // it (~25ms) and the idle turn starts — its stream call is held open by
    // the snapshot gate, so the idle turn is verifiably IN FLIGHT below.
    bridge.pushMessage(TG_MSG("TGIDLEMARK hello while idle"));
    await waitUntil(() => st.calls.length >= 1, 5000, "idle turn started (stream called)");
    assert.equal(st.calls[0] && classify(st.calls[0]!), "idle", "the held-open turn is the TELEGRAM idle turn");
    // Type at the prompt WHILE the idle turn holds the mutex.
    stdin.push("USERMARK typed during the idle turn\n");
    // Bounded wait: the user turn must NOT reach the LLM while the idle turn
    // is still open (no second stream call, and no "user" in the order).
    await sleep(80);
    assert.equal(st.calls.length, 1, "the typed line must NOT start a turn while the idle turn is in flight");
    assert.ok(!order.includes("user"), "user turn started before the idle turn settled — turns are NOT serialized");
    // Settle the idle turn: it replies, releases the mutex, THEN the user
    // turn runs.
    st.releaseGate();
    await waitUntil(() => order.includes("sent"), 5000, "idle reply sent");
    await waitUntil(() => order.includes("user"), 5000, "user turn ran after the idle turn settled");
    assert.deepEqual(order, ["idle", "sent", "user"], "idle turn fully settled (reply sent) before the typed line's turn began");
    const userCall = st.calls[1]!;
    assert.ok(hasSteer(userCall, "USERMARK"), "the typed line ran as its own turn");
    stdin.push("/quit\n");
    stdin.push(null);
    assert.equal(await code, 0);
    const out = S.out.join("");
    assert.ok(out.includes("Idle reply via bot"), "the idle reply was printed");
    assert.ok(out.includes("User turn reply"), "the user turn was printed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── R4-R2: one-shot exit-130 cancellation wiring (main-level) ──────────────
// F2 changed the ONE-SHOT contract: a lifecycle stop() that races startup
// cancels the reserved-but-unstarted turn body (driver.withTurn resolves
// undefined) and main() must map that to exit 130 with an "aborted" worker
// status — NOTHING ran and NOTHING is replied via the bot. The driver-level
// cancellation is pinned above (test "F2: stop() cancels a reserved-but-
// unstarted body…"); this is the main()-level regression for that wiring
// (audit round-4 recommendation R2): the telegramDriverHook seam holds the
// driver's turn mutex BEFORE main() reserves its body, so the body is
// certainly parked (reserved, unstarted) when the test's stop() fires — no
// timer-order dependency.

test("R4-R2: main() one-shot — stop() racing startup exits 130, body never runs, nothing replied", async () => {
  const { dir, models } = await workspace();
  try {
    const S = mkSinks();
    const sent: string[] = [];
    const bridge: TelegramBridge = {
      enabled: true,
      pollLong: (_timeoutSec: number, signal?: AbortSignal) =>
        new Promise<null>((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        }),
      send: async (text: string) => {
        sent.push(text);
      },
    };
    let blockerRelease!: () => void;
    const blockerGate = new Promise<void>((r) => (blockerRelease = r));
    let blockerStarted = false;
    let streamCalls = 0;
    const base = fakeStream([{ type: "text", text: "must never run" }]);
    const streamFn: NonNullable<Parameters<typeof main>[1]>["streamFn"] = (model, ctx, o) => {
      streamCalls += 1;
      return base(model, ctx, o);
    };
    let driverRef: TelegramDriver | undefined;
    const codeP = main(
      ["run", "the prompt", "--tools", "none", "--models", models, "--cwd", dir],
      {
        streamFn,
        sinks: S.sinks,
        telegramBridge: bridge,
        workerDir: dir,
        telegramDriverOpts: { minIntervalMs: 20, failBaseMs: 10, failCapMs: 50 },
        telegramDriverHook: (driver) => {
          // Reserve the mutex from INSIDE the driver BEFORE main() calls
          // its own withTurn — main()'s body parks behind this one.
          void driver.withTurn(async () => {
            blockerStarted = true;
            await blockerGate;
          });
          driverRef = driver;
        },
      },
    );
    await waitUntil(() => blockerStarted, 5000, "blocker holds the mutex (main's turn is parked)");
    assert.equal(streamCalls, 0, "main's body is still parked — the stream was never called");
    // Lifecycle stop while main()'s body is reserved-but-unstarted:
    driverRef!.stop();
    blockerRelease(); // release the mutex so main's parked body resumes into the stop check
    const code = await codeP;
    assert.equal(code, 130, "the cancelled one-shot exits 130 (nothing ran, no outcome)");
    assert.equal(streamCalls, 0, "the cancelled body never reached the LLM");
    assert.equal(sent.length, 0, "nothing was replied via the bot");
    assert.equal(S.out.join(""), "", "nothing was printed to stdout");
    // The worker registry records the abort (status "failed" / activity
    // "aborted") — this is the branch F2 added for one-shot visibility.
    const workers = readWorkerStatuses(dir);
    assert.equal(workers.length, 1, "exactly the one-shot worker entry");
    assert.equal(workers[0]!.status, "failed");
    assert.equal(workers[0]!.activity, "aborted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
