# Plan: In-app mouse selection and copy for the TUI

Status: implemented (2026-10-10). The SGR parser (`src/tui/mouse.ts`), the
content-coordinate selection model (`src/tui/state.ts`: selectStart/selectUpdate/
selectClear, selectedRanges/selectedText/copySelectionText), the App routing +
viewport→anchor mapping + highlight (`src/tui/app.tsx`), the driver's `/copy` +
clipboard adapter (`src/tui/copy.ts` `makeCopySelection`, `src/tui/clipboard.ts`),
and the opt-in mouse-mode enable/restore are in. Mouse tracking is opt-in via the
persisted `mouse` config key (`~/.tre/tui.json`; `mouseTrackingEnabled` shared by
driver and App) — explicit env always beats the file, so a one-off launch can flip
it either way: `TRE_NO_MOUSE=1` → off (wins over everything), `TRE_MOUSE=1` → on,
otherwise the config key (default off: the terminal keeps its native
highlight-and-copy). Driver handlers are extracted for testability: `makeMouseGate`
(`src/tui/mouse-gate.ts`), `makeResizeHandler` (`src/tui/resize.ts` — a resize
clears an active selection), `makeCopySelection` (`src/tui/copy.ts` — a deferred
copy settles without dropping the selection/viewport/streamed/busy state).
Deterministic tests: `test/tui-mouse.test.ts` (parser), `test/tui-selection.test.ts`
(model), `test/tui-clipboard.test.ts` (copy path), `test/tui-app.test.tsx`
(routing + mapping), `test/tui-mouse-gate.test.ts` (gate lifecycle),
`test/tui-resize.test.ts` (resize clears selection), `test/tui-selection-styling.test.tsx`
(highlight == `/copy` agreement); the PTY mode lifecycle (enable + restore of
1002/1006) is in `test/e2e.sh`. Manual Terminal.app gesture verification (drag
creates a visible selection; `/copy` lands the exact text on the macOS clipboard)
was the remaining acceptance step — it needs a real terminal, not a PTY.
**ACCEPTED (2026-10-17): all 7 checklist steps PASS** (see the Manual
acceptance checklist below); the feature is DONE.

## Goal

Allow users of tre.'s full-screen TUI to select and copy rendered output with the mouse while mouse reporting is enabled for wheel/trackpad scrolling. The feature must not depend on Terminal.app performing native text selection inside the TUI. It should keep the existing keyboard scrolling and selection-friendly mode available as fallbacks.

## Motivation and verified behavior

The driver enables SGR mouse reporting (`1002` + `1006`) only when `TRE_MOUSE=1`. In Terminal.app, live tests with tracking modes `1000`, `1002`, and `1003` showed that drags are reported to the application rather than handled as native terminal selection; mode `1002` reports button-held motion, and wheel events are also delivered. Consequently, changing only the tracking mode is not a demonstrated way to retain Terminal.app's native selection while tre. receives wheel input. An application-owned selection is the plausible route to offer both operations in the same TUI session.

Observed probe data and limitations:
- `1000`: button press/release and wheel reports reached the probe; native drag selection did not work.
- `1002`: button-held motion (SGR button code 32) and wheel reports reached the probe; native drag selection did not work.
- `1003`: motion reports reached the probe; native drag selection did not work.
- This is confirmed for the user's Terminal.app setup, not every terminal emulator/version. The probe was a raw-input diagnostic, not tre.'s app-level selection implementation.

## UX proposal

- Keep `TRE_MOUSE=1` as opt-in initially; it enables wheel scrolling and app-owned selection. Keep the current default (mouse tracking off) and `TRE_NO_MOUSE=1` behavior until compatibility is established.
- Left-button press in the scrollable output region starts a selection; drag updates its endpoint; release fixes the selection. Wheel events continue to scroll.
- Do not start selection in the prompt/input row, approval/model-picker controls, separators, or bottom-display region. Define the selectable region explicitly (initially the rendered output item viewport only).
- Provide a clear visual highlight that works across existing colored/dim output (e.g. a terminal background color overlay, not reverse-video assumptions). Keep selection visible while scrolling; define whether dragging beyond the viewport edge autoscrolls (recommended for the first usable release, or explicitly defer it).
- Add a documented copy action that is discoverable and does not type into the prompt. Candidate: `Cmd+C` where the terminal reports the modifier distinctly; fallback: a configured key such as `Ctrl+Shift+C` or an explicit command. Do not intercept ordinary Ctrl+C, which is tre.'s abort/quit behavior. Confirm macOS Terminal.app's actual key reporting before choosing the default.
- Copy the selected rendered text to the system clipboard. Prefer a platform clipboard helper (`pbcopy` on macOS) with bounded input, no shell interpolation, and graceful failure; optionally support OSC 52 for remote terminals only after security/compatibility review. Clearly document local-vs-remote behavior.
- Releasing the mouse without a non-empty selection should not alter the prompt or trigger an action. A new press starts a new selection; Escape clears it. Selection must not affect agent state or session contents.

## Investigation / design work before implementation

1. **Input protocol and terminal compatibility**
   - Capture Terminal.app SGR press, held-motion, release, wheel, and modifier reports with the existing diagnostic probe; record macOS/Terminal version and exact mode.
   - Confirm the correct SGR button/modifier bit decoding, wheel handling, release semantics, and behavior when events arrive combined in one chunk.
   - Check at least one xterm-compatible terminal in addition to Terminal.app before generalizing claims. Preserve a no-mouse fallback and always restore modes on normal exit, errors, and signals.
2. **Coordinate-to-content mapping**
   - The viewport is laid out by `App` using `fitItemsScrollable` and `itemLines`; `VisibleSlice` provides item line ranges. Selection must map terminal row/column to stable content positions through wrapping, clipped slices, blank/pad rows, separators, and scroll offsets.
   - Avoid indexing ANSI escape bytes as visible columns. Existing rendered lines contain spans/styles and Unicode; define a shared display-cell mapping that handles wide code points, combining marks, ANSI color spans, and the renderer's wrapping rules consistently.
   - Decide whether selection anchors use item identity + logical text offsets (recommended) so stream appends and rerenders do not silently shift a selection. Specify behavior if selected content is replaced/compacted or scrolled out of view.
3. **Selection text semantics**
   - Define extraction for user, assistant (including thinking text), tool, diff, compaction, error, and other item kinds. Decide whether to copy visible text or semantic item text; preserve line breaks and omit TUI decoration (prompt glyphs, status markers, ANSI styling) unless explicitly part of content.
   - Handle wrapped lines, clipped viewport edges, blank separators, hidden tools, tables, and partial-line selections. Define whether mouse drag is character-cell or word/line granular; start with character-cell selection and add modifier-based word/line selection only if reliably detectable.
4. **Rendering integration**
   - Keep the `App` presentational and event routing testable. Add explicit callbacks/state for selection start, update, end, clear, and copy; do not write terminal escape sequences from a React render.
   - Ensure selected spans compose with existing ANSI colors/dim/bold styling and do not break pinned frame height, row accounting, clipping, or render-coalescing behavior.
   - Ensure ordinary clicks do not activate controls, type escape bytes into the prompt, or interfere with approval/model-picker handling. Define precedence between selection gestures and existing wheel/key handling.
5. **Clipboard and security**
   - Evaluate a safe `pbcopy` integration (stdin pipe, no shell, bounded payload, timeout, no clipboard write until explicit user action) and supported platform behavior. Handle missing clipboard utilities without crashing the TUI.
   - OSC 52 may expose copied text to remote multiplexers/terminals; make it opt-in if supported and document the trust boundary. Never copy automatically on mouse release without an explicit policy/consent decision.
6. **Testing**
   - Pure unit tests for mouse-report parsing, coordinates, cell widths, wrapping, selection ordering, text extraction, and mode transitions.
   - Deterministic App tests for press/drag/release, wheel while selection is active, clear/copy commands, input-row exclusion, and key precedence.
   - Mutation/regression tests showing route/parser changes fail the relevant tests.
   - PTY tests for enabling/restoring mouse modes and delivery of SGR events; PTY tests cannot prove native Terminal.app gesture behavior.
   - Manual Terminal.app verification: wheel scrolls; drag creates visible tre. selection; explicit copy places expected text on macOS clipboard; ordinary typing, approval, Ctrl+C, quit, resize, and scroll still work. Repeat with `TRE_MOUSE=1` and selection-friendly mode.

## Suggested implementation increments

1. **Protocol spike (no user-facing behavior):** document event traces and implement/test a pure SGR mouse parser; verify exact Terminal.app button, modifier, motion, release, and wheel values. Decide supported terminal scope.
2. **Selection model and mapping:** add pure selection anchor/range types and coordinate mapping from rendered viewport cells to logical output offsets; test every item kind and clipping/wrapping case.
3. **Visible selection rendering:** render an in-app highlight for a drag-selected range; no clipboard integration yet. Add deterministic App tests and verify pinned-frame invariants.
4. **Copy action:** implement explicit copy shortcut/action and safe macOS clipboard adapter; test clipboard payload through an injectable adapter, errors/timeouts, and ensure Ctrl+C retains its current meaning.
5. **End-to-end and documentation:** add PTY mode lifecycle checks, perform manual Terminal.app validation, document keyboard/mouse controls, compatibility, and opt-outs. Enable by default only after compatibility and fallback behavior are approved.

## Acceptance criteria

- With mouse reporting enabled in Terminal.app, wheel/trackpad scrolls tre.'s output and click-drag produces a visible selection owned by tre.; Terminal.app native selection is not required.
- Explicit copy puts precisely the specified selected text on the clipboard; empty selection, unavailable helper, timeout, or unsupported terminal fails safely with clear feedback.
- The input prompt, approval and model-picker controls are not accidentally selected/activated; Ctrl+C and existing quit behavior remain unchanged.
- Selection remains logically correct across redraws, wrapping, clipping, scroll, and normal stream appends, with documented behavior for compaction/resizing.
- Mouse modes are restored on all supported teardown paths; keyboard scrolling and the current selection-friendly no-mouse mode continue to work.
- Build/test/quality gate passes; deterministic tests cover parser/model/render/copy behavior; manual Terminal.app verification is recorded before declaring the feature done.

## Manual acceptance checklist (needs a real terminal — a PTY cannot do this)

**RESULT (2026-10-17): all 7 steps PASS** (Terminal.app, `TRE_MOUSE=1`
mouse-on run + `TRE_NO_MOUSE=1` no-mouse run). The D28 mouse-selection
feature is DONE — no further acceptance steps.

Run in Terminal.app (or iTerm2), NOT through an agent's pty. Enable mouse
tracking for the session: `TRE_MOUSE=1 tre. tui` (or set `"mouse": true` in
`~/.tre/tui.json`). Record PASS/FAIL per step; the feature is DONE when all
pass and the results are noted here with a date.

1. **Drag selects.** Click-drag across a few lines of streamed output → a
   visible tre.-owned highlight appears (SEL_BG gray). Terminal.app's native
   selection does NOT appear at the same time.
2. **`/copy` is exact.** Type `/copy` (the selection stays highlighted; the
   input line clears). In a separate shell: `pbpaste` → the clipboard
   contains EXACTLY the selected text (compare against the rendered lines,
   including a wrapped line and a line with a `◆`/`│` gutter prefix).
3. **Empty selection fails safely.** `/copy` with nothing selected → a clear
   message, no crash, the TUI keeps running.
4. **Controls are not hijacked.** With mouse tracking on: typing, Enter,
   ↑/↓ history, an approval prompt (y/n/esc), the model picker, Ctrl+C
   (abort / quit) and `/quit` all behave as in no-mouse mode.
5. **Resize + redraw.** Resize the window mid-selection → the selection
   clears (no stale highlight); scroll the output → the selection tracks the
   content, not the viewport.
6. **Modes restored on exit.** `grep -c 

- Terminal mouse protocols deliver cell coordinates, not OS text-selection semantics; tre. must maintain its own mapping from visible cells to content offsets.
- Terminal rendering includes styled spans, Unicode width complexities, clipped items, and streaming updates; incorrect mapping can highlight or copy the wrong text.
- macOS Terminal.app may report modifier keys differently from other terminals; do not assume Cmd/Option mappings.
- Clipboard mechanisms differ locally and over SSH/tmux. `pbcopy` is local-only; OSC 52 has security and intermediary-policy concerns.
- The current `1002` mode reports held motion and can create event volume during drags. Coalescing visual highlight updates may be required while preserving responsive selection.
- The exact copy shortcut, selection scope, word/line selection, autoscroll, and OSC 52 support remain product decisions; resolve before implementation increments 3–4.
\x1b[?1002l'`-style check: after
   quitting, Terminal.app's native highlight-and-copy works again (the 1002/
   1006 modes were turned off — the PTY e2e asserts the escape sequences;
   this step asserts the user-visible effect).
7. **Repeat in no-mouse mode** (`TRE_NO_MOUSE=1 tre. tui`): native
   highlight-and-copy works, wheel scrolling still works, no 1002/1006 bytes
   (e2e scenario 18 pins the bytes; this step is the user-visible check).

## Risks / open decisions

- Terminal mouse protocols deliver cell coordinates, not OS text-selection semantics; tre. must maintain its own mapping from visible cells to content offsets.
- Terminal rendering includes styled spans, Unicode width complexities, clipped items, and streaming updates; incorrect mapping can highlight or copy the wrong text.
- macOS Terminal.app may report modifier keys differently from other terminals; do not assume Cmd/Option mappings.
- Clipboard mechanisms differ locally and over SSH/tmux. `pbcopy` is local-only; OSC 52 has security and intermediary-policy concerns.
- The current `1002` mode reports held motion and can create event volume during drags. Coalescing visual highlight updates may be required while preserving responsive selection.
- The exact copy shortcut, selection scope, word/line selection, autoscroll, and OSC 52 support remain product decisions; resolve before implementation increments 3–4.
