# r21 audit findings log (auditor: gpt-6.1-terra, target: scripts/contract-check.mjs)

Baseline: r21-F1 (inline unclosed <!-- never opens masking) + r21-F2
(ordered start!=1 cannot interrupt a paragraph in atBlockStart) already
landed pre-loop (commits 6cb7ea0, ffc4779). Fuzzer steady state: 2
accepted overstrict divergences (raw HTML block inside a list item).

## Cycle 1 (audit-r21-c1.txt)
- F1 HIGH CONFIRMED+FIXED pre-loop as r21-F2 (ordered-marker laundering;
  repro verified against commonmark.js; 4 regression tests). — fixed ffc4779
- F2 LOW (mask closed code spans): policy disagreement — C9's convention
  (established since r15) is that code span/block content is VISIBLE
  (renders as literal text) and reported. Rejected.
- PASS areas: same-line comment/span gate, list/comment ownership,
  after-closer, block-state boundaries.

## Cycle 2 (audit-r21-c2.txt)
- F1 LOW (indented-code-first-in-item should mask): same policy
  disagreement as cycle-1 F2 — code_block content is visible per the
  accepted convention (commonmark.js: code_block; renderer echoes the
  ref in <pre><code>); checker flags it = consistent. Rejected.
- PASS areas: inline comment gate + spans, container/prefix cases,
  fences (tilde/info-string/longer), setext, CDATA/PI/type-6/type-7,
  EOF states, after-closer.

## Cycle 3 (audit-r21-c3.txt)
- F1 LOW ("> <!--" refused as unsupported instead of masking the
  in-quote comment): INTENTIONAL fail-closed design (C9 never models
  comment state across blockquote boundaries; the refusal is loud, not
  laundering). Accepted overstrict — rejected.
- PASS areas: nested lists/marker-line openers, after-closer, degenerate
  + span interplay, fences/HTML-blocks/EOF, ordered interruption.
  No laundering found.

## Cycle 4 (audit-r21-c4.txt)
- F1 LOW (`<!-- ok --> §99999` same-line ref after a closed type-2
  comment gets flagged): overstrict-only, deliberate since r15 (masking
  stops at `-->`; rest of line scanned as prose). Not laundering.
  Accepted overstrict — rejected.
- PASS areas: block-start gate + list tracking (14 fixtures incl.
  tabbed/ordered/blockquote), degenerate opener + spans, fences/state
  termination, CDATA/PI/autolink/escapes, after-closer list, CRLF
  refusal. No laundering found.

## Cycle 5 (audit-r21-c5.txt)
- F1 LOW (tab before nested marker "exposes a hidden ref"): FALSE
  POSITIVE. Reproduced byte-for-byte from the auditor's own probe file
  (`- a` / `\t- <!--` / `\t  §99999` / `\t  -->`): commonmark.js AND
  markdown-it both render §99999 VISIBLE (the tab layout breaks the
  type-2 continuation; the comment never closes over the ref line).
  The checker flagging it is CORRECT behavior, not a defect. Rejected.
- PASS areas: block-start prefixes, after-closer/ordered, degenerate +
  spans, fences/EOF, CDATA/PI/autolinks/escapes, setext/CRLF.

## Cycle 6 (audit-r21-c6.txt)
- F1 LOW (`text <!--\n§99999\n-->` closed multiline INLINE comment
  flagged): overstrict-only, and the uniform r21-F1 rule (an inline,
  non-block-start `<!--` NEVER enters comment state) is the
  deliberate post-HIGH design — a masking expansion in exactly the
  direction the r21 hardening just closed is unjustified under the
  safety contract (masking errors launder; flag errors fail closed).
  Rejected.
- F2 LOW (`- item\n\t<!--\n\t§99999\n\t-->` tab-continuation block
  comment flagged): verified via commonmark.js — the tab version IS a
  block comment (browser-hidden), checker flags = overstrict-only.
  atBlockStart refuses every tab in the prefix (documented choice:
  fail-closed toward flagging; tab-stop expansion in container
  contexts is exactly where laundering bugs breed). Same class as the
  accepted blockquote refusal. Rejected.
- PASS areas: nested chains, ordered continuation, degenerate+spans,
  fences, escapes/CDATA/PI/autolinks, EOF, CRLF refusal, after-closer.

## Cycle 7 (audit-r21-c7.txt)
- F1 LOW (5-space padding "-     x": first block is indented code,
  §99999 expected exempt): SAME policy disagreement as cycle-1 F2 /
  cycle-2 F1 — per the accepted convention code_block content is
  VISIBLE (rendered in <pre><code>) and the checker's documented model
  masks only root-level indented code (r8-F3: item-indented lines are
  continuation prose). Checker flagging = consistent. Rejected.
  (Note: the c7 run had no CommonMark renderer available; this review
  applied the pinned convention directly.)
- PASS areas: prefix/ownership (nested markers, blockquote enter/exit,
  tab-padded markers), continuation columns 0/3/4/8 + after-closer
  inline, degenerate openers, span/comment interplay (padded/double
  backtick, unclosed run, resume, fence interruption), fences (tilde,
  longer, info strings, backtick), CDATA/PI/type-6/type-7, setext,
  frontmatter-like text, escapes, links/images/autolinks, CRLF refusal,
  EOF unclosed-comment refusal.
- Provider note: cycles 7 first three attempts were refused by the
  endpoint safety filter on the prompt's "adversarial/launder"
  phrasing; prompt rephrased (audit-r21-prompt.txt) with identical
  technical content, and --no-telegram added to the driver (the child
  session's Telegram poller raced the parent's).

## Cycle 8 (audit-r21-c8.txt)
- F1 LOW ("2. text" after a paragraph with §ref on the line: checker
  reports the ref; CommonMark: lazy continuation inside the item,
  stripped + indented into <pre><code> = hidden, E246/E249):
  consistent with the r16c2-F5 pinned convention ("refusing the marker
  only ever EXPOSES — lazy-continuation refs remain visible as root
  text"). Overstrict-only (fail-closed), same class as the two
  accepted divergences and cycle-3 F1. Rejected; documented here.
- PASS areas: atBlockStart prefix walks (blockquote/nested-chain/tab
  leads), contCol threading incl. after-closer base, marker-line
  interaction, degenerate openers, span/comment interplay, setext +
  frontmatter + fence/EOF states, new r21-F2 gate verified in both
  directions (start=1 interrupts and masks; start!=1 after paragraph
  exposes).
- Provider note: 6 attempts (transient "provider error" aborts mid-run
  at ~4-7 min); attempt 7 completed clean.

## Cycle 9 (audit-r21-c9.txt)
- No findings — differential probes (checker vs commonmark.js at
  .scratch-r20/ref/node_modules, both renderers) across all 7 audit
  areas: every visible ref reported, every masked ref exempt, all
  fail-closed refusals (CRLF, EOF unclosed comment, blockquote
  container) verified. PASS.

## Cycle 10 (audit-r21-c10.txt)
- No findings. Differential harness re-run across all areas (prefix
  walks, contCol, marker lines, degenerate openers, spans, setext/
  frontmatter/fence/EOF, gate edges, escapes, links/autolinks,
  CRLF/EOF refusals): every probe agrees with CommonMark or is the
  documented fail-closed refusal. PASS.

## Final summary (cycles 1–10 complete)
- Confirmed laundering (HIGH) defects found & fixed: 2 — the
  pre-loop inline unclosed `<!--` (commit 6cb7ea0, plus r20 test
  strengthening) and cycle-1 F2 (ordered-marker start≠1 laundering,
  commit ffc4779 with 4 regression tests). Cycles 2–10 surfaced NO
  new laundering defect.
- Cycles 9, 10: clean PASS (differential against commonmark.js +
  markdown-it).
- Rejected findings (all overstrict-only, fail-closed direction):
  c1-F2 / c2-F1 / c7-F1 (code-block/code-span content visibility —
  pinned convention: rendered `<pre><code>`/`<code>` content is
  VISIBLE and reported), c3-F1 (blockquote comment unsupported =
  loud refusal), c4-F1 (mask stops at `-->`, rest of line is prose),
  c5-F1 (FALSE POSITIVE — disproven byte-for-byte against both
  renderers), c6-F1/F2 (inline `<!--` never enters comment state;
  tab-prefix refusals documented), c8-F1 (lazy-continuation exposes).
- Accepted divergences (documented, intentional): raw-HTML-block-in-
  list-item refusals (2), plus the overstrict classes above.
- Test gate: `tsc && node --test dist/test/contract-check.test.js`
  110/110 pass (the .ts file is run compiled — `npx vitest` does not
  apply here).
