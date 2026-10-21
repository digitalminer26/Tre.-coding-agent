/**
 * WS3 — the `read` tool. Reads a file, pages via offset/limit, truncates
 * from the head (you want the beginning), never splits a line, and offers
 * a temp-file recovery path when truncated.
 *
 * `read` is UNRESTRICTED by design (see safety.ts): it may read ANY file or
 * directory on the system — no project-root restriction, no approval
 * prompt. Pointing it at a directory lists its entries (name, `d` for
 * directory / `-` for file, size in bytes) instead of reading it.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import type { Tool, ToolResult } from "../types.js";
import {
  MAX_BYTES,
  MAX_LINES,
  saveFullOutput,
  truncationMarker,
  truncateHead,
} from "./truncate.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

/**
 * L1 (audit 2026-10-21): hard size cap checked on the STAT before the file
 * is ever materialized. The page caps (2000 lines / 50 KB) only apply
 * AFTER readFile, so a multi-GB file used to OOM the process before any
 * cap could fire. 64 MiB is generous for text anyone wants to page through;
 * above it the tool refuses with the size named (and the binary/FIFO/device
 * refusal below stops the other "read hangs or explodes" cases).
 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

/** L2: directory listings are capped like file pages (was unbounded — a
 *  100k-entry dir flooded the context). */
const MAX_LIST_ENTRIES = MAX_LINES;

/** List a directory's entries: `- name` (file) or `d name` (dir) + size.
 *  L2: returns at most `limit` lines plus the TOTAL entry count (the caller
 *  adds the truncation note) — a 100k-entry directory must not flood the
 *  context the way an uncapped file page would. */
async function listDir(dir: string, limit: number): Promise<{ text: string; total: number; shown: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    let size = "";
    if (!e.isSymbolicLink()) {
      try {
        const s = await stat(`${dir}/${e.name}`);
        size = ` (${s.size} bytes)`;
      } catch {
        size = ""; // broken entries are listed anyway
      }
    }
    lines.push(`${e.isDirectory() ? "d" : "-"} ${e.name}${size}`);
  }
  lines.sort();
  const kept = lines.slice(0, limit);
  return {
    text: kept.join("\n") + (kept.length > 0 ? "\n" : ""),
    total: lines.length,
    shown: kept.length,
  };
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file from disk. Returns the content (up to 2000 lines / 50KB; " +
    "truncation keeps the head and tells you how to continue). Use offset " +
    "(1-based line) and limit to read further into large files. May read any " +
    "file on the system (no project-root restriction, no approval prompt). " +
    "Reading a directory lists its entries (d = directory, - = file, size in bytes).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (or directory) to read" },
      offset: {
        type: "integer",
        description: "1-based line number to start reading from",
      },
      limit: {
        type: "integer",
        description: "Maximum number of lines to read",
      },
    },
    required: ["path"],
  },
  executionMode: "parallel",
  async execute(_id, args, _signal, _onUpdate): Promise<ToolResult> {
    const a = args as { path: string; offset?: number; limit?: number };
    // L1 (audit 2026-10-21): stat BEFORE materializing. A huge file is
    // refused by size (no OOM path); a FIFO/socket/device is refused
    // outright (a FIFO without a writer would hang readFile forever — see
    // also the L5 timeout). Directories fall through to the listing branch.
    try {
      const st = await stat(a.path);
      if (!st.isDirectory() && !st.isFile()) {
        return {
          content: text(
            `read: ${a.path} is not a regular file (it is a ${
              st.isFIFO() ? "pipe" : st.isSocket() ? "socket" : "device"
            }) — refusing to read it`,
          ),
          isError: true,
        };
      }
      if (st.isFile() && st.size > MAX_READ_BYTES) {
        return {
          content: text(
            `read: ${a.path} is ${(st.size / (1024 * 1024)).toFixed(1)} MB ` +
              `(cap ${MAX_READ_BYTES / (1024 * 1024)} MB) — too large to read; ` +
              `use bash (head/tail/grep) to sample it`,
          ),
          isError: true,
        };
      }
    } catch {
      // stat failed (ENOENT/ENOTDIR/EACCES/…) — fall through and let
      // readFile below produce the canonical error result.
    }
    let raw: string;
    try {
      raw = await readFile(a.path, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EISDIR") {
        // Directory: list its entries instead of reading it. L2: capped.
        try {
          const listing = await listDir(a.path, MAX_LIST_ENTRIES);
          const note =
            listing.total > listing.shown
              ? `\n[listing truncated: showing ${listing.shown} of ${listing.total} entries — pass a file path to read inside it]`
              : "";
          return {
            content: text(
              (listing.text === "" ? "(empty directory)" : listing.text) +
                note +
                (note === ""
                  ? `\n[${a.path} is a directory — read a file inside it to see its content]`
                  : ""),
            ),
          };
        } catch (derr) {
          const msg = derr instanceof Error ? derr.message : String(derr);
          return { content: text(`read: cannot list ${a.path}: ${msg}`), isError: true };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: text(`read: cannot read ${a.path}: ${msg}`),
        isError: true,
      };
    }

    // Binary guard — NUL byte in the first chunk means "not a text file".
    if (raw.slice(0, 8192).includes("\u0000")) {
      return {
        content: text(`read: ${a.path} appears to be a binary file.`),
        isError: true,
      };
    }

    const offset = Math.max(1, Math.floor(a.offset ?? 1));
    const limit = a.limit !== undefined ? Math.max(0, Math.floor(a.limit)) : undefined;

    const lines = raw === "" ? [] : raw.split("\n");
    if (raw.endsWith("\n")) lines.pop(); // drop the artifact of the trailing newline
    const total = lines.length;

    const start = offset - 1;
    const slice =
      limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
    // The page is the exact original slice: a line ends with \n iff it did
    // in the file (every line but the file's last one; the last one iff the
    // file ends with a newline).
    const lastIdx = start + slice.length - 1;
    const trailing = slice.length > 0 && (lastIdx < total - 1 || raw.endsWith("\n"));
    const paged = slice.join("\n") + (trailing ? "\n" : "");

    const t = truncateHead(paged);
    if (!t.truncated) {
      const head =
        slice.length > 0 && offset > 1
          ? `lines ${offset}–${offset + slice.length - 1} of ${total}\n`
          : "";
      return {
        content: text(head + (slice.length === 0 ? "(file has no more lines)" : paged)),
      };
    }

    // Truncated: save the FULL paged (pre-truncation) content and tell the
    // model where it went.
    const fullOutputPath = await saveFullOutput("read", paged);
    let hint = `continue with offset=${offset + t.keptLines} (file has ${total} lines)`;
    // Why was the page truncated? The line cap allows min(page, MAX_LINES)
    // lines; if fewer were kept, the BYTE cap is the binding constraint.
    // Following offset alone then re-hits the cap — suggest a smaller page.
    const byteCapped = t.keptLines < Math.min(slice.length, MAX_LINES);
    if (byteCapped && t.keptLines > 0) {
      const avgLineBytes = t.keptBytes / t.keptLines;
      const suggestedLimit = Math.max(1, Math.floor(MAX_BYTES / avgLineBytes) - 1);
      hint += `; wide lines hit the byte cap — also pass limit=${suggestedLimit}`;
    }
    const body = t.text + "\n" + truncationMarker("head", t, fullOutputPath) + `\n${hint}`;
    return {
      content: text(body),
      details: { truncated: true, fullOutputPath },
    };
  },
};
