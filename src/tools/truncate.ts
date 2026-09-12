/**
 * WS3 — output truncation (copy of pi's rules, docs/01 §5):
 *  - two independent limits, whichever hits first: 2000 lines or 50 KB
 *  - `read` keeps the HEAD (you want the beginning); `bash` keeps the TAIL
 *    (you want the final lines / errors)
 *  - never splits a line
 *  - truncated output is a FEATURE with a recovery path: the full text is
 *    saved to a temp file and the tool result carries
 *    `details: { truncated: true, fullOutputPath }` so the model can read on.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50 KB

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncateResult {
  /** The kept text (whole lines only), no marker. */
  text: string;
  truncated: boolean;
  keptLines: number;
  totalLines: number;
  keptBytes: number;
  totalBytes: number;
}

/** Split into lines without a trailing empty element (trailing \n aware). */
function toLines(text: string): { lines: string[]; hadTrailingNewline: boolean } {
  if (text === "") return { lines: [], hadTrailingNewline: false };
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadTrailingNewline) lines.pop();
  return { lines, hadTrailingNewline };
}

function fromLines(lines: string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (hadTrailingNewline ? "\n" : "");
}

function truncate(
  input: string,
  from: "head" | "tail",
  opts: TruncateOptions = {},
): TruncateResult {
  const maxLines = opts.maxLines ?? MAX_LINES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const { lines, hadTrailingNewline } = toLines(input);
  const totalBytes = Buffer.byteLength(input, "utf8");

  // Cost model = the line's exact contribution to the kept text: every line
  // except the original's last one contributes its \n too (the kept text is
  // the exact original slice, see below).
  const lastIdx = lines.length - 1;
  const lastTrailing = hadTrailingNewline ? 1 : 0;
  const cost = (line: string, idx: number) =>
    Buffer.byteLength(line, "utf8") + (idx === lastIdx ? lastTrailing : 1);

  let kept: string[];
  if (from === "head") {
    kept = [];
    let bytes = 0;
    for (let i = 0; i < lines.length; i++) {
      if (kept.length >= maxLines) break;
      const line = lines[i]!;
      const c = cost(line, i);
      if (bytes + c > maxBytes) break;
      kept.push(line);
      bytes += c;
    }
  } else {
    kept = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
      const line = lines[i]!;
      const c = cost(line, i);
      if (bytes + c > maxBytes) break;
      kept.unshift(line);
      bytes += c;
    }
  }

  const truncated = kept.length < lines.length;
  // The kept text is the exact original slice through the end of the last
  // kept line: a line ends with \n iff it did in the original. Every line
  // except the original's last one has a \n, so:
  //  - head truncated: the last kept line had a \n after it in the original
  //  - tail / not truncated: the last kept line IS the original's last line
  const endsWithNewline =
    kept.length > 0 &&
    (truncated ? (from === "head" ? true : hadTrailingNewline) : hadTrailingNewline);
  const text = fromLines(kept, endsWithNewline);
  return {
    text,
    truncated,
    keptLines: kept.length,
    totalLines: lines.length,
    keptBytes: Buffer.byteLength(text, "utf8"),
    totalBytes,
  };
}

export const truncateHead = (text: string, opts?: TruncateOptions) =>
  truncate(text, "head", opts);
export const truncateTail = (text: string, opts?: TruncateOptions) =>
  truncate(text, "tail", opts);

/**
 * Human/model-readable marker added by tools around truncated text.
 * `from` = which end was kept.
 */
export function truncationMarker(
  from: "head" | "tail",
  r: TruncateResult,
  fullOutputPath?: string,
): string {
  const where = from === "head" ? "first" : "last";
  let m =
    `[truncated: showing ${where} ${r.keptLines} of ${r.totalLines} lines ` +
    `(${r.keptBytes} of ${r.totalBytes} bytes)`;
  if (fullOutputPath) m += `; full output saved to ${fullOutputPath}`;
  return m + "]";
}

/**
 * Save full (untruncated) output to a temp file; returns the path.
 * Caller decides when (only when truncated) and surfaces the path in
 * `details.fullOutputPath`.
 */
export async function saveFullOutput(
  prefix: string,
  content: string,
): Promise<string> {
  const dir = path.join(tmpdir(), "coding-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${randomUUID()}.log`);
  await writeFile(file, content, "utf8");
  return file;
}
