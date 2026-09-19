# D14 — Pinned input layout (RESUME DOC)

**Status: PAUSED 2026-09-18 ~13:00Z (21:00 local).** No D14 code exists yet. This doc is self-contained — a future session can execute the resume steps without re-deriving anything.

## Goal (user request, verbatim intent)

Dedicated typing section at a CONSTANT location: input line exactly **4 lines above the bottom of the terminal**, a **U+2500 separator immediately above AND below** it, the **lower 3 lines reserved** (blank for now — future status info), and agent output filling the unreserved rows above (trimmed from the top when it doesn't fit).

## Design (verified against Ink 7.1.1 internals — do not re-derive)

```
row 1      header: "model — turn N · working…"
rows 2..   output items (top-trimmed so the frame never exceeds rows)
           pad lines (single-space <Text>)
           [approval question line, 1 line, only when pending]
rows H-7   hint line (dim)
row  H-6   top separator "─"×width
row  H-5   INPUT LINE  ("you <input>")  ← exactly 4 above bottom
row  H-4   bottom separator "─"×width
rows H-3..H  3× reserved blank lines
```
Frame height == terminal `rows` **always** (by construction). When `rows` < 9, frame may exceed rows — degenerate, Ink scrolls, bottom stays pinned (acceptable).

### Verified Ink facts (checked in `node_modules/ink/build/`)
- Final frame is wrapped by `wrapAnsi(output, terminalWidth, {trim:false, hard:true})`; per-`<Text>` layout wrapping uses the SAME options. ⇒ a plain full-width `<Text>{t}</Text>` renders exactly `wrapAnsi(t, width, {trim:false,hard:true}).split('\n').length` lines. Our height math must use this exact call.
- Frame `height >= rows` ⇒ "fullscreen": frame bottom = screen bottom, no trailing newline, **no full-clear flicker while height stays == rows**; `height > rows` ⇒ full clear + scroll (top scrolls off, bottom pinned). ⇒ keep frame exactly == rows.
- Ink effective size = `stdout.columns/rows` with 80×24 fallback (`utils.js getWindowSize`). e2e PTY (winsize 0×0) ⇒ effective **80×24**. Ink re-renders on stdout `resize` (built-in).
- `ink-testing-library` fake stdout: `columns` getter = **100**, NO `rows` property ⇒ effective **100×24**; `debug:true` writes full frames; `lastFrame()` may end with trailing `'\n'` — strip one before splitting.
- The ONLY multi-segment line is the user item: cyan `you` prefix (4 cols on line 1 only) → its text wraps at `width-4`.
- Never render an empty `<Text>` (padding uses a single space).

### Exact API to add to `src/tui/state.ts` (append; existing exports untouched)
```ts
import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';

export const RESERVED_BOTTOM_LINES = 3;
export const PINNED_LINES = 6;          // top sep + input + bottom sep + reserved
export const FIXED_NON_ITEM_LINES = 8;  // header(1) + hint(1) + PINNED_LINES(6)

export function wrapLineCount(text: string, width: number): number;
// '' -> 0; else wrapAnsi(text, max(1,width), {trim:false,hard:true}).split('\n').length

export function itemHeight(item: TuiItem, width: number): number;
// user: text ? wrapAnsi(text, width-4, {trim:false,hard:true}).split('\n').length : 1
// assistant: (thinking?1:0) + (text ? wrapLineCount(text,width) : 0)
// tool: mark = resultText!==undefined ? (isError?'✗':'✓') : running?'→':'·'
//   wrapLineCount(`${mark} ${name} ${args}`, width)
//   + Σ non-empty diff lines wrapLineCount(line, width)
//   + (resultText!==undefined ? wrapLineCount(`${mark} ${resultText}`, width) : 0)
// compaction / error: wrapLineCount(text, width)

export function itemsHeight(items: TuiItem[], width: number): number;

export function fitItems(items: TuiItem[], width: number, rows: number, hasApproval: boolean)
  : { visible: TuiItem[]; pad: number };
// budget = rows - FIXED_NON_ITEM_LINES - (hasApproval?1:0), clamped >= 1
// keep longest TAIL with itemsHeight <= budget; if only the last fits -> keep just it;
// if even the last alone exceeds -> keep just it, pad 0 (frame may exceed rows; Ink scrolls)
// pad = max(0, budget - itemsHeight(visible))

export function inputText(input: string, width: number): string;
// '' -> ''; else cliTruncate(input, max(1, width-4), {position:'start'})  (keep TAIL)

export function approvalLine(question: string, width: number): string;
// cliTruncate(question + ' [y/N]', width, {position:'end'})
```

### Renderer (`src/tui/app.tsx`, presentational only; key handling/exit/`Item` unchanged)
```tsx
import { useStdout } from 'ink';
const stdout = useStdout();
const width = stdout.columns > 0 ? stdout.columns : 80;   // MUST mirror Ink fallbacks
const rows  = stdout.rows  > 0 ? stdout.rows  : 24;
const layout = fitItems(state.items, width, rows, state.approval !== undefined);
const oneLine = (s: string, w: number) => cliTruncate(s, w, { position: 'end' });
// frame, top→bottom, root <Box flexDirection="column">:
//   <Text dimColor>{oneLine(headerText(state), width)}</Text>
//   {layout.visible.map((item, i) => <Item key={i} item={item} />)}
//   {Array.from({length: layout.pad}, (_, i) => <Text key={`pad-${i}`}> </Text>)}
//   {state.approval && <Text color="yellow">{approvalLine(state.approval.question, width)}</Text>}
//   <Text dimColor>{oneLine(footerHint(state), width)}</Text>
//   <Text color="gray">{'─'.repeat(width)}</Text>
//   <Box><Text color="cyan">you</Text> <Text>{inputText(state.input, width)}</Text></Box>
//   <Text color="gray">{'─'.repeat(width)}</Text>
//   3× <Text key={`reserved-${i}`}> </Text>
```
Proof frame == rows: 1 + visible + pad + (0/1) + 1 + 1 + 1 + 1 + 3.

### Tests (new file `test/tui-pinned-layout.test.ts`; node:test + ink-testing-library, imports like `test/tui-app.test.tsx`)
- wrapLineCount: `''`→0; `'hi'`@80→1; `'word '.repeat(20)`@80→2; `'x'.repeat(200)`@80→3 (hard wrap).
- itemHeight per kind @80: user `'x'.repeat(200)`→3 (wraps at 76); assistant thinking+200×'x'→3; tool running 100×'a' args→2; tool with 10 diff lines + resultText; compaction 1; error 1.
- fitItems @rows=24: short items → pad = 16 − itemsHeight; 30×5-line items → TAIL kept, ≤16, pad≥0, newest last; hasApproval shrinks budget by 1; single 50-line item → visible=[it], pad=0.
- inputText: `''`→`''`; `'hello'`@80→`'hello'`; `'x'.repeat(300)`@80 → width ≤76, ends with `'xxxxx'`, contains ellipsis.
- approvalLine: width ≤40 (1 line), ends `[y/N]`.
- **App render geometry** (fake 100×24): render `<App state onInput={()=>{}} onQuit={()=>{}}/>`; `lines = lastFrame().replace(/\n$/,'').split('\n')`; assert `lines.length===24`; `lines[0]` has header; `lines[19]` starts `you`; `lines[18]===lines[20]==='─'.repeat(100)`; `lines[21..23]` each `=== ' '`; `lines[17]` contains `enter send`; approval pending → `lines[16]` ends `[y/N]`; 200×'x' assistant item → frame still exactly 24 lines, `lines[19]` still `you` (pad shrank).

### e2e `scenario_14` (append to `test/e2e.sh`, style of `scenario_12`; helpers in `test/e2e-feederlib.sh`; add `14` to NAMES + case dispatcher; use default `$MODELS` = radeon endpoint 172.30.70.13)
- feed.sh: `printf 'Reply with exactly: PONG-14\r'` + `wait_turn_done "$SESS" 440 || true` + `sleep 3` + `quit_retry`
- assertions: raw out.log contains `PONG-14`; after ANSI strip (`sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b[()][0-9A-B]//g'`), **tail -7** of stripped log = [hint (`enter send`), `^─+$`, `^you`, `^─+$`, 3× blank/space].

## State at pause

**Done**
- Deps installed: `package.json`/`package-lock.json` now have `wrap-ansi@^10.0.1`, `cli-truncate@^6.1.1` (WS-A did `npm install` before dying).
- Pre-change snapshots in `.history/snapshots/…/20260918T035813Z`: `src/tui/state.ts`, `src/tui/app.tsx`, `test/tui-state.test.ts`, `test/tui-app.test.tsx`, `test/e2e.sh`, `package.json`, `package-lock.json`, `HANDOFF.md` (logged in `.history/CHANGELOG.md`).
- Farm spec with full task texts: **`/tmp/farm-d14/spec.json`** (run dir `/tmp/farm-d14/run1/`).

**Wave-1 farm result (2 lanes, 27B Qwen3.8 both) — NO CODE PRODUCED**
- `wsa-impl` (nvidia): **exit 1** — `.err`: `Context size has been exceeded.` The agent's own context blew past the 131K cap (it was instructed to read several full files incl. e2e.sh); nvidia server logged the same errors. Only `npm install` completed.
- `wsb-tests` (radeon): exit 0, **zero artifacts** (no stdout, no `test/tui-pinned-layout.test.ts`, no e2e/HANDOFF changes) — 27B flakiness; the farm has NO artifact verification, so this sailed through as "ok". (Farm gap to fix later: verify the report file exists / non-empty stdout.)

**NOT started**: all D14 code, all D14 tests, HANDOFF D14 section, e2e s14.

**Pre-existing in the tree (NOT D14 — do not touch or commit)**: uncommitted D13 work — `src/tools/safety.ts`, `src/cli/main.ts`, `test/safety.test.ts`, `test/cli.test.ts`, `models.json`, `HANDOFF.md`, `PLAN.md` (D13 workspace-scoped approval; last green: 246 unit tests).

## Infra notes (observed 2026-09-18)
- Both LLM servers healthy at pause (probes OK: nvidia 172.30.70.11, radeon 172.30.70.13; both pinned Qwen3.8-27B).
- **nvidia MTP bug**: 6× `got exception: speculative batch index 4 is not inside the current sub-batch [0, 4)` in 8h of nvidia logs (radeon: 0). llama.cpp MTP draft-acceptance bug → intermittent 500s on one request (nvidia has MTP n_max=3 from the parent session). Mitigations if it recurs during farm runs: lower/disable nvidia MTP (`llama-perf params --cluster nvidia`), or just retry the workstream.
- **Context budget is the real constraint for 27B farm agents**: nvidia ctx 131K is not enough for "read 5 full files + implement + run tests". Keep farm task tool-output small (read in ranges, `grep -n`/`sed -n` instead of whole-file cats, avoid `npm install` output).

## Resume steps

1. `python3 ~/.pi/agent/skills/gpu-farm/scripts/farm status` — confirm both lanes idle/healthy.
2. Re-run wave 1. Two options:
   - **A (simpler)**: reuse `/tmp/farm-d14/spec.json` as-is, but prepend to BOTH tasks: "Context budget: keep cumulative tool output under ~40K chars; read files with sed -n ranges, never whole files over 200 lines; never cat node_modules."
   - **B (safer, 3 waves)**: split WS-A into `state.ts functions` (wave 1, with WS-B) → `app.tsx renderer` (wave 2) → `test updates + npm test green` (wave 2 or 3). Each task < 15K chars of context.
3. Integration (orchestrator, cloud model — no GPU): `npm test`; fix any seam drift between WS-A impl and WS-B tests (API is fixed by this doc — drift should be minimal).
4. e2e: run scenarios `01`, `12`, `14` (they hit the radeon endpoint; run the e2e agent on the nvidia lane, or solo from the orchestrator). Expect ~10–25 min.
5. Write the HANDOFF D14 section (WS-B never wrote it; content per its task in the spec: change summary + design facts + verification status) and mark this doc DONE.
6. User decision: whether to commit D13 (+D14) — the tree is dirty from 2026-09-14.
7. Optional follow-ups (user's call): farm artifact-verification fix; nvidia MTP decision; the 3 reserved lines get their future content (D15?).

## Paths
- This doc: `~/projects/coding-agent/D14-RESUME.md`
- Farm spec (full task texts): `/tmp/farm-d14/spec.json` (may be gone after reboot — the design section above is the source of truth)
- Wave-1 run dir: `/tmp/farm-d14/run1/`
- Snapshots: `.history/snapshots/<file>/20260918T035813Z`
- TUI source: `src/tui/{state.ts,app.tsx,diff.ts,run.tsx}` · unit tests `test/tui-*.test.*` · e2e `test/e2e.sh` + `test/e2e-feederlib.sh`
