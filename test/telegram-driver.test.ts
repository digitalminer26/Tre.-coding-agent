/**
 * Background Telegram driver (plain CLI) — loop prevention + routing.
 *
 * The CORE of this feature is that the background poll loop CANNOT hot-spin:
 * a naive `while (true) { poll(); }` spins hundreds of times/second when a
 * poll fails fast (network down, bad token). These tests prove the three
 * loop-prevention mechanisms (long-poll self-pacing, the min-interval hard
 * cap, and capped exponential backoff on failure) with a FAKE bridge (no
 * network, controlled timing) plus the steer-vs-idle routing and the turn
 * mutex. The main.ts wiring is covered by the regression tests at the bottom
 * (the no-telegram path must be unchanged).
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
