/**
 * The driver's `/copy` handler, extracted as a factory so its concurrency
 * contract is testable without the Ink app: it submits/clears the input
 * SYNCHRONOUSLY, defers the clipboard I/O, and on settlement spreads the
 * CURRENT state (read at settlement time, not at /copy time) and appends the
 * feedback item — so a draft typed, a streamed item, or a busy flip that
 * happen while the clipboard write is in flight all survive the feedback.
 * run.tsx calls makeCopySelection with the real seams (behavior unchanged).
 */
import { copyToClipboard, type ClipboardAdapter } from "./clipboard.js";
import { copySelectionText, submitInput, submitSlashBusy, type TuiState } from "./state.js";

/** The seams the /copy handler needs (the driver supplies the real ones). */
export interface CopySelectionSeams {
  /** Read the current TuiState — at /copy time AND again at clipboard
   * settlement (the settlement must spread the state as it is THEN). */
  getState: () => TuiState;
  /** Immediate (interactive) state write — the driver's setStateNow route. */
  setStateNow: (s: TuiState) => void;
  /** Clipboard adapter (tests inject a fake; absent → the platform helper). */
  clipboardAdapter?: ClipboardAdapter;
  /** Mounted guard — a copy that settles after quit must not re-render. */
  isMounted: () => boolean;
  /** The terminal width the App renders at (the rendered lines — and thus
   * the copy — are width-dependent; the driver measures it the same way). */
  width: () => number;
}

/**
 * Build the `/copy` handler. Never throws (I3): a clipboard failure is a
 * reported info item, not a crash. The selection is NOT cleared (the user
 * may copy again after a scroll; Esc clears it).
 */
export function makeCopySelection(seams: CopySelectionSeams): () => void {
  return (): void => {
    const width = seams.width();
    const text = copySelectionText(seams.getState(), width);
    const slashState = seams.getState().busy ? submitSlashBusy(seams.getState())?.state : submitInput(seams.getState())?.state;
    const cur = seams.getState();
    const cleared = { ...(slashState ?? cur), busy: cur.busy, input: "", cursorPos: 0, historyIdx: null, history: [...cur.history, "/copy"] };
    seams.setStateNow(cleared);
    if (text === "") {
      seams.setStateNow({ ...seams.getState(), ...cleared, items: [...cleared.items, { kind: "info", text: "copy: nothing selected (drag in the output area with the mouse)" }] });
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    void copyToClipboard(text, seams.clipboardAdapter).then((res) => {
      if (!seams.isMounted()) return; // a copy that settles after quit must not re-render
      const settled = seams.getState();
      seams.setStateNow({
        ...settled,
        items: [
          ...settled.items,
          {
            kind: "info",
            text: res.ok
              ? `copied ${bytes} byte(s) to the clipboard`
              : `copy failed: ${res.error}`,
          },
        ],
      });
    });
  };
}
