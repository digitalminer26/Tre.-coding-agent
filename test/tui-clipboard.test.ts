/**
 * The TUI's `/copy` clipboard path — unit tests with an INJECTED adapter.
 *
 * `copyToClipboard(text, adapter)` never throws: it returns `{ ok: true }`
 * on success and `{ ok: false, error }` on failure (empty, oversized, or the
 * adapter rejects — no helper, timeout, non-zero exit). The default adapter
 * (pbcopy/xclip, stdin-piped, bounded, timed) is NOT exercised here (it would
 * need a real clipboard); the adapter is the seam. These tests pin the
 * result contract and the payload handed to the adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard, type ClipboardAdapter } from "../src/tui/clipboard.js";

/** A fake adapter that records the payload and resolves/rejects on demand. */
const fakeAdapter = (
  over: Partial<ClipboardAdapter> = {},
): { adapter: ClipboardAdapter; calls: string[] } => {
  const calls: string[] = [];
  const adapter: ClipboardAdapter = {
    copy(text) {
      calls.push(text);
      return over.copy ? over.copy(text) : Promise.resolve();
    },
  };
  return { adapter, calls };
};

test("success: resolves { ok: true } and hands the exact text to the adapter", async () => {
  const { adapter, calls } = fakeAdapter();
  const res = await copyToClipboard("hello world", adapter);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, ["hello world"]);
});

test("empty text → { ok: false, error: 'nothing to copy' } (the adapter is NOT called)", async () => {
  const { adapter, calls } = fakeAdapter();
  const res = await copyToClipboard("", adapter);
  assert.deepEqual(res, { ok: false, error: "nothing to copy" });
  assert.deepEqual(calls, []);
});

test("oversized text → { ok: false, error: 'selection too large to copy' } (the adapter is NOT called)", async () => {
  const { adapter, calls } = fakeAdapter();
  // 1,000,001 bytes > MAX_COPY_BYTES (1,000,000).
  const big = "a".repeat(1_000_001);
  const res = await copyToClipboard(big, adapter);
  assert.deepEqual(res, { ok: false, error: "selection too large to copy" });
  assert.deepEqual(calls, []);
});

test("exactly at the byte limit → allowed (the bound is strict >)", async () => {
  const { adapter, calls } = fakeAdapter();
  const exact = "a".repeat(1_000_000);
  const res = await copyToClipboard(exact, adapter);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 1_000_000);
});

test("adapter rejection (no helper / timeout / non-zero exit) → { ok: false, error }", async () => {
  const { adapter } = fakeAdapter({
    copy: () => Promise.reject(new Error("pbcopy exited 127: command not found")),
  });
  const res = await copyToClipboard("some text", adapter);
  assert.deepEqual(res, { ok: false, error: "pbcopy exited 127: command not found" });
});

test("a non-Error rejection is stringified (never throws)", async () => {
  const { adapter } = fakeAdapter({
    copy: () => Promise.reject("raw string failure"),
  });
  const res = await copyToClipboard("some text", adapter);
  assert.deepEqual(res, { ok: false, error: "raw string failure" });
});

test("multi-line / unicode text is passed through verbatim", async () => {
  const { adapter, calls } = fakeAdapter();
  const text = "line one\nline two\n日本語";
  const res = await copyToClipboard(text, adapter);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls[0], text);
});
