/**
 * The elapsed-time ticker (src/tui/elapsed-ticker.ts): the arm/stop/tick
 * contract of the header's 1s elapsed clock. The clock is ARMED on a run's
 * agent_start and STOPPED on its agent_end — while idle there is no pending
 * timer at all. Fake timers drive the ticks (no real 1s waits).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeElapsedTicker } from "../src/tui/elapsed-ticker.js";

/** A minimal fake timer: records scheduled callbacks, fires them on demand. */
function makeFakeTimers() {
  let nextId = 1;
  const scheduled: Map<number, { cb: () => void; ms: number; cleared: boolean; fired: boolean }> =
    new Map();
  const setTimeout = (cb: () => void, ms: number): number => {
    const id = nextId++;
    scheduled.set(id, { cb, ms, cleared: false, fired: false });
    return id;
  };
  const clearTimeout = (id: unknown): void => {
    const s = scheduled.get(id as number);
    if (s) s.cleared = true;
  };
  /** Fire all pending (uncleared) callbacks, in schedule order. */
  const tick = (): number => {
    let fired = 0;
    for (const s of [...scheduled.values()]) {
      if (!s.cleared && !s.fired) {
        s.fired = true;
        s.cb();
        fired++;
      }
    }
    return fired;
  };
  /** Number of live (uncleared, unfired) pending timers. */
  const pending = (): number =>
    [...scheduled.values()].filter((s) => !s.cleared && !s.fired).length;
  return { setTimeout, clearTimeout, tick, pending };
}

test("ticker: idle (never armed) — no pending timer, nothing ever fires", () => {
  const ft = makeFakeTimers();
  let paints = 0;
  const t = makeElapsedTicker({
    shouldPaint: () => true,
    paint: () => paints++,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  assert.equal(t.armed(), false);
  assert.equal(ft.pending(), 0, "no timer while idle");
  ft.tick();
  assert.equal(paints, 0);
});

test("ticker: arm → one pending 1s timer; each tick repaints and re-arms", () => {
  const ft = makeFakeTimers();
  let paints = 0;
  const t = makeElapsedTicker({
    shouldPaint: () => true,
    paint: () => paints++,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  t.arm();
  assert.equal(t.armed(), true);
  assert.equal(ft.pending(), 1, "exactly one pending timer while armed");
  ft.tick();
  assert.equal(paints, 1, "the tick painted");
  assert.equal(ft.pending(), 1, "re-armed after the tick");
  ft.tick();
  ft.tick();
  assert.equal(paints, 3, "keeps ticking every second");
});

test("ticker: paint fires only when shouldPaint() is true (idle busy=false → no repaint)", () => {
  const ft = makeFakeTimers();
  let busy = true;
  let paints = 0;
  const t = makeElapsedTicker({
    shouldPaint: () => busy,
    paint: () => paints++,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  t.arm();
  ft.tick();
  assert.equal(paints, 1);
  busy = false; // the run ended but agent_end was missed for a beat — the tick must not repaint
  ft.tick();
  assert.equal(paints, 1, "no repaint while shouldPaint is false");
});

test("ticker: stop cancels the pending timer; a stray callback cannot re-arm", () => {
  const ft = makeFakeTimers();
  let paints = 0;
  const t = makeElapsedTicker({
    shouldPaint: () => true,
    paint: () => paints++,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  t.arm();
  t.stop();
  assert.equal(t.armed(), false);
  assert.equal(ft.pending(), 0, "stop clears the pending timer");
  ft.tick(); // fire anything that was still scheduled
  assert.equal(paints, 0, "the stray callback is a no-op (generation check)");
  assert.equal(ft.pending(), 0, "…and it did not re-arm");
});

test("ticker: arm is idempotent (a second arm does not stack timers)", () => {
  const ft = makeFakeTimers();
  const t = makeElapsedTicker({
    shouldPaint: () => true,
    paint: () => {},
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  t.arm();
  t.arm();
  assert.equal(ft.pending(), 1, "still exactly one pending timer");
  t.stop();
});

test("ticker: re-arm after stop works (a new run after the previous one ended)", () => {
  const ft = makeFakeTimers();
  let paints = 0;
  const t = makeElapsedTicker({
    shouldPaint: () => true,
    paint: () => paints++,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  t.arm();
  ft.tick();
  t.stop();
  t.arm(); // the next run
  assert.equal(ft.pending(), 1);
  ft.tick();
  assert.equal(paints, 2);
});
