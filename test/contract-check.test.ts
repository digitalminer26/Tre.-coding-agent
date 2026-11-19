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

// FB: an ESCAPED backtick run (\\`a\\`) can never close a pending span;
// without the escape rule the sequence laundered following lines under a
// comment. The ref stays live (span content is live prose by policy).
test("R8-FB escaped ticks cannot close a span or launder a comment", () => {
  runProbe("r8-fb-escape", base + "\npara `\n\\`a\\` <!--\n§999 laundered?\n-->\n", ["C9 every body", "\u00a7999"]);
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
  // Comment still inside the nested item: masked.
  runProbe("r14-nested-still-in", base + "\n- a\n  - b <!--\n    §99999 masked\n    -->\n", false);
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
