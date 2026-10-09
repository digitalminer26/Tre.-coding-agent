/**
 * SGR mouse-report parser (mode 1006) — pure unit tests.
 *
 * The driver enables SGR mouse reporting (1002 + 1006, opt-in via TRE_MOUSE=1)
 * and the terminal delivers mouse events as RAW input text; Ink strips the
 * leading ESC, so the App receives `[<b;x;yM` / `[<b;x;ym`. These tests pin
 * the parser's decoding (button, press/release, motion, coordinates,
 * modifier bits) and its total-ness (null for anything that is not a
 * well-formed SGR report), plus isSgrMouse's swallow gate.
 *
 * The parser does NOT own wheel events (64/65 SGR, 62/63 X11) — the App's
 * existing wheel regexes own those; the parser returns null for them so the
 * wheel path is preserved byte-for-byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSgrMouse, parseSgrMouse } from "../src/tui/mouse.js";

// ── press / release / motion ────────────────────────────────────────────────

test("left-button press: [<0;x;yM → left, pressed, not motion", () => {
  const ev = parseSgrMouse("[<0;10;5M");
  assert.deepEqual(ev, {
    button: "left",
    pressed: true,
    motion: false,
    col: 10,
    row: 5,
    shift: false,
    alt: false,
    ctrl: false,
  });
});

test("release: the `m` suffix is authoritative (b=3 → release)", () => {
  const ev = parseSgrMouse("[<3;10;5m");
  assert.equal(ev?.pressed, false);
  assert.equal(ev?.button, "left"); // b=3 base → not middle/right → left
  assert.equal(ev?.motion, false);
});

test("release echoing the held button (b=0, suffix m) → release", () => {
  const ev = parseSgrMouse("[<0;10;5m");
  assert.equal(ev?.pressed, false);
  assert.equal(ev?.button, "left");
});

test("button-held motion: [<32;x;yM → left, motion", () => {
  const ev = parseSgrMouse("[<32;12;7M");
  assert.equal(ev?.button, "left");
  assert.equal(ev?.pressed, true);
  assert.equal(ev?.motion, true);
  assert.equal(ev?.col, 12);
  assert.equal(ev?.row, 7);
});

test("middle-button press: b=1 → middle", () => {
  const ev = parseSgrMouse("[<1;4;4M");
  assert.equal(ev?.button, "middle");
  assert.equal(ev?.pressed, true);
  assert.equal(ev?.motion, false);
});

test("right-button press: b=2 → right", () => {
  const ev = parseSgrMouse("[<2;4;4M");
  assert.equal(ev?.button, "right");
  assert.equal(ev?.pressed, true);
});

// ── modifier bits (added to the button code) ────────────────────────────────

test("shift+left press: b=4 → left with shift", () => {
  const ev = parseSgrMouse("[<4;1;1M");
  assert.equal(ev?.button, "left");
  assert.equal(ev?.shift, true);
  assert.equal(ev?.alt, false);
  assert.equal(ev?.ctrl, false);
});

test("alt+left press: b=8 → left with alt", () => {
  const ev = parseSgrMouse("[<8;1;1M");
  assert.equal(ev?.button, "left");
  assert.equal(ev?.alt, true);
});

test("ctrl+left press: b=16 → left with ctrl", () => {
  const ev = parseSgrMouse("[<16;1;1M");
  assert.equal(ev?.button, "left");
  assert.equal(ev?.ctrl, true);
});

test("ctrl+shift+left press: b=20 → left with ctrl+shift", () => {
  const ev = parseSgrMouse("[<20;1;1M");
  assert.equal(ev?.button, "left");
  assert.equal(ev?.ctrl, true);
  assert.equal(ev?.shift, true);
  assert.equal(ev?.alt, false);
});

test("modifier bits mask off the base button (b=17 = ctrl+middle)", () => {
  const ev = parseSgrMouse("[<17;1;1M");
  assert.equal(ev?.button, "middle");
  assert.equal(ev?.ctrl, true);
});

// ── wheel events are NOT parsed (the App's wheel regexes own them) ──────────

test("SGR wheel up (b=64) → null (the wheel path handles it)", () => {
  assert.equal(parseSgrMouse("[<64;1;1M"), null);
});

test("SGR wheel down (b=65) → null", () => {
  assert.equal(parseSgrMouse("[<65;1;1M"), null);
});

test("X11 wheel up (b=62) → null (the legacy 4-byte form is a wheel)", () => {
  assert.equal(parseSgrMouse("[<62;1;1M"), null);
});

test("X11 wheel down (b=63) → null", () => {
  assert.equal(parseSgrMouse("[<63;1;1M"), null);
});

// ── total-ness: null for anything that is not a well-formed SGR report ──────

test("non-mouse input → null", () => {
  assert.equal(parseSgrMouse("hello"), null);
  assert.equal(parseSgrMouse(""), null);
  assert.equal(parseSgrMouse("\x1b[A"), null); // arrow (with the ESC)
  assert.equal(parseSgrMouse("[A"), null); // arrow (stripped)
});

test("malformed SGR (missing fields / bad suffix) → null", () => {
  assert.equal(parseSgrMouse("[<0;10M"), null); // missing row
  assert.equal(parseSgrMouse("[<0;10;5"), null); // missing suffix
  assert.equal(parseSgrMouse("[<0;10;5X"), null); // bad suffix
  assert.equal(parseSgrMouse("[<0;10;5MM"), null); // trailing junk
  assert.equal(parseSgrMouse("[<0;10;5 M"), null); // embedded space
});

test("non-numeric fields → null", () => {
  assert.equal(parseSgrMouse("[<a;10;5M"), null);
  assert.equal(parseSgrMouse("[<0;x;5M"), null);
});

// ── isSgrMouse (the App's swallow gate) ─────────────────────────────────────

test("isSgrMouse: true for any well-formed SGR report (wheel included)", () => {
  assert.equal(isSgrMouse("[<0;10;5M"), true);
  assert.equal(isSgrMouse("[<32;12;7M"), true);
  assert.equal(isSgrMouse("[<3;10;5m"), true);
  assert.equal(isSgrMouse("[<64;1;1M"), true); // wheel — still a mouse event
  assert.equal(isSgrMouse("[<62;1;1M"), true); // X11 wheel
});

test("isSgrMouse: false for non-mouse input", () => {
  assert.equal(isSgrMouse("hello"), false);
  assert.equal(isSgrMouse(""), false);
  assert.equal(isSgrMouse("[A"), false);
  assert.equal(isSgrMouse("[<0;10M"), false);
  assert.equal(isSgrMouse("[<0;10;5"), false);
});
