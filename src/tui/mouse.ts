/**
 * SGR mouse-report parser (mode 1006). The driver enables SGR mouse
 * reporting (1002 + 1006, opt-in via TRE_MOUSE=1) and the terminal delivers
 * mouse events as RAW input text (Ink's useInput passes the unparsed CSI
 * sequence through as the `input` string). This module parses those
 * sequences into typed events so the App can route them.
 *
 * Format: `CSI < b ; x ; y M/m` — i.e. the string (after Ink strips the
 * leading ESC) is `[<b;x;yM` (press/motion) or `[<b;x;ym` (release).
 *
 * Button codes (SGR):
 *   0 = left, 1 = middle, 2 = right (a press)
 *   3 = release (any button; the SGR spec encodes the release as b=3, but
 *       terminals that report the HELD button on release send the button
 *       code too — we accept both: a release is identified by the `m`
 *       suffix, not the button code)
 *   32 = button-HELD motion (mode 1002 reports drags as b=32)
 *   64 = wheel UP, 65 = wheel DOWN (SGR wheel)
 *   62 = wheel UP, 63 = wheel DOWN (X11 wheel — the legacy 4-byte form the
 *       terminal may still send; the App's existing wheel regexes already
 *       handle 62/63, and this parser must not swallow them as clicks)
 *
 * Modifier bits (added to the button code): 4 = shift, 8 = alt, 16 = ctrl.
 * The button is the LOW 2 bits (`b & 3`) — a ctrl+left press arrives as
 * b=16 (16|0), shift+left as b=4 (4|0), ctrl+middle as b=17 (16|1).
 *
 * The parser is PURE and total: it returns null for anything that is not a
 * well-formed SGR mouse report (so the App can fall through to its existing
 * swallow/char handling). Wheel events are parsed too (the App's existing
 * wheel regexes remain the source of truth for scroll behavior — the parser
 * is used for the click/drag/release events; the wheel path is unchanged to
 * preserve byte-for-byte behavior).
 */

/** One decoded SGR mouse event (click/drag/release). Wheel is handled by the
 * App's existing regexes and is NOT parsed here (see the module doc). */
export interface MouseEvent {
  /** The base button: "left" | "middle" | "right". */
  button: "left" | "middle" | "right";
  /** True for a press (`M`), false for a release (`m`). A button-held
   * motion (b=32) is a press-style event (suffix `M`) that updates an
   * active selection. */
  pressed: boolean;
  /** True when the event is a button-HELD motion (SGR b=32) — a drag. */
  motion: boolean;
  /** 1-based terminal column (SGR coordinates are 1-based). */
  col: number;
  /** 1-based terminal row (SGR coordinates are 1-based). */
  row: number;
  /** Modifier flags as reported (shift/alt/ctrl) — informational; the App
   * does not act on them (no word/line selection in this increment). */
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * Parse a RAW input string as an SGR mouse report. Returns null when the
 * string is not a well-formed SGR mouse event (the App then treats it as
 * before — swallowed, never typed).
 *
 * Accepts the string with or without the leading ESC (Ink strips it; the
 * existing wheel regexes match the stripped form `[<...`). This parser
 * matches the stripped form: `[<b;x;yM` or `[<b;x;ym`.
 */
export function parseSgrMouse(input: string): MouseEvent | null {
  const m = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (m === null) return null;
  const b = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  const suffix = m[4];
  // Wheel events (64/65 SGR, 62/63 X11) are NOT click/drag/release — the
  // App's existing wheel regexes own them (scroll behavior is preserved
  // byte-for-byte). Return null so the caller falls through to the wheel
  // path.
  if (b === 64 || b === 65 || b === 62 || b === 63) return null;
  // SGR button-code layout: the LOW 2 bits are the button (0=left, 1=middle,
  // 2=right, 3=release-of-unnamed-button), bit 2=shift(4), bit 3=alt(8),
  // bit 4=ctrl(16), bit 5=motion(32). A ctrl+middle press is b=17 (16|1); a
  // held-motion left drag is b=32. The button is `b & 3` (NOT `b & ~31` —
  // that would zero the button bits and decode every press as left, so a
  // right-click would start a selection). The release is identified by the
  // `m` suffix, not the button code.
  const buttonCode = b & 3;
  const shift = (b & 4) !== 0;
  const alt = (b & 8) !== 0;
  const ctrl = (b & 16) !== 0;
  const motion = (b & 32) !== 0;
  const button = buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : "left";
  // A release (suffix `m`) is a release regardless of the button code (the
  // SGR spec uses b=3 for release, but terminals that echo the held button
  // on release send 0/1/2 — the suffix is authoritative).
  const pressed = suffix === "M";
  return { button, pressed, motion, col: x, row: y, shift, alt, ctrl };
}

/**
 * True when the raw input string is an SGR mouse report of ANY kind (wheel
 * or click/drag/release) — i.e. it must be SWALLOWED (never typed into the
 * prompt). This is the App's "is this a mouse event at all" gate, replacing
 * the old `MOUSE_SGR` prefix check with a precise match.
 */
export function isSgrMouse(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}
