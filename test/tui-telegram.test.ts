/**
 * TUI telegram bridge (src/tui/telegram.ts) — the 2026-10-03 "bare
 * `Command failed:` with no detail" fix.
 *
 * Two regressions are pinned:
 *   1. A helper failure must surface the helper's STDERR (its die()
 *      messages, urllib tracebacks) in the thrown error — previously the
 *      bridge only destructured `{ stdout }`, so the driver logged
 *      `telegram poll error: Error: Command failed: python3 … poll` with
 *      zero diagnostics.
 *   2. The hard cap per helper call is a BACKSTOP above the helper's own
 *      worst case (60s HTTP read + a 429 `retry_after` sleep), not the
 *      15s poll cadence — a cap below that killed the helper on every slow
 *      response / rate limit. A timeout-kill must name itself in the error.
 *
 * The helper is a FAKE (a real `python3` script) placed in the PROJECT skill
 * root (`<cwd>/.tre/skills/telegram/telegram.py`) — the resolver probes
 * project before user, so the real `~/.tre/agent/skills` is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeTelegramBridge,
  TELEGRAM_TIMEOUT_MS,
  TELEGRAM_POLL_MS,
} from "../src/tui/telegram.js";
import { steerTelegramBatch, steerTelegramBusy } from "../src/tui/run.js";
import { makeInitialState } from "../src/tui/state.js";
import type { TuiState } from "../src/tui/state.js";
import type { SteeringQueue } from "../src/loop/agent-loop.js";

function setup(): { cwd: string; home: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-tui-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-tui-home-"));
  // Config (enables the bridge) is MACHINE-LEVEL (~/.tre/telegram.json) —
  // written to the fake home, not the workspace. The fake helper lives in
  // the PROJECT skill root.
  fs.mkdirSync(path.join(cwd, ".tre", "skills", "telegram"), { recursive: true });
  fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".tre", "telegram.json"),
    JSON.stringify({ token: "test-token", chatId: "0" }),
  );
  const helper = path.join(cwd, ".tre", "skills", "telegram", "telegram.py");
  const cleanup = (): void => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { cwd, home, cleanup };
}

test("default cap clears the helper's worst case (60s HTTP + 60s 429 sleep)", () => {
  // The helper's HTTP read timeout is 60s and a 429 makes it sleep the full
  // retry_after (up to 60s) before retrying once — the cap must exceed that,
  // or every slow response / rate limit kills the helper mid-flight.
  assert.ok(
    TELEGRAM_TIMEOUT_MS >= 135_000,
    `TELEGRAM_TIMEOUT_MS is ${TELEGRAM_TIMEOUT_MS} — must clear 60+60s + margin`,
  );
  // The cap is a backstop, not the pacing: the cadence stays 15s.
  assert.equal(TELEGRAM_POLL_MS, 15_000);
});

test("helper failure surfaces its stderr in the error (no bare Command failed)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    // A helper that fails the way the real one does: die() → stderr + exit 1.
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nimport sys\n" +
        "print('telegram: HTTP Error 429: Too Many Requests', file=sys.stderr)\n" +
        "sys.exit(1)\n",
    );
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, true);
    let err: unknown;
    try {
      await bridge.poll();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "poll() must throw on helper failure");
    const msg = (err as Error).message;
    assert.match(msg, /Command failed/, "keeps the execFile base message");
    assert.match(msg, /HTTP Error 429/, "helper stderr is included");
  } finally {
    cleanup();
  }
});

test("a timeout-kill is named in the error (cap + likely cause)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    // A helper that outlives the (injected, short) cap.
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n",
    );
    const bridge = makeTelegramBridge(cwd, home, 500); // 0.5s cap for the test
    let err: unknown;
    try {
      await bridge.poll();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "poll() must throw on timeout-kill");
    const msg = (err as Error).message;
    assert.match(msg, /killed at the 1s cap/, "the kill + cap value are named");
    assert.match(msg, /429 retry_after|slow Telegram/, "the likely cause is named");
  } finally {
    cleanup();
  }
});

test("a clean poll still returns null (no regression on the happy path)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nprint('telegram: no new messages')\n",
    );
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(await bridge.poll(), null);
  } finally {
    cleanup();
  }
});

// D25 (deferred item) — the TUI poller no longer early-returns while a run is
// in flight; the busy branch steers the polled batch into the active run's
// SteeringQueue. The steer decision is the pure `steerTelegramBatch` helper
// (extracted from the telegramTick closure so it is unit-testable without a
// full TUI render). These pin its contract: it builds the `[telegram from
// <sender>] <text>` prompts, pushes each to the queue, and returns them (the
// caller appends them to the visible items + the info line).
test("steerTelegramBatch: builds [telegram from <sender>] <text> prompts, pushes each, returns them", () => {
  const pushed: string[] = [];
  const msgs: [string, string, string][] = [
    ["chat1", "Alice", "hello"],
    ["chat2", "Bob", "second message"],
  ];
  const returned = steerTelegramBatch(msgs, (p) => pushed.push(p));
  assert.deepEqual(pushed, [
    "[telegram from Alice] hello",
    "[telegram from Bob] second message",
  ]);
  // The returned prompts are the SAME strings that were pushed (the caller
  // appends these to the visible items).
  assert.deepEqual(returned, pushed);
});

test("steerTelegramBatch: an empty batch pushes nothing and returns [] (no spurious steer/info)", () => {
  const pushed: string[] = [];
  const returned = steerTelegramBatch([], (p) => pushed.push(p));
  assert.deepEqual(pushed, []);
  assert.deepEqual(returned, []);
});

test("steerTelegramBatch: is pure (no I/O, no state mutation) — the queue callback is the only side channel", () => {
  // The helper takes the push callback as a parameter (it never touches a
  // shared queue) and returns a fresh array each call — two calls with the
  // same input are independent.
  const a: string[] = [];
  const b: string[] = [];
  const msgs: [string, string, string][] = [["c", "S", "t"]];
  const r1 = steerTelegramBatch(msgs, (p) => a.push(p));
  const r2 = steerTelegramBatch(msgs, (p) => b.push(p));
  assert.deepEqual(a, ["[telegram from S] t"]);
  assert.deepEqual(b, ["[telegram from S] t"]);
  assert.deepEqual(r1, r2);
  // The input array is not mutated.
  assert.deepEqual(msgs, [["c", "S", "t"]]);
});

// D25 — the BUSY-branch wiring (the part the earlier tests did NOT cover):
// a message polled while a run is in flight must be steered into the ACTIVE
// SteeringQueue AND surfaced as visible items + an info line, in one atomic
// state update. `steerTelegramBusy` is the pure decision extracted from the
// `telegramTick` closure, so it can be driven directly without a full TUI render.
function fakeQueue(): SteeringQueue & { pushed: string[] } {
  const pushed: string[] = [];
  return { pushed, push: (p: string) => pushed.push(p), drain: () => [] };
}
function busyState(): TuiState {
  return { ...makeInitialState("m"), busy: true, items: [{ kind: "user", text: "original prompt" }] };
}

test("steerTelegramBusy: steers the batch into the active queue AND appends items + info line", () => {
  const queue = fakeQueue();
  const state = busyState();
  const msgs: [string, string, string][] = [
    ["chat1", "Alice", "hello"],
    ["chat2", "Bob", "second"],
  ];
  const next = steerTelegramBusy(state, msgs, queue);
  assert.ok(next, "a non-empty batch returns a new state");
  // The messages were pushed to the ACTIVE steering queue (drained before the
  // next LLM call) in the [telegram from <sender>] <text> form.
  assert.deepEqual(queue.pushed, ["[telegram from Alice] hello", "[telegram from Bob] second"]);
  // The returned state appends the prompts as visible user items + the info
  // line, preserving the existing items and keeping busy true.
  assert.equal(next!.items.length, state.items.length + 3, "2 user items + 1 info line appended");
  assert.deepEqual(next!.items[state.items.length], { kind: "user", text: "[telegram from Alice] hello" });
  assert.deepEqual(next!.items[state.items.length + 1], { kind: "user", text: "[telegram from Bob] second" });
  assert.deepEqual(next!.items[state.items.length + 2], {
    kind: "info",
    text: "telegram: 2 message(s) steered into the running turn",
  });
  assert.equal(next!.busy, true, "the run is still busy after steering");
  // The original items are preserved (not replaced).
  assert.deepEqual(next!.items[0], { kind: "user", text: "original prompt" });
});

test("steerTelegramBusy: an empty batch is a no-op (null — no steer, no items, no info line)", () => {
  const queue = fakeQueue();
  const state = busyState();
  const next = steerTelegramBusy(state, [], queue);
  assert.equal(next, null, "empty batch → null (the caller returns without updating state)");
  assert.deepEqual(queue.pushed, [], "nothing is pushed to the queue");
  // The state is untouched (no spurious `0 message(s) steered` info line).
  assert.equal(state.items.length, 1);
});

test("steerTelegramBusy: is pure w.r.t. the state (returns a NEW state; the input is not mutated)", () => {
  const queue = fakeQueue();
  const state = busyState();
  const before = state.items.length;
  const msgs: [string, string, string][] = [["c", "S", "t"]];
  const next = steerTelegramBusy(state, msgs, queue);
  assert.notEqual(next, state, "returns a distinct state object");
  assert.equal(state.items.length, before, "the input state's items are not mutated");
  assert.equal(next!.items.length, before + 2, "the new state has the appended items");
});
