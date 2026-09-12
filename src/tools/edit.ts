/**
 * WS3 — the `edit` tool. Exact text replacement against the ORIGINAL file
 * contents:
 *  - `oldText` must occur EXACTLY once (unique match, no fuzzy matching)
 *  - `newText` replaces that one region (may be empty = delete)
 *  - any failure (no match, multiple matches, unreadable file) is an
 *    isError result describing the problem — the model re-tries with a
 *    more specific oldText
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "../types.js";

const text = (t: string) => [{ type: "text" as const, text: t }];

export const editTool: Tool = {
  name: "edit",
  description:
    "Make a precise edit to a file by replacing an exact text region. " +
    "`oldText` must appear EXACTLY ONCE in the file (exact match including " +
    "whitespace and newlines) — if it matches 0 or >1 times the edit fails " +
    "and nothing is written. Set newText to \"\" to delete the region.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      oldText: {
        type: "string",
        description: "Exact text of the region to replace (must be unique in the file)",
      },
      newText: {
        type: "string",
        description: "Replacement text (empty string deletes the region)",
      },
    },
    required: ["path", "oldText", "newText"],
  },
  executionMode: "sequential",
  async execute(_id, args, _signal, _onUpdate): Promise<ToolResult> {
    const a = args as { path: string; oldText: string; newText: string };

    if (a.oldText === "") {
      return {
        content: text(`edit: oldText must not be empty.`),
        isError: true,
      };
    }

    let original: string;
    try {
      original = await readFile(a.path, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: text(`edit: cannot read ${a.path}: ${msg}`),
        isError: true,
      };
    }

    // Count occurrences against the ORIGINAL content (single edit per call).
    let count = 0;
    let idx = original.indexOf(a.oldText);
    while (idx !== -1) {
      count += 1;
      idx = original.indexOf(a.oldText, idx + a.oldText.length);
    }

    if (count === 0) {
      return {
        content: text(
          `edit: no exact match for oldText in ${a.path}. ` +
            "Read the file and retry with text that matches exactly " +
            "(including whitespace and newlines).",
        ),
        isError: true,
      };
    }
    if (count > 1) {
      return {
        content: text(
          `edit: oldText matches ${count} times in ${a.path} — it must be unique. ` +
            "Add surrounding context lines to disambiguate and retry.",
        ),
        isError: true,
      };
    }

    const updated = original.replace(a.oldText, a.newText);
    try {
      await writeFile(a.path, updated, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: text(`edit: cannot write ${a.path}: ${msg}`),
        isError: true,
      };
    }

    const delta =
      updated.length - original.length >= 0
        ? `+${updated.length - original.length}`
        : `${updated.length - original.length}`;
    return {
      content: text(`Edited ${a.path} (1 occurrence, ${delta} bytes)`),
      details: { bytesDelta: updated.length - original.length },
    };
  },
};
