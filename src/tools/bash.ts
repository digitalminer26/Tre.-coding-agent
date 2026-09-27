/**
 * WS3 — the `bash` tool. Runs a shell command, capturing stdout and stderr
 * separately, with a timeout and full abort support. Output is truncated
 * from the TAIL (you want the final lines / errors), never splits a line,
 * and gets a temp-file recovery path when truncated.
 *
 * Errors (spawn failure, timeout, abort, non-zero exit) are isError RESULTS
 * whose text the model reads — I3.
 *
 * WS7: `createBashTool(cwd)` pins the shell's working directory to the
 * project root, so relative paths in commands mean the same thing as
 * relative paths in the file tools (the safety hook resolves those
 * against the root). `bashTool` (no cwd) is the process-cwd default.
 *
 * WS11: when a cwd is set and the platform is darwin, the child runs under
 * a kernel (Seatbelt) sandbox that confines file access to the workspace
 * plus system dirs — see `sandbox.ts` / D12. Off: `{ sandbox: false }`
 * (the CLI's --no-sandbox).
 *
 * Timeout/abort kill (2026-09-21): the shell is spawned DETACHED so the
 * whole command tree (shell + its pipeline children) forms its own process
 * group, and the kill targets that GROUP. Killing only the direct child
 * left pipeline orphans alive (SIGKILL the /bin/sh of `sleep 30 | cat`
 * → sleep keeps running, still holding the stdout pipe → the `close`
 * event never fires → the tool promise never settles → the agent loop
 * hangs; proven 2026-09-21). A force-settle timer is the last-resort
 * backstop in case a re-parented orphan keeps a pipe fd open.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Tool, ToolResult } from "../types.js";
import {
  bashSandboxAvailable,
  spawnSandboxedBash,
} from "./sandbox.js";
import {
  saveFullOutput,
  truncationMarker,
  truncateTail,
} from "./truncate.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

const DEFAULT_TIMEOUT_S = 120;
const MEMORY_CAP_BYTES = 1024 * 1024; // keep at most ~1MB per stream in RAM

/** Backstop after a group kill: settle anyway if a pipe is still held. */
const FORCE_SETTLE_MS = 10_000;

/** Keep only the tail of a growing string, bounded to `cap` bytes, without
 *  splitting the first kept line. */
function boundedTail(s: string, cap: number): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  let cut = s;
  while (Buffer.byteLength(cut, "utf8") > cap && cut.length > 0) {
    cut = cut.slice(Math.ceil(cut.length / 2));
  }
  const nl = cut.indexOf("\n");
  if (nl !== -1) cut = cut.slice(nl + 1);
  return cut;
}

export interface BashToolOptions {
  /** WS11: kernel-sandbox the child's file access to the workspace.
   *  On by default when a cwd is set AND the platform is darwin. */
  sandbox?: boolean;
  /** C35: explicitly assigned additional read/write regions (CLI
   *  --extra-root) re-allowed in the per-call kernel policy. */
  extraRoots?: string[];
}

export function createBashTool(cwd?: string, opts: BashToolOptions = {}): Tool {
  const sandboxOn = cwd !== undefined && opts.sandbox !== false && bashSandboxAvailable();
  return {
  name: "bash",
  description:
    "Run a shell command and return its output (stdout, then [stderr] if any). " +
    "Output is truncated to the last 2000 lines / 50KB — use a more specific " +
    "command (grep, head, tail, ...) when the output may be large. " +
    "A non-zero exit code or a timeout is reported as an error result. " +
    "Timeout defaults to 120s. " +
    "File access is confined to the working directory (kernel sandbox on " +
    "macOS): reading system files (/etc, other home dirs) or writing system " +
    "directories fails with 'Operation not permitted' — do not retry those.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "integer", description: "Timeout in seconds (default 120)" },
    },
    required: ["command"],
  },
  executionMode: "parallel",
  async execute(_id, args, signal, onUpdate): Promise<ToolResult> {
    const a = args as { command: string; timeout?: number };
    const timeoutS =
      a.timeout !== undefined ? Math.max(1, Math.floor(a.timeout)) : DEFAULT_TIMEOUT_S;

    let child: ChildProcess;
    let disposePolicy: (() => Promise<void>) | undefined;
    try {
      if (sandboxOn) {
        const s = await spawnSandboxedBash(a.command, {
          cwd,
          env: process.env,
          // detached: the sandbox-exec→shell→cmd tree forms its own process
          // group so timeout/abort can kill it whole (see killChild).
          detached: true,
          // C35: explicitly assigned extra roots (validated by the CLI).
          extraRoots: opts.extraRoots,
        });
        child = s.child;
        disposePolicy = s.dispose;
      } else {
        child = spawn(a.command, {
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          // detached: the shell leads its own process group (see killChild).
          detached: true,
          ...(cwd ? { cwd } : {}),
        });
      }
    } catch (err) {
      return {
        content: text(
          `bash: failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        ),
        isError: true,
      };
    }

    // SIGKILL the whole process group first (POSIX), then the child itself
    // as fallback (Windows / already-dead group). Both spawns above are
    // detached, so the group id IS the child's pid.
    const killChild = () => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* group already gone — fall through to the single-child kill */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };

    return new Promise<ToolResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      // Last-resort backstop: a SIGKILL'd group can only fail to release the
      // pipes if a re-parented orphan re-opened/kept an fd — settle anyway
      // rather than hang the loop forever. Armed only on the kill paths.
      const armForceSettle = () => {
        if (forceTimer || settled) return;
        forceTimer = setTimeout(() => finish(null, null), FORCE_SETTLE_MS);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
        armForceSettle();
      }, timeoutS * 1000);

      const onAbort = () => {
        aborted = true;
        killChild();
        armForceSettle();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d: Buffer) => {
        stdout = boundedTail(stdout + d.toString("utf8"), MEMORY_CAP_BYTES);
        onUpdate?.(`… ${Buffer.byteLength(stdout, "utf8")} bytes of output so far`);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr = boundedTail(stderr + d.toString("utf8"), MEMORY_CAP_BYTES);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          content: text(`bash: failed to run command: ${err.message}`),
          isError: true,
        });
      });

      child.on("close", (code, sig) => finish(code, sig));

      const finish = (code: number | null, sig: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        void (async () => {
          const full = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");

          if (aborted) {
            resolve({ content: text("bash: operation aborted."), isError: true });
            return;
          }

          const exitCode = code ?? (sig ? 1 : 0);
          let prefix: string | undefined;
          let isError = false;
          if (timedOut) {
            prefix = `bash: command timed out after ${timeoutS}s and was killed`;
            isError = true;
          } else if (exitCode !== 0) {
            prefix = `exit code ${exitCode}${sig ? ` (signal ${sig})` : ""}`;
            isError = true;
          }

          const t = truncateTail(full);
          const head = prefix ? `${prefix}\n` : "";
          if (!t.truncated) {
            const body = full.trim() === "" ? "(no output)" : full;
            resolve({ content: text(head + body), isError: isError || undefined });
            return;
          }

          // Truncated: save the full output and point the model at it.
          const fullOutputPath = await saveFullOutput("bash", full);
          const body =
            head + truncationMarker("tail", t, fullOutputPath) + "\n" + t.text;
          resolve({
            content: text(body),
            isError: isError || undefined,
            details: { truncated: true, fullOutputPath },
          });
        })();
      };

      function cleanup(): void {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        signal.removeEventListener("abort", onAbort);
        if (disposePolicy) void disposePolicy();
      }
    });
  },
};
}

/** The default bash tool (runs in the process cwd). */
export const bashTool: Tool = createBashTool();
