/**
 * C25 — perf-entry sweep tests.
 *
 * React's DEV build calls performance.measure() for every component render
 * and Node keeps those entries in an unbounded buffer (the 40MB/turn heap
 * growth behind the 2GB OOM crash). The sweep must clear the buffer and the
 * interval wrapper must start/stop cleanly.
 *
 * Note: `performance` is a process-global and node:test itself may create
 * timing entries, so the assertions check for OUR planted entries by name
 * rather than an absolute buffer count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepPerfEntries, startPerfEntrySweep } from "../src/tui/perf-sweep.js";

function planted(): PerformanceEntry[] {
  return performance
    .getEntries()
    .filter((e) => e.name.startsWith("c25-"));
}

test("sweepPerfEntries: clears marks and measures from the buffer", () => {
  performance.mark("c25-mark-a");
  performance.mark("c25-mark-b");
  performance.measure("c25-measure", "c25-mark-a", "c25-mark-b");
  assert.equal(planted().length, 3, "planted entries must be in the buffer");

  sweepPerfEntries();

  assert.equal(planted().length, 0, "planted entries must be gone after the sweep");
});

test("sweepPerfEntries: is a no-op on an already-empty buffer", () => {
  sweepPerfEntries(); // must not throw
  assert.equal(planted().length, 0);
});

test("startPerfEntrySweep: clears entries that arrive while running, stop halts it", async () => {
  const stop = startPerfEntrySweep(20);
  try {
    // Entries planted AFTER the start get swept while the interval is live.
    performance.mark("c25-late-mark");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      planted().length,
      0,
      "live sweep must clear entries planted after start",
    );
  } finally {
    stop();
  }

  // After stop, the buffer is no longer swept.
  performance.mark("c25-post-stop");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    planted().length,
    1,
    "entries planted after stop must remain (sweep halted)",
  );
  sweepPerfEntries(); // clean up for other tests in this file
});

test("startPerfEntrySweep: stop is idempotent", () => {
  const stop = startPerfEntrySweep(20);
  stop();
  assert.doesNotThrow(() => stop());
});
