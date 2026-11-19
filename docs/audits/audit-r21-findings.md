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
