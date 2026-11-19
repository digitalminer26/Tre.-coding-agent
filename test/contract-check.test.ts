// c28 mutation probes: prove every contract-check guard FIRES on the exact
// fault class it was written for. Each probe copies the real schema, plants
// one fault, and asserts contract-check.mjs exits 1 with the named check in
// its FAIL output. Run: node --test test/contract-check.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Walk up from this test file to the repo root (the nearest ancestor that
// contains BOTH the contract checker and the schema doc) so the probes work
// regardless of how deep this test sits in the tree.
let repoRoot = path.dirname(fileURLToPath(import.meta.url));
for (;;) {
  const parent = path.resolve(repoRoot, "..");
  if (parent === repoRoot) throw new Error("no repo root above test dir");
  repoRoot = parent;
  if (
    fs.existsSync(path.join(repoRoot, "scripts", "contract-check.mjs")) &&
    fs.existsSync(path.join(repoRoot, "docs", "11-orchestrator-schema.md"))
  ) break;
}
const SCRIPT = path.join(repoRoot, "scripts", "contract-check.mjs");
const DOC = path.join(repoRoot, "docs", "11-orchestrator-schema.md");
const base = fs.readFileSync(DOC, "utf8");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-probe-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runProbe(name: string, doc: string, expectFail: string[] | false) {
  const f = path.join(tmp, `${name}.md`);
  fs.writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  if (expectFail) {
    assert.equal(r.status, 1, `${name}: expected exit 1, got ${r.status}`);
    for (const frag of expectFail) {
      if (!r.stderr.includes(frag)) {
        assert.fail(`${name}: FAIL output missing "${frag}"\n--- stderr ---\n${r.stderr}\n--- stdout tail ---\n${r.stdout.slice(-400)}`);
      }
    }
  } else {
    assert.equal(r.status, 0, `${name}: expected exit 0, got ${r.status}\n${r.stderr}`);
  }
}

test("baseline copy passes", () => runProbe("baseline", base, false));

// Helper: wipe EVERY current-version citation inside one section's
// statusText window (status line + following paragraph up to the first
// blank line) — simulating a fold that bumped nothing there. This is
// where C2 looks; a single literal replace can silently launder itself
// when a section keeps its citation in the paragraph after the header.
function staleSection(doc: string, sec: string, from: string, to: string): string {
  const hm = doc.match(new RegExp(`^### ${sec.replace(".", "\\.")} `, "m"));
  assert.ok(hm, `section ${sec} header not found`);
  const start = hm.index!;
  const next = doc.indexOf("\n### ", start + 1);
  const end = next === -1 ? doc.length : next;
  const window = doc.slice(start, end);
  const st = window.search(/\*\*Status: DRAFT v\d+ \(/);
  assert.ok(st >= 0, `status line missing in ${sec}`);
  const rest = window.slice(st);
  const paraEnd = rest.indexOf("\n\n");
  const winEnd = paraEnd === -1 ? window.length : st + paraEnd;
  const edited = window.slice(st, winEnd).replaceAll(from, to);
  assert.notEqual(edited, window.slice(st, winEnd), `no ${from} in ${sec} window`);
  return doc.slice(0, start + st) + edited + doc.slice(start + winEnd);
}

// A1: a fully stale section must fail PER-SECTION (C2) and overall (C1).
test("A1 one stale section fails that section citation", () => {
  const mutated = staleSection(base, "14.12", "v34", "v33");
  runProbe("a1-stale-subnote", mutated, ["C2 \u00a714.12 status cites v34", "C1 status uniform"]);
});

// A1: a second section (14.14) left fully stale fails too.
test("A1 one stale section status line fails uniformly", () => {
  const target = staleSection(base, "14.14", "v34", "v33");
  runProbe("a1-stale-status", target, ["C1 status uniform", "C2 \u00a714.14 status cites v34"]);
});

// A1 decoy: a fake status string OUTSIDE any G-section must not launder a
// real section's stale version (the old doc-wide presence check passed
// this). \u00a714.11 fully stale (v33 throughout its window) + a planted
// decoy elsewhere: C1 catches the non-uniform version; \u00a714.11 keeps
// its v34 fold citation so C2 passes there BY DESIGN (C1 owns uniformity;
// C2 owns citation presence).
test("A1 decoy status outside sections launders nothing", () => {
  const stale = staleSection(base, "14.11", "v34", "v33");
  const decoyAnchor = "### 14.1 Identity";
  const i = stale.indexOf(decoyAnchor);
  assert.ok(i > 0);
  const mutated = stale.slice(0, i) + "**Status: DRAFT v34 (2099-01-01)**\n\n" + stale.slice(i);
  runProbe("a1-decoy", mutated, ["C1 status uniform"]);
});

// A4: a decoy (vN marker planted in an OLDER ledger row fails uniqueness.
test("A4 decoy marker in an older row fails uniqueness", () => {
  const olderRow = "| 2026-10-30 | \u00a712 | added build-vs-buy prior-art appendix (herdr evaluation) | internet research |";
  assert.ok(base.includes(olderRow));
  const decoy = olderRow.replace("(herdr evaluation)", "(v34 decoy) (herdr evaluation)");
  runProbe("a4-decoy-marker", base.replace(olderRow, decoy), ["C3 exactly one row carries the current-version marker (v34)"]);
});

// A4: unescaped-terminator detection — convert the c27 row's final | to \|
test("A4 escaped terminator fails termination", () => {
  const m = base.match(/^\| 2026-11-18 \| §14\.12\.3, §14\.12\.4b, tooling \|.*\|\s*$/m);
  assert.ok(m, "c27 ledger row not found");
  const row = m[0].trimEnd();
  const escaped = row.slice(0, -1) + "\\|";
  runProbe("a4-escaped", base.replace(row, escaped), ["C3 all ledger rows terminated (unescaped)"]);
});

// A4: the marked row with an open decision fails.
test("A4 current row with DECISIONS-REQUIRED: 1 fails", () => {
  const mutated = base.replace(
    "wired into quality-check.sh as step 8: C1 status-line uniformity",
    "wired into quality-check.sh as step 8 (DECISIONS-REQUIRED: 1): C1 status-line uniformity",
  );
  assert.notEqual(mutated, base);
  runProbe("a4-open-decision", mutated, ["C3 current-marked row DECISIONS-REQUIRED"]);
});

// A3: deleting a pinned sentence and burying it in an HTML comment ELSEWHERE
// must still fail (old doc-wide substring check passed this).
test("A3 pin deletion hidden in a comment fails", () => {
  const pin = "A closed fault is never reopened by an unsupported read, and no later validation rewrites it.";
  assert.ok(base.includes(pin));
  // replaceAll: the pin exists BOTH in the c27 ledger row and in \u00a714.12
  // proper; a single replace only hits the ledger copy and launders the
  // section unchanged. All copies go, then one is buried in a comment.
  let mutated = base.replaceAll(pin, "[rule removed in fold].");
  mutated = mutated.replace("### 14.13 ", `<!-- ${pin} -->\n\n### 14.13 `);
  runProbe("a3-comment-burial", mutated, ["C8 pin survives in \u00a714.12"]);
});

// A3: pin moved to another section fails the home-section check.
test("A3 pin relocated to another section fails", () => {
  const pin = "the restored blob is INERT";
  const moved = base.replace(pin, "[moved]").replace("### 14.15 ", `note: ${pin}\n\n### 14.15 `);
  runProbe("a3-relocated", moved, ["C8 pin survives in \u00a714.12"]);
});

// A6: allowlist self-validation — delete EVERY mention of an allowlisted
// term (kind-shaped prose term) so only the allowlist would cover it.
test("A6 stale allowlist entry fails self-validation", () => {
  // `residual-unit-release` lives in the allowlist; scrub all its mentions
  // from the doc (keep one in a NON-backticked impossible-to-count form? no:
  // scrub to zero). The self-check must then flag the allowlist entry.
  let mutated = base;
  const term = "residual-unit-release";
  while (mutated.includes(term)) mutated = mutated.replace(term, "scrubbed-term");
  runProbe("a6-stale-allow", mutated, ["C7 allowlist entries still exist in the document"]);
});

// C4: add a kind to the faultKind union with no identity tuple.
test("C4 unbound faultKind fires", () => {
  // Anchor-preserving insertion: keep `faultKind: "counter-divergence"`
  // intact (the region-anchor indexOf) and add the new kind mid-union.
  const mutated = base.replace('"counter-divergence" | "fenceless-boundary"', '"counter-divergence" | "brand-new-unbound-kind" | "fenceless-boundary"');
  assert.notEqual(mutated, base);
  runProbe("c4-unbound", mutated, ["C4 every faultKind bound to an identity tuple"]);
});

// C5: desync the two decision-enum sites.
test("C5 decision enum desync fires", () => {
  const mutated = base.replace('"accept-recomputed" |', '"accept-recomputed" | "brand-new-decision" |');
  runProbe("c5-desync", mutated, ["C5 decision enums agree (12.4b \u2286 12.4)"]);
});

// C6: reintroduce the undecided-authority idiom in the body.
test("C6 undecided idiom fires", () => {
  const mutated = base.replace("### 14.14 ", "### 14.14 \n\n(not decided here; the owner will choose)\n");
  runProbe("c6-idiom", mutated, ["C6 no 'not decided here' idiom in body"]);
});

// C7: new kind-shaped term (3+ components) that nothing registers.
test("C7 unregistered kind-shaped term fires", () => {
  const mutated = base.replace("### 14.14 ", "### 14.14 \n\nA `totally-new-kind-of-thing` record is dispatched.\n");
  runProbe("c7-novel", mutated, ["C7 no unregistered kind-shaped term"]);
});

// A1/date-independence: bumping every status DATE (not version) passes.
test("date-only change passes (no hard-coded date)", () => {
  const mutated = base.replaceAll("**Status: DRAFT v34 (2026-11-18", "**Status: DRAFT v34 (2026-12-31");
  runProbe("a1-date-bump", mutated, false);
});

// C9 — dangling cross-reference: a body §ref to a section that does not
// exist must fire. (§0.1-§0.7 = §0 principles; refs on a line naming
// docs/NN are external anchors and stay excused.)
test("dangling body §ref fails C9", () => {
  const mutated = base.replace("**Wire contract (P0-closed, \u2192 \u00a714.3):**", "**Wire contract (P0-closed, \u2192 \u00a714.99):**");
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-dangling", mutated, ["C9 every body §ref resolves"]);
});

test("§0.8 (beyond the 7 §0 principles) fails C9", () => {
  const mutated = base.replace(
    "**advice only**, never an authority grant, I-cortex §0.7)",
    "**advice only**, never an authority grant, I-cortex §0.8)",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-principle", mutated, ["C9 every body §ref resolves"]);
});

test("external-anchor control uses a LOCALLY unresolvable ref (F7)", () => {
  // §98.99 cannot resolve as a heading or a §0 principle — the ONLY thing
  // that may excuse it is the docs/NN proximity exemption.
  const mutated = base.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):**",
    "**Wire contract (docs/99 \u00a798.99):**",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-ext-anchor", mutated, false);
});

// F1 — proximity-bound exemption: docs/ AFTER the ref must not launder it.
test("docs/ mention after a dangling ref does not excuse it (C9 F1)", () => {
  const mutated = base.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):** one",
    "**Wire contract (P0-closed, \u2192 \u00a714.99):** one See docs/21 for background.",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-ext-after", mutated, ["C9 every body §ref resolves"]);
});

// F2 — the ledger exemption is scoped to §1: a date-shaped body row is live.
test("date-shaped row outside \u00a71 is scanned (C9 F2)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "| 2026-11-19 | Mandatory rule: follow \u00a714.99 |\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-fake-ledger", mutated, ["C9 every body §ref resolves"]);
});

// F3 — §0.7 must map to an ACTUAL principle: renumber it away and the
// previously-exempt §0.7 refs become dangling.
test("principle renumber breaks the \u00a70.n exemption (C9 F3)", () => {
  const mutated = base.replace("7. **Acceptance, not activity.**", "9. **Acceptance, not activity.**");
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-renumber", mutated, ["C9 every body §ref resolves"]);
});

// F4 — a heading faked inside an HTML comment resolves nothing.
test("commented fake heading does not resolve refs (C9 F4)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "<!-- ### 14.99 Placeholder -->\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  // Also needs a live ref to it.
  const mutated2 = mutated.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):**",
    "**Wire contract (P0-closed, \u2192 \u00a714.99):**",
  );
  runProbe("c9-fake-heading", mutated2, ["C9 every body §ref resolves"]);
  // NOTE: C8 stays green here — my probe text sits OUTSIDE the §14.12
  // section (the fake heading is a §14.99 anchor before §7), so only the
  // dangling ref is expected to fire.
});

// F5 — a legitimate 10th principle is exempt by ID, not by a digit bound.
test("legitimate \u00a70.10 principle is exempt (C9 F5)", () => {
  let mutated = base.replace(
    "## 1. Schema index & Change Ledger",
    "10. **Tenth principle.** Test fixture.\n\n## 1. Schema index & Change Ledger",
  );
  // principle list lives in §0 — insert the 10th BEFORE §1 heading block:
  mutated = base.replace(
    "\n## 1. Schema index & Change Ledger",
    "\n10. **Tenth principle.** Test fixture.\n\n## 1. Schema index & Change Ledger",
  );
  mutated = mutated.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):**",
    "**Wire contract (P0-closed, \u2192 \u00a70.10):**",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-principle-10", mutated, false); // §0.10 exempt by ID: full gate green (v1 [1-9] bound would have failed C9 here)
});

// F6 — a retired §ref inside a comment is not body text.
test("commented retired ref does not fail (C9 F6)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "<!-- retired reference \u00a714.99 -->\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-comment-ref", mutated, false);
});

// Round-2 F1 — a planted/unrelated docs/ mention must not launder.
test("backticked planted docs/ path does not launder (C9 r2-F1)", () => {
  const mutated = base.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):**",
    "**Wire contract (P0-closed): `docs/99` unrelated rule \u00a714.99:**",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-planted", mutated, ["C9 every body §ref resolves"]);
});

// Round-2 F2 — malformed tokens are flagged, never partially exempted.
test("§0.1e3 malformed token flagged (C9 r2-F2)", () => {
  const mutated = base.replace(
    "**Wire contract (P0-closed, \u2192 \u00a714.3):**",
    "**Wire contract (P0-closed, \u2192 \u00a70.1e3):**",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-malformed", mutated, ["C9 every body §ref resolves"]);
});

// Round-2 F3 — an unclosed comment must FAIL the gate, not mask the tail.
test("unclosed <!-- fails the gate (C9 r2-F3)", () => {
  const mutated = base + "\n<!--\n## 98. Fake heading\nlive ref \u00a798.99\n";
  runProbe("c9-unclosed", mutated, ["C9 every body §ref resolves"]);
});

// Round-3 F1 — punctuation pseudo-paths and embedded fragments never launder.
test("docs/.. and prefixdocs/ never launder (C9 r3-F1)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "docs/.. \u00a798.99 and prefixdocs/99 \u00a798.98\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-pseudo-path", mutated, ["C9 every body §ref resolves"]);
});

// Round-3 F2 — chains of any length resolve as chains; nested paths allowed.
test("3-link docs chain + nested path exempt (C9 r3-F2)", () => {
  let mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "docs/99 \u00a798.1/\u00a798.2/\u00a798.3 and docs/dir/file.md \u00a798.99\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-long-chain", mutated, false);
});

// Round-3 F3 — malformed prefixes/suffixes are flagged, never skipped.
test("§.98 and §0.1é9 flagged (C9 r3-F3)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "\u00a7.98 and \u00a70.1\u00e99\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-malformed-r3", mutated, ["C9 every body §ref resolves"]);
});

// Round-3 F4 — a stray --> earlier must not balance an unclosed <!--.
test("stray --> cannot balance an unclosed <!-- (C9 r3-F4)", () => {
  const mutated = base + "\n-->\n<!--\n\u00a798.99\n";
  runProbe("c9-stray-close", mutated, ["C9 every body §ref resolves"]);
});

// Round-3 F5 — `<!--` inside an inline code span is text, not a comment.
test("`<!--` in a code span neither masks nor false-fails (C9 r3-F5)", () => {
  const mutated = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "The marker `` `<!--` `` is literal text.\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(mutated, base, "anchor text not found");
  runProbe("c9-span-marker", mutated, false);
});

// Fenced blocks are data: refs and fake headings inside never reach C9, but
// an unclosed fence fails.
test("fenced payload masked; unclosed fence fails (C9 fences)", () => {
  const okMut = base.replace(
    "## 7. S6 \u2014 Episode state file",
    "```markdown\n### 14.99 fake\nlive ref \u00a714.99\n```\n\n## 7. S6 \u2014 Episode state file",
  );
  assert.notEqual(okMut, base, "anchor text not found");
  runProbe("c9-fence-masked", okMut, false);
  const badMut = base + "\n```\n\u00a798.99\n";
  runProbe("c9-fence-unclosed", badMut, ["C9 every body §ref resolves"]);
});

// Round-4 F1 — a fence inside an open comment starts no fence.
test("``` inside <!-- --> starts no fence (C9 r4-F1)", () => {
  const mutated = base + "\n<!--\n```\n-->\n\u00a799999\n```\n-->\n";
  runProbe("c9-fence-in-comment", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F2 — fence char/run pairing: ~~~ is not closed by ```.
test("~~~ fence survives ``` and fails unclosed (C9 r4-F2)", () => {
  const mutated = base + "\n~~~\n```\n\u00a799999\n";
  runProbe("c9-fence-pairing", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F3 — run-length-aware spans: a 2-tick span carries ` <!-- ` as
// literal text; the ref outside it stays LIVE (fails for the right reason).
test("`` ` <!-- `` span keeps the outside ref live (C9 r4-F3)", () => {
  const mutated = base + "\n`` ` <!-- `` \u00a799999\n";
  runProbe("c9-span-runlength", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F4 — CR-only line endings fail the model outright.
test("lone \\r fails the gate (C9 r4-F4)", () => {
  const mutated = base + "\n```\r```\r\u00a799999\n```\n";
  runProbe("c9-cr-only", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F5 — Unicode word boundary: édocs/a is not a docs path.
test("édocs/a does not launder (C9 r4-F5)", () => {
  const mutated = base + "\n\u00e9docs/a\u00a799999\n";
  runProbe("c9-unicode-boundary", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F6 — the record must bind a NON-EMPTY doc directly to its anchor.
test("empty doc path / split records do not launder (C9 r4-F6)", () => {
  const m1 = base + "\n{\"doc\":\"docs/\",\"anchor\":\"\u00a799999\"}\n";
  runProbe("c9-empty-doc", m1, ["C9 every body §ref resolves"]);
  const m2 = base + "\n{\"doc\":\"docs/a\"} {\"anchor\":\"\u00a799998\"}\n";
  runProbe("c9-split-records", m2, ["C9 every body §ref resolves"]);
});

// Round-6 F1 — U+2028/U+2029 are JS line terminators but the scanner's
// line model is \n-only: they are masked to spaces so a mid-line
// "heading" can never anchor ^; content use (C\u2028D) stays harmless.
test("U+2028 phantom heading cannot resolve a ref (C9 r6-F1)", () => {
  const mutated = base + "\ntext \u2028### 999 fake\n\u00a7999\n";
  runProbe("c9-u2028-phantom", mutated, ["C9 every body §ref resolves"]);
});

// Round-6 F2 — multi-line inline spans: a heading inside a span is not a
// heading (span content never gets heading/fence/comment interpretation),
// but §refs inside span content stay LIVE. Positive controls: a legit
// multi-line span (§ on a content line, resolved) and paragraph scoping
// (a stray opener dies at the blank line; the ref below is live+valid).
test("multiline span hides headings, keeps refs live (C9 r6-F2)", () => {
  const mutated = base + "\n`start\n### 999 fake\nend`\n\u00a7999\n";
  runProbe("c9-span-heading", mutated, ["C9 every body §ref resolves"]);
});
test("legit multiline span passes (r6-F2 positive)", () => {
  const mutated = base + "\n`see\n\u00a714.1\nhere`\n";
  runProbe("c9-span-legit", mutated, false);
});

// Round-6 F3 — fences open THROUGH a blockquote prefix (> ```): the
// fenced § is data. Positive control: a ref after a properly closed
// blockquote fence is live and must still be flagged when dangling.
test("blockquote fence masks its content (C9 r6-F3)", () => {
  const mutated = base + "\n> ```\n> \u00a7999\n> ```\n";
  runProbe("c9-bq-fence", mutated, false);
});
test("ref after closed blockquote fence is live (r6-F3)", () => {
  const mutated = base + "\n> ```\n> \u00a7999\n> ```\n\u00a7998\n";
  runProbe("c9-bq-fence-tail", mutated, ["C9 every body §ref resolves"]);
});

// Round-6 F4 — an escaped quote inside the doc value is refused
// (fail-closed: '"' is not a path char; ambiguous quoted paths are not
// an exemption). Documented limitation.
test("escaped quote in doc value refuses exemption (C9 r6-F4)", () => {
  const mutated = base + "\n{\"doc\":\"docs/a\\\"oops\",\"anchor\":\"\u00a7999\"}\n";
  runProbe("c9-escaped-quote-doc", mutated, ["C9 every body §ref resolves"]);
});

// Round-5 F1 — an UNCLOSED backtick run is literal text: the `<!--` that
// follows still opens a comment (copying the line remainder laundered it).
test("unclosed backtick does not hide a comment opener (C9 r5-F1)", () => {
  const mutated = base + "\n`oops <!--\n### 999 Fake\n-->\n\u00a7999\n";
  runProbe("c9-unclosed-backtick", mutated, ["C9 every body §ref resolves"]);
});

// Round-5 F2 — a COMMENTED-OUT `### 14.12 fake` heading is masked, not a
// section boundary: discovery must use the masked text too (positive
// control: this mutation must PASS, it used to fire 15 checks).
test("commented fake heading neither launders nor clobbers (r5-F2)", () => {
  const mutated = base + "\n<!--\n### 14.12 fake\n-->\n";
  runProbe("c5-commented-heading", mutated, false);
});

// Round-5 F3 (r13-F2 REVISED — the old rule was wrong): CommonMark bounds
// a CLOSER's indent at <= 3, NOT at the opener's indent. "  ```" closes a
// column-0 fence (the ref inside is fence content = masked; a ref AFTER
// the closer is live — proving the fence really closed). Control: a
// 4-space-indented marker never closes (it is itself fence content), so
// the fence stays unclosed and fails.
test("closer at indent <=3 closes; indent 4+ never closes (C9 r5-F3/r13-F2)", () => {
  const closing = base + "\n```\n\u00a799998 fence content\n  ```\n\u00a799999 live after closer\n";
  const fc = path.join(tmp, "c9-closer-indent-closes.md");
  fs.writeFileSync(fc, closing);
  const rc = spawnSync(process.execPath, [SCRIPT, fc], { encoding: "utf8" });
  assert.equal(rc.status, 1, "F3-r13: the live ref after the closer must fire C9");
  assert.ok(!rc.stderr.includes("\u00a799998"), "F3-r13: ref inside the closed fence must stay masked");
  assert.ok(rc.stderr.includes("\u00a799999"), "F3-r13: ref after the closer must be live");
  runProbe("c9-closer-indent-4", base + "\n```\n\u00a799999\n    ```\n", ["unclosed code fence"]);
});

// Round-5 F4 — a duplicate "doc" key makes the record ambiguous; the
// anchor pairing is refused (last-key-wins parsers resolve doc:"local").
test("duplicate doc keys refuse the anchor exemption (C9 r5-F4)", () => {
  const mutated = base + "\n{\"doc\":\"docs/a\", \"anchor\":\"\u00a7999\", \"doc\":\"local\"}\n";
  runProbe("c9-dup-doc-keys", mutated, ["C9 every body §ref resolves"]);
});

// Round-4 F7 — a pin fenced away as example content does NOT survive C8:
// sections come from the masked text, same model as C9.
test("fenced pin fails C8 (r4-F7 shared masking)", () => {
  const pin = "A closed fault is never reopened by an unsupported read, and no later validation rewrites it.";
  assert.ok(base.includes(pin), "pin text not found");
  // The sentence appears TWICE (c27 ledger row + the §14.12 pin); fence the
  // whole LINE of the last occurrence — the one inside §14.12 that C8's
  // registry checks (a fence must open at line start to count).
  const idx = base.lastIndexOf(pin);
  const lineStart = base.lastIndexOf("\n", idx) + 1;
  const lineEnd = base.indexOf("\n", idx) === -1 ? base.length : base.indexOf("\n", idx);
  const mutated = base.slice(0, lineStart) + "```\n" + base.slice(lineStart, lineEnd) + "\n```" + base.slice(lineEnd);
  runProbe("c8-fenced-pin", mutated, ["C8 pin survives"]);
});

// ── Round-7 (cycle-2) probes ───────────────────────────────────────────

// F2: heading interrupts an unmatched span — the heading text and every
// line after it must be visible (never silently swallowed into a pending
// span). Positive control: a planted ref in the heading line stays
// VISIBLE (fires C9); negative control: the same ref inside a genuinely
// paired multi-line span stays MASKED (no fire).
test("F2 heading interrupts pending span (positive control)", () => {
  runProbe("r7-heading-kills-span", base + "\n`unclosed\n\n## Heading §999 after stray opener\n\nbody\n",
    ["C9 every body", "\u00a7999"]);
  // Negative control: a GENUINE paired multi-line span still hides
  // heading STRUCTURE (the fake ### inside live span content must not
  // create a section — C1/C8 clean) and carries no dangling ref.
  runProbe("r7-span-still-pairs", base + "\n`two runs\n### 999 fake heading\nend`\n", false);
});

// F3: a blockquote fence that never closes must not turn the whole tail
// into invisible markdown — a §999 after it must still fire.
test("F3 unclosed blockquote fence leaks no invisibility", () => {
  runProbe("r7-bq-fence-leak", base + "\n> ```\n§999 after unclosed fence\n", ["C9 every body", "\u00a7999"]);
});

// F4: strict doc paths — a '"doc":"…"' value with characters outside
// [A-Za-z0-9/._-] (? # spaces) is rejected as a path candidate, so its
// following "anchor" is NOT exempted.
test("F4 loose doc-value candidates are not consumed as paths", () => {
  runProbe("r7-doc-loose-value",
    base + '\n{ "doc":"docs/notes/weekly digest?x=1", "anchor":"§999" }\n',
    ["C9 every body", "\u00a7999"]);
  runProbe("r7-doc-hash-value",
    base + '\n{ "doc":"docs/11-orchestrator-schema.md#s3.5", "anchor":"§999" }\n',
    ["C9 every body", "\u00a7999"]);
  // Positive control: a strict-path doc record still exempts its anchor.
  runProbe("r7-doc-strict-ok",
    base + '\n{ "doc":"docs/11-orchestrator-schema.md", "anchor":"§999" }\n', false);
});

// F5: stated policy is refuse ANY CR — CRLF too (byte-exact contract).
test("F5 CRLF is refused (any-CR policy)", () => {
  const crlf = base.replace(/\n/g, "\r\n");
  const f = path.join(tmp, "r7-crlf.md");
  fs.writeFileSync(f, crlf, "latin1");
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "latin1" });
  assert.equal(r.status, 1, "CRLF file must exit 1");
  assert.ok(r.stderr.includes("CR") || r.stderr.match(/carriage/i) !== null,
    `stderr should name the CR policy:\n${r.stderr.slice(0, 400)}`);
});

// F6: indented code blocks are not paragraph continuation — a planted
// §ref inside one stays invisible (documented exclusion).
test("F6 indented code block masks its refs", () => {
  const doc = base + "\n\ntext before\n\n    §999 in an indented code block\n\ntext after\n";
  const f = path.join(tmp, "r7-indented-code.md");
  fs.writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 0, `expected valid indented code fixture: ${r.stderr}`);
  if (r.stderr.includes("§999")) {
    assert.fail("F6: §ref inside an indented code block must stay masked");
  }
});

// ---------------------------------------------------------------------------
// Round-8 (c35 terra audits): masking-model fixes with probes.
// A1: a blank-line paragraph continuation inside a list item is LIVE prose
// (CommonMark) — its §ref must be flagged, not masked as indented code.
test("R8-A1 list continuation paragraph keeps refs live", () => {
  runProbe("r8-a1-list-cont", base + "\n- item\n\n    §999 list continuation\n", ["C9 every body", "\u00a7999"]);
});

// A2: code inside a list item (item-content col + 4) is still code — masked.
test("R8-A2 indented code inside a list item stays masked", () => {
  const doc = base + "\n- item\n\n      §999 code in item\n";
  const f = path.join(tmp, "r8-a2-code-in-item.md");
  fs.writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 0, `code-in-item: expected exit 0\n${r.stderr}`);
});

// D1: a DEEPER blockquote fence line ("> > ```") inside a depth-1
// blockquote fence is fence CONTENT — it must not close the fence early
// and expose following lines, and the plain-depth closer after it must.
test("R8-D1 blockquote fence closes only at its own depth", () => {
  const inside = base + "\n> ```\n> > ```\n> §999 still fence content\n> ```\n";
  const fi = path.join(tmp, "r8-d1-inside.md");
  fs.writeFileSync(fi, inside);
  const ri = spawnSync(process.execPath, [SCRIPT, fi], { encoding: "utf8" });
  assert.equal(ri.status, 0, `expected valid masked fixture: ${ri.stderr}`);
  assert.ok(!ri.stderr.includes("§999"), "D1: §999 inside the fence must stay masked");
  runProbe("r8-d2-after", base + "\n> ```\n> > ```\n> content\n> ```\n§999 after fence\n", ["C9 every body", "\u00a7999"]);
});

// FB (r16-F2 REVERSAL): CommonMark §6.1 — backslash escapes do NOT
// operate inside code spans: "`a \`" CLOSES the span at the escaped
// backtick. The old rule (an escaped backtick cannot close a span) let
// "`a \` <!--" stay open and hide every following line under a phantom
// unclosed span; it is REVERSED: the escaped run closes the span.
// r21-F1 (audit HIGH, SECOND reversal): the "<!--" after the closed
// span is INLINE paragraph text — not at a type-2 block start — so it
// NEVER opens a multiline comment (both reference implementations
// render it as html_inline literal text; commonmark.js shows
// paragraph[text, code, text, html_inline]). The old expectation
// ("ref lands in a real comment", masked) laundered live refs and is
// REVERSED: the ref below is live and must be reported.
test("R8-FB escaped ticks close a span (CommonMark §6.1); inline unclosed <!-- never hides following lines", () => {
  const doc = base + "\npara `a \\` <!--\n\u00a7999 in comment\n--> `\n";
  const f = path.join(tmp, "r16-fb-escape.md");
  fs.writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 1, "r21: §999 after an INLINE unclosed opener must be reported as unresolved");
  assert.ok(r.stderr.includes("\u00a7999"), "r21-F1: §999 must stay LIVE (inline unclosed <!-- is literal text)");
  assert.ok(!r.stderr.includes("unclosed"), "r21: no phantom unclosed-span issue may remain");
});

// E1/E2: NBSP and form-feed are NOT blank lines (CommonMark: blank =
// spaces/tabs only) — they never kill a pending span or an indented-code
// block. §999 stays inside the still-running code block.
test("R8-E exotic whitespace lines are not blank", () => {
  for (const [nm, ws] of [["formfeed", "\f"], ["nbsp", "\u00a0"]] as const) {
    const doc = base + `\ntext\n\n    §999 code\n${ws}\n    more code\n`;
    const f = path.join(tmp, `r8-e-${nm}.md`);
    fs.writeFileSync(f, doc);
    const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
    assert.equal(r.status, 0, `expected valid masked fixture: ${r.stderr}`);
    assert.ok(!r.stderr.includes("§999"), `E-${nm}: §999 must stay masked (line is not blank)`);
  }
});

// R8-F1: tab STOPS count — " \t" REACHES column 4, so after a blank line
// it opens indented code (masked). A tab-indented ``` mid-paragraph does
// NOT open a fence (a code block cannot interrupt a paragraph): the ref
// on the tab-indented line stays live.
test("R8-F1 tab-stop columns: space-tab opens code, tab-fence needs a block boundary", () => {
  const code = base + "\ntext\n\n \t§999 tab-stop code\n";
  const fc = path.join(tmp, "r8-f1-tabcode.md");
  fs.writeFileSync(fc, code);
  const rc = spawnSync(process.execPath, [SCRIPT, fc], { encoding: "utf8" });
  assert.equal(rc.status, 0, `expected valid masked fixture: ${rc.stderr}`);
  assert.ok(!rc.stderr.includes("§999"), "F1: §999 after ' \\t' must stay masked (col 4 code)");
  runProbe("r8-g1-tabfence", base + "\nparagraph\n\t```\n\t§999 paragraph continuation\n", ["C9 every body", "\u00a7999"]);
});

// ---------------------------------------------------------------------------
// Round-9 (terra audits): list-content-column precision + list fence death.
// F1: tab padding after a list marker advances to the NEXT TAB STOP
// ("-\tx" content column 4): with floor col+4, an 8-column line is
// indented code (masked) while a 5-column line stays live continuation.
test("R9-F1 tab padding after marker uses tab stops", () => {
  const code = base + "\n-\tx\n\n        §999 code at col 8\n";
  const fc = path.join(tmp, "r9-f1-code.md");
  fs.writeFileSync(fc, code);
  const rc = spawnSync(process.execPath, [SCRIPT, fc], { encoding: "utf8" });
  assert.equal(rc.status, 0, `expected valid masked fixture: ${rc.stderr}`);
  assert.ok(!rc.stderr.includes("§999"), "F1: 8-col line after '-\\tx' is code — must stay masked");
  runProbe("r9-f1b-cont", base + "\n-\tx\n\n     §999 five-col continuation\n", ["C9 every body", "\u00a7999"]);
});

// F2: padding beyond 4 columns after the marker start makes the item's
// first block an indented code block; content column drops to
// markerEnd+1 ("-     x" -> column 2): a 6-column line is code (>= 2+4).
test("R9-F2 >4-column padding: item content column is markerEnd+1", () => {
  const code = base + "\n-     x\n\n      §999 item code (col 6 >= 2+4)\n";
  const fc = path.join(tmp, "r9-f2-code.md");
  fs.writeFileSync(fc, code);
  const rc = spawnSync(process.execPath, [SCRIPT, fc], { encoding: "utf8" });
  assert.equal(rc.status, 0, `expected valid masked fixture: ${rc.stderr}`);
  assert.ok(!rc.stderr.includes("§999"), "F2: 6-col line is item code — must stay masked");
  runProbe("r9-f2b-live", base + "\n-     x\n\n     §999 five-col paragraph\n", ["C9 every body", "\u00a7999"]);
});

// F3 (FAIL-OPEN): a fenced block opened INSIDE a list item must die with
// the item — a non-blank line dedented below the item content column
// ends both, and its §refs are live top-level prose. (Control: the same
// fence keeps masking while lines stay at the item column.)
test("R9-F3 list-contained fence dies at the item dedent", () => {
  runProbe("r9-f3-dedent", base + "\n- item\n  ```\n  code\n§999 live after list end\n  ```\n", ["C9 every body", "\u00a7999"]);
  const inside = base + "\n- item\n  ```\n  §999 inside fence\n  ```\nafter\n";
  const fi = path.join(tmp, "r9-f3-inside.md");
  fs.writeFileSync(fi, inside);
  const ri = spawnSync(process.execPath, [SCRIPT, fi], { encoding: "utf8" });
  assert.equal(ri.status, 0, `expected valid masked fixture: ${ri.stderr}`);
  assert.ok(!ri.stderr.includes("§999"), "F3 control: ref inside a still-open item fence stays masked");
});

// ---------------------------------------------------------------------------
// Round-10 (terra convergence): fenceListCol must tag the item that OWNS
// the fence line (innermost column <= the line's absolute column — a
// fence at an OUTER item's column with a deeper inner item open was
// untagged and survived the item end = FAIL-OPEN), and the tag compares
// against the column BEFORE any "> " strip (a blockquote fence inside a
// list item died never: FAIL-OPEN).
test("R10 fenceListCol: outer-item fence and blockquote-in-item fence die with the item", () => {
  runProbe("r10-outer-item-fence", base + "\n- a\n  - b\n  ```\n  x\n§999 live after outer item\n  ```\n", ["C9 every body", "\u00a7999"]);
  runProbe("r10-bq-in-item", base + "\n- item\n  > ```\n  > code\n> §999 live past item\n> ```\n", ["C9 every body", "\u00a7999"]);
  // controls: fences still mask while their item is alive
  const c1 = base + "\n- item\n  > ```\n  > §999 inside\n  > ```\nT\n";
  const f1 = path.join(tmp, "r10-c1.md");
  fs.writeFileSync(f1, c1);
  const r1 = spawnSync(process.execPath, [SCRIPT, f1], { encoding: "utf8" });
  assert.equal(r1.status, 0, `expected valid masked fixture: ${r1.stderr}`);
  assert.ok(!r1.stderr.includes("§999"), "R10 control: bq fence inside a live item stays masked");
});

// ---------------------------------------------------------------------------
// Round-11: tab-indented fences in list items. "-\tx\n\t```" opens the
// fence at the item's tab-stop column (false-fire otherwise), and the
// closer/dedent tests are container-relative via consumeCol — a tab that
// CROSSES the item column is consumed partially (CommonMark strips the
// container prefix tab-stop-wise and the overshot columns return as
// spaces), so the fence lives; only a non-whitespace char before the
// column is a true dedent (death). The listStack pop now runs ONLY on
// fence-match lines (an unconditional pop killed list-continuation
// exemptions: caught by the R8-A1/R9-F1/R9-F2 probes during development).
test("R11 tab fences: item-column container prefix, partial-tab crossing", () => {
  const open = base + "\n-\tx\n\t```\n\t§999 fence content\n\t```\nafter\n";
  const fo = path.join(tmp, "r11-tab-open.md");
  fs.writeFileSync(fo, open);
  const ro = spawnSync(process.execPath, [SCRIPT, fo], { encoding: "utf8" });
  assert.equal(ro.status, 0, `expected valid masked fixture: ${ro.stderr}`);
  assert.ok(!ro.stderr.includes("§999"), "R11: tab fence inside tab item must mask §999");
  // r12-F1 REVISED the r9-F3 expectation: a tab that OVERSHOOTS the item
  // column is consumed PARTIALLY (container-prefix tab semantics), so the
  // tab line is still fence content — masked. The fence never closes and
  // the unclosed-fence issue fires; §999 stays masked.
  runProbe("r11-overshoot", base + "\n- x\n  ```\n  a\n\t§999 tab-overshoot death\n", ["C9 every body", "unclosed code fence"]);
});

// ── Round 13 (F1: blockquote fence depth; F2: closer indent rule) ─────

// R13-F1: a fence survives lines at its own depth or deeper, but ends
// when its owning blockquote ends; the shallower line is live.
test("R13-F1: BQ fences end on a line shallower than the opener", () => {
  // A depth-1 fence survives a depth-2 content line and masks its own
  // depth-1 content until its depth-1 closer:
  runProbe("r13-bq-depth2-survives",
    base + "\n> ```\n> > ```\n> §9999 still fence content\n> ```\n",
    false);
  // the depth-1 line is fence content (masked), depth-0 line kills the
  // fence, ref on the depth-0 line is live:
  runProbe("r13-bq-depth2-dies-at-0",
    base + "\n> ```\n> > ```\n> content\n§9999 live\n",
    ["C9 every body", "\u00a7999"]);
  // fence at depth 1 with NO closer anywhere: dies at the depth-0 line
  // and the depth-0 line goes live.
  runProbe("r13-bq-depth1-dies-at-0",
    base + "\n> ```\n> code\ntail §9999 live\n",
    ["C9 every body", "\u00a7999"]);
  // THE canonical HIGH case: fence OPENER at depth 2. It survives depth-2
  // content lines (masked) and dies only at the first depth-1 line,
  // which is the outer quote's LIVE content.
  runProbe("r13-bq-depth2-opener-survives-depth2",
    base + "\n> > ```\n> > §9999 in fence\n> > ```\n",
    false);
  runProbe("r13-bq-depth2-dies-at-depth1",
    base + "\n> > ```\n> §9999 outer content\n",
    ["C9 every body", "\u00a7999"]);
});

// R13-F2: CommonMark closer rule — closer indentation ≤ 3 (NOT ≤ opener
// indent): a 2-space closer closes a 0-space opener; a ref after it is
// live while a ref inside the fence body stays masked.
test("R13-F2: closer indent bound is 3, not the opener's indent", () => {
  const src = base + "\n```\n§99998 masked\n   ```\n§9999 live\n";
  const f = path.join(tmp, "r13-f2-closer.md");
  fs.writeFileSync(f, src);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 1, "R13-F2: ref after the 3-space closer must fire C9");
  assert.ok(r.stderr.includes("\u00a7999"), "R13-F2: §999 after closer is live");
  assert.ok(!r.stderr.includes("\u00a799998"), "R13-F2: ref inside the fence body stays masked");
});

test("blockquote fence ends on an unmarked blank but not a marked blank", () => {
  runProbe("bq-unmarked-blank", base + "\n> ```\n> code\n\n> §99999 live\n> ```\n", ["§99999"]);
  runProbe("bq-marked-blank", base + "\n> ```\n> code\n>\n> §99999 masked\n> ```\n", false);
  runProbe("bq-partial-blank", base + "\n> > ```\n>\n> §99999 live\n", ["§99999"]);
});

test("nested blockquote fence recognizes indentation between quote markers", () => {
  runProbe("bq-spaced-nested", base + "\n>  > ```\n>  > §99999 masked\n>  > ```\n", false);
  runProbe("bq-spaced-dedent", base + "\n>  > ```\n> §99999 live\n", ["§99999"]);
  runProbe("bq-spaced-close", base + "\n>  > ```\n>   > ```\n> §99999 live\n", ["§99999"]);
});

test("quote opener does not consume indentation twice", () => {
  runProbe("bq-four-space-opener", base + "\n    > ```\n> §99999 live\n> ```\n", ["§99999"]);
  runProbe("bq-three-space-opener", base + "\n   > ```\n   > §99999 masked\n   > ```\n", false);
});

test("unsupported list within blockquote fails closed", () => {
  runProbe("bq-list-fence", base + "\n> - item\n>   ```\n>   code\n> §99999 live\n>   ```\n", ["list inside blockquote is unsupported"]);
});

test("unsupported nested quote lists fail closed before spans and inside outer lists", () => {
  runProbe("bq-list-after-span", base + "\nparagraph `\n> - item\n>   ```\n> §99999 live\n>   ```\n", ["list inside blockquote is unsupported"]);
  runProbe("bq-list-inside-item", base + "\n-\titem\n    > - nested\n    >   ```\n    > §99999 live\n    >   ```\n", ["list inside blockquote is unsupported"]);
});

test("comments in blockquotes fail closed when ownership is unsupported", () => {
  runProbe("bq-comment-escape", base + "\n> <!--\n§99999 live\n-->\n", ["comment inside blockquote is unsupported"]);
  runProbe("bq-comment-contained", base + "\n> <!--\n> §99999 example\n> -->\n", ["comment inside blockquote is unsupported"]);
  runProbe("comment-outside-quote", base + "\n<!--\n§99999 example\n-->\n", false);
});

test("same-line list quote list nesting is rejected", () => {
  runProbe("same-line-nested-list", base + "\n- > - item\n  >   ```\n  >   code\n  > §99999 live\n  >   ```\n", ["list inside blockquote is unsupported"]);
  runProbe("same-line-list-quote", base + "\n- > item\n  > ```\n  > §99999 masked\n  > ```\n", false);
});

// ── Round 14 (F1: list-owned comment laundry; F2: literal <!-- is not
// an opener inside inline code / fence info) ────────────────────────────

test("r14-F1: comment opened in a list dies at the list boundary — refs below are live", () => {
  // The audit's laundry pattern: a comment opened inside a list item
  // must NOT mask top-level prose after the list ends.
  runProbe("r14-list-owned-laundry", base + "\n- <!--\n§99999 live\n-->\n", ["§99999"]);
  // Dedent back to the item's OWN content column keeps the comment
  // owned: the ref stays masked.
  runProbe("r14-list-owned-same-col", base + "\n- item\n  <!--\n  §99999 masked\n  -->\n", false);
  // Nested item: the comment belongs to the DEEPER item; a line at the
  // outer item's column ends the inner list -> comment dies, ref live.
  runProbe("r14-nested-pop", base + "\n- a\n  - b <!--\n  §99999 live\n  -->\n", ["§99999"]);
  // r21-F1 (audit HIGH) REVERSAL of the old "still-in masked" control:
  // "- b <!--" sits at column 8 — 4 past the inner item's content
  // column 4 — so it is INLINE text of the item's paragraph (both
  // commonmark.js and markdown-it render "b <!--\n§99999\n-->" as
  // html_inline inside the paragraph, ref visible). An inline unclosed
  // opener never opens a multiline comment: the ref is LIVE.
  runProbe("r14-nested-still-in", base + "\n- a\n  - b <!--\n    §99999 masked\n    -->\n", ["§99999"]);
  // Comment closing BEFORE the list ends: nothing exposed.
  runProbe("r14-comment-closes-in-list", base + "\n- b <!-- §99999 masked -->\n", false);
  // Top-level comment unchanged (mask everything to -->).
  runProbe("r14-toplevel-still-masks", base + "\n<!--\n§99999 masked\n-->\npara\n", false);
});

test("r14-F2: literal <!-- in code spans and fence info is not a comment opener", () => {
  runProbe("r14-bq-code-span", base + "\n> use `<!--` to comment\n", false);
  runProbe("r14-bq-fence-info", base + "\n> ```html <!-- x\n> content §99999 masked\n> ```\n", false);
  runProbe("r14-bq-double-backtick", base + "\n> ``<!--`` not open\n", false);
  runProbe("r14-bq-escaped-backtick", base + "\n> \\`unclosed <!-- real opener\n> §99999 example\n> -->\n", ["comment inside blockquote is unsupported"]);
  runProbe("r14-bq-after-close-span", base + "\n> `x` then <!-- tail\n> §99999 example\n> -->\n", ["comment inside blockquote is unsupported"]);
  runProbe("r14-bq-tilde-fence-info", base + "\n> ~~~ <!-- info\n> content\n> ~~~\n", false);
});

// ── Round 15 (F1: fence opener in a same-line list chain launders via
// fence-info `<!--`; F2: same-line list chains `- - <!--` and TAB-indented
// nested `\t- <!--` were untracked so their owned comment hid live refs;
// F3: the pending-span closer masked everything BEFORE the closer,
// laundering a §ref sitting before the closing backtick run) ───────────

test("r15-F1: fence in a same-line list chain fails closed (container-model crossing)", () => {
  // "- > ~~~ <!-- info" opens a fence the main state machine never
  // models while processText reads the fence info's `<!--` as a phantom
  // comment opener — the two views must not diverge: fail closed.
  runProbe("r15-chain-fence-quote", base + "\n- > ~~~ <!-- info\n  §99999 live\n  -->\n", ["fence inside a same-line list chain"]);
  runProbe("r15-chain-fence-backtick", base + "\n- ``` <!-- info\n  §99999 live\n  -->\n", ["fence inside a same-line list chain"]);
  runProbe("r15-chain-fence-tilde", base + "\n- ~~ ~~~ nope\n", false); // not a fence chain: unaffected
});

test("r15-F2: same-line list chains and TAB-indented nesting are tracked for comment ownership", () => {
  // "- - <!--" — comment owned by the SAME-LINE nested item; a dedent to
  // column 0 ends both lists, the comment dies, and the ref is live.
  runProbe("r15-same-line-chain-laundry", base + "\n- - <!--\n§99999 live\n-->\n", ["§99999"]);
  // TAB-indented nested item: the tab was invisible to the old
  // space-only list matcher, so the comment outlived its owner.
  runProbe("r15-tab-nested-laundry", base + "\n- a\n\t- <!--\n§99999 live\n-->\n", ["§99999"]);
  // CONTROL (legit ownership): ref inside the item's content column,
  // dedent AFTER the closer — the comment is properly owned; masked.
  runProbe("r15-tab-nested-owned", base + "\n- x\n  <!--\n\t§99999 masked\n  -->\n", false);
  // Same-line chain where the comment stays inside the chain's column.
  runProbe("r15-chain-still-owned", base + "\n- - <!--\n    §99999 masked\n    -->\n", false);
});

test("r15-F3: a §ref before the pending-span closing delimiter stays live", () => {
  // "paragraph `\n§99999 `" — the closer pairs the span, but the TEXT
  // BEFORE the closer is span content (norm text): the ref must fire.
  runProbe("r15-span-closer-laundry", base + "\nparagraph `\n§99999 `\n", ["§99999"]);
  // CONTROL: a ref purely INSIDE the span content (between opener and
  // closer, not before a closer) was always live — still live.
  runProbe("r15-span-content-live", base + "\nstart `\n§99999\nend ` more\n", ["§99999"]);
  // CONTROL: closed same-line span — its content is live text (spans
  // are norm text): a ref inside a closed span is reported, not masked.
  runProbe("r15-closed-span-still-live", base + "\na `\u00a799999` b\n", ["§99999"]);
});

test("r15c2-F1: a §ref on the span opener line after the opener stays live", () => {
  // "paragraph ` §99999\nend `" — the opener-line remainder is span
  // content (norm text); the old code discarded it: laundering.
  runProbe("r15c2-span-opener-line-laundry", base + "\nparagraph ` §99999\nend `\n", ["§99999"]);
  // CONTROL: opener-line remainder with no ref and a later closer: fine.
  runProbe("r15c2-span-opener-line-clean", base + "\nparagraph ` x\nend `\n", false);
  // EDGE: opener run at column 0 — the copied remainder must not become
  // a phantom fence; the ref after it is live (never masked).
  runProbe("r15c2-span-col0-no-phantom-fence", base + "\n``~~~\n§99999\n~~~\n", ["§99999"]);
});

test("r15c2-F2: a list chain past the tracked depth fails closed (never a silent stop)", () => {
  // 9-marker chain: comment owned by the 9th item; the old 8-cap lost
  // that item and a dedent to column 16 laundered the ref.
  runProbe("r15c2-nine-chain-laundry", base + "\n- - - - - - - - - <!--\n                §99999\n                -->\n", ["§99999"]);
  // BOUNDARY at the cap: 8-marker chain still models correctly (masked).
  runProbe("r15c2-eight-chain-owned", base + "\n- - - - - - - - <!--\n                §99999\n                -->\n", false);
  // Past the hard model depth (16): fail closed with the guard issue.
  runProbe("r15c2-twenty-chain-guard", base + "\n" + "- ".repeat(20) + "<!--\n§99999\n-->\n", ["list chain deeper"]);
});

test("r15c2-F3: no candidate-expansion cap — 33-marker fence chain fails closed", () => {
  // 33 same-line markers then a fence whose info string carries "<!--":
  // past-cap candidates used to skip the fence guard entirely.
  const chain = "- ".repeat(33) + "~~~ <!-- info";
  runProbe("r15c2-long-chain-fence", base + `\n${chain}\n${" ".repeat(66)}~~~\n${" ".repeat(66)}§99999\n${" ".repeat(66)}-->\n`, ["fence inside a same-line list chain"]);
});

test("r15c3-F1: a multiline-span opener cannot JOIN text into a fake external path", () => {
  // "docs/`a §99999" + "end `" — deleting the opener run used to
  // reconstruct "docs/a §99999", fabricating an external adjacency.
  runProbe("r15c3-span-join-extpath", base + "\ndocs/`a \u00a799999\nend `\n", ["\u00a799999"]);
  // CONTROL: a genuine external chain (no backticks) stays exempt.
  runProbe("r15c3-plain-extchain", base + "\nsee docs/audits/audit-x.md \u00a74.2 detail\n", false);
});

test("r15c3-F2: a docs/ path inside an inline code span gets no external exemption", () => {
  // Backtick is now a left boundary of the extPrefix grammar: a path in
  // span content is literal text, never a prose chain (fail closed).
  runProbe("r15c3-span-extpath", base + "\n`docs/a \u00a799999`\n", ["\u00a799999"]);
  runProbe("r15c3-span-extpath-multiline", base + "\n`docs/a \u00a799999\nend `\n", ["\u00a799999"]);
  // CONTROL: glued non-path boundary (paren) keeps prior semantics.
  runProbe("r15c3-paren-boundary", base + "\n(docs/a.md \u00a74.2)\n", false);
});

// ---- r15c4 (audit cycle-1 TESTS-MISSING battery): span-range boundaries,
// multiline-span closer edges, comment ownership across dedents/siblings,
// and degenerate inputs. All probes assert the OBSERVED fail-closed/exempt
// behavior of the r15c3 range model; external §98.99 is unresolvable
// locally, so exemption failures are visible.

test("r15c4-T1: span-range boundary denial on external chains", () => {
  // Span ends GLUED to the path start: backtick is a left boundary and
  // the path start sits inside… denial either way, ref must fire.
  runProbe("r15c4-span-glued-pathstart", base + "\n`x`docs/a \u00a798.99 y\n", ["\u00a798.99"]);
  // Ref directly after the opener (inside span content): fires.
  runProbe("r15c4-ref-at-opener", base + "\ndocs/a `x\u00a798.99 y\n", ["\u00a798.99"]);
  // CONTROL: closed span EARLIER on the line, genuine chain after —
  // ranges do not overlap the chain region: exemption survives.
  runProbe("r15c4-span-then-genuine-chain", base + "\nrun `ls` then docs/audits/audit-x.md \u00a798.99 tail\n", false);
  // CONTROL: unrelated code span AFTER a genuine chain: still exempt.
  runProbe("r15c4-genuine-chain-then-span", base + "\nsee docs/audits/audit-x.md \u00a798.99 tail `code`\n", false);
  // Path wholly inside a span: no exemption.
  runProbe("r15c4-path-wholly-span", base + "\nsee `docs/audits/audit-x.md` \u00a798.99 tail\n", ["\u00a798.99"]);
});

test("r15c4-T2: multiline-span closer lines — content before/after a mid-line closer", () => {
  // Pending span, line with " ` more ` ": the first run CLOSES the span;
  // text after the closer is live prose until the next opener; a ref in
  // that region fires. Content BEFORE the closer (span text) also lives.
  runProbe("r15c4-closer-mid-line", base + "\nopener `\ndocs/audits/audit-x.md ` more ` \u00a798.99\nend `\n", ["\u00a798.99"]);
  runProbe("r15c4-closer-mid-line2", base + "\nopener `\na ` b ` docs/audits/audit-x.md \u00a798.99\nend `\n", ["\u00a798.99"]);
  // CONTROL: no ref anywhere on the closer edges: clean.
  runProbe("r15c4-closer-edges-clean", base + "\nopener `\ncontent ` more ` rest\nend `\n", false);
  // Longer opener run (```): a 2-run on the content line is literal
  // (run-length pairing); the span closes only at "end ```" — the
  // docs path before it gets no exemption.
  runProbe("r15c4-fencelike-closer", base + "\nopener ```\ndocs/audits/audit-x.md `` \u00a798.99 tail\nend ```\n", ["\u00a798.99"]);
  // Closer-line text before a never-matching "-->" stays live.
  runProbe("r15c4-span-closer-dangling-arrow", base + "\nopener `\ndocs/audits/audit-x.md\n \u00a798.99 -->\nend `\n", ["\u00a798.99"]);
});

test("r15c4-T3: comment ownership across list dedents and siblings", () => {
  // CONTROL: comment owned by the 2-deep item, dedent INSIDE the comment
  // (content indented under the item): stays masked.
  runProbe("r15c4-comment-dedent-under-item", base + "\n  - x\n    <!--\n    masked \u00a798.99\n    -->\n", false);
  // CONTROL: sibling item after a closed owned comment: live ref fires.
  runProbe("r15c4-sibling-after-comment", base + "\n- <!--\n  masked \u00a798.99\n  -->\n- \u00a798.99 live\n", ["\u00a798.99"]);
  // Deep chain dedented past the owner: comment dies, ref exposed.
  runProbe("r15c4-chain-dedent-kills-comment", base + "\n- - <!--\n  \u00a798.99\n  -->\n", ["\u00a798.99"]);
});

test("r15c4-T4: degenerate inputs never crash and stay fail-closed", () => {
  // Empty doc and fence-only doc: the checker exits nonzero on their own
  // anchors/ledger failures (or passes with zero refs) — never a crash;
  // assert via the fragment shared by both paths.
  runProbe("r15c4-fence-only-open", base + "\n```\n", ["unclosed code fence"]);
  runProbe("r15c4-tilde-only-open", base + "\n~~~\n", ["unclosed code fence"]);
  // 50-run unclosed: ALSO the fence-guard route (run>=3 fences).
  runProbe("r15c4-run50-unclosed", base + "\n" + "`".repeat(50) + " \u00a798.99\n", ["unclosed code fence"]);
  // 50-run + same-line 49-run: a backtick FENCE opener may not carry
  // backticks in its info string, so the 50-run is not a fence; the run
  // pairing leaves the whole line inline prose. "docs/audits/audit-x.md
  // §98.99" then sits in PROSE with a genuine docs/ path before it —
  // exactly the external-chain form that is exempt by design (the
  // checker cannot resolve another document's anchors). Literal
  // backtick noise neither launders the ref (the chain text is real)
  // nor breaks the exemption; a span range never covers this ref.
  runProbe("r15c4-run50-mismatch-close", base + "\n" + "`".repeat(50) + " docs/audits/audit-x.md \u00a798.99 " + "`".repeat(49) + "\n", false);
  // CONTROL: plain genuine chain next to run probes stays exempt.
  runProbe("r15c4-run-clean-control", base + "\nsee docs/audits/audit-x.md \u00a798.99 tail\n", false);
});

// ── r16 cycle-1: HTML blocks & list-interruption (auditor F1/F3/F4) ──

// F1+F2: a <div> (type-6) HTML block runs raw until the blank line —
// the "<!--" inside it is RAW TEXT, never a comment opener. Old
// behavior: the fake comment swallowed everything after it and MASKED
// (rc=0) the §999 paragraph that follows the blank line; CommonMark
// ends the block at the blank line, so that paragraph is LIVE prose
// and must fire (rc=1). CONTROL: without the <div> the "<!--" is a
// real comment and the same ref stays masked (rc=0).
test("r16-F1 <!-- inside an HTML block never opens a comment; following ref fires", () => {
  // The laundering pattern: fires after the fix (was masked before).
  runProbe("r16-f1-div-block", base + "\n<div>\n<!--\n\n\u00a7999 after blank in html block\n-->\n", ["\u00a7999"]);
  // CONTROL: same lines minus the <div> opener — comment is real, masked.
  runProbe("r16-f1-no-div-control", base + "\n<!--\n\n\u00a7999 in comment\n-->\n", false);
  // Raw HTML before the blank line is masked: ref INSIDE the block
  // (before any blank) never reaches prose — type-6 content is raw.
  runProbe("r16-f1-inside-block-masked", base + "\n<div>\n<!--\n\u00a7999 raw html text\n-->\n</div>\n", false);
});

// F4: <script> is a type-2 HTML block — content runs to </script> and is
// masked as raw HTML (never scanned as prose). CONTROL: same text
// outside any HTML block stays live prose and fires.
test("r16-F4 raw HTML script content is masked, never prose", () => {
  runProbe("r16-f4-script", base + "\n<script>\n\u00a7999\n</script>\n", false);
  runProbe("r16-f4-noscript-control", base + "\nparagraph\n\n\u00a7999 live\n", ["\u00a7999"]);
});

// F3: CommonMark §4.2 — an ordered marker with start != 1 cannot
// interrupt a paragraph. "paragraph\n2. not a list" stays ONE paragraph;
// the list never opens, so the later 4-space-indented "    §999" (after
// a blank) is an INDENTED CODE BLOCK → masked. Old behavior tracked the
// "2." as a list item and reported the code-block ref as item prose.
test("r16-F3 start!=1 ordered marker cannot interrupt a paragraph", () => {
  runProbe("r16-f3-no-interrupt", base + "\nparagraph\n2. not a list\n\n    \u00a7999 code\n", false);
  // CONTROL: start=1 DOES interrupt → real list → the same indented ref
  // is now item continuation (live prose) and must fire.
  runProbe("r16-f3-start1-interrupts", base + "\nparagraph\n1. real list item\n\n\u00a7999 item prose\n", ["\u00a7999"]);
  // CONTROL: unordered marker always interrupts.
  runProbe("r16-f3-dash-interrupts", base + "\nparagraph\n- real item\n\n\u00a7999 item prose\n", ["\u00a7999"]);
});

// ── r16A cycle: auditor findings F1–F4 (contract-check hardening) ──

// F1 (audit HIGH): a raw HTML block opens ONLY on a COMPLETE tag.
// Malformed openers ("<div!not-a-tag>", "<foo", "<script! foo>") must
// NOT open a block: their following prose is LIVE and a bad ref fires.
// Old behavior: the regex made ">" optional and searched the delimiter
// over the whole line, so malformed tags masked following prose.
test("r16A-F1 malformed HTML openers never start a block", () => {
  runProbe("r16a-f1-div-bang", base + "\n<div!not-a-tag>\n\u00a7999 visible\n", ["\u00a7999"]);
  runProbe("r16a-f1-foo-nogt", base + "\n<foo\n\u00a7999 visible\n", ["\u00a7999"]);
  runProbe("r16a-f1-script-bang", base + "\n<script! foo>\n\u00a7999 visible\n", ["\u00a7999"]);
  // CONTROL: the WELL-FORMED opener still opens a block and masks.
  runProbe("r16a-f1-wellformed-control", base + "\n<div>\n\u00a7999 raw block text\n</div>\n", false);
});

// F2 (audit HIGH): the type-1 close needle is TAG-END anchored —
// "</scripture>" must NOT close an open <script> block. Laundering
// pattern: "<script>\n</scripture>\n<!--\n</script>\n\n§99999\n-->" —
// if "</scripture>" wrongly closed the block mid-way, the following
// "<!--" would be read as a comment opener and HIDE the ref. Under
// correct semantics the block runs to the REAL </script>, the <!--
// inside is raw text, and the ref is masked (rc=0) either way — so the
// discriminating probe is the structure AFTER a close: a ref that only
// fires when the block died at the fake closer must stay masked.
test("r16A-F2 </scripture> does not close a <script> block", () => {
  // </scripture> is NOT a closer: block continues; everything raw to
  // the true </script>, ref masked. If the fake closer ended the block
  // early, the lines between would be re-scanned and could fire.
  runProbe("r16a-f2-fake-closer", base + "\n<script>\n</scripture>\n\u00a7999 still script\n</script>\n", false);
  // CONTROL: the REAL closer ends the block; the same ref after it is
  // live prose and fires.
  runProbe("r16a-f2-real-closer-control", base + "\n<script>\nx\n</script>\n\n\u00a7999 live\n", ["\u00a7999"]);
});

// F3 (audit HIGH): the start!=1 interrupt rule must use TRUE paragraph
// state, not the prevBlank proxy. A heading (or list, fence, hr) line
// before "2. item" opens NO paragraph — CommonMark legitimately starts
// the list there and its indented continuation is item content (LIVE).
// The old proxy refused the push and masked the ref as indented code.
test("r16A-F3 ordered marker after a heading starts a real list", () => {
  runProbe("r16a-f3-heading-then-2", base + "\n# Heading\n2. item\n\n    \u00a7999 item prose\n", ["\u00a7999"]);
  // CONTROL: a real PARAGRAPH before "2." still blocks the interrupt
  // (r16-F3 policy intact): the indented ref is a code block, masked.
  runProbe("r16a-f3-para-still-blocks-control", base + "\nparagraph text here\n2. not a list\n\n    \u00a7999 code\n", false);
});

// F4 (audit HIGH): a raw HTML block COMMITTING inside an open list item
// or blockquote is not modelled — and the old fail-open silently fell
// through to text, where the masker's comment engine read the block's
// "<!--" as a comment opener and HID visible prose ("- <div>\n<!--\n
// \n §ref\n-->" renders §ref visible, masker hid it). Now it FAILS
// CLOSED with a named unsupported-container issue.
test("r16A-F4 HTML block inside a list item fails closed", () => {
  runProbe("r16a-f4-list-item", base + "\n- item\n  <div>\n  <!--\n\n  \u00a7999 visible\n  -->\n",
    ["raw HTML block inside a list item is unsupported"]);
  // CONTROL: same lines with the <div> OUTSIDE the item (dedented to
  // root) — the modeled root path runs and the ref after the blank is
  // live prose (fires), no unsupported-container issue.
  runProbe("r16a-f4-root-control", base + "\n- item\n\n<div>\n<!--\n\n\u00a7999 visible\n-->\n", ["\u00a7999"]);
  // Blockquote variant also fails closed.
  runProbe("r16a-f4-blockquote", base + "\n> <div>\n> <!--\n\n> \u00a7999\n",
    ["raw HTML block inside a blockquote is unsupported"]);
});

// ── r17 cycle-1: auditor findings F1–F4 (HTML tag grammar) ──

// F1 (audit HIGH): the tag NAME is a capture group — attributes must not
// remain in it. "<div class="x">" opens a type-6 block (masked); the old
// strip-delimiters regex made the name junk, demoting <div ...> to
// type-7 (suppressed under a paragraph) so "paragraph\n<div class=x>\n
// <!--\n\n§999\n-->" laundered the ref (renderer shows it: the comment
// is raw text inside the div block, closed by the blank line).
test("r17-F1 open tag with attributes opens a block", () => {
  runProbe("r17-f1-div-attr-launder", base + "\nparagraph text\n<div class=\"x\">\n<!--\n\n\u00a7999 live\n-->\n", ["\u00a7999"]);
  // CONTROL: inside the div block (no blank before the ref) the raw
  // text is masked — exactly what the renderer shows as block content.
  runProbe("r17-f1-div-attr-masked-control", base + "\n<div class=\"x\">\n\u00a7999 raw\n</div>\n", false);
  // Space around '=' is legal attribute syntax: still a block opener.
  runProbe("r17-f1-attr-spaces", base + "\n<div class = \"x\">\n\u00a7999 raw\n</div>\n", false);
  // Uppercase name + attributes: case-insensitive known name.
  runProbe("r17-f1-uppercase-attr", base + "\n<DIV CLASS=\"x\">\n\u00a7999 raw\n</div>\n", false);
});

// F2 (audit HIGH): the type-1 opener allows TRAILING CONTENT after
// ">" — "<script>foo" opens the block. Laundering pattern:
// "<script>foo\n<!--\n</script>\n\n§999" — with the old ">$" anchor the
// opener was missed, "<!--" became a phantom comment and hid every
// following line; renderer: all of it is raw script content up to
// </script>, and after the blank §999 is LIVE prose.
test("r17-F2 type-1 opener with trailing content", () => {
  runProbe("r17-f2-script-inline-launder", base + "\n<script>foo\n<!--\n</script>\n\n\u00a7999 live\n", ["\u00a7999"]);
  // CONTROL: ref INSIDE the inline-opened block is masked raw text.
  runProbe("r17-f2-script-inline-masked", base + "\n<script>foo\n\u00a7999 raw\n</script>\n", false);
  // "<script foo>" (name + attribute, > at EOL) still opens.
  runProbe("r17-f2-script-attr", base + "\n<script src=x>\n\u00a7999 raw\n</script>\n", false);
});

// F3 (audit HIGH, r17; expectation corrected in r18): closing tags in
// the TYPE-7 production carry no attribute grammar ("</foo x>" is not a
// complete closing tag), but §4.6 condition 6 is a PREFIX rule: "</"
// followed by a listed name (case-insensitive) then "a space, a tab,
// the end of the line, the string `>`, or the string `/>`" — so
// "</div x>" DOES open a type-6 block (adjudicated: cmark and
// markdown-it both keep the following prose raw block text). The r17
// test expected junk/exit-1; that contradicted §4.6 and the refs.
test("r17-F3 closing tags: exact grammar", () => {
  // "</div x>" opens a type-6 block (prefix rule, space after name):
  // the ref is masked raw block content, not live prose.
  runProbe("r17-f3-close-attrs-junk", base + "\n</div x>\n\u00a7999 live\n", false);
  // CONTROL: a well-formed closing tag opens a type-6 block (CommonMark
  // §4.6) — the ref inside is raw block text, masked.
  runProbe("r17-f3-close-plain-block", base + "\n</div>\n\u00a7999 raw\n", false);
  // "</div>tail" ALSO opens a type-6 block (prefix rule: name + the
  // string ">"), but the block ends at the blank line — so the ref
  // after the blank is live prose and the probe must flag it.
  runProbe("r17-f3-close-tail", base + "\nparagraph\n</div>tail\n\n\u00a7999 live\n", ["\u00a7999"]);
});

// F4 (audit MED): the type-4 declaration is "<!" + an ASCII LETTER
// (either case) — "<!doctype html>" must open a declaration block and
// close at the FIRST ">" (the continuation engine), so a ref after the
// closing ">" is live prose while a ref inside the declaration is raw.
test("r17-F4 declaration accepts lowercase doctype", () => {
  runProbe("r17-f4-doctype-lower-masked", base + "\n<!doctype html\n\u00a7999 in declaration\n>\n\nnext para\n", false);
  // Control: after the declaration closes, a ref is live.
  runProbe("r17-f4-doctype-close-then-live", base + "\n<!doctype html>\n\n\u00a7999 live\n", ["\u00a7999"]);
});

// ── r19 audit: type-1 opener and type-6 name list vs CommonMark §4.6 ──
// (verified against commonmark.js and markdown-it, both agree)

// "<script/>" is NOT a type-1 opener (only whitespace, ">", or EOL may
// follow the name). It is a type-7 candidate: the raw "<!--" beneath it
// does not open a block that could mask the following prose, so the
// §ref after the blank line is LIVE and must fire.
test("r19-F1 self-closing <script/> does not open a type-1 block", () => {
  runProbe("r19-f1-script-slash-live", base + "\n<script/>\n<!--\n\n\u00a7999 visible\n-->\n", ["\u00a7999"]);
  // CONTROL: the real type-1 opener keeps the block open to </script>.
  runProbe("r19-f1-script-gt-control", base + "\n<script>\n\u00a7999 raw\n</script>\n", false);
});

// §4.6 type-6 list: "option" and "optgroup" are type-6 names (they can
// interrupt a paragraph); "object" and "hgroup" are NOT.
test("r19-F2 type-6 name list matches §4.6", () => {
  runProbe("r19-f2-option-interrupts", base + "\nparagraph\n<option>\n<!--\n\n\u00a7999 visible\n-->\n", ["\u00a7999"]);
  runProbe("r19-f2-optgroup-interrupts", base + "\nparagraph\n<optgroup>\n<!--\n\n\u00a7999 visible\n-->\n", ["\u00a7999"]);
  // "object" is type 7 and cannot interrupt a paragraph: the paragraph
  // continues, the "<!--" after the blank line is a real comment.
  runProbe("r19-f2-object-no-interrupt", base + "\nparagraph\n<object>\n<!--\n\n\u00a7999 visible\n-->\n", false);
});

// r19 audit follow-ups: hgroup is NOT a type-6 name (paragraph-interrupt
// probe), and a committed type-6 block ends a pending code span.
test("r19-F3 hgroup is not a type-6 name", () => {
  runProbe("r19-f3-hgroup-no-interrupt", base + "\nparagraph\n<hgroup>\n<!--\n\n\u00a7999 visible\n-->\n", false);
});

test("r19-F4 type-6 block interrupt clears a pending code span", () => {
  // Both references render §999 as visible prose (the span died at the
  // <div> block), so the ref after the span-closing run must fire.
  runProbe("r19-f4-div-span-interrupt", base + "\npara `\n<div>\nraw\n\n` <!--\n\u00a7999 visible\n-->\n", ["\u00a7999"]);
});

// ── r20 fuzz: degenerate complete comments "<!-->" / "<!--->" ──
// CommonMark §6: the comment grammar is "<!-->|<!--->|<!--[\s\S]*?-->".
// The two degenerate forms are COMPLETE comments whose closer OVERLAPS
// the opener; the old processText search for "-->" started after the
// opener and never saw them, so "<!-->" opened a phantom comment that
// masked the rest of the document — 42 fuzz laundries (probe-vs-impl
// fuzz, commonmark.js AST as ground truth).

test("r20-F1 degenerate <!--> does not mask following prose", () => {
  runProbe("r20-f1-deg-open", base + "\n<!-->\n\u00a7999 visible\n", ["\u00a7999"]);
  runProbe("r20-f1-deg2-open", base + "\n<!--->\n\u00a7999 visible\n", ["\u00a7999"]);
  runProbe("r20-f1-deg-para", base + "\npara\n\n<!-->\n\n\u00a7999 after\n", ["\u00a7999"]);
  runProbe("r20-f1-deg-heading", base + "\n<!-->\n# \u00a7999 heading\n", ["\u00a7999"]);
  runProbe("r20-f1-two-deg", base + "\n<!--><!--->\n\u00a7999 live\n\nz\n", ["\u00a7999"]);
});

test("r20-F1b three-dash <!--- is NOT a degenerate comment (still masks)", () => {
  runProbe("r20-f1b-triple-dash", base + "\n<!---\n\u00a7999 masked\n-->\n", false);
  // Four dashes "<!---->" IS a complete comment (closer = last three).
  runProbe("r20-f1b-four-dash", base + "\n<!---->\n\u00a7999 live\n\ny\n", ["\u00a7999"]);
});

test("r20-F1c a complete line-leading comment overflags its own line (safe direction)", () => {
  // "<!--> \u00a7999 x" is a type-2 HTML block for CommonMark (\u00a7999 invisible);
  // the masker closes the comment inline and EXPOSES the ref. Over-flagging
  // (never hiding) is the documented conservative direction.
  runProbe("r20-f1c-same-line", base + "\n<!--> \u00a7999 x\n", ["\u00a7999"]);
});

test("r20-F1d a real comment opened AFTER a degenerate one still masks (EOF fail-closed)", () => {
  const doc = base + "\n<!--> t\n<!-- \u00a7999 open\nmore\n";
  const f = path.join(tmp, "r20-f1d-deg-then-open.md");
  fs.writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("unclosed"), r.stderr);
  // r21 (audit MEDIUM): the OLD assertion stripped "resolves…" from the
  // C9 FAIL line — the exact place a leaked citation appears — making it
  // unable to ever fire. Assert DIRECTLY that the masked ref is never
  // cited: a leak would append "\u2014 line N: \u00a7999" to the C9 line.
  assert.ok(!/\u2014 line \d+: \u00a7999/.test(r.stderr), "masked ref must not be cited live:\n" + r.stderr);
});

// r21-F1 (audit HIGH) battery: an INLINE unclosed "<!--" is literal
// paragraph text — it must NEVER enter multiline comment state. The
// laundering repro the auditor filed: "para <!-- x\n\n\u00a7ref" used to
// vanish the ref under a phantom comment; both reference implementations
// (commonmark.js and markdown-it) render everything after it visible.
test("r21-F1 inline unclosed <!-- never launders following lines (same-line repro)", () => {
  // THE repro: ref on the SAME line, after the inline opener.
  runProbe("r21-f1-sameline", base + "\npara <!-- \u00a799999 tail\n", ["\u00a799999"]);
  // THE audit repro: ref on a later line after an inline opener + blank.
  runProbe("r21-f1-nextline", base + "\npara x <!--\n\n\u00a799999 after\n", ["\u00a799999"]);
  // A SECOND opener after a same-line closer is inline too (the closer
  // consumed the block-start position — probe L8/H1).
  runProbe("r21-f1-reopen-after-closer", base + "\n<!-- a --> b <!-- c\n\u00a799999 live\n", ["\u00a799999"]);
  // 4-space indent at root: indented-code position, never a type-2 block.
  runProbe("r21-f1-indent4", base + "\n\n\u00a799999 para\n\n    <!-- inline\n    tail \u00a799998\n", ["\u00a799999"]);
  // Tab-indented opener: same story (never a block-start).
  runProbe("r21-f1-tab", base + "\n\n\u00a799999 para\n\n\t<!-- inline\n\ttail \u00a799998\n", ["\u00a799999"]);
  // r21-F2 (audit c1 HIGH): an ordered marker with start ≠ 1 cannot
  // interrupt an open paragraph (§4.2) — the whole "2. <!--" line is
  // LAZY PARAGRAPH TEXT, so its inline "<!--" is literal text and the
  // ref below stays LIVE even though the prefix "looks" like a chain
  // of block containers.
  runProbe("r21-f2-ord2-launder", base + "\nparagraph\n2. <!--\n\n   \u00a799999 live\n   -->\n", ["\u00a799999"]);
  // start=1 DOES interrupt: real list, real block comment -> masked.
  runProbe("r21-f2-ord1-mask", base + "\nparagraph\n1. <!--\n   \u00a799999 masked\n   -->\n", false);
  // no paragraph open (heading before) -> the ordered list starts and
  // the comment is a block: masked.
  runProbe("r21-f2-ord2-head-mask", base + "\n# \u00a7999 heading\n2. <!--\n   \u00a799999 masked\n   -->\n", ["\u00a7999"]);
  // lazy continuation inside an item: "2." never interrupts the item's
  // paragraph -> inline, ref live.
  runProbe("r21-f2-lazy2-live", base + "\n- x\n  para\n  2. <!--\n  \u00a799999 live\n", ["\u00a799999"]);

  // CONTROLS (must stay MASKED — block-start openers):
  // root line-leading unclosed opener: masks, EOF fail-closed.
  const eof = base + "\n<!--\n\u00a799999 masked\n";
  const fe = path.join(tmp, "r21-f1-eof-mask.md");
  fs.writeFileSync(fe, eof);
  const re = spawnSync(process.execPath, [SCRIPT, fe], { encoding: "utf8" });
  assert.equal(re.status, 1, "unclosed block comment must fail closed");
  assert.ok(re.stderr.includes("unclosed"), re.stderr);
  assert.ok(!/\u2014 line \d+: \u00a799999/.test(re.stderr), "masked ref must not be cited live:\n" + re.stderr);
  // block comment fully closed: masked, exit 0.
  runProbe("r21-f1-closed-mask", base + "\n<!--\n\u00a799999 masked\n-->\n", false);
  // lead-3 root opener is still a type-2 block: masks.
  runProbe("r21-f1-lead3-mask", base + "\n   <!--\n   \u00a799999 masked\n   -->\n", false);
  // list context: opener AT the item content column is a block (probe
  // B/D): masks. Opener 4+ past the content column is inline text
  // (probe C): live.
  runProbe("r21-f1-list-block-mask", base + "\n- item\n  <!--\n  \u00a799999 masked\n  -->\n", false);
  runProbe("r21-f1-list-inline-live", base + "\n- a\n  - b <!--\n    \u00a799999 live\n    -->\n", ["\u00a799999"]);
});

test("r20-F2 blockquote guard: complete comments no longer refuse, open comments still do", () => {
  // Complete (degenerate or closed) comments own no cross-boundary state:
  // the doc must process and flag the LIVE ref after the quote — without
  // the "unsupported by C9's container model" refusal.
  for (const [name, opener] of [["deg", "<!-->"], ["deg2", "<!--->"], ["full", "<!-- x -->"]] as const) {
    const f = path.join(tmp, `r20-f2-${name}.md`);
    fs.writeFileSync(f, base + `\n> ${opener}\n> text\n\n\u00a7999 live\n`);
    const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
    assert.equal(r.status, 1, name);
    assert.ok(!r.stderr.includes("unsupported"), `${name}: refused: ${r.stderr}`);
    assert.ok(/line \d+.*\u00a7999/.test(r.stderr) || r.stderr.includes("\u00a7999"), `${name}: live ref not cited: ${r.stderr}`);
  }
  // A POSSIBLY-OPEN comment inside a quote still fails closed.
  runProbe("r20-f2-open", base + "\n> <!-- x\n> y\n\n\u00a7999 live\n", ["unsupported"]);
});

// r21c14-F1: a type-2 comment-block opener INTERRUPTS the paragraph that
// owns a pending multi-line span (CommonMark §4.6; commonmark.js and
// markdown-it agree: "a `\n<!--\nREF\n`\n-->" hides REF inside the
// comment). The old span branch swallowed the opener as span content and
// flagged the hidden ref (overstrict). Quote-prefixed openers stay the
// accepted fail-closed report (round-20 convention f).
test("r21c14-F1 comment opener interrupts a pending span", () => {
  // The fixed case: opener line interrupts, ref hides in the comment.
  runProbe("r21c14-interrupt-mask", base + "\na `\n<!--\n\u00a799999\n`\n-->\n", false);
  // Same-line open+close around the ref (span still pending on the
  // opener line): the comment is complete, the ref is hidden.
  runProbe("r21c14-sameline-close", base + "\nb `\n<!-- \u00a799999 ` -->\n", false);
  // Interrupting opener that never closes: fails closed at EOF and the
  // hidden ref is NOT cited as live.
  const f = path.join(tmp, "r21c14-unclosed.md");
  fs.writeFileSync(f, base + "\nc `\n<!--\n\u00a799999\n");
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
  assert.equal(r.status, 1, "unclosed interrupting comment must fail closed");
  assert.ok(r.stderr.includes("unclosed"), r.stderr);
  assert.ok(!/\u2014 line \d+: \u00a799999/.test(r.stderr), "hidden ref must not be cited live:\n" + r.stderr);
  // Quote-prefixed opener under a pending span: FAIL-CLOSED report
  // pinned by round-20 convention (f) — overstrict, renderer-hidden.
  runProbe("r21c14-quote-failclosed", base + "\ne `\n> <!--\n\u00a799999\n`\n> -->\n", ["\u00a799999"]);
  // Control: pending span + interrupting opener + a closer eventually
  // arriving: the comment owns the tail, everything is masked, exit 0
  // (both renderers hide the whole comment region the same way).
  runProbe("r21c14-span-still-pairs", base + "\n`two runs\n<!-- fake\nend`\n-->\n", false);
});

// r21c15-F1/F2 (cycle-15 audit, HIGH x2): a list marker that INTERRUPTS
// the paragraph owning a pending multi-line span must end the span AND
// update the list stack. The old span branch consumed "- item" as span
// content without tracking, so a comment opened inside the new item was
// owned at the old depth and a ref visibly dedenting out of the item
// stayed masked (laundering). commonmark.js + markdown-it both render
// the ref visible in every case below.
test("r21c15-F1/F2 list interruption during a pending span tracks the list", () => {
  // Canonical: bullet interrupts, comment inside the item, ref dedents
  // visibly to root (probe lost-list.md).
  runProbe("r21c15-lost-list", base + "\na `\n- item\n  <!--\n\u00a799999\n-->\n`\n", ["\u00a799999"]);
  // Ordered start-1 marker interrupts identically (lost-ordered.md).
  runProbe("r21c15-lost-ordered", base + "\na `\n1. item\n   <!--\n\u00a799999\n-->\n`\n", ["\u00a799999"]);
  // Nested list opened under an OUTER item mid-span (lost-nested.md):
  // the ref dedents out of the INNER item into the outer item — still
  // rendered visible.
  runProbe("r21c15-lost-nested", base + "\n- outer\n  a `\n  - item\n    <!--\n  \u00a799999\n  -->\n  `\n", ["\u00a799999"]);
  // Marker chain opened mid-span ("- - x"): comment owned at the
  // innermost column; root-column ref escapes both items visibly.
  runProbe("r21c15-chain", base + "\na `\n- - x\n    <!--\n\u00a799999\n-->\n`\n", ["\u00a799999"]);
  // Sibling continuation: span opens inside item x, a SIBLING marker
  // interrupts it, the comment sits in the sibling, the ref dedents to
  // root (sibling-dedent).
  runProbe("r21c15-sibling", base + "\n- x\n  a `\n- y\n  <!--\n\u00a799999\n-->", ["\u00a799999"]);
  // Control (NOT a list start): start!=1 after a paragraph is lazy
  // text; the span keeps the region, both renderers hide the ref, and
  // the r14 ownership mask stays correct -> exit 0.
  runProbe("r21c15-lazy-start2", base + "\na `\n2. item\n   <!--\n\u00a799999\n-->\n`\n", false);
  // Control: 4-space indented marker after paragraph = indented code
  // INSIDE the span (both renderers echo the ref literally in
  // <code> content): per the pinned code-content convention (cycles
  // 1/2/7: rendered code content is VISIBLE) the ref is flagged.
  runProbe("r21c15-ind4", base + "\na `\n    - item\n      <!--\n    \u00a799999\n      -->\n`\n", ["\u00a799999"]);
});
