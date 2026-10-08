/**
 * Render coalescing for the TUI driver — the "stuck loop freezes the TUI"
 * fix.
 *
 * Why: every streamed delta used to trigger a FULL synchronous Ink
 * re-render (state apply + visible-window re-wrap + React reconcile +
 * terminal paint), up to ~100 times a second. Each render re-wraps the
 * visible window, and in a tool-loop session that window is hundreds of KB
 * of history — the main thread was saturated (measured: re-wrapping a 60KB
 * streaming item alone takes ~8ms; ×100 deltas/s = the event loop is >100%
 * busy). In raw mode Ctrl-C is just a stdin BYTE, so a saturated loop means
 * neither typing nor the abort key ever reaches a handler — the terminal
 * looks "frozen" and the user cannot interrupt a stuck agent.
 *
 * What: stream paints are coalesced — at most one render per `windowMs`.
 * The first event paints immediately; events inside the window fold into
 * one deferred paint. Paint duration counts toward the next window, preventing
 * slow paints from chaining synchronously and starving input. A steady
 * 100 deltas/s becomes ~30 renders/s. Sparse events (a single late delta,
 * a keystroke after a quiet period) paint immediately because the window
 * has already elapsed. Interactive paths never wait more than one window
 * (~33ms, below the human perception threshold for input response).
 *
 * Pure and timer-injectable so the timing semantics are unit-testable
 * (test/render-coalesce.test.ts); the driver wires it in src/tui/run.tsx.
 */
export interface RenderCoalescer {
  /**
   * Schedule a paint: immediate when the coalescing window has elapsed
   * since the last paint, otherwise deferred to the window's end (the
   * first deferred call owns the timer; later calls in the same window
   * are no-ops — they only update state, which the driver does itself).
   */
  schedule(): void;
  /** Paint right now, cancelling any pending deferred paint. */
  paintNow(): void;
  /** Drop any pending deferred paint (e.g. on unmount). */
  cancel(): void;
}

export interface InputTransitions<T> {
  char(s: T, ch: string): T;
  backspace(s: T): T;
  move(s: T, dir: -1 | 1): T;
  history(s: T, dir: -1 | 1): T;
}

/** Build input navigation handlers using the router's immediate path. */
export function makeInputHandlers<T>(
  getState: () => T,
  router: StateUpdateRouter<T>,
  t: InputTransitions<T>,
): {
  onChar(ch: string): void;
  onBackspace(): void;
  onMove(dir: -1 | 1): void;
  onHistory(dir: -1 | 1): void;
} {
  const apply = (next: T): void => router.interactive(next);
  return {
    onChar: (ch) => apply(t.char(getState(), ch)),
    onBackspace: () => apply(t.backspace(getState())),
    onMove: (dir) => apply(t.move(getState(), dir)),
    onHistory: (dir) => apply(t.history(getState(), dir)),
  };
}

export function isHighFrequencyStreamEvent(event: { type: string }): boolean {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

export interface StateUpdateRouter<T> {
  stream(state: T): void;
  interactive(state: T): void;
}

/** Keep high-frequency stream updates on the coalesced path and interactive
 * feedback on the immediate path. */
export function makeStateUpdateRouter<T>(opts: {
  getState: () => T;
  setState: (state: T) => void;
  schedule: () => void;
  paintNow: () => void;
}): StateUpdateRouter<T> {
  const update = (state: T, paint: () => void): void => {
    if (state === opts.getState()) return;
    opts.setState(state);
    paint();
  };
  return {
    stream: (state) => update(state, opts.schedule),
    interactive: (state) => update(state, opts.paintNow),
  };
}

export interface RenderCoalescerOptions {
  /** The actual paint (driver: `app.rerender(...)`). */
  paint: () => void;
  /** Coalescing window in ms; default 33 (~30fps). */
  windowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable timers (tests) — loose return type so fakes can return any id. */
  setTimeout?: (fn: () => void, ms?: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export function makeRenderCoalescer(opts: RenderCoalescerOptions): RenderCoalescer {
  const windowMs = opts.windowMs ?? 33;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeout ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout));
  let last = -Infinity; // no paint yet — the first event must paint immediately
  let timer: unknown;
  const paintNow = (): void => {
    if (timer !== undefined) {
      clearT(timer);
      timer = undefined;
    }
    opts.paint();
    last = now();
  };
  return {
    schedule(): void {
      const t = now();
      if (t - last >= windowMs) {
        paintNow(); // window elapsed — paint immediately (no added latency)
        return;
      }
      if (timer === undefined) {
        // Fold into ONE deferred paint at the window's end.
        timer = setT(() => {
          timer = undefined;
          paintNow();
        }, windowMs - (t - last));
      }
    },
    paintNow,
    cancel(): void {
      if (timer !== undefined) {
        clearT(timer);
        timer = undefined;
      }
    },
  };
}
