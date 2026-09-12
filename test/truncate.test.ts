/**
 * WS3 — truncate: 2000-line / 50KB limits, head vs tail, no split lines,
 * trailing-newline semantics, markers, temp-file save.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_BYTES,
  MAX_LINES,
  saveFullOutput,
  truncationMarker,
  truncateHead,
  truncateTail,
} from "../src/tools/truncate.js";

const LINES = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `line-${i + 1}`);

test("no truncation under both limits: text unchanged", () => {
  const text = LINES(10).join("\n") + "\n";
  const h = truncateHead(text);
  assert.equal(h.truncated, false);
  assert.equal(h.text, text);
  assert.equal(h.keptLines, 10);
  assert.equal(h.totalLines, 10);
  const t = truncateTail(text);
  assert.equal(t.truncated, false);
  assert.equal(t.text, text);
});

test("line limit: head keeps the FIRST lines, tail keeps the LAST lines", () => {
  const text = LINES(MAX_LINES + 500).join("\n");
  const h = truncateHead(text);
  assert.equal(h.truncated, true);
  assert.equal(h.keptLines, MAX_LINES);
  assert.equal(h.totalLines, MAX_LINES + 500);
  assert.ok(h.text.startsWith("line-1\n"));
  // exact-slice semantics: line-2000 had a \n after it in the original
  assert.ok(h.text.endsWith(`line-${MAX_LINES}\n`));
  assert.ok(!h.text.includes(`line-${MAX_LINES + 1}`));

  const t = truncateTail(text);
  assert.equal(t.truncated, true);
  assert.equal(t.keptLines, MAX_LINES);
  assert.ok(t.text.startsWith(`line-501`));
  assert.ok(t.text.endsWith(`line-${MAX_LINES + 500}`));
});

test("byte limit: keeps WHOLE lines only (never splits a line)", () => {
  // 60-byte lines; a 50KB budget fits 819 whole lines (820th would exceed).
  const line = "x".repeat(59) + "\n"; // 60 bytes incl newline
  const text = line.repeat(2000);
  const h = truncateHead(text, { maxLines: 100000 });
  assert.equal(h.truncated, true);
  // Every kept line must be complete: text is a multiple of 60 bytes.
  assert.equal(h.keptBytes % 60, 0);
  assert.ok(h.keptBytes <= MAX_BYTES);
  assert.ok(h.text.endsWith("x".repeat(59) + "\n"));
  assert.equal(h.keptLines * 60, h.keptBytes);

  const t = truncateTail(text, { maxLines: 100000 });
  assert.equal(t.truncated, true);
  assert.equal(t.keptBytes % 60, 0);
  assert.ok(t.keptBytes <= MAX_BYTES);
});

test("a single line longer than the byte budget: kept text is empty, no partial line", () => {
  const text = "y".repeat(MAX_BYTES + 100);
  const h = truncateHead(text);
  assert.equal(h.truncated, true);
  assert.equal(h.keptLines, 0);
  assert.equal(h.text, "");
  assert.equal(h.totalLines, 1);
  const t = truncateTail(text);
  assert.equal(t.truncated, true);
  assert.equal(t.text, "");
});

test("trailing newline: kept text ends with \\n iff the original did and the kept end IS the original end", () => {
  // Original ends with \n, head-truncated → the last kept line had a \n
  // after it in the original: kept text is the exact prefix and DOES end
  // with a newline.
  const many = LINES(3000).join("\n") + "\n";
  const h = truncateHead(many);
  assert.ok(h.truncated);
  assert.ok(h.text.endsWith("\n"));

  // head, NOT truncated → trailing newline preserved.
  const small = LINES(5).join("\n") + "\n";
  assert.equal(truncateHead(small).text, small);

  // tail (kept end = original end) → trailing newline preserved.
  const t = truncateTail(many);
  assert.ok(t.truncated);
  assert.ok(t.text.endsWith("\n"));

  // Original without a trailing newline.
  const bare = LINES(3000).join("\n");
  // head-truncated: the last kept line was followed by \n in the original
  // (the separator to the next line) → present.
  assert.ok(truncateHead(bare).text.endsWith("\n"));
  // tail-truncated: the last kept line IS the original's last line, which
  // had no \n → absent.
  assert.ok(!truncateTail(bare).text.endsWith("\n"));
});

test("empty input", () => {
  const h = truncateHead("");
  assert.equal(h.truncated, false);
  assert.equal(h.text, "");
  assert.equal(h.totalLines, 0);
});

test("truncationMarker: first/last wording + optional path", () => {
  const r = {
    text: "",
    truncated: true,
    keptLines: 2000,
    totalLines: 5000,
    keptBytes: 49000,
    totalBytes: 120000,
  };
  assert.equal(
    truncationMarker("head", r),
    "[truncated: showing first 2000 of 5000 lines (49000 of 120000 bytes)]",
  );
  assert.equal(
    truncationMarker("tail", r, "/tmp/x.log"),
    "[truncated: showing last 2000 of 5000 lines (49000 of 120000 bytes); full output saved to /tmp/x.log]",
  );
});

test("saveFullOutput: writes the full content to a file it returns", async () => {
  const p = await saveFullOutput("test", "hello\nworld\n");
  assert.ok(existsSync(p), p);
  assert.equal(readFileSync(p, "utf8"), "hello\nworld\n");
  assert.ok(p.endsWith(".log"));
});
