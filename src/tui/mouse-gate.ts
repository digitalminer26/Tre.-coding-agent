/**
 * The driver's mouse-selection GATING, extracted as a factory so the
 * press→drag→release→subsequent-motion sequence is testable without the Ink
 * app: a left-button PRESS (selectStart) sets the dragging flag; a
 * button-held MOTION (selectUpdate) is IGNORED unless the flag is set (a
 * motion event without a prior press must not start a selection); a RELEASE
 * (selectEnd) clears the flag (the selection itself STAYS — the user may
 * /copy it); a motion AFTER the release is a no-op (no setStateNow call).
 * run.tsx wires it with the real seams (behavior unchanged).
 */
import { selectClear, selectStart, selectUpdate, type SelectionAnchor, type TuiState } from "./state.js";

/** The seams the mouse handlers need (the driver supplies the real ones). */
export interface MouseGateSeams {
  /** Read the current TuiState. */
  getState: () => TuiState;
  /** Immediate (interactive) state write — the driver's setStateNow route. */
  setStateNow: (s: TuiState) => void;
}

/** The four onSelect* handlers the driver's App props need. */
export interface MouseGateHandlers {
  onSelectStart: (anchor: SelectionAnchor) => void;
  onSelectUpdate: (anchor: SelectionAnchor) => void;
  onSelectEnd: () => void;
  onSelectClear: () => void;
}

/**
 * Build the gated mouse handlers. The dragging flag lives in the factory
 * closure — it is DRIVER state, not TuiState (the selection in TuiState
 * survives a release; only the drag GATE closes).
 */
export function makeMouseGate(seams: MouseGateSeams): MouseGateHandlers {
  let dragging = false;
  return {
    onSelectStart: (anchor: SelectionAnchor): void => {
      dragging = true;
      seams.setStateNow(selectStart(seams.getState(), anchor));
    },
    onSelectUpdate: (anchor: SelectionAnchor): void => {
      if (!dragging) return;
      const next = selectUpdate(seams.getState(), anchor);
      if (next !== null) seams.setStateNow(next);
    },
    onSelectEnd: (): void => {
      dragging = false;
    },
    onSelectClear: (): void => {
      seams.setStateNow(selectClear(seams.getState()));
    },
  };
}
