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
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Tool, ToolResult } from "../types.js";
import {
  saveFullOutput,
  truncationMarker,
  truncateTail,
} from "./truncate.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

const DEFAULT_TIMEOUT_S = 120;
const MEMORY_CAP_BYTES = 1024 * 1024; // keep at most ~1MB per stream in RAM

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

export function createBashTool(cwd?: string): Tool {
  return {
  name: "bash",
  description:
    "Run a shell command and return its output (stdout, then [stderr] if any). " +
    "Output is truncated to the last 2000 lines / 50KB — use a more specific " +
    "command (grep, head, tail, ...) when the output may be large. " +
    "A non-zero exit code or a timeout is reported as an error result. " +
    "Timeout defaults to 120s.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "integer", description: "Timeout in seconds (default 120)" },
    },
    required: ["command"],
  },
  executionMode: "parallel",
  execute(_id, args, signal, onUpdate): Promise<ToolResult> {
    const a = args as { command: string; timeout?: number };
    const timeoutS =
      a.timeout !== undefined ? Math.max(1, Math.floor(a.timeout)) : DEFAULT_TIMEOUT_S;

    return new Promise<ToolResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(a.command, {
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          ...(cwd ? { cwd } : {}),
        });
      } catch (err) {
        resolve({
          content: text(
            `bash: failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
          ),
          isError: true,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutS * 1000);

      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
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

      child.on("close", (code, sig) => {
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
      });

      function cleanup(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    });
  },
};
}

/** The default bash tool (runs in the process cwd). */
export const bashTool: Tool = createBashTool();
