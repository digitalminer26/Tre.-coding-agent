/**
 * WS3 — the `write` tool. Creates/overwrites a file, making parent
 * directories as needed. Sequential: file mutators must not interleave.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "../types.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

export const writeTool: Tool = {
  name: "write",
  description:
    "Write content to a file (creates or fully overwrites it; parent directories " +
    "are created). For targeted changes to an existing file, use edit instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Full content to write to the file" },
    },
    required: ["path", "content"],
  },
  executionMode: "sequential",
  async execute(_id, args, _signal, _onUpdate): Promise<ToolResult> {
    const a = args as { path: string; content: string };
    try {
      await mkdir(path.dirname(a.path), { recursive: true });
      await writeFile(a.path, a.content, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: text(`write: cannot write ${a.path}: ${msg}`),
        isError: true,
      };
    }
    const lines =
      a.content === ""
        ? 0
        : a.content.split("\n").length - (a.content.endsWith("\n") ? 1 : 0);
    return {
      content: text(`Wrote ${a.content.length} bytes (${lines} lines) to ${a.path}`),
      details: { bytes: a.content.length, lines },
    };
  },
};
