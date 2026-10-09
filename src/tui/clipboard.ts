/**
 * The system clipboard for the TUI's `/copy` (mouse selection). The DRIVER
 * owns this module (src/tui/run.tsx) — the pure state machine (state.ts)
 * never touches the clipboard or the terminal.
 *
 * The ADAPTER is injectable so the copy path is unit-testable without a real
 * clipboard: `copyToClipboard(text, adapter)`. The default adapter shells out
 * to a platform helper (pbcopy on macOS, xclip on Linux) with the text piped
 * on STDIN — no shell, no command-line interpolation, bounded payload, and a
 * timeout so a wedged helper can't hang the TUI.
 *
 * Security: the text is written to the helper's stdin as a single buffer,
 * never interpolated into a command line, so there is no injection surface.
 * OSC 52 is deliberately NOT used — it would expose the copied text to remote
 * multiplexers/terminals, a trust-boundary decision the plan defers. `pbcopy`
 * is local-only; over SSH the helper is absent and the copy fails safely with
 * a clear message (no crash).
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";

/** A system-clipboard writer. The default shells out to a platform helper;
 * tests inject a fake to assert the payload without a real clipboard. */
export interface ClipboardAdapter {
  /** Copy `text` to the system clipboard. Resolves on success, rejects on
   * failure (no helper, non-zero exit, timeout). */
  copy(text: string): Promise<void>;
}

/** Max bytes handed to the clipboard helper (bounded input — a runaway
 * selection can't OOM the helper or the TUI). */
const MAX_COPY_BYTES = 1_000_000;
/** The helper must exit within this window or it is killed (a wedged
 * clipboard daemon must not hang the TUI). */
const COPY_TIMEOUT_MS = 3000;

/** The platform helper for the current OS (darwin → pbcopy, else xclip). */
function helper(): { cmd: string; args: string[] } {
  return platform() === "darwin"
    ? { cmd: "pbcopy", args: [] }
    : { cmd: "xclip", args: ["-selection", "clipboard"] };
}

/** The default adapter: a platform clipboard helper, text on stdin. */
export const defaultClipboardAdapter: ClipboardAdapter = {
  copy(text): Promise<void> {
    const { cmd, args } = helper();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`${cmd} timed out after ${COPY_TIMEOUT_MS}ms`));
      }, COPY_TIMEOUT_MS);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", fail); // ENOENT — the helper is not installed
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
      child.stdin.on("error", (err) => fail(err)); // EPIPE if the helper died early
      child.stdin.write(text);
      child.stdin.end();
    });
  },
};

/**
 * Copy `text` to the system clipboard through `adapter` (default: the
 * platform helper). Returns a result, never throws: `{ ok: true }` on
 * success, `{ ok: false, error }` on failure (no helper, timeout, non-zero
 * exit, empty or oversized text). The TUI reports the result as an info item.
 */
export async function copyToClipboard(
  text: string,
  adapter: ClipboardAdapter = defaultClipboardAdapter,
): Promise<{ ok: boolean; error?: string }> {
  if (text === "") return { ok: false, error: "nothing to copy" };
  if (Buffer.byteLength(text, "utf8") > MAX_COPY_BYTES) {
    return { ok: false, error: "selection too large to copy" };
  }
  try {
    await adapter.copy(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
