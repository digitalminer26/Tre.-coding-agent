/**
 * WS3 — the `read` tool. Reads a file, pages via offset/limit, truncates
 * from the head (you want the beginning), never splits a line, and offers
 * a temp-file recovery path when truncated.
 */
import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "../types.js";
import {
  saveFullOutput,
  truncationMarker,
  truncateHead,
} from "./truncate.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file from disk. Returns the content (up to 2000 lines / 50KB; " +
    "truncation keeps the head and tells you how to continue). " +
    "Use offset (1-based line) and limit to read further into large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read" },
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
    let raw: string;
    try {
      raw = await readFile(a.path, "utf8");
    } catch (err) {
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
    const trailing =
      slice.length > 0 && (lastIdx < total - 1 || raw.endsWith("\n"));
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
    const body =
      t.text +
      "\n" +
      truncationMarker("head", t, fullOutputPath) +
      `\ncontinue with offset=${offset + t.keptLines} (file has ${total} lines)`;
    return {
      content: text(body),
      details: { truncated: true, fullOutputPath },
    };
  },
};
