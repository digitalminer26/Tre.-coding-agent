/**
 * WS10 — unit tests for the edit diff renderer (pure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEditDiff } from "../src/tui/diff.js";

test("renderEditDiff: single-line replacement", () => {
  const d = renderEditDiff({ path: "a.txt", oldText: "b = 1", newText: "b = 2" });
  assert.deepEqual(d, ["- b = 1", "+ b = 2"]);
});

test("renderEditDiff: multi-line with unchanged context lines", () => {
  const oldText = "const a = 1;\nconst b = 2;\nconst c = 3;";
  const newText = "const a = 1;\nconst b = 22;\nconst c = 3;";
  assert.deepEqual(renderEditDiff({ oldText, newText }), [
    "  const a = 1;",
    "- const b = 2;",
    "+ const b = 22;",
    "  const c = 3;",
  ]);
});

test("renderEditDiff: insertion aligns after the common prefix (LCS, not zip)", () => {
  const oldText = "a\nb\nc";
  const newText = "a\nINSERT\nb\nc";
  assert.deepEqual(renderEditDiff({ oldText, newText }), [
    "  a",
    "+ INSERT",
    "  b",
    "  c",
  ]);
});

test("renderEditDiff: deletion", () => {
  const d = renderEditDiff({ oldText: "a\nb\nc", newText: "a\nc" });
  assert.deepEqual(d, ["  a", "- b", "  c"]);
});

test("renderEditDiff: identical texts → all context", () => {
  const d = renderEditDiff({ oldText: "x\ny", newText: "x\ny" });
  assert.deepEqual(d, ["  x", "  y"]);
});

test("renderEditDiff: empty new text (pure deletion); trailing newline is not a phantom line", () => {
  assert.deepEqual(renderEditDiff({ oldText: "a\n", newText: "" }), ["- a"]);
  // an INTERNAL empty line is still a real line
  assert.deepEqual(renderEditDiff({ oldText: "a\n\n", newText: "" }), ["- a", "- "]);
});

test("renderEditDiff: non-edit-shaped args → undefined", () => {
  assert.equal(renderEditDiff({ path: "a.txt" }), undefined);
  assert.equal(renderEditDiff({ oldText: 1, newText: "x" }), undefined);
  assert.equal(renderEditDiff({}), undefined);
});

test("renderEditDiff: edit-shaped args with extra fields still render", () => {
  const d = renderEditDiff({ path: "a.txt", oldText: "x", newText: "y" });
  assert.deepEqual(d, ["- x", "+ y"]);
});
