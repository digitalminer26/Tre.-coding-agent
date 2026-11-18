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
  let inComment = false, inFence = false, fenceChar = "", fenceLen = 0, fenceIndent = 0, fenceBq = false;
  let spanRun = 0; // r6-F2: open multi-line inline span (required closer run)
  const findRun = (str, from, n) => {
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
  const processText = (ln, st, openSpan) => {
    let res = "", i = 0;
    while (i < ln.length) {
      if (ln[i] === "\\" && i + 1 < ln.length) { res += ln[i] + ln[i + 1]; i += 2; continue; }
      if (ln[i] === "`") {
        let n = 0;
        while (ln[i + n] === "`") n++;
        const close = findRun(ln, i + n, n);
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
          if (openSpan) { st.spanRun = n; i = ln.length; break; }
          res += "`".repeat(n); i += n; continue;
        }
        res += ln.slice(i, close + n); i = close + n; continue;
      }
      if (ln.startsWith("<!--", i)) {
        const c = ln.indexOf("-->", i + 4);
        if (c !== -1) { res += " ".repeat(c + 3 - i); i = c + 3; continue; }
        st.inComment = true; res += " ".repeat(ln.length - i); i = ln.length; break;
      }
      res += ln[i]; i++;
    }
    return res;
  };
  // r6-F3: fences open THROUGH a blockquote prefix (> ```): a line is
  // tested plain first, then with its "> " prefix(es) stripped (CommonMark
  // strips one optional space). The closer must carry the same shape, and
  // the r5-F3 indent rule holds (closer indent <= opener indent).
  const fenceMatch = (ln, expectBq) => {
    let rest = ln, indent = 0, bq = false;
    const lead = rest.match(/^( {0,3})/); if (lead) { indent = lead[1].length; rest = rest.slice(indent); }
    if (expectBq) {
      const bp = rest.match(/^(?:>[ ]?)+/);
      if (!bp) return null;
      bq = true; rest = rest.slice(bp[0].length);
      const lead2 = rest.match(/^( {0,3})/); if (lead2) { indent = lead2[1].length; rest = rest.slice(lead2[1].length); }
    }
    const m = rest.match(/^(`{3,}|~{3,})(.*)$/);
    if (!m) return null;
    if (m[1][0] === "`" && m[2].includes("`")) return null;
    return { marker: m[1], indent, bq };
  };
  // r6-F2 scope: CommonMark pairs inline code WITHIN a block — a
  // pending span dies at a blank line (paragraph end) and a FENCE line
  // interrupts the paragraph (opener becomes literal, fence opens).
  // Lines that are block-openers (table rows, headings, ">") never OPEN
  // a pending span: their inline code is scoped to their own line/cell.
  const canOpenSpan = (ln) => !/^(?: {0,3}(?:#{1,6} |\||>|~~~|```))/.test(ln);
  let prevBlank = true; // r7-F6: start-of-file behaves like a blank line
  let codeIndent = -1;  // r7-F6: active indented-code block (indent width)
  const indentWidth = (ln) => {
    const m = ln.match(/^ +/); if (m) return m[0].length;
    const t = ln.match(/^\t/); return t ? 4 : 0;
  };
  for (const ln of lines) {
    const isBlank = !ln.trim();
    // r7-F6: inside an indented code block — blank lines and lines at
    // >= the opener's indent keep the block; anything else ends it and
    // is processed normally from here.
    if (codeIndent >= 0) {
      if (isBlank) { outLines.push(" ".repeat(ln.length)); prevBlank = true; continue; }
      if (indentWidth(ln) >= codeIndent) { outLines.push(" ".repeat(ln.length)); prevBlank = false; continue; }
      codeIndent = -1;
    }
    if (inFence) {
      const cm = !fenceBq && ln.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
      const cb = fenceBq && ln.match(/^( {0,3})(?:>[ ]?)+( {0,3})(`{3,}|~{3,})[ \t]*$/);
      const marker = cm ? cm[2] : cb ? cb[3] : null;
      const mIndent = cm ? cm[1].length : cb ? cb[2].length : 99;
      // r5-F3: char match, run >= opener, closer indent <= opener indent.
      // r7-F3: EVERY close path resets the full fence state (not just the
      // inFence flag) so a later open cannot inherit stale opener shape.
      if (marker && marker[0] === fenceChar && marker.length >= fenceLen && mIndent <= fenceIndent) {
        inFence = false; fenceChar = ""; fenceLen = 0; fenceIndent = 0; fenceBq = false;
        outLines.push(ln.replace(/./g, " ")); prevBlank = isBlank; continue;
      }
      // r7-F3: a blockquote fence cannot outlive its blockquote — a blank
      // line or a line WITHOUT the ">" prefix ends both. The line that
      // ended the blockquote is LIVE and falls through for normal
      // processing (it was never fence content).
      if (fenceBq && (isBlank || !/^( {0,3})(?:>[ ]?)/.test(ln))) {
        inFence = false; fenceChar = ""; fenceLen = 0; fenceIndent = 0; fenceBq = false;
        if (isBlank) { outLines.push(" ".repeat(ln.length)); prevBlank = true; continue; }
      } else {
        outLines.push(ln.replace(/./g, " ")); prevBlank = isBlank; continue;
      }
    }
    if (inComment) {
      const c = ln.indexOf("-->");
      if (c === -1) { outLines.push(" ".repeat(ln.length)); prevBlank = isBlank; continue; }
      inComment = false;
      const st = {};
      let out = processText(ln.slice(c + 3), st, canOpenSpan(ln));
      if (st.spanRun) { spanRun = st.spanRun; out = out.replace(/`+/g, (m) => " ".repeat(m.length)); }
      outLines.push(" ".repeat(c + 3) + out);
      if (st.inComment) inComment = true;
      prevBlank = isBlank;
      continue;
    }
    // Fence open is checked BEFORE the pending-span branch: a fence line
    // interrupts the paragraph, so the opener run was literal (CommonMark).
    const fm = fenceMatch(ln, false) ?? fenceMatch(ln, true);
    if (fm) {
      spanRun = 0;
      inFence = true; fenceChar = fm.marker[0]; fenceLen = fm.marker.length; fenceIndent = fm.indent; fenceBq = fm.bq;
      outLines.push(ln.replace(/./g, " ")); prevBlank = isBlank; continue;
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
        // Content line: copied (§refs inside stay LIVE) but NEVER heading/
        // fence/comment material — leading space kills a phantom heading.
        const c = findRun(ln, 0, spanRun);
        if (c === -1) { outLines.push(" " + ln); prevBlank = false; continue; }
        let runLen = 0; while (ln[c + runLen] === "`") runLen++;
        spanRun = 0;
        const st = {};
        outLines.push(" " + " ".repeat(c + runLen) + processText(ln.slice(c + runLen), st, canOpenSpan(ln)));
        if (st.inComment) inComment = true;
        if (st.spanRun) spanRun = st.spanRun;
        prevBlank = false;
        continue;
      }
    }
    // r7-F6: indented code block START — 4+ spaces (or a tab) directly
    // after a blank line (outside fences/comments/pending spans, which
    // are all handled above). Documented exclusion: content is code,
    // masked to the end of the indented run.
    if (prevBlank && indentWidth(ln) >= 4) {
      codeIndent = indentWidth(ln);
      outLines.push(" ".repeat(ln.length)); prevBlank = false; continue;
    }
    const st = {};
    let out = processText(ln, st, canOpenSpan(ln));
    if (st.spanRun) {
      // r6-F2: the opener run is masked once the span pairs (closer emits
      // as spaces too) — backtick runs vanish from live text.
      spanRun = st.spanRun;
      out = out.replace(/`+/g, (m) => " ".repeat(m.length));
    }
    outLines.push(out);
    if (st.inComment) inComment = true;
    prevBlank = isBlank;
  }
  if (inComment) issues.push("unclosed <!-- masks the rest of the document from C9");
  if (inFence) issues.push("unclosed code fence masks the rest of the document from C9");
  if (spanRun > 0) issues.push("unclosed multi-line inline span masks heading/fence structure from C9");
  return { masked: outLines.join("\n").replace(/[\u2028\u2029]/g, " "), issues };
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
const extPrefix = (before, line) =>
  // Unicode-aware left boundary (r4-F5): édocs/a is one word, not a path.
  /(?<![\p{L}\p{N}\p{M}\p{Pc}/.~-])docs\/(?=[^\s§|]*[A-Za-z0-9])[\w.~\-–—…#()\/]{1,60}(?:[ ]?§[0-9]+(?:\.[0-9]+)*[a-z]?(?:[ ]?[\/&][ ]?|, ))*[ ]?$/u.test(before)
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
  || (/"doc"\s*:\s*"docs\/[A-Za-z0-9/._\u2026-]+"\s*,\s*"anchor"\s*:\s*"$/.test(before)
      && (line.match(/"doc"\s*:/g) || []).length === 1);
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
    if (extPrefix(line.slice(0, m.index), line)) continue; // true external anchor chain
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
