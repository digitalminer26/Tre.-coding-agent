/**
 * C29 note: since prod-env.ts removes console.timeStamp before the DEV
 * reconciler loads, the reconciler no longer creates these entries at all
 * (the root fix). This sweep is kept as a BACKSTOP for anything else that
 * writes User-Timing entries into the buffer.
 *
 * C25 — OOM fix: sweep React's User-Timing entries out of Node's
 * performance buffer.
 *
 * Why this exists (root cause of the 2GB heap crash):
 *  - The DEV build of react-reconciler (what ink runs under) calls
 *    `performance.measure(name, { start, end, detail: { devtools: { track,
 *    color, tooltipText, properties } } })` for EVERY component
 *    mount/update/render/effect — one entry per component per render.
 *  - Node keeps User-Timing marks/measures in an UNBOUNDED buffer
 *    (nothing prunes it; `performance.getEntries()` grows forever).
 *  - A TUI re-renders constantly (every streamed token, every keystroke),
 *    so entries accumulated ~450/s — each holding strings (component names,
 *    tooltip text) plus a detail object — the heap grew ~40MB per agent
 *    turn and long sessions died with "JavaScript heap out of memory"
 *    (confirmed live: a 10-minute tre session held ~600k entries; the
 *    crashed child held the same `track`/`color`/`tooltipText` strings in
 *    its 3.3GB heap snapshot).
 *
 * The sweep is safe: nothing in tre (or ink) ever reads these entries back —
 * they exist only for browser DevTools, which is not present in a TUI.
 * Production React builds create no entries, so in production the sweep is a
 * cheap no-op.
 */

/** Clear all User-Timing marks and measures from the performance buffer. */
export function sweepPerfEntries(): void {
  performance.clearMeasures();
  performance.clearMarks();
}

/**
 * Start a periodic sweep of the performance buffer.
 *
 * @param intervalMs sweep period; default 5s — at tre's observed entry
 *   rate (~450/s) that bounds the buffer to a few thousand entries (~a few MB)
 *   no matter how long the session runs.
 * @returns a stop function (clears the interval). The timer is unref'd so it
 *   never keeps the process alive on its own.
 */
export function startPerfEntrySweep(intervalMs: number = 5000): () => void {
  const id = setInterval(() => {
    sweepPerfEntries();
  }, intervalMs);
  if (typeof id.unref === "function") id.unref();
  return () => clearInterval(id);
}
