/**
 * The driver's terminal-resize handler, extracted as a factory so it is
 * testable with a fake EventEmitter stream: a resize CLEARS an active
 * selection (the anchors are content coordinates — a reflow changes the
 * rendered lines, so the stale anchors must not survive) and is a no-op
 * (same state reference) when no selection is active. attach/detach bind
 * the handler to the stream's "resize" event — the driver attaches at
 * startup and detaches on quit (a resize after quit must not re-render).
 * run.tsx wires it with the real seams (behavior unchanged).
 */
import { selectClear, type TuiState } from "./state.js";

/** The stream surface the driver needs (process.stdout satisfies it). */
export interface ResizeStream {
  on(event: "resize", handler: () => void): unknown;
  off(event: "resize", handler: () => void): unknown;
}

/** The seams the resize handler needs (the driver supplies the real ones). */
export interface ResizeSeams {
  stream: ResizeStream;
  /** Read the current TuiState. */
  getState: () => TuiState;
  /** Immediate (interactive) state write — the driver's setStateNow route. */
  setStateNow: (s: TuiState) => void;
}

/**
 * Build the resize handler + attach/detach. The state is read ONCE per
 * event (the condition and the clear must act on the same snapshot).
 */
export function makeResizeHandler(seams: ResizeSeams): {
  onResize: () => void;
  attach: () => void;
  detach: () => void;
} {
  const onResize = (): void => {
    const s = seams.getState();
    if (s.selection !== null) seams.setStateNow(selectClear(s));
  };
  return {
    onResize,
    attach: () => { seams.stream.on("resize", onResize); },
    detach: () => { seams.stream.off("resize", onResize); },
  };
}
