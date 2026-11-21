#!/usr/bin/env node
// contract-check.mjs — deterministic consistency gate for the G2–G5 contract
// (docs/11-orchestrator-schema.md). Built after the v31 audit (option D of the
// 2026-11-18 assessment): the terra arc's recurring defect classes were
//   (1) patch-induced contradiction (a fix edited one passage; other passages
//       stating the same invariant were left standing),
//   (2) rules referencing enum members / record kinds never declared,
//   (3) ledger formatting drift,
// all mechanically detectable without an LLM round. This script turns those
// classes into a ratchet: each check passes on the v34 baseline; any fold that
// breaks one fails the quality gate BEFORE an auditor is paid to find it.
//
// v35 (c28 self-audit): the c27 original was audited against its own claims
// and six findings were confirmed by mutation probes; all are fixed here:
//   A1 version checks are SECTION-SCOPED (per-section status version,
//      per-section (vN: sub-note) instead of whole-document string presence;
//      the date is no longer hard-coded — a date bump can neither fake-pass
//      nor false-fail).
//   A3 pins carry their HOME SECTION and are checked against comment-stripped
//      section text (deleting a pinned rule and hiding the sentence in an
//      HTML comment elsewhere no longer passes).
//   A4 the CURRENT ledger row is identified UNIQUENESS-FIRST: exactly one
//      row may carry the `(vN` current-version marker and it must show
//      DECISIONS-REQUIRED: 0 (the rows are workstream-grouped, NOT globally
//      prepended, so row order is not load-bearing); terminators must be
//      UNESCAPED `|`.
//   A6 allowlist self-validation: every allow entry must still exist in the
//      document — a stale allowlist entry is a failure, so silently deleting
//      a declaration cannot keep laundering its term.
//   C2 strengthening (mutation-probe confirmed): the `DRAFT vN (` header
//      token is MASKED before a section's citation search, so a section
//      whose current-fold citation is missing fails even when its header
//      was bumped.
//   All probes now live as a permanent suite: test/contract-check.test.ts
//      (15 mutation probes: each plants one fault in a copy of the schema
//      and asserts the named check FIRES; the suite itself caught two
//      laundered-check gaps and one probe-slice bug during c28).
//
//   C9 cross-reference resolution: every `§N(.M)` citation in BODY text must
//      resolve to a heading in this document (or be locally excusable:
//      §0.<n> = a §0 standing principle; a §ref on a line naming docs/NN is
//      an external anchor). Change Ledger rows are exempt — they are
//      historical statements citing sections as they were at fold time, not
//      live cross-references.
//   C9 v2 (c35 terra audits, 2 rounds / 10 findings, all closed — probes
//      F1..F7 + r2-F1..F3):
//      headings + scan run on comment-STRIPPED text (faked `### x` in a
//      comment resolves nothing; retired refs in comments no longer fail);
//      an UNCLOSED <!-- fails the gate (a truncated scan must not pass);
//      ledger exemption SCOPE-BOUND to §1 (planted date-shaped body rows
//      are scanned); §0 exemption is by ACTUAL principle ID (renumbering
//      breaks it; two-digit principle 10 works); external exemption is a
//      strict CHAIN GRAMMAR (docs/<path>§ref adjacency or "anchor":"§) —
//      a planted distant docs/ mention launders nothing; refs are matched
//      FULL-TOKEN with junk capture (§0.1e3 → malformed flag, never a
//      partial exemption). Headings/refs accept the doc's letter-suffix
//      sections (#### 14.12.4b).
// Remaining known boundary: refs in non-ledger table rows (section index,
// P-table) are live cross-references and scanned as such — correct.
//
// KNOWN LIMIT (deliberate spec boundary, c28 A2/A5 triage): the kind-shaped
// ratchet covers THREE-plus-component kebab terms only. Two-component terms
// (`owner-act`, `group-plan`, …) mix record kinds with value-enum members and
// field names; mechanically distinguishing them requires an authored record-
// kind inventory (a spec decision the contract has not made). Until that
// inventory exists, new two-component terms are ratcheted by the Change
// Ledger + human/auditor review, not by C7. Likewise C8 pins guard against
// DELETION/relocation, not against a negating sentence wrapped around them.
//
// Usage:  node scripts/contract-check.mjs [path-to-schema]
// Exit:   0 = all checks pass, 1 = violations (printed), 2 = usage/IO error.
// Stdlib only; never writes; safe inside the sandbox (same rules as check-deps).

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "docs/11-orchestrator-schema.md";
let s;
try {
  s = readFileSync(path, "utf8");
} catch (e) {
  console.error(`contract-check: cannot read ${path}: ${e.message}`);
  process.exit(2);
}

const fails = [];
const ok = [];
function check(name, pass, detail) {
  (pass ? ok : fails).push(pass ? name : `${name}${detail ? ` — ${detail}` : ""}`);
}
const strip = (t) => t.replace(/\s+/g, " ");
// Comment stripping for normative-text checks: an HTML comment is not norm.
const stripComments = (t) => t.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");

// ---------------------------------------------------------------------------
// THE masking model (c35 terra round-4: ONE sequential character scan is the
// single source of truth for what is live text — C9 AND the section map for
// C1/C2/C8 consume it, so no check can diverge from another's idea of
// "comment" or "fence"):
//   State order: comment FIRST, then fence. A ``` inside an open <!-- --> is
//   comment text and starts no fence; a --> inside a fence closes no
//   comment. A line that merely EXITS a comment cannot start a fence (its
//   remainder is text). Fence pairing remembers the opener character and
//   run length (closer: same char, run >= opener, only trailing spaces/
//   tabs, indent <= 3); backtick fences take no backtick in the info
//   string. Inline code spans are run-LENGTH-AWARE (a span opened by N
//   backticks closes only on a run of exactly N) and copied VERBATIM —
//   markers inside them are literal text, refs inside them stay live.
//   Backslash escapes copy two chars. Unclosed comment or fence at EOF
//   FAILS (silently masking the document tail is the laundromat).
//   Round-7: ANY CR (lone OR CRLF) FAILS — the line model is \n-only and
//   a CR riding inside masked/live text breaks the byte-exact contract.
//   A pending multi-line span is INTERRUPTED by a heading (r7-F2): the
//   stray opener dies, the heading line is processed normally. A
//   blockquote fence auto-closes when the blockquote ends (r7-F3) and
//   every fence-state variable resets on every close path. Indented
//   code blocks (4+ spaces / tab right after a blank line) are masked
//   to the end of the indented run (r7-F6, documented exclusion).
const scanModel = (text) => {
  // r15c3-F2 (audit HIGH): per-line SPAN-CONTENT ranges in MASKED
  // coordinates (parallel to outLines). C9 refuses the docs/ external
  // exemption for a ref whose "§" or path start lies inside a span —
  // span content is literal text, never a prose chain. Ranges include
  // the delimiter runs. null = the line carries no span content.
  const spanRanges = [];
  const issues = [];
  // Round-7 F5: stated policy is refuse ANY CR — lone OR part of CRLF.
  // The line model is \n-only; CRLF would let \r ride along inside
  // masked/live text and (regex-wise) a $-anchored grammar could see a
  // CR-hidden trailing char. Byte-exact contract: \n endings only.
  if (/\r/.test(text)) issues.push("carriage return (\\r): C9's line model refuses ANY CR (\\n-only byte contract, incl. CRLF)");
  // r6-F1: JS multiline ^ ALSO treats U+2028/U+2029 as line boundaries
  // while this scanner splits \n only. They are MASKED to spaces in the
  // output (column-preserving): text after a mid-line separator can
  // never anchor ^ as a phantom heading in the masked text, and
  // legitimate CONTENT use of these codepoints (prose "C\u2028D") stays
  // harmless. Lone \r stays fail-closed (whole-line model breaks).
  const lines = text.split("\n");
  const outLines = [];
  // r15c3-F2: parallel per-line span-content ranges (masked coords).
  // Set by the loop before each pushLine via this line's collector.
  // curShift: the r15c2-F1 >=4-column pad injected before an opener
  // hole (shifts masked coords of everything after it by pad-1);
  // curCmtPad: the r12-F3 comment-open pad (shifts by +3 when active).
  let curRanges = [];
  let curShift = 0;
  let curCmtPad = false;
  const pushLine = (out) => { outLines.push(out); spanRanges.push(curRanges); curRanges = []; curShift = 0; curCmtPad = false; };
  let inComment = false, inFence = false, fenceChar = "", fenceLen = 0, fenceIndent = 0, fenceBq = false, fenceBqDepth = 0, fenceListCol = -1;
  let spanRun = 0; // r6-F2: open multi-line inline span (required closer run)
  const findRun = (str, from, n) => {
    // r16-F2 (audit MED, r8-F2 REVERSED): CommonMark §6.1 — backslash
    // escapes do NOT operate inside code spans: "`a \` b`" is one span.
    // The old escape-skip refused to close on the escaped run, so
    // "`a \` <!--" never closed the span and laundered every following
    // line under a phantom comment. Backticks are inert for every
    // downstream consumer of the masked text, so closing on escaped
    // runs is both exact and safe.
    for (let j = from; j < str.length; j++) {
      if (str[j] === "`") {
        let m = 0;
        while (str[j + m] === "`") m++;
        if (m === n) return j;
        j += m - 1;
      }
    }
    return -1;
  };
  // r16-F1/F4 (audit HIGH/MED): CommonMark §4.6 HTML blocks. A top-level
  // line starting a raw-HTML block swallows following lines as LITERAL
  // block content — an HTML block is not Markdown, so a "<!--" inside a
  // <div> block is NOT a comment opener and a visible paragraph after
  // the block's blank-line end must not be masked under a phantom
  // comment (the laundry: "<div>\n<!--\n\n§ref visible\n-->" reported
  // OK). Types modelled: 1 (<script|pre|style|textarea>, closes on the
  // closing TAG — r16A-F2: "</scripture>" must NOT close <script>, so
  // the continuation needle is anchored by a TAG-END regex, not a raw
  // substring), 3 (<? … ?>), 4 (<!A… >), 5 (<![CDATA[ … ]]>), 6/7
  // (known tag / lone complete tag, close at a blank line). Line-leading
  // "<!--" stays on the existing comment path (type 2, EOF fail-closed).
  // r16A-F1 (audit HIGH): the old regex made ">" optional and searched
  // the delimiter over the whole rest of the line, so malformed tags
  // masked following prose — a launder route. Current rules by type:
  // type 6 is a PREFIX rule (known name + whitespace, ">", "/>", or EOL,
  // so a bare "<div" at end-of-line DOES open a block); type 7 needs a
  // COMPLETE open or closing tag ("<foo" alone is not type 7); "<div!x>"
  // is not an opener of any type.
  // Type 1 requires the name followed by whitespace, ">", or EOL (NOT
  // "/": "<script/>" is type 7 at most). Type 6 requires the name
  // followed by whitespace, ">", "/>", or EOL. Type 7 requires a full
  // open tag or closing tag with no trailing text.
  // Start is detected ONLY at root context (no open list item, no quote
  // prefix, indent < 4) — see the fail-closed guard at the open site.
  let htmlType = 0, htmlNeedle = "";
  const HTML_KNOWN = /^(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|optgroup|option|ol|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
  // r16A-F1: for type 7 the opener tag must be CLOSED (">" or "/>")
  // right after its name or attributes — the delimiter is anchored
  // directly after the tag, not searched anywhere in the remainder.
  // r16c2-F2 (audit LOW): a bare "/" is a namespace separator in tag
  // syntax ("<div/x" is junk, never an opener). Note that EOL is a
  // valid terminator for type 6 ("<div" alone opens a block) but NOT
  // for a type-7 tag, which needs its ">" on the line.
  // r16c2-F4 (audit MED): TYPE 7 needs a FULL open-tag grammar — "<"
  // tag-name, attributes (each: whitespace-run + attribute with optional
  // whitespace around "=" and an unquoted / single- / double-quoted
  // value), optional whitespace, optional "/", ">". "<foo attr="x">" is
  // a complete tag: a type-7 opener (a lone tag on its own line). Type 6
  // is a prefix rule (see above) and does not use this grammar. Types
  // 3–5 have their own fixed-delimiter openers ("<?", "<!" + letter,
  // "<![CDATA[") and are not governed by the tag grammar.
  // r17-F1/F3 (audit HIGH, cycle-1): OPEN-tag and CLOSE-tag are SEPARATE
  // CommonMark productions. An open tag is "<" name attr* ws* ["/"] ">";
  // a closing tag is "</" name ws* ">" — a closing tag carries NO
  // attribute grammar ("</foo x>" is junk text, opens nothing; the old
  // combined regex gave closing tags the attribute grammar and let
  // "</foo x>" mask the following prose). The NAME comes from a capture
  // GROUP (r17-F1: the old strip-the-delimiters regex left
  // 'div class="x"' in the name, so <div class="x"> never matched
  // HTML_KNOWN, fell to type 7 — which a paragraph suppresses — and
  // laundered "paragraph\n<div class=x>\n<!--\n\n§ref").
  const TAG_NAME_SRC = "[A-Za-z][A-Za-z0-9-]*";
  const ATTRS_SRC = "(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:\"[^\"]*\"|'[^']*'|[^\\s\"'=<>`]+))?)*";
  const OPEN_TAG_RE = new RegExp("^<(" + TAG_NAME_SRC + ")(" + ATTRS_SRC + ")[ \\t]*/?>");
  const CLOSE_TAG_RE = new RegExp("^</(" + TAG_NAME_SRC + ")[ \\t]*>");
  const htmlBlockStart = (ln) => {
    // r16c2-F3 (audit MED): the type-1 closer is a COMPLETE closing
    // tag — "</" name + ONLY whitespace + ">": "</script x>" is junk,
    // not a closer (the r16A-F2 needle "[ \t/>]|$" let it close the
    // block mid-document and launder the following text under a
    // phantom comment).
    // r17-F2 (audit HIGH, cycle-1): the type-1 OPENER condition is
    // CommonMark §4.6 exact: the name is followed by whitespace or ">"
    // — WITH trailing content allowed — or EOL ("/" is NOT a
    // delimiter, r19-F1). The old ">$" anchor
    // required ">" at line end, so "<script>foo" never opened the block
    // and a raw "<!--" beneath it became a phantom comment laundering
    // every following line ("<script>foo\n<!--\n</script>\n\n§ref").
    let m = ln.match(/^ {0,3}<(script|pre|style|textarea)(?:[ \t]|>|$)/i);
    if (m) {
      // r18-F3 (audit HIGH, cycle-1): the type-1 END condition is
      // CommonMark §4.6 literal — "line contains an end tag `</script>`,
      // `</pre>`, `</style>`, or `</textarea>`" — it does NOT require
      // the closing name to match the opener. The old per-opener needle
      // kept "<script>" open across "</style>", laundering everything
      // between it and the blank line. The closer is ANY of the four
      // names, and it is LITERAL: no whitespace before ">" (finding 4:
      // "</script >" is NOT an end tag — adjudicated against BOTH
      // reference implementations, commonmark.js and markdown-it
      // commonmark preset, which agree; "</script x>" stays junk per
      // r16c2-F3).
      return { type: 1, needle: /<\/(?:script|pre|style|textarea)>/i };
    }
    if (/^ {0,3}<\?/.test(ln)) return { type: 3, needle: "?>", icase: false };
    if (/^ {0,3}<!\[CDATA\[/.test(ln)) return { type: 5, needle: "]]>", icase: false };
    if (/^ {0,3}<![A-Za-z]/.test(ln)) return { type: 4, needle: ">", icase: false }; // r17: spec says "an ASCII letter" (either case)
    const body = ln.replace(/^ {0,3}/, "");
    // r18-F1 (audit HIGH, cycle-1): type 6 is a PREFIX rule, not a
    // complete-tag rule — §4.6: line begins with "<" or "</" followed
    // by a listed name (case-insensitive), then "a space, a tab, the
    // end of the line, the string `>`, or the string `/>`". The r17
    // code required a full open/close-tag grammar, so "</div x>",
    // "<div class=" and bare "<div" opened nothing and a following
    // raw "<!--" became a phantom comment laundering every line under
    // it. "/>" only as a STRING: "<div/ x>" is junk (spec probe).
    if (/^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|>|\/>|$)/i.test(body)) return { type: 6, needle: null };
    // r18-F2 (audit HIGH, cycle-1): type 7 per §4.6 is a complete
    // OPEN tag (any name except pre/script/style/textarea — those
    // returned type 1 above) OR a complete CLOSING tag, followed by
    // zero or more spaces/tabs and the END OF THE LINE. The r17 code
    // tested the trailing-EOF condition on the closing-tag match only,
    // so "<foo>" (unknown open tag) never started type 7 and its raw
    // content laundered everything to the blank line. Known names
    // already returned type 6 above (types are tried in order, §4.6).
    m = OPEN_TAG_RE.exec(body) ?? CLOSE_TAG_RE.exec(body);
    if (m && /^[ \t]*$/.test(body.slice(m[0].length))) return { type: 7, needle: null };
    return null;
  };
  // r21-F1 (audit HIGH): blockOK — whether this call may transition the
  // document into multiline-comment state. An unclosed "<!--" opens a
  // type-2 HTML comment ONLY as a block-start: at line lead with at most
  // three SPACE characters before it (CommonMark §4.6: a type-2 opener
  // interrupts a paragraph at ≤3 indent; 4+/tab indents are paragraph
  // continuation — ref probe K3_lead4_after_blank/H7_tab_lead — and a
  // "<!--" after a comment closer on the same line is inline content,
  // probe L8_after_closer/H1). The old code set st.inComment for an
  // unclosed "<!--" ANYWHERE on ANY line, laundering everything after
  // e.g. "<!-- a --> <!-- x" under a phantom comment. When the opener is
  // NOT at a block-start its characters mask 1:1 and the scan CONTINUES
  // (the remainder of the line stays live). The two after-delimiter
  // call sites (text following "-->" / following a pending-span closer)
  // pass blockOK=false: their line can no longer be a block-start line.
  // r21-F1 (audit HIGH): test whether index i (a "<!--" occurrence) sits
  // at a CommonMark type-2 HTML-BLOCK start: the prefix must consist of
  // nothing but same-line container openings — a ≤3-space lead, ">"
  // quote markers (each with ≤3 spaces before it), and list markers
  // (each followed by ≥1 space/tab and, as trackList requires, with its
  // content within 4 columns). Anything else in the prefix (a word, a
  // backtick run, a tab or 4+ space indent at root, ≥4 spaces after a
  // marker) means the "<!--" is INLINE paragraph text (or code content),
  // which per both reference implementations never opens a comment block
  // (probes L4/L5/L7/L8 vs L6/L9).
  const atBlockStart = (ln, i, base = 0) => {
    // `base` is the ABSOLUTE content column of the innermost open list
    // item (0 at root): CommonMark's ≤3-space rule applies AFTER the
    // container prefix, so a line-leading "<!--" under an item whose
    // content column is 4 is a type-2 block inside that item (probe D:
    // "  - x\n    <!--" -> html_block), while 4+ columns past the item
    // column is continuation text (probe C: "  - b <!--" at column 8
    // under content 4 -> html_inline, visible).
    let j = 0;
    for (;;) {
      let k = j;
      while (k < i && ln[k] === " ") k++;
      if (k - j > (j === 0 ? base + 3 : 3)) return false; // indented past container + 3: not block-start
      if (k === i) return true;    // prefix exactly consumed at the "<!--"
      if (ln[k] === ">") { j = k + 1; continue; }
      // The lookahead (?=\S) is implicit: at "<!--" the character after
      // the marker gap is always "<". A tab expands to the next stop.
      const m = ln.slice(k, i).match(/^([-+*]|[0-9]{1,9}[.)])([ \t]+)/);
      if (!m) return false;
      // r21-F2 (audit c1 HIGH): the prefix markers must be markers the
      // CONTAINER MODEL actually accepts. CommonMark §4.2: an ordered
      // marker with start ≠ 1 cannot interrupt an open paragraph, so
      // "paragraph\n2. <!--" makes the whole line LAZY PARAGRAPH TEXT
      // (commonmark.js + markdown-it: §99999 below renders visible) —
      // yet this loop accepted the marker and opened masking. Apply the
      // same interruption rule trackList uses (r16-F3): refuse an
      // ordered start ≠ 1 as the FIRST prefix marker while a paragraph
      // is open. Inner markers face a fresh container context (no open
      // paragraph), so the rule is level-0 only — matching trackList,
      // which likewise refuses only at its first push.
      if (j === 0 && paraOpen && m[1][0] >= "0" && m[1][0] <= "9" && Number(m[1].slice(0, -1)) !== 1) return false;
      let cols = 0;
      for (const ch of m[2]) cols = ch === "\t" ? cols + (4 - (cols % 4)) : cols + 1;
      if (cols > 4) return false; // ≥5 cols after marker: content is indented code
      j = k + m[0].length;
    }
  };
  const processText = (ln, st, openSpan, lineBase = 0, collect = false, blockOK = true, contCol = 0) => {
    // r15c3-F2 (audit HIGH): when collect, span-content ranges (in
    // MASKED coordinates: lineBase + local index) are pushed to
    // lineRanges. Closed spans cover delimiters through content; an
    // opener run of a multi-line span covers through the line end
    // (its remainder is span content).
    let res = "", i = 0;
    while (i < ln.length) {
      if (ln[i] === "\\" && i + 1 < ln.length) { res += ln[i] + ln[i + 1]; i += 2; continue; }
      if (ln[i] === "`") {
        let n = 0;
        while (ln[i + n] === "`") n++;
        const close = findRun(ln, i + n, n);
        // r15c3-F2: ranges in MASKED coordinates. Input column ==
        // output column for every processText branch (all copy or mask
        // 1:1); the opener-run pad shifts by <=4 and the end bound
        // (ln.length) still covers any ref in the remainder.
        if (collect) {
          if (close !== -1) curRanges.push([lineBase + i, lineBase + close + n]);
        }
        // r5-F1: an UNCLOSED backtick run MID-LINE is literal text
        // (CommonMark) — the scan CONTINUES past it; a `<!--` later on
        // the line is still a comment opener.
        if (close === -1) {
          // r6-F2: an unclosed run opens a MULTI-LINE span (CommonMark
          // pairs it with the next run of the SAME length, on any later
          // line). Content lines until the closer are never heading/
          // fence/comment material; §refs inside them stay LIVE (spans
          // are norm text). The remainder of the opener line is span
          // content too (copied; `<!--` inside span content is literal).
          if (openSpan) {
            // r15c2-F1 (audit HIGH): the remainder of the OPENER line is
            // span content too — norm text whose §refs stay live. It is
            // copied verbatim (never rescanned, so a `<!--` in it stays
            // literal; it sits mid-line so it can never form a heading).
            // If the opener run sits at column 0 the remainder would land
            // at OUTPUT column 0 and could form a phantom fence/heading
            // ("``~~~" -> "~~~" masking following lines); pad 4 columns so
            // the span content can never start a block construct, while
            // §refs (unanchored regex) stay fully visible.
            st.spanRun = n;
            // r15c3-F2: the copied remainder (hole included) is span
            // content. All processText branches are 1:1, so the input
            // column of the opener == its output column before the
            // r15c2-F1 pad is injected; masked coords of the copied
            // remainder shift by the injected pad only.
            const pad = Math.max(0, 4 - res.length);
            if (collect) curRanges.push([lineBase + i + pad, lineBase + ln.length + pad]);
            // The delimiter run becomes a BACKTICK HOLE (r15c3-F1/F2):
            // deleting it JOINED text across it ("docs/`a §ref" ->
            // "docs/a §ref" fabricated an external-path adjacency), and
            // a SPACE hole at column 0 re-created the prose boundary a
            // glued "`docs/…" never had. A backtick is not a path
            // character under the extPrefix grammar and IS a left
            // boundary, so span content can never satisfy the external
            // exemption; it is also inert for every other downstream
            // consumer of the masked text (section map, ledger rows).
            // Pad BEFORE the hole so it sits at column >= 4: the copied
            // remainder can never start a phantom fence/heading.
            if (res.length < 4) res += " ".repeat(4 - res.length);
            // r15c3-F2: the copied remainder (incl. the hole) is span
            // content. Masked start = input col + injected pad (the pad
            // shifts everything after it); end = end of the line.
            if (collect) curRanges.push([lineBase + i + Math.max(0, 4 - res.length), lineBase + ln.length + 1]);
            res += "`".repeat(n) + ln.slice(i + n); i = ln.length; break;
          }
          res += "`".repeat(n); i += n; continue;
        }
        res += ln.slice(i, close + n); i = close + n; continue;
      }
      if (ln.startsWith("<!--", i)) {
        // r20-F1 (fuzz, 42 laundries): the comment grammar's DEGENERATE
        // forms "<!-->" and "<!--->" are COMPLETE comments whose closer
        // OVERLAPS the opener — "<!-->" contains "-->" at offset 2 (and
        // "<!--->" at 3). The old search from i+4 could never find them,
        // so "<!-->" opened a phantom comment masking the whole rest of
        // the document (fuzz: "<!-->\n§999" — the renderer shows §999 as
        // visible prose). Searching from i+2 is spec-exact: the
        // non-greedy first match "-->" from i+2 exists iff the input is
        // the degenerate complete comment at i (offset 2 <=> "<!-->",
        // offset 3 <=> "<!--->"); every other input's first possible
        // closer is at >= i+4, so the general open/close path is
        // bit-for-bit unchanged. A closed comment masks its characters
        // 1:1 and the scan CONTINUES — the remainder of the line stays
        // live (same-line refs are exposed: the type-2-block reading of
        // a line-leading comment would hide them, and exposing is the
        // safe direction, consistent with closed comments since r5).
        const c = ln.indexOf("-->", i + 2);
        if (c !== -1) { res += " ".repeat(c + 3 - i); i = c + 3; continue; }
        // r21-F1 (audit HIGH): an UNCLOSED "<!--" enters multiline
        // comment state ONLY at a type-2 HTML-block start (CommonMark
        // §4.6: "<!--" at the block-start of the line — at most three
        // leading spaces, or directly after same-line container markers
        // ">"/list markers — where a type-2 block may interrupt). An
        // INLINE unclosed opener is literal paragraph text: both
        // reference implementations (commonmark.js + markdown-it,
        // probes A/C/D/H1/H5/H8/H9/H10/H11/K3/L5/L7/L8) render
        // everything after it as visible prose, while the old
        // unconditional st.inComment laundered the rest of the
        // document under a phantom comment ("para <!-- x\n\n§ref" —
        // the §ref vanished). Not-a-block-start: the four opener
        // characters mask 1:1 and the scan CONTINUES (the remainder of
        // the line and every following line stay live — expose is the
        // safe direction, same rule as the closed-comment branch).
        if (blockOK && atBlockStart(ln, i, contCol)) { st.inComment = true; res += " ".repeat(ln.length - i); i = ln.length; break; }
        res += " ".repeat(4); i += 4; continue;
      }
      res += ln[i]; i++;
    }
    return res;
  };
  // r14-F2 (audit MEDIUM): CommonMark makes inline code spans and fence
  // info strings LITERAL text — "`<!--`" never opens a comment and a
  // fence opener's info string ("> ```html <!-- x") merely CONTAINS the
  // characters. The blockquote comment check must test live text:
  // mask closed spans (delimiters included), drop a fence line's info
  // string, and treat a line inside a pending multi-line span (r6-F2)
  // as span content. An UNCLOSED backtick run is literal (CommonMark) —
  // scanning continues past it so a "<!--" later on the line is still
  // detected (same rule as processText r5-F1).
  const stripLiteral = (txt, pending) => {
    if (pending > 0) {
      const close = findRun(txt, 0, pending);
      if (close === -1) return ""; // whole line is pending-span content
      txt = " ".repeat(close + pending) + txt.slice(close + pending);
    }
    // Fence opener at line start (0-3 space indent): the marker and its
    // info string are literal. A backtick fence carrying a backtick in
    // its info is NOT a fence (CommonMark) — fall through to inline scan.
    const fi = txt.match(/^( {0,3})(`{3,}|~{3,})/);
    if (fi && !(fi[2][0] === "`" && txt.slice(fi[0].length).includes("`"))) {
      return fi[1] + " ".repeat(txt.length - fi[1].length);
    }
    let res = "", i = 0;
    while (i < txt.length) {
      if (txt[i] === "\\" && i + 1 < txt.length) { res += txt[i] + txt[i + 1]; i += 2; continue; }
      if (txt[i] === "`") {
        let n = 0; while (txt[i + n] === "`") n++;
        const close = findRun(txt, i + n, n);
        if (close === -1) { res += "`".repeat(n); i += n; continue; } // literal run
        res += " ".repeat(close + n - i); i = close + n; continue;    // mask whole span
      }
      res += txt[i]; i++;
    }
    return res;
  };
  // Blockquote markers may each be preceded by up to three spaces relative
  // to their container. Return the remaining text and the nesting depth.
  const quotePrefix = (ln) => {
    let rest = ln, depth = 0, m;
    while ((m = rest.match(/^ {0,3}> ?/))) {
      rest = rest.slice(m[0].length);
      depth++;
    }
    return { rest, depth };
  };
  // Fences may open through blockquote prefixes; closer indentation is
  // bounded by three spaces relative to the innermost container.
  const fenceMatch = (ln, expectBq) => {
    let rest = ln, indent = 0, bq = false, depth = 0;
    const lead = rest.match(/^( {0,3})/); if (lead) { indent = lead[1].length; rest = rest.slice(indent); }
    const absIndent = indent; // r10-F2: line column BEFORE any "> " strip (list-tagging)
    if (expectBq) {
      const bp = quotePrefix(ln);
      if (!bp.depth) return null;
      bq = true; rest = bp.rest;
      depth = bp.depth;
      const lead2 = rest.match(/^( {0,3})/); if (lead2) { indent = lead2[1].length; rest = rest.slice(lead2[1].length); }
    }
    const m = rest.match(/^(`{3,}|~{3,})(.*)$/);
    if (!m) return null;
    if (m[1][0] === "`" && m[2].includes("`")) return null;
    return { marker: m[1], indent, absIndent, bq, depth };
  };
  // r11-F1/r12-F1: consume container prefix whitespace exactly up to
  // column `col` (tab stops). A tab that CROSSES the column is consumed
  // PARTIALLY (CommonMark container-prefix tab semantics: " \tx" keeps
  // living inside a col-2 fence); the columns it overshot reappear as
  // virtual spaces at the head of the remainder. Only a non-whitespace
  // char before col fails (a true dedent out of the container).
  const consumeCol = (ln, col) => {
    if (col <= 0) return ln;
    let w = 0, j = 0;
    while (j < ln.length && w < col) {
      const ch = ln[j];
      if (ch === " ") { w++; j++; continue; }
      if (ch !== "\t") return null;
      const w2 = ((w >> 2) + 1) << 2;
      if (w2 > col) return " ".repeat(w2 - col) + ln.slice(j + 1); // partial tab
      w = w2; j++;
    }
    return w === col ? ln.slice(j) : null;
  };
  // r6-F2 scope: CommonMark pairs inline code WITHIN a block — a
  // pending span dies at a blank line (paragraph end) and a FENCE line
  // interrupts the paragraph (opener becomes literal, fence opens).
  // Lines that are block-openers (table rows, headings, ">") never OPEN
  // a pending span: their inline code is scoped to their own line/cell.
  const canOpenSpan = (ln) => !/^(?: {0,3}(?:#{1,6} |\||>|~~~|```))/.test(ln);
  let prevBlank = true; // r7-F6: start-of-file behaves like a blank line
  let codeIndent = -1;  // r7-F6: active indented-code block (opener indent)
  let codeFloor = 4;    // r8-F1: continuation threshold of the active indented-code block
  let listStack = [];   // r8-F3: content columns of currently-open list items (innermost last)
  // r16A-F3 (audit HIGH): true paragraph tracking replaces the old
  // "prevBlank" proxy for the ordered-marker interrupt rule: a heading
  // or list line before "2. item" OPENS NO PARAGRAPH, so CommonMark
  // legitimately starts the list there — the proxy wrongly refused it
  // and masked the item's indented continuation. paraOpen is set at
  // every loop exit: TRUE only for lines that are paragraph text
  // (non-blank, not heading/setext/hr/quote/list content), FALSE for
  // blank lines and every masked/block exit.
  let paraOpen = false;
  const ATX_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
  const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  let commentListDepth = -1; // r14-F1: open-list depth when inComment opened (-1 = top-level)
  // r8-F1: CommonMark tab stops (4 columns). " \t" REACHES column 4
  // (indented-code territory); a bare tab advances to the next stop.
  // The old approximation (leading spaces only, bare tab = 4) treated
  // " \t§ref" as column-1 content — a live-looking line that renders
  // as CODE.
  const indentWidth = (ln) => {
    let w = 0;
    for (let j = 0; j < ln.length; j++) {
      const ch = ln[j];
      if (ch === " ") w++;
      else if (ch === "\t") w += 4 - (w % 4);
      else break;
    }
    return w;
  };
  // r8-F3: track open-list content indents so a blank-line+indented
  // paragraph CONTINUATION inside a list is no longer mistaken for an
  // indented code block (CommonMark: "- item\n\n    text" is a live
  // paragraph, not code; code inside the item needs item-column + 4).
  // r15-F2b (audit HIGH): the marker lead may contain TABS — the old
  // " {0,17}" space-only regex missed "\t- item" entirely, so the nested
  // item was never tracked and its comment was owned by the OUTER item,
  // keeping §refs masked after the dedent that left the inner item.
  // Consume a container-lead of spaces/tabs up to an absolute column,
  // honoring tab stops; null when the lead exceeds it.
  const leadUpTo = (txt, base, max) => {
    let w = 0, j = 0;
    while (j < txt.length && w < max) {
      const ch = txt[j];
      if (ch === " ") { w++; j++; continue; }
      if (ch !== "\t") break;
      const stop = (((base + w) >> 2) + 1) << 2; // absolute tab stop
      if (stop > base + max) return null;
      w = stop - base; j++;
    }
    return { col: base + w, rest: txt.slice(j) };
  };
  const trackList = (ln) => {
    const w = indentWidth(ln);
    const saved = listStack.slice(); // r16c2-F5: see refusal-restore below
    while (listStack.length && listStack[listStack.length - 1] > w) listStack.pop();
    // r15-F2a (audit HIGH): a line may open a CHAIN of list containers on
    // ONE line ("- - item" = outer item at content column 2, inner item
    // at 4). Tracking only the outer marker let a comment opened by the
    // innermost item be owned at the wrong depth, so its §refs stayed
    // masked after the dedent that had actually left the inner item.
    // The chain walks every same-line marker (each nested lead bounded
    // by the 3-space container rule).
    let rest = ln;
    let base = 0; // column where `rest` starts (tab stops respected)
    // r15c2-F2 (audit HIGH): the chain cap must FAIL CLOSED. With the
    // old hard cap of 8, a 9-marker chain ("- - - - - - - - - <!--")
    // tracked only 8 items, so the comment was owned at depth 8 and a
    // dedent to column 16 (outside the 9th item, column 18) never popped
    // it — laundering every line after. Now: hitting the cap with a real
    // marker still pending is a fail-closed issue, never a silent stop.
    for (let d = 0; ; d++) {
      if (d >= 16) {
        issues.push("list chain deeper than C9's container model tracks is unsupported");
        return;
      }
      const L = leadUpTo(rest, base, d === 0 ? 17 : 3);
      if (L === null) return;
      const m = L.rest.match(/^([-+*]|[0-9]{1,9}[.)])([ \t]+)(?=\S)/);
      if (!m) return;
      // r16-F3 / r16A-F3 (audit MED/HIGH): CommonMark §4.2 — an ordered
      // marker may interrupt a PARAGRAPH only with start number 1;
      // "paragraph\n2. not a list" keeps "2. not a list" as LAZY
      // PARAGRAPH TEXT. But the r16 check used prevBlank as a proxy for
      // "in paragraph", which wrongly refused legitimate starts after a
      // heading or list line ("# H\n2. item\n\n    §99999" — the ref is
      // item content, live). Now the check uses true paragraph state:
      // refuse the push only when a paragraph is actually open.
      // Refusing the push only ever EXPOSES (the line stays text), so
      // any doubt (paraOpen=true after quote/prefixed text) cannot
      // launder: item-continuation refs remain visible as root text.
      // r16c2-F5 (audit HIGH): refusing the marker is CommonMark's LAZY
      // continuation — "paragraph\n2. not a list" is paragraph text of
      // the still-open container, so the pop above (which left the
      // item's content column) must be UNDONE: restoring the stack
      // keeps the item's continuation floor alive, and the item's
      // indented §refs stay visible prose instead of being re-taxed as
      // a top-level indented code block.
      if (paraOpen && m[1][0] >= "0" && m[1][0] <= "9" && Number(m[1].slice(0, -1)) !== 1) {
        listStack.length = 0;
        for (const c of saved) listStack.push(c);
        return;
      }
      // r9-F1: marker padding advances by TAB STOPS (CommonMark tab stop
      // = 4 columns), not +4 per tab char: "-\tx" has content column 4.
      let col = L.col + m[1].length;
      for (const ch of m[2]) col = ch === "\t" ? (((col >> 2) + 1) << 2) : col + 1;
      // r9-F2: padding whose columns exceed marker-start + 4 means the
      // item's FIRST block is an indented code block; the content column
      // drops to markerEnd + 1 (CommonMark §5.2). "-     x" -> column 2:
      // a 6-column line continues the item's code (>= 2+4, masked), a
      // 5-column line starts a live paragraph there.
      if (col > L.col + m[1].length + 4) col = L.col + m[1].length + 1;
      listStack.push(col);
      rest = L.rest.slice(m[0].length);
      base = col;
    }
  };
  for (const ln of lines) {
    // r8-F4: CommonMark blank line = spaces/tabs ONLY. JS trim() also
    // eats NBSP, form-feed, U+2028 etc., which killed pending spans and
    // indented-code runs on lines that are ordinary paragraph content.
    const isBlank = !/[^ \t]/.test(ln);
    // r16A-F3: a blank line ends any open paragraph before this line's
    // checks run (trackList / HTML type-7 interrupt rules consult it).
    if (isBlank) paraOpen = false;
    // r16-F1/F4: raw HTML block continuation (root context only, see
    // htmlBlockStart). Block content is opaque: masked 1:1, no comment/
    // fence/span/heading semantics inside (masking HTML block content
    // follows the fence policy: non-prose blocks mask their content).
    if (htmlType > 0) {
      // r16A-F2: type 1 closes on a TAG-END-anchored regex (see
      // htmlBlockStart) — "</scripture>" is NOT "</script>"; raw
      // substring needles ("?>", ">", "]]>") keep includes().
      const closes = htmlType >= 6
        ? isBlank
        : (htmlNeedle instanceof RegExp ? htmlNeedle.test(ln) : ln.includes(htmlNeedle));
      pushLine(" ".repeat(ln.length));
      prevBlank = isBlank;
      if (closes) { htmlType = 0; htmlNeedle = ""; }
      paraOpen = false; // block content is never an open paragraph
      continue;
    }
    // r7-F6: inside an indented code block — blank lines and lines at
    // >= the continuation floor keep the block; anything else ends it
    // and is processed normally from here. r8-F1: the floor is 4
    // COLUMNS at top level (a 6-space opener does NOT raise it — a
    // 4-space line continues the same block, CommonMark), and
    // item-column + 4 for code opened inside a list item.
    if (codeIndent >= 0) {
      if (isBlank) { pushLine(" ".repeat(ln.length)); prevBlank = true; continue; }
      if (indentWidth(ln) >= codeFloor) { pushLine(" ".repeat(ln.length)); prevBlank = false; paraOpen = false; continue; }
      codeIndent = -1;
    }
    if (inFence) {
      // r11-F2: a list-owned fence is tested CONTAINER-relatively: the
      // owning item's column prefix (tab stops included) is consumed
      // BEFORE the marker regexes — "-\tx\n\t```" closes at a tab line
      // reaching column 4. A line that cannot consume the column is a
      // dedent out of the item (the r9-F3 death, now exact: tabs that
      // OVERSHOOT the column are not consumable). Blank lines never end
      // list items and keep the fence.
      let src = ln;
      if (fenceListCol >= 0) {
        const s = consumeCol(ln, fenceListCol);
        if (s === null) {
          if (isBlank) { pushLine(" ".repeat(ln.length)); prevBlank = true; continue; }
          inFence = false; fenceChar = ""; fenceLen = 0; fenceIndent = 0; fenceBq = false; fenceListCol = -1;
        } else src = s;
      }
      if (!inFence) { /* fence died on the dedent above: fall through, line is LIVE */ }
      else {
      const cm = !fenceBq && src.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
      const bp = fenceBq ? quotePrefix(src) : null;
      const cb = bp && bp.depth ? bp.rest.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/) : null;
      const marker = cm ? cm[2] : cb ? cb[1] : null;
      // r5-F3 → r13-F2: char match and run >= opener; the closer indent
      // is bounded by the regex itself: CommonMark allows ANY closer at
      // indent <= 3 (the old "closer indent <= opener indent" rule left
      // " ```\nx\n   ```" wrongly OPEN). With no backtracking past the
      // {0,3} lead, a 4+ space indent NEVER matches — such a line is a
      // new indented-code block, not a closer, so no separate indent
      // comparison is needed.
      // r7-F3: EVERY close path resets the full fence state (not just the
      // inFence flag) so a later open cannot inherit stale opener shape.
      // r8-F5: a blockquote fence closes only at ITS OWN container depth
      // — "> > ```" inside a depth-1 blockquote fence is FENCE CONTENT
      // (would otherwise over-close and expose/launder later lines).
      const cDepth = bp ? bp.depth : 0;
      if (marker && marker[0] === fenceChar && marker.length >= fenceLen && (!fenceBq || cDepth === fenceBqDepth)) {
        inFence = false; fenceChar = ""; fenceLen = 0; fenceIndent = 0; fenceBq = false; fenceListCol = -1;
        pushLine(ln.replace(/./g, " ")); prevBlank = isBlank; paraOpen = false; continue;
      }
      // r7-F3: a blockquote fence cannot outlive its blockquote — a line
      // WITHOUT the ">" prefix ends both. The line that ended the
      // blockquote is LIVE and falls through for normal processing (it
      // was never fence content).
      // r11-F2: tested on src (the owning item's column prefix already
      // consumed). r9-F3 death (dedent below the item column) is handled
      // by the consumeCol check above — exact for tab stops.
      // r13-F1 (HIGH): FULL depth tracking, not just depth 0 — the rule
      // applies to EVERY shallower line: a fence opened at depth 2
      // ("> > ```") dies at the first depth-1 line ("> x"), which is the
      // outer blockquote's content — LIVE prose whose §refs must be
      // flagged, not masked as fence content. An unmarked blank line has
      // depth zero and ends the quote; a marked blank retains its depth.
      if (fenceBq) {
        if (bp.depth < fenceBqDepth) {
          inFence = false; fenceChar = ""; fenceLen = 0; fenceIndent = 0; fenceBq = false; fenceListCol = -1;
          // fall through: the shallower line is LIVE content.
        } else {
          pushLine(ln.replace(/./g, " ")); prevBlank = isBlank; paraOpen = false; continue;
        }
      } else {
        pushLine(ln.replace(/./g, " ")); prevBlank = isBlank; paraOpen = false; continue;
      }
      }
    }
    if (inComment) {
      // r14-F1 (audit HIGH): a comment opened while list items were open is
      // OWNED by that container — a dedent line below the deepest item's
      // column ends the list, and the comment dies with it: the line is
      // LIVE content, never masked under the dead comment (the laundry the
      // audit found: "- <!--\n§ref outside the list\n-->"). Conservative:
      // blank lines never pop items (r8 trackList rule), so ambiguity only
      // ever EXPOSES refs (flag) — hiding can never result from this rule.
      if (commentListDepth > 0 && !isBlank) {
        const wC = indentWidth(ln);
        while (listStack.length && listStack[listStack.length - 1] > wC) listStack.pop();
        if (listStack.length < commentListDepth) { inComment = false; commentListDepth = -1; }
      }
      if (inComment) {
      const c = ln.indexOf("-->");
      if (c === -1) { pushLine(" ".repeat(ln.length)); prevBlank = isBlank; paraOpen = false; continue; }
      inComment = false;
      const st = {};
      curRanges = [];
      let out = processText(ln.slice(c + 3), st, canOpenSpan(ln), c + 3, true, false); // r21-F1: after a comment closer, block-start is impossible
      // r15c3-F1 (audit HIGH): NO backtick-to-space replace — same
      // laundering as the main path: spaces at the opener hole re-join
      // text across the delimiter and fabricate external adjacency.
      if (st.spanRun) spanRun = st.spanRun;
      pushLine(" ".repeat(c + 3) + out);
      if (st.inComment) inComment = true;
      if (st.inComment) commentListDepth = listStack.length; // r14-F1 re-open inherits HERE
      prevBlank = isBlank;
      // r16A-F3: non-blank text after the comment closer starts a
      // paragraph (fail-open direction: paraOpen=true only refuses the
      // ordered-marker push and delays a type-7 HTML block).
      paraOpen = !isBlank && ln.slice(c + 3).trim().length > 0 && !st.inComment;
      continue;
      }
    }
    // Check unsupported quote/list nesting before pending-span early exits,
    // and relative to each active outer list container as well as the root.
    const candidates = [ln];
    for (const col of listStack) {
      const relative = consumeCol(ln, col);
      if (relative !== null) candidates.push(relative);
    }
    // A list marker can introduce another container on the same line.
    // Inspect the marker's content too, not only previously tracked items.
    // r15c2-F3 (audit HIGH): NO expansion cap — the old "i < 32" limit
    // was bypassed by 33 same-line markers ("-. -. -... ~~~ <!-- info"):
    // candidates past 32 were never checked, the fence guard skipped the
    // line, and the info-string "<!--" opened a laundering phantom
    // comment. Each pushed inner view strictly shortens the string (a
    // marker consumes >= 2 chars), so the queue is bounded by the line
    // length — full expansion is linear and safe.
    for (let i = 0; i < candidates.length; i++) {
      const marker = candidates[i].match(/^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/);
      if (marker) {
        const inner = candidates[i].slice(marker[0].length);
        // r15-F1 (audit HIGH): a fence opener on the SAME line as a list
        // marker (chain "- > ~~~ <!-- info" or "- ~~~ <!--") opens a
        // fence the main state machine never models (fences do not open
        // through a same-line container chain), while processText reads
        // the fence INFO STRING's "<!--" as a comment opener — the two
        // views disagree and the phantom comment launders every following
        // line (probe: "- > ~~~ <!-- info\n  §ref\n  -->" reported OK).
        // This ownership-crossing form fails closed like its sibling
        // quote/list nesting rules above.
        if (quotePrefix(inner).rest.match(/^ {0,3}(?:`{3,}|~{3,})/)) {
          issues.push("fence inside a same-line list chain is unsupported by C9's container model");
        }
        candidates.push(inner);
      }
    }
    if (candidates.some((candidate) => {
      const quote = quotePrefix(candidate);
      return quote.depth && /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)/.test(quote.rest);
    })) issues.push("list inside blockquote is unsupported by C9's container model");
    // Comment ownership across blockquote boundaries is not modeled.
    // Reject a possible opener rather than hiding prose after quote exit.
    // r14-F2: test LIVE text only — inline code spans, fence info
    // strings, and pending-span content are literal and never open a
    // comment ("> `<!--`" and "> ```html <!-- x" must NOT fail closed).
    // r20-F2 (precision): a comment that CLOSES ON ITS OWN LINE owns no
    // container state, so quote-exit laundering is impossible and the
    // line must not fail closed ("> <!-->", "> <!-- x --> §ref"). Erase
    // every COMPLETE comment production ("> " and "-> " are the r20-F1
    // degenerate forms; "[\s\S]*?-->" is the general non-greedy close —
    // leftmost-shortest matching reproduces the §6 CommonMark comment
    // grammar on a single line, probe-verified) and refuse only if a
    // POSSIBLY-OPEN "<!--" survives ("> <!-- x" still crosses the quote
    // boundary and must fail closed).
    if (candidates.some((candidate) => {
      const quote = quotePrefix(candidate);
      return quote.depth && stripLiteral(quote.rest, spanRun).replace(/<!--(?:>|->|[\s\S]*?-->)/g, " ").includes("<!--");
    })) issues.push("comment inside blockquote is unsupported by C9's container model");
    // Fence open is checked BEFORE the pending-span branch: a fence line
    // interrupts the paragraph, so the opener run was literal (CommonMark).
    // r11-F1: try plain match first (the common path — NO listStack
    // mutation for ordinary lines). Only on a match does the fence line
    // close deeper items (CommonMark) and get tagged with the innermost
    // open item column (its owner, -1 at top level; r10-F1). If a plain
    // match fails, the fence may sit at an open item's content column —
    // consume that column as a container prefix (tab stops included) and
    // retest; items deeper than the line's own column are popped first
    // (r11-F1's pop must NEVER run for non-fence lines — that killed the
    // list-continuation exemption).
    // r16-F1/F4 (audit HIGH/LOW): raw HTML block OPEN. CommonMark HTML
    // blocks are opaque non-prose: after the opener, content lines are
    // masked 1:1 with NO comment/fence/span/heading semantics — the
    // audit laundry was "<div>\n<!--\n\n§99999\n-->" where CommonMark
    // renders §99999 as VISIBLE prose: the "<!--" inside an open HTML
    // block is raw text, NOT a comment opener, but the old model read
    // it as one and hid every following line under a phantom comment.
    // Detection context: the block opens only where CommonMark puts it
    // — at root, i.e., after any open list item that the line's column
    // dedents out of (a dedent closes the item AND leaves the line for
    // block detection). A line that stays INSIDE an open item gets no
    // HTML-block modeling: it processes as text, which can only ever
    // EXPOSE refs, never hide them (an item-owned block that kept
    // absorbing past a dedent WOULD launder — so it is deliberately
    // not modeled). NO blockquote prefix / inside an open list item:
    // r16A-F4 (audit HIGH): those contexts now DETECT a commit-worthy
    // opener and FAIL CLOSED instead of silently falling through to
    // text. The old fail-open assumed the unmodeled paths could only
    // expose, but the masker's downstream comment engine disagrees
    // with the renderer: "- <div>\n<!--\n  §ref\n-->" renders §ref as
    // VISIBLE (the "<!--" is raw text inside the item's HTML block,
    // closed by the blank line), while the unmodeled fall-through read
    // "<!--" as a comment opener and HID the ref (probe-audited).
    // Refusing is the only sound option: container-owned HTML blocks
    // are not modelled.
    if (!isBlank && ln.includes("<")) {
      const wH = indentWidth(ln);
      let insideItem = false;
      for (const c of listStack) if (c <= wH) { insideItem = true; break; }
      const inQuote = quotePrefix(ln).depth > 0;
      if (insideItem || inQuote) {
        const hbC = htmlBlockStart(quotePrefix(ln).rest);
        if (hbC && !(hbC.type === 7 && paraOpen)) {
          issues.push(`raw HTML block inside ${inQuote ? "a blockquote" : "a list item"} is unsupported by C9's container model`);
          // Continue processing the line as text (fail-closed already
          // fired; keeping the state machine on its old path avoids
          // inventing an unverified container model mid-document).
        }
      }
      // r16c2-F1 (audit HIGH): SAME-LINE container views. "- <div>"
      // puts the HTML-block opener as the list item's FIRST block: the
      // tag is not at the line root so the root detector never sees it,
      // the item gets tracked, and the following "<!--" is read as a
      // live comment — hiding §refs the renderer shows as visible
      // prose. Walk the same-line marker chain (same lead/marker walk
      // as trackList) and test each post-marker view for an opener:
      // every container on this line starts fresh (no paragraph can be
      // open before its first block), so even a type-7 match commits
      // here — fail closed, container-owned blocks are not modelled.
      {
        let cv = ln, cvBase = 0;
        for (let d = 0; ; d++) {
          if (d >= 16) break; // trackList fails closed on the real chain
          const L = leadUpTo(cv, cvBase, d === 0 ? 17 : 3);
          if (L === null) break;
          const m = L.rest.match(/^([-+*]|[0-9]{1,9}[.)])([ \t]+)(?=\S)/);
          if (!m) break;
          if (htmlBlockStart(L.rest.slice(m[0].length))) {
            issues.push("raw HTML block opened on a list-marker line is unsupported by C9's container model");
            break;
          }
          let col = L.col + m[1].length;
          for (const ch of m[2]) col = ch === "\t" ? (((col >> 2) + 1) << 2) : col + 1;
          if (col > L.col + m[1].length + 4) col = L.col + m[1].length + 1;
          cv = L.rest.slice(m[0].length); cvBase = col;
        }
      }
    }
    if (!isBlank && !quotePrefix(ln).depth && ln.includes("<")) {
      const wH = indentWidth(ln);
      let insideItem = false;
      for (const c of listStack) if (c <= wH) { insideItem = true; break; }
      if (!insideItem) {
        const hb = htmlBlockStart(ln);
        if (hb && !(hb.type === 7 && paraOpen)) {
          // The block commits: dedent out of any items deeper than this
          // line's column (CommonMark closes them; trackList would pop
          // identically if this line fell through to text processing).
          while (listStack.length && listStack[listStack.length - 1] > wH) listStack.pop();
          // A block whose closing condition is satisfied ON the opener
          // line is a single-line block (CommonMark): mask it, no state.
          // r16A-F2: regex needles are TAG-END anchored ("</script>" in
          // "</scripture>" does NOT close on the opener line either).
          const sameClose = hb.needle !== null && (hb.needle instanceof RegExp ? hb.needle.test(ln) : ln.includes(hb.needle));
          if (!sameClose) { htmlType = hb.type; htmlNeedle = hb.needle; }
          // Any committed HTML block ends a pending inline code span: a
          // type-6 block interrupts the paragraph that owns the span, so
          // the span's backtick run must not pair with a later run (the
          // span-literal rule). Type 7 cannot commit while a span is
          // open (it needs paraOpen=false), so clearing for all types
          // is exact.
          spanRun = 0;
          pushLine(" ".repeat(ln.length)); prevBlank = isBlank; paraOpen = false; continue;
        }
      }
    }
    let fm = fenceMatch(ln, false) ?? fenceMatch(ln, true);
    if (fm) {
      const wFence = indentWidth(ln);
      while (listStack.length && listStack[listStack.length - 1] > wFence) listStack.pop();
      spanRun = 0;
      fenceListCol = listStack.length ? listStack[listStack.length - 1] : -1;
      inFence = true; fenceChar = fm.marker[0]; fenceLen = fm.marker.length; fenceIndent = fm.indent; fenceBq = fm.bq; fenceBqDepth = fm.depth || 0;
      pushLine(ln.replace(/./g, " ")); prevBlank = isBlank; paraOpen = false; continue;
    }
    if (listStack.length && !isBlank) {
      const s = consumeCol(ln, listStack[listStack.length - 1]);
      fm = s !== null ? (fenceMatch(s, false) ?? fenceMatch(s, true)) : null;
      if (fm) {
        spanRun = 0;
        fenceListCol = listStack[listStack.length - 1];
        inFence = true; fenceChar = fm.marker[0]; fenceLen = fm.marker.length; fenceIndent = fm.indent; fenceBq = fm.bq; fenceBqDepth = fm.depth || 0;
        pushLine(ln.replace(/./g, " ")); prevBlank = isBlank; paraOpen = false; continue;
      }
    }
    if (spanRun > 0) {
      // r6-F2: pending multi-line span (paragraph scope). r7-F2: a blank
      // line is the block boundary that ends the paragraph — the stray
      // opener dies and everything from the boundary on is processed
      // NORMALLY, so a heading after a blank line can never be swallowed
      // into a pending span and its refs always stay visible (probe
      // r7-heading-kills-span). A heading FUSED directly under the
      // opener (no blank line) stays span content: r6-F2's deliberate
      // policy that span content is never heading/fence/comment
      // material — refs on such lines stay live regardless.
      // (r6-F2 also had a line-loss bug: the blank boundary line was
      // never pushed, misaligning every following line number.)
      if (isBlank) {
        spanRun = 0;
      } else {
        // r21c14-F1 (audit LOW, cycle 14): a type-2 comment block opener
        // INTERRUPTS the paragraph that owns a pending span (CommonMark
        // §4.6; commonmark.js + markdown-it agree): "a `\n<!--\nREF\n`\n-->"
        // renders REF INSIDE the comment — the old branch swallowed the
        // opener as span content and flagged the hidden ref (overstrict).
        // Test the SAME predicate the root path uses (atBlockStart with
        // the innermost open item column; the ordered-marker/paraOpen rule
        // inside it applies since a span line keeps a paragraph open).
        // Blockquote prefixes are excluded: "> <!--" stays the accepted
        // fail-closed context (round-20 convention) — falling through a
        // quote line could open a root comment and launder post-quote
        // lines. On a hit drop the span and fall through: processText
        // models the opener with its proven same-line-closer/degenerate
        // rules and r14 comment ownership.
        let spanBlockHit = false;
        if (ln.includes("<!--") && !quotePrefix(ln).depth) {
          const iC = ln.indexOf("<!--");
          if (atBlockStart(ln, iC, listStack.length ? listStack[listStack.length - 1] : 0)) {
            spanRun = 0;
            spanBlockHit = true;
          }
        }
        if (!spanBlockHit) {
          // r21c15-F1/F2 (audit HIGH x2, cycle 15): a LIST-MARKER
          // interruption of the paragraph that owns the pending span must
          // end the span AND update listStack (CommonMark §4.2 + §4.6
          // interrupt rules; commonmark.js and markdown-it agree). The
          // old branch consumed "- item" as span content without
          // tracking it, so a comment opened inside the newly opened
          // item was owned at the OLD depth (root); a ref dedenting
          // visibly out of the item stayed masked (lost-list.md,
          // lost-nested.md, lost-ordered.md). Dry-run semantics: keep
          // trackList's result ONLY when it pushed a new item (bullet
          // markers and start-1 ordered markers interrupt paragraphs;
          // a start!=1 marker is refused by the r16-F3 rule inside
          // trackList, and a plain/lazy line pushes nothing — in both
          // cases the span keeps owning the line, restored stack, and
          // the span-content path keeps refs LIVE, which matches the
          // renderers showing those refs).
        // Guard: only a marker that could interrupt the span's
        // paragraph may flip the line to the normal path — a root list
        // start is <=3-space indented, a nested start lands within 3
        // columns of the innermost open item's content column (the
        // container rule). Anything else (4+ after a paragraph, lazy
        // continuation) is NOT a list start and must not be tracked.
        const savedStack = listStack.slice();
        const wMark = indentWidth(ln);
        const topCol = listStack.length ? listStack[listStack.length - 1] : 0;
        if (listStack.length ? (wMark >= topCol && wMark <= topCol + 3) : wMark <= 3) {
          trackList(ln);
        }
        if (listStack.length > savedStack.length) spanBlockHit = true; // trackList on the line below is idempotent
        else { listStack.length = 0; for (const c of savedStack) listStack.push(c); }
        }
        if (!spanBlockHit) {
        // Content line: copied (§refs inside stay LIVE) but NEVER heading/
        // fence/comment material — leading space kills a phantom heading.
        const c = findRun(ln, 0, spanRun);
        if (c === -1) { curRanges = [[0, ln.length + 1]]; pushLine(" " + ln); prevBlank = false; paraOpen = true; continue; }
        let runLen = 0; while (ln[c + runLen] === "`") runLen++;
        spanRun = 0;
        const st = {};
        // r15-F3 (audit HIGH): text BEFORE the closing run is span
        // CONTENT — norm text whose §refs stay live (the old code masked
        // everything through the closer, laundering "paragraph `\n
        // §99999 `" into nothing). Only the delimiter run itself is
        // masked; the prefix is span content and copied verbatim (it
        // never reaches processText, so a `<!--` inside stays literal).
        curRanges = [[0, c + runLen + 1]];
        pushLine(" " + ln.slice(0, c) + " ".repeat(runLen) + processText(ln.slice(c + runLen), st, canOpenSpan(ln), c + runLen + 1, true, false)); // r21-F1: span content is paragraph text — no block-start after the closer
        if (st.inComment) inComment = true;
        if (st.inComment) commentListDepth = listStack.length; // r14-F1
        if (st.spanRun) spanRun = st.spanRun;
        prevBlank = false;
        paraOpen = true; // span content is paragraph text (r15-F3)
        continue;
        }
        // spanBlockHit: fall through to the normal line path — processText
        // models the comment opener with its proven rules (r21c14-F1).
      }
    }
    // r7-F6: indented code block START — 4+ columns (tab stops) directly
    // after a blank line (outside fences/comments/pending spans, which
    // are all handled above). r8-F3: a line whose indent is claimed by an
    // open list item (< item-content-column + 4) is that item's
    // CONTINUATION PARAGRAPH (live prose, §refs visible), not code — the
    // old rule masked list continuations ("  - item\n\n    §9" hid a real
    // ref). Documented exclusion: true code content is masked to the end
    // of the indented run.
    if (prevBlank && indentWidth(ln) >= 4) {
      const w = indentWidth(ln);
      const cont = listStack.length ? listStack[listStack.length - 1] : -1;
      if (cont < 0 || w >= cont + 4) {
        codeIndent = w;
        // r8-F1: continuation floor — code opened at top level keeps
        // running on any 4-column line; code inside a list item needs
        // item-content + 4.
        codeFloor = cont >= 0 && w >= cont + 4 ? cont + 4 : 4;
        pushLine(" ".repeat(ln.length)); prevBlank = false; paraOpen = false; continue;
      }
    }
    if (!isBlank) trackList(ln); // blank lines preserve list continuation
    const st = {};
    curRanges = [];
    let out = processText(ln, st, canOpenSpan(ln), 0, true, true, listStack.length ? listStack[listStack.length - 1] : 0);
    if (st.spanRun) {
      // r6-F2: an unclosed run opens a multi-line span. r15c3 (audit
      // HIGH): NO blanket backtick-to-space replace here anymore — the
      // processText hole (a backtick, see r15c3-F1/F2) is the mask for
      // the opener run, and replacing backticks with spaces re-created
      // a prose left-boundary at "docs/", laundering span-contained
      // external paths into C9's exemption. Backticks elsewhere in
      // live text are inert for every downstream consumer (the
      // section-map/heading/fence regexes never match mid-line runs).
      spanRun = st.spanRun;
    }
    pushLine(out);
    if (st.inComment) inComment = true;
    if (st.inComment) commentListDepth = listStack.length; // r14-F1: tag open depth at re-open
    prevBlank = isBlank;
    // r16A-F3: paragraph state at the text fall-through. A non-blank
    // line here is paragraph-ish content EXCEPT structural lines that
    // open no paragraph: ATX headings and thematic breaks always close
    // one; a setext underline only closes its own paragraph (a bare
    // "==="/("---" run with no paragraph under it is literal text).
    paraOpen = !isBlank && !ATX_RE.test(ln) && !HR_RE.test(ln) &&
      !(/^ {0,3}(?:=+|-+)[ \t]*$/.test(ln) && paraOpen);
  }
  if (inComment) issues.push("unclosed <!-- masks the rest of the document from C9");
  if (inFence) issues.push("unclosed code fence masks the rest of the document from C9");
  if (spanRun > 0) issues.push("unclosed multi-line inline span masks heading/fence structure from C9");
  return { masked: outLines.join("\n").replace(/[\u2028\u2029]/g, " "), issues, spanRanges };
};


// Section map: every `### 14.N` header to the next one (or EOF).
// Round-5 F2: boundaries are DISCOVERED in the masked text too (r4-F7
// sliced contents from masked but discovered from raw — a commented-out
// `### 14.12 fake` heading clobbered the real entry and fired 15 checks).
// One scanModel pass, shared by the section map and C9 (scan9 = scanMain).
const scanMain = scanModel(s);
const maskedSecSource = scanMain.masked;
const secNums = [];
const secStarts = [];
for (const m of maskedSecSource.matchAll(/^### (14\.\d+) /gm)) {
  secNums.push(m[1]);
  secStarts.push(m.index);
}
const sections = new Map();
// Round-4 c35 terra F7: sections come from the MASKED text, so C1/C2/C8
// share C9's masking model — a pin fenced away as example content no
// longer survives C8, and inline-code `<!--` markers no longer make C8
// strip live text. Offsets survive: masking is line/column-aligned.
for (let i = 0; i < secNums.length; i++) {
  sections.set(secNums[i], maskedSecSource.slice(secStarts[i], i + 1 < secNums.length ? secStarts[i + 1] : maskedSecSource.length));
}

// ---------------------------------------------------------------------------
// C1 — Per-section status versions (A1): the five G2–G5 sections EACH carry
// exactly one `**Status: DRAFT vN (` line; all five must share one version N
// (the max). Whole-section scoping: a decoy status string anywhere else in
// the file can no longer launder a stale section header, and the batch date
// is not part of the pattern (a date correction is legal).
const gSections = ["14.11", "14.12", "14.13", "14.14", "14.15"];
const secVers = new Map();
for (const n of gSections) {
  const body = sections.get(n) ?? "";
  const vs = [...body.matchAll(/\*\*Status: DRAFT v(\d+) \(/g)].map((m) => Number(m[1]));
  check(`C1 §${n} has exactly one status line`, vs.length === 1, `found ${vs.length}`);
  secVers.set(n, vs);
}
const allV = [...secVers.values()].flat();
const V = allV.length ? Math.max(...allV) : 0;
check("C1 status lines exist", allV.length === 5, `found ${allV.length}`);
check("C1 status uniform", allV.every((n) => n === V), `versions=${[...new Set(allV)]}`);

// ---------------------------------------------------------------------------
// C2 — Per-section version propagation (A1, c28 probe-confirmed fix): EACH
// G-section's status text (the status line plus its immediately-following
// fold-history paragraph, up to the first blank line) must CITE the current
// version as a standalone token (`vN` with word boundaries). Whole-document
// string presence laundered a stale sub-note whenever any other section
// carried the mark (mutation probe c28-P2: four of five sub-notes left at
// v33 while one v34 mention existed — old check passed, new check fails
// per-section). SECOND strengthening probe (c28 mutation test): the bumped
// `DRAFT vN (` header itself satisfied the citation trivially, so a section
// whose FOLD CITATION was missing still passed — now the header's own
// version token is masked before the citation search, so every section
// must carry a citation of the current fold in its status prose, not just
// a bumped header. A section a fold did not materially change is still
// cited honestly ("vN: status bump only") — writing the citation is the
// point.
for (const n of gSections) {
  const body = sections.get(n) ?? "";
  const stIdx = body.search(/\*\*Status: DRAFT v\d+ \(/);
  let statusText = "";
  if (stIdx >= 0) {
    const rest = body.slice(stIdx);
    const end = rest.indexOf("\n\n");
    statusText = end === -1 ? rest : rest.slice(0, end);
  }
  // Mask the header's version token(s) so only a real citation counts.
  const masked = statusText.replace(/\*\*Status: DRAFT v\d+ \(/g, "**Status: DRAFT (");
  check(`C2 §${n} status cites v${V}`, new RegExp(`\\bv${V}\\b`).test(masked));
}

// ---------------------------------------------------------------------------
// C3 — Change Ledger mechanics (c28 A4 fix): every data row (starts
// "| YYYY-MM-DD") terminates with an UNESCAPED "|" (a trailing `\|` is
// escaped cell content, not a terminator). The rows are NOT globally
// prepended — they are grouped by workstream with local insertion (verified
// against the v34 ledger), so "first row" is meaningless and was dropped.
// The current row is instead identified UNIQUENESS-FIRST: exactly ONE row
// may carry the `(vN` current-version marker (a decoy marker planted in an
// older row now FAILS the uniqueness check rather than laundering it), and
// that row must carry DECISIONS-REQUIRED: 0. Rows whose change text
// mentions DECISIONS-REQUIRED are all current-generation rows; older
// grouped rows with open decisions predate the current fold and are exempt
// only when they do not carry the marker.
const ledgerRows = s.split("\n").filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l));
check("C3 ledger non-empty", ledgerRows.length > 20, `rows=${ledgerRows.length}`);
const isTerminated = (l) => {
  const t = l.trimEnd();
  if (!t.endsWith("|")) return false;
  let backslashes = 0;
  for (let i = t.length - 2; i >= 0 && t[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0; // odd count => the final | is escaped
};
const unterminated = ledgerRows.filter((l) => !isTerminated(l));
check("C3 all ledger rows terminated (unescaped)", unterminated.length === 0, `${unterminated.length} unterminated`);
const markerRe = new RegExp(`\\(v${V}\\b`);
const markedRows = ledgerRows.filter((l) => markerRe.test(l));
check(`C3 exactly one row carries the current-version marker (v${V})`, markedRows.length === 1, `found ${markedRows.length}`);
for (const row of markedRows) {
  const dec = row.match(/DECISIONS-REQUIRED: (\d+)/);
  check("C3 current-marked row DECISIONS-REQUIRED: 0", dec ? dec[1] === "0" : false, dec ? dec[1] : "absent");
}

// ---------------------------------------------------------------------------
// C4 — faultKind closure (the c10-f9 / c22-f5 class: a rule mandates a fault
// the closed enum cannot represent, or a kind exists with no identity tuple).
// Union = quoted members of the faultKind field in the fault-record shape.
const iU = s.indexOf('faultKind: "counter-divergence"');
const iUend = s.indexOf("boundaryId|null, affectedRecordId", iU);
check("C4 faultKind union region found", iU > 0 && iUend > iU);
const unionKinds = new Set(
  [...s.slice(iU, iUend).matchAll(/"([a-z][a-z-]+)"/g)].map((m) => m[1]),
);
check("C4 union non-empty", unionKinds.size >= 11, `kinds=${unionKinds.size}`);
// Every union member must be BOUND in the stable-identity-tuple list
// (`kind` = (faultKind, ...)), and every tuple binding must name a union
// member — set equality in both directions.
const iK = s.indexOf("**Stable identity tuple");
const tupleBlock = strip(s.slice(iK, iK + 6000));
const tupleKinds = new Set(
  [...tupleBlock.matchAll(/`([a-z][a-z-]+)` = \(faultKind/g)].map((m) => m[1]),
);
const unbound = [...unionKinds].filter((k) => !tupleKinds.has(k));
const orphan = [...tupleKinds].filter((k) => !unionKinds.has(k));
check("C4 every faultKind bound to an identity tuple", unbound.length === 0, unbound.join(","));
check("C4 no tuple for an undeclared faultKind", orphan.length === 0, orphan.join(","));

// ---------------------------------------------------------------------------
// C5 — disposition decision enum: the §14.12.4 brace list and the §14.12.4b
// EXIT jsonc list must be the SAME set (two declaration sites, one meaning;
// the v18 addition nearly desynced them).
const iD1 = s.indexOf("decision` ∈ {");
const iD2 = s.indexOf('"accept-recomputed" |');
check("C5 both decision-enum sites present", iD1 > 0 && iD2 > 0);
const set1 = new Set((s.slice(iD1, s.indexOf("}", iD1)).match(/[a-z][a-z-]+/g) ?? []).filter((w) => w !== "decision"));
const set2 = new Set([...s.slice(iD2, s.indexOf("explanationDigest", iD2)).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
const d12 = [...set1].filter((x) => !set2.has(x));
const d21 = [...set2].filter((x) => !set1.has(x));
check("C5 decision enums agree (12.4 ⊆ 12.4b)", d12.length === 0, d12.join(","));
check("C5 decision enums agree (12.4b ⊆ 12.4)", d21.length === 0, d21.join(","));

// ---------------------------------------------------------------------------
// C6 — no undecided-authority idiom survives outside the ledger (checked on
// MASKED body — r5 one-model close-out: C6 previously ran stripComments on
// RAW text, a second masking model that fences could hide nothing from but
// spans could; masked is the single source of what is live text).
const body = maskedSecSource.split("\n").filter((l) => !/^\| \d{4}-\d{2}-\d{2} \|/.test(l)).join("\n");
check("C6 no 'not decided here' idiom in body", !body.includes("not decided here"));

// ---------------------------------------------------------------------------
// C7 — kind-shaped ratchet: every backticked kebab word (≥3 components) in
// the G2–G5 body must be a DECLARED record kind ("kind":"…" in jsonc), a
// faultKind, a decision-enum member, or on the reviewed allowlist below.
// Allowlist entries are CATEGORY-COMMENTED; extend ONLY with a fold that
// introduces the member into the schema.
// A6 (c28): the allowlist SELF-VALIDATES — every entry must still exist
// somewhere in the document (as a jsonc kind, a faultKind, a decision value,
// or a literal backticked/quoted mention). Deleting a declaration while the
// allowlist quietly keeps laundering the term is now a FAILURE.
// KNOWN LIMIT (documented spec boundary, see header): two-component terms
// are NOT covered pending an authored record-kind inventory.
// DECLARATION extraction (declaredKinds/unionKinds/decision enums, C4/C5)
// DELIBERATELY reads the RAW document: the declarations live in fenced
// jsonc blocks which are DATA to parse, not norm — masking them is not
// what these checks consume. The one-model rule governs NORMAT text
// (C1/C2/C6/C7/C8/C9): everything reading prose consumes scanModel.masked.
const declaredKinds = new Set([...s.matchAll(/"kind":"([a-z][a-z0-9-]+)"/g)].map((m) => m[1]));
const decisionValues = new Set([...set1, ...set2]);
const allow = new Set([
  // faultKinds (also in the union; listed for when region parsing shifts):
  "channel-id-collision", "group-plan-mismatch", "policy-digest-mismatch",
  "queue-receipt-divergence", "fold-summary-unsupported-version",
  // disposition decision values (C5 sets):
  "accept-recomputed", "external-explanation", "retire-duplicate-channel",
  // other closed value enums referenced across the body (verified v33):
  "accept-open-risk", "accept-residual-risk", "close-terminal-outcome",
  "deferral-loop-disposition", "finalization-wait-anchor", "finding-intake-invalid",
  "group-plan-oversize", "hold-until-repro", "measured-overrides-accepted",
  "norm-not-ratified", "parse-or-schema", "prior-attempt-running",
  "prior-attempt-unresolved", "proven-not-issued",
  "provider-inability-evidence", "reconciliation-floor-divergence",
  "remote-terminal-disposition", "remote-terminal-unproven", "reset-chain-with-new-window",
  "residual-re-resolution", "residual-risk-accepted", "scope-escape-waiver",
  "stale-deferral-lineage", "task-tip-archived", "task-tip-lost",
  "usage-late-arrived", "zero-call-closure", "grant-new-window",
  "dispatch-authorization-drop", "evidence-nudge-resume", "auditor-round-completion",
  // record kinds described in prose (declared by field-shape, not "kind":jsonc):
  "history-integrity-fault", "history-integrity-disposition", "residual-unit-release",
  "channel-open", "evidence-invalidation", "queue-receipt",
  // v25 R5-C18-3: two-phase residual-cure settlement record (§14.10.3,
  // declared in the §14.12.4b introduced-kinds inventory by field-shape):
  "residual-cure-settlement",
  // G1 §14.10 owner-act op + refusal class (round-4; backticked in the
  // §14.12.2 finalization table rows since the v9 fold):
  "owner-filing-draft-drift", "owner-filing-mapping",
  "filing-drift-resolution", "spool-loss-post-filing",
  "owner-filing-integrity-fault", "filing-integrity-disposition",
  "integrity-disposition-mismatch",
  // v27 R5-C19-5: residual-cure cancellation owner-act op (§14.10.3,
  // declared by field-shape in the op enum; mints no record kind):
  "residual-cure-cancel",
]);
// Existence test: the term must still appear as a standalone token
// (word-bounded) somewhere in the document — declared kinds, faultKinds and
// decision values are already exempt; the token test catches a term whose
// ONLY surviving mention was deleted. Word boundaries (not quote-delimited)
// because most allowlisted terms appear bare in prose.
const staleAllow = [...allow].filter(
  (k) => !declaredKinds.has(k) && !unionKinds.has(k) && !decisionValues.has(k) && !new RegExp(`\\b${k}\\b`).test(s),
);
check("C7 allowlist entries still exist in the document", staleAllow.length === 0, staleAllow.join(","));
const iBody = sections.has("14.11") ? maskedSecSource.indexOf("### 14.11 ") : 0;
// r5 one-model close-out: the ratchet scans LIVE body text (masked) — a
// novel term fenced out of norm no longer counts, and `<!--` inside an
// inline span no longer makes stripComments strip live text.
const kindShaped = new Set([...maskedSecSource.slice(iBody).matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+){2,})`/g)].map((m) => m[1]));
const novel = [...kindShaped].filter((k) => !declaredKinds.has(k) && !unionKinds.has(k) && !decisionValues.has(k) && !allow.has(k));
check("C7 no unregistered kind-shaped term", novel.length === 0, novel.join(","));

// ---------------------------------------------------------------------------
// C8 — pinned-clause registry (the C27-F1 lesson made mechanical): the v33
// fold's span replacement silently deleted a sentence the v32 fold had added.
// Every normative clause that a fold inserted (v29–v34) is pinned — with its
// HOME SECTION (c28 A3) — as a whitespace-insensitive string that MUST
// survive every later edit IN THAT SECTION, checked against comment-stripped
// section text. A fold that legitimately REPLACES a pinned clause must edit
// THIS registry in the same commit — the ratchet is deliberate friction, the
// same kind that kept the Change Ledger honest. Pins guard deletion and
// relocation, not negation (documented limit).
const PINS = [
  ["14.12", "A closed fault is never reopened by an unsupported read, and no later validation rewrites it."],
  ["14.12", "the fault is one durable fact"],
  ["14.12", "closes the durable FAULT only"],
  ["14.12", "which is local readability state and never a clean verdict"],
  ["14.12", "a fault already present with the same identity, open or CLOSED, is NOT re-appended"],
  ["14.12", "the restored blob is INERT"],
  ["14.12", "named a revision record as the sole identity is WITHDRAWN"],
  ["14.12", "recomputedDigest NULL (no stored bytes to recompute)"],
  ["14.12", "no decision value is added and no historical verdict is rewritten"],
  ["14.12", "replay verification IS the authoritative validation"],
  ["14.12", "NEVER admits on the explanation alone"],
  ["14.12", "IN THE SAME revision; a bump that does neither is OUT OF CONTRACT"],
];
for (const [sec, p] of PINS) {
  // r5 one-model close-out: sections are already masked (comment-free);
  // the redundant stripComments used to eat LIVE `<!--` text copied
  // verbatim inside inline spans — a divergence from C9, now gone.
  const flat = strip(sections.get(sec) ?? "");
  check(`C8 pin survives in §${sec}: "${p.slice(0, 40)}…"`, flat.includes(strip(p)));
}

// ---------------------------------------------------------------------------
// C9 — cross-reference resolution (the dangling-§ref defect class): every
// `§N(.M…)` citation in BODY text must resolve to a heading in THIS document
// or be locally excusable. v3 (c35 terra audits — 4 rounds, 22 findings,
// all closed; probes F1..F7 + r2-* + r3-* + r4-*):
//   Masking: the shared scanModel above (comment-first state order, fenced
//   blocks masked — example payloads are data, never live refs or headings;
//   unclosed comment/fence FAILS; inline spans verbatim).
//   Ledger exemption SCOPE-BOUND to §1 (planted date-shaped rows scanned).
//   §0 exemption is by ACTUAL principle ID (renumber breaks it; §0.10 ok).
//   External exemption = strict adjacency CHAIN GRAMMAR: docs/<path>§ref
//   (UNICODE-aware left boundary, ≥1 alphanumeric in the path — docs/.. and
//   édocs/a are not paths; nested dirs allowed), unlimited chain links
//   "§a/§b/§c"; findings records exempt only when the SAME record binds
//   "doc":"docs/<non-empty path>" directly before "anchor":"§…" on the
//   line. A planted docs/ mention anywhere else launders nothing. Refs are
//   matched FULL-TOKEN against a strict grammar (single-trailing-dot
//   normalized; §.98, §14..99, §0.1é9, leading zeros, §14x99 → malformed
//   flag, never a partial exemption).
// Remaining known boundary: refs in non-ledger table rows (section index,
// P-table) are live cross-references and scanned as such — correct.
const scan9 = scanMain; // r5-F2: ONE scan serves the section map AND C9.
const sScan = scan9.masked;
const headingSet = new Set();
for (const m of sScan.matchAll(/^#{2,4} ([0-9]+(?:\.[0-9]+)*[a-z]?)\.? /gm)) headingSet.add(m[1]);
const iSec1 = sScan.indexOf("## 1. Schema");
const iSec2 = sScan.indexOf("\n## ", iSec1 + 1);
check("C9 §0 Purpose and §1 Schema anchors exist (the C9 scan depends on them)",
  sScan.includes("## 0. Purpose") && iSec1 > 0 && iSec2 > iSec1, "anchors present");
const sec0 = sScan.slice(sScan.indexOf("## 0. Purpose"), iSec1);
const principleIds = new Set([...sec0.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1])));
const dangling = [...scan9.issues];
const lines2 = sScan.split("\n");
const ledgerStart = sScan.slice(0, iSec1).split("\n").length;
const ledgerEnd = sScan.slice(0, iSec2).split("\n").length;
// External chain grammar (r3-F1/F2): left-bounded docs/ path with at least
// one alphanumeric (docs/.., docs/# are not paths), nested dirs allowed,
// then zero or more chain links "§n/ " "§n, " "§n&", then the ref. The
// findings-record form "anchor":"§… is exempt ONLY on lines that also
// carry "doc":"docs/…" (the record that the anchor belongs to).
// r15c3-F2 (audit HIGH, range-based denial): span content is literal
// text — never a prose chain. A ref whose "§", or whose chain path,
// overlaps a span-content range (scanModel.spanRanges, masked coords)
// gets NO exemption: masked span delimiters (holes/pads/closers) can
// otherwise reconstitute adjacency that never existed in the source.
// Denial region: any span range from the chain path start through the
// ref (a laundered middle "docs/a `x` §99" already fails the adjacency
// grammar — the range check closes the path-start/ref-column holes the
// blanket backtick guard used to cover without breaking genuine chains
// that legitimately carry code spans elsewhere on the line).
const extChainRe = /(?<![\p{L}\p{N}\p{M}\p{Pc}/.~\-`])docs\/(?=[^\s§|]*[A-Za-z0-9])[\w.~\-–—…#()\/]{1,60}(?:[ ]?§[0-9]+(?:\.[0-9]+)*[a-z]?(?:[ ]?[\/&][ ]?|, ))*[ ]?$/u;
const extRecRe = /"doc"\s*:\s*"docs\/[A-Za-z0-9/._\u2026-]+"\s*,\s*"anchor"\s*:\s*"$/;
const extPrefix = (before, line, ranges, refCol) => {
  const inSpan = (col) => {
    for (const [a, b] of ranges || []) if (col >= a && col < b) return true;
    return false;
  };
  // The ref itself inside span content: never a prose-chain ref.
  if (inSpan(refCol)) return false;
  const m = extChainRe.exec(before);
  if (m) {
    const pathStart = before.length - m[0].length;
    // Deny if ANY span range lies within (or spans across) the chain
    // region from the path start to the ref.
    for (const [a, b] of ranges || []) {
      if (b > pathStart && a <= refCol) return false;
    }
    return true;
  }
  // Findings records (r4-F6): the SAME record must bind a non-empty
  // "doc":"docs/…" directly before its own "anchor":" — two unrelated
  // objects on one line pair no more than the empty path doc:"docs/".
  // r5-F4: a DUPLICATE "doc" key anywhere on the line makes the record
  // ambiguous (last-key-wins parsers resolve doc:"local"), so the pairing
  // is rejected — an ambiguous record is not an exemption.
  // r6-F4: an ESCAPED QUOTE inside the doc value ("docs/a\"oops") is
  // likewise refused: '"' is not a path character under the extPrefix
  // grammar, and a quoted path is ambiguous to line-level scanning —
  // fail-closed, same principle as duplicate keys.
  // r7-F4: the value is constrained to PATH characters only (word chars,
  // / . - _ + the document's "…" truncation marker): spaces, '?', '#'
  // query/fragment syntax are NOT path characters — a loose value is
  // rejected and the anchor is scanned as a plain ref (fail-closed).
  // r15c3-F2: any span content at all on a record line makes it
  // ambiguous for line-level scanning — records are plain JSON, so any
  // range on the line is refused (fail-closed).
  return extRecRe.test(before)
    && (line.match(/"doc"\s*:/g) || []).length === 1
    && !(ranges || []).length;
};
// Strict ref token (r3-F3): § + digits/dots/optional letter suffix, junk
// after (any letter incl. Unicode, digit, dot) is a malformed token.
const refGrammar = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*[a-z]?$/;
for (let i = 0; i < lines2.length; i++) {
  const line = lines2[i];
  if (i >= ledgerStart && i < ledgerEnd && /^\| \d{4}-\d{2}-\d{2} \|/.test(line)) continue; // ledger row
  // § followed by a dot = malformed prefix, matched before any digit scan.
  for (const m of line.matchAll(/§(?=\.)/g)) dangling.push(`line ${i + 1}: malformed §ref "§."`);
  for (const m of line.matchAll(/§(\d[\d.]*[a-z]?)([\p{L}\d.]*)/gu)) {
    if (m[2]) { dangling.push(`line ${i + 1}: malformed §ref token "${m[0]}"`); continue; }
    const ref = m[1].replace(/\.$/, ""); // ONE trailing dot normalized (§14. == §14)
    if (!refGrammar.test(ref)) { dangling.push(`line ${i + 1}: malformed §ref "§${m[1]}"`); continue; }
    if (headingSet.has(ref)) continue;
    const pm = ref.match(/^0\.([1-9][0-9]?)$/);
    if (pm && principleIds.has(Number(pm[1]))) continue; // §0 principle n
    if (extPrefix(line.slice(0, m.index), line, scan9.spanRanges[i], m.index)) continue; // true external anchor chain
    dangling.push(`line ${i + 1}: §${ref}`);
  }
}
check(`C9 every body §ref resolves (headings, real §0 principle ids {${[...principleIds].join(",")}}, ledger rows in §1 only, external chains docs/N §ref with "doc" pairing, strict token grammar, fences/comments/spans modeled)`,
  dangling.length === 0, dangling.slice(0, 6).join("; "));

// ---------------------------------------------------------------------------
// Report
for (const line of ok) console.log(`contract-check: PASS ${line}`);
if (fails.length) {
  for (const line of fails) console.error(`contract-check: FAIL ${line}`);
  console.error(`contract-check: FAILED — ${fails.length} of ${ok.length + fails.length} checks`);
  process.exit(1);
}
console.log(`contract-check: OK — ${ok.length} checks on ${path} (contract v${V})`);
