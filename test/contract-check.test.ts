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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
