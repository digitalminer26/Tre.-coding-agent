/**
 * C29 — follow-up to C25: make the DEV React reconciler stop creating
 * User-Timing entries at the ROOT, not just sweeping them 5s at a time.
 *
 * C25 found that React 19's DEV reconciler (ink loads it whenever
 * NODE_ENV is unset) calls `performance.measure()` once per component
 * render, and Node keeps those PerformanceMeasure objects until cleared —
 * the first OOM. The sweep (perf-sweep.ts) bounds the buffer to
 * RATE × 5s. That bound is fine at C25's measured rate (~450
 * measures/s → a few MB), but the rate scales with renders/s: a dense
 * streaming reply re-renders the visible tree on every token delta
 * (~40 renders/s × ~400 components = ~16,000 measures/s), so the
 * between-sweep buffer peaked at 78,000+ entries / ~700 MB RSS — and
 * triple the rate (faster model, larger terminal) crosses Node's ~2 GB
 * heap limit BETWEEN sweeps: the same "Ineffective mark-compacts near
 * heap limit" OOM.
 *
 * The DEV reconciler gates the whole feature on ONE check at module
 * init:
 *
 *     supportsUserTiming =
 *       typeof console.timeStamp === "function" &&
 *       typeof performance.clearMarks === "function" &&
 *       typeof performance.clearMeasures === "function"
 *
 * Node's `console.timeStamp` is a documented no-op (it exists for
 * browser API compatibility — nothing in Node or in this stack ever
 * reads it), so removing it flips `supportsUserTiming` to false and the
 * reconciler never calls `performance.measure` at all. Zero per-frame
 * cost, no NODE_ENV change (so spawned children — builds, tests, shells
 * — inherit the user's environment untouched), and React stays in DEV
 * mode (its useful error messages and devtools hooks are preserved).
 *
 * ORDERING: this module's side effect MUST run before `ink` is linked.
 * main.ts imports it statically next to terminal-size-fix.js; ink itself
 * is only linked later, via the dynamic `await import("../tui/run.js")`
 * in the TUI branch (see the C23 note there). The C25 sweep is kept as
 * a backstop for anything else that ever writes User-Timing entries.
 */

/** Remove `console.timeStamp` so the DEV reconciler disables User-Timing. */
export function disableReactUserTiming(): void {
  if (typeof console.timeStamp === "function") {
    // Configurable on Node (verified); fall back to assignment in case a
    // future runtime makes it non-configurable. (Cast to an optional member:
    // `delete` requires an optional operand — TS2790 — and the lib types
    // console.timeStamp as a non-optional method.)
    try {
      delete (console as unknown as { timeStamp?: unknown }).timeStamp;
    } catch {
      (console as unknown as { timeStamp?: unknown }).timeStamp = undefined;
    }
  }
}

// Side effect on import — see the ordering note above.
disableReactUserTiming();
