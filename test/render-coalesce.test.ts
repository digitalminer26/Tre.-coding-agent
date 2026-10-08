/**
 * Render coalescing (the "stuck loop freezes the TUI" fix) — timing
 * semantics of makeRenderCoalescer, with an injected clock and timers.
 *
 * Contract: state updates are immediate (the driver's job); the PAINT is
 * coalesced to at most one render per window. Steady high-frequency events
 * (streamed deltas, ~100/s) must produce ~1 render per window (~30/s),
 * sparse events must paint immediately (zero added latency), and
 * paintNow/cancel must behave for the interactive + unmount paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRenderCoalescer, makeStateUpdateRouter } from "../src/tui/render-coalesce.js";

test("driver routes stream callback to coalescer and interactive callback paints immediately", () => {
  const ft = makeFakeTimers();
  let current = 0;
  let output = "initial";
  let paints = 0;
  const coalescer = makeRenderCoalescer({
    windowMs: 33,
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
    paint: () => { paints++; output = `painted:${current}`; },
  });
  // This is the same state-update router wiring used by runTui: synthetic
  // stream and input callbacks enter through their respective driver routes.
  const route = makeStateUpdateRouter({
    getState: () => current,
    setState: (value: number) => { current = value; },
    schedule: () => coalescer.schedule(),
    paintNow: () => coalescer.paintNow(),
  });
  const onStream = (value: number): void => route.stream(value);
  const onInteractiveInput = (value: number): void => route.interactive(value);
  onStream(1); // first stream paint is immediate
  ft.advance(5);
  onStream(2); // stream update is deferred/coalesced
  assert.equal(paints, 1);
  onInteractiveInput(3); // must cancel defer and paint synchronously
  assert.equal(paints, 2);
  assert.equal(output, "painted:3");
  assert.equal(ft.pending(), 0);
  ft.advance(100);
  assert.equal(paints, 2);
});

interface FakeTimers {
  now(): number;
  advance(ms: number): void;
  pending(): number;
  queue: Array<{ at: number; fn: () => void; id: number }>;
  setTimeout(fn: () => void, ms?: number): number;
  clearTimeout(id: unknown): void;
}

/** Deterministic clock + timer queue (no real waiting). */
function makeFakeTimers(): FakeTimers {
  let t = 0;
  let nextId = 1;
  const queue: Array<{ at: number; fn: () => void; id: number }> = [];
  return {
    now: () => t,
    advance(ms: number): void {
      const target = t + ms;
      for (;;) {
        const due = queue
          .filter((q) => q.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        queue.splice(queue.indexOf(due), 1);
        t = due.at;
        due.fn();
      }
      t = target;
    },
    pending: () => queue.length,
    queue,
    setTimeout: (fn: () => void, ms?: number): number => {
      const id = nextId++;
      queue.push({ at: t + (ms ?? 0), fn, id });
      return id;
    },
    clearTimeout: (id: unknown): void => {
      const i = queue.findIndex((q) => q.id === id);
      if (i !== -1) queue.splice(i, 1);
    },
  };
}

function makeCoalescer(windowMs = 33) {
  const ft = makeFakeTimers();
  let paints = 0;
  const c = makeRenderCoalescer({
    paint: () => {
      paints++;
    },
    windowMs,
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  return { c, ft, paints: () => paints };
}

test("coalescer: the first event paints immediately (zero added latency)", () => {
  const { c, paints } = makeCoalescer();
  c.schedule();
  assert.equal(paints(), 1);
});

test("coalescer: a steady 100 deltas/s stream becomes ~30 renders/s", () => {
  const { c, ft, paints } = makeCoalescer(33);
  // One second of deltas at 100/s (10ms apart), as a stuck agent loop
  // produces. The old code painted on EVERY delta (100 paints/s); the
  // coalescer must paint at most once per 33ms window.
  for (let i = 0; i < 100; i++) {
    c.schedule();
    ft.advance(10);
  }
  const perSecond = paints();
  assert.ok(
    perSecond <= 40,
    `expected ≤40 paints/s (one per window + margin), got ${perSecond}`,
  );
  assert.ok(
    perSecond >= 25,
    `expected ≥25 paints/s (the stream must stay visible), got ${perSecond}`,
  );
});

test("coalescer: slow paints start a fresh window after completion", () => {
  const ft = makeFakeTimers();
  let paints = 0;
  const c = makeRenderCoalescer({
    windowMs: 33, now: ft.now, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout,
    paint: () => { paints++; ft.advance(40); },
  });
  c.schedule(); // paint consumes 40ms
  c.schedule(); // must defer, not chain synchronously
  assert.equal(paints, 1);
  assert.equal(ft.pending(), 1);
  ft.advance(33);
  assert.equal(paints, 2);
});

test("coalescer: sparse events paint immediately (no window wait)", () => {
  const { c, ft, paints } = makeCoalescer(33);
  c.schedule(); // t=0 → immediate
  assert.equal(paints(), 1);
  ft.advance(40); // window elapsed
  c.schedule(); // a lone late delta / keystroke → immediate, NOT deferred
  assert.equal(paints(), 2);
  assert.equal(ft.pending(), 0);
});

test("coalescer: deferred paint fires exactly once at the window's end", () => {
  const { c, ft, paints } = makeCoalescer(33);
  c.schedule(); // t=0 → immediate
  ft.advance(10);
  c.schedule(); // inside the window → deferred, fires at t=33 (window end)
  ft.advance(9); // t=19 — still inside the window
  assert.equal(paints(), 1);
  ft.advance(14); // t=33 → the deferred paint fires
  assert.equal(paints(), 2);
  assert.equal(ft.pending(), 0);
});

test("coalescer: paintNow cancels the pending deferred paint", () => {
  const { c, ft, paints } = makeCoalescer(33);
  c.schedule(); // immediate
  ft.advance(10);
  c.schedule(); // deferred
  c.paintNow(); // interactive path (a keystroke) — paint + cancel
  assert.equal(paints(), 2);
  ft.advance(100);
  assert.equal(paints(), 2); // the cancelled timer must not fire
});

test("coalescer: cancel drops the pending paint (unmount)", () => {
  const { c, ft, paints } = makeCoalescer(33);
  c.schedule(); // immediate
  ft.advance(10);
  c.schedule(); // deferred
  c.cancel();
  ft.advance(1000);
  assert.equal(paints(), 1); // nothing fired after cancel
});

test("coalescer: the default window is ~33ms (30fps)", () => {
  const ft = makeFakeTimers();
  let count = 0;
  const paints = (): number => count;
  const c = makeRenderCoalescer({
    paint: () => {
      count++;
    },
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
  });
  c.schedule();
  ft.advance(16);
  c.schedule(); // inside the default window → deferred
  assert.equal(paints(), 1);
  ft.advance(20); // t=36 ≥ 33 → fired
  assert.equal(paints(), 2);
});
