/**
 * The TUI header's elapsed-time ticker (used by run.tsx): a 1s repaint
 * loop that is ARMED on a run's `agent_start` and STOPPED on its
 * `agent_end` — while idle there is no pending timer at all. Only real
 * runs arm it: a manual `/compact` emits no agent_start/agent_end
 * (compactNow yields only compaction events), so it never touches the
 * clock.
 *
 * Why a tick at all: stream events repaint continuously while the model
 * streams, but a LONG TOOL CALL (bash can run minutes) emits no stream
 * events — without a tick the elapsed clock would freeze mid-run. The
 * repaint is a fresh state reference (the router no-ops on an identical
 * reference, and the elapsed value is computed at RENDER time —
 * `Date.now()` in app.tsx — so a fresh reference with identical data is
 * exactly what forces the repaint).
 *
 * Extracted from run.tsx as a small factory so the arm/stop/tick contract
 * is unit-testable without mounting the whole TUI (fake timers). The
 * generation counter makes a stray callback (scheduled before a stop,
 * fired after it) a no-op — it can never re-arm a stopped ticker.
 */
export interface ElapsedTickerDeps {
  /** Whether a repaint is needed right now (busy + a run in flight). */
  shouldPaint: () => boolean;
  /** Fire a repaint (a fresh state reference in run.tsx). */
  paint: () => void;
  /** Injectable for tests (fake timers); defaults to the globals. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export interface ElapsedTicker {
  /** Start the 1s loop (idempotent — a second arm is a no-op). */
  arm: () => void;
  /** Cancel the loop; a stray in-flight callback becomes a no-op. */
  stop: () => void;
  /** True while a tick is pending (tests assert the idle state has none). */
  armed: () => boolean;
}

export function makeElapsedTicker(deps: ElapsedTickerDeps, tickMs = 1000): ElapsedTicker {
  const setT = deps.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT = deps.clearTimeout ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  let timer: unknown;
  let gen = 0;
  const arm = (): void => {
    if (timer !== undefined) return; // already armed (idempotent)
    const myGen = ++gen;
    timer = setT(() => {
      timer = undefined; // this tick has fired — allow re-arming
      if (gen !== myGen) return; // stopped since this tick was scheduled
      if (deps.shouldPaint()) deps.paint();
      arm(); // re-arm while alive; stop() ends the chain
    }, tickMs);
    (timer as { unref?: () => void })?.unref?.(); // never keeps the process alive
  };
  const stop = (): void => {
    gen++; // invalidate any in-flight callback
    if (timer !== undefined) {
      clearT(timer);
      timer = undefined;
    }
  };
  return { arm, stop, armed: () => timer !== undefined };
}
