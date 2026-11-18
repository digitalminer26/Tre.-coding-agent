#!/usr/bin/env node
// contract-check.mjs — deterministic consistency gate for the G2–G5 contract
// (docs/11-orchestrator-schema.md). Built after the v31 audit (option D of the
// 2026-11-18 assessment): the terra arc's recurring defect classes were
//   (1) patch-induced contradiction (a fix edited one passage; other passages
//       stating the same invariant were left standing),
//   (2) rules referencing enum members / record kinds never declared,
//   (3) ledger formatting drift,
// all mechanically detectable without an LLM round. This script turns those
// classes into a ratchet: each check passes on the v33 baseline; any fold that
// breaks one fails the quality gate BEFORE an auditor is paid to find it.
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

// ---------------------------------------------------------------------------
// C1 — Status lines: all section status lines carry ONE version (the max).
// The five G2–G5 headers drift apart whenever a fold bumps some and not
// others (v29-era near-miss). Date-scoped to the G2–G5 batch date.
const statusLines = [...s.matchAll(/\*\*Status: DRAFT v(\d+) \(2026-11-18/g)].map((m) => Number(m[1]));
const V = statusLines.length ? Math.max(...statusLines) : 0;
check("C1 status lines exist", statusLines.length >= 5, `found ${statusLines.length}`);
check("C1 status uniform", statusLines.every((n) => n === V), `versions=${[...new Set(statusLines)]}`);

// ---------------------------------------------------------------------------
// C2 — Version propagation: the max version must appear in the §14.11 fold
// header, the §14.15 ledger-row list, a (vN: …) status sub-note, and the
// newest ledger row. A fold that bumps status lines but forgets the
// propagation text is the exact "stale text beside patched text" class.
const foldHeader = s.includes(`v${V} folds`) || s.includes(`v${V} records`);
check("C2 §14.11 header cites v" + V, foldHeader);
check("C2 §14.15 list cites v" + V, s.includes(`v${V} Change Ledger rows`));
check("C2 status sub-note v" + V, s.includes(`(v${V}:`));

// ---------------------------------------------------------------------------
// C3 — Change Ledger mechanics: every ledger data row (starts "| YYYY-MM-DD")
// must terminate with "|" (the c23/c24 row defect, twice), the first data row
// (newest, by append-before convention) must cite the current version, and
// the current row's DECISIONS-REQUIRED must be 0 (open decisions are allowed
// ONLY in older rows, never in the newest).
const ledgerRows = s.split("\n").filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l));
check("C3 ledger non-empty", ledgerRows.length > 20, `rows=${ledgerRows.length}`);
const unterminated = ledgerRows.filter((l) => !l.trimEnd().endsWith("|"));
check("C3 all ledger rows terminated", unterminated.length === 0, `${unterminated.length} unterminated`);
// Rows are NOT stored chronologically; the NEWEST row is the one carrying the
// current-version marker (each fold prepends its row and stamps the version).
const curRow = ledgerRows.find((l) => new RegExp(`\\(v${V}\\b`).test(l)) ?? null;
check(`C3 newest row (v${V} marker) exists`, curRow !== null);
if (curRow) {
  check("C3 v" + V + " row terminated", curRow.trimEnd().endsWith("|"));
  const dec = curRow.match(/DECISIONS-REQUIRED: (\d+)/);
  check("C3 v" + V + " row DECISIONS-REQUIRED: 0", dec ? dec[1] === "0" : false, dec ? dec[1] : "absent");
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
// C6 — no undecided-authority idiom survives outside the ledger: the audits
// flagged "OWNER DECISION (… not decided here)" text that shipped into body
// rules. Body text must not delegate mid-bandage.
const body = s.split("\n").filter((l) => !/^\| \d{4}-\d{2}-\d{2} \|/.test(l)).join("\n");
check("C6 no 'not decided here' idiom in body", !body.includes("not decided here"));

// ---------------------------------------------------------------------------
// C7 — kind-shaped ratchet: every backticked kebab word (≥3 components) in
// the G2–G5 body must be a DECLARED record kind ("kind":"…" in jsonc), a
// faultKind, or on the reviewed allowlist below. A fold that mentions a new
// `foo-bar-baz` record/decision kind must register it consciously — this is
// the mechanical half of "no new mechanism without schema representation".
// Allowlist entries are CATEGORY-COMMENTED; extend ONLY with a fold that
// introduces the member into the schema.
const declaredKinds = new Set([...s.matchAll(/"kind":"([a-z][a-z0-9-]+)"/g)].map((m) => m[1]));
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
const iBody = s.indexOf("#### 14.11") > 0 ? s.indexOf("#### 14.11") : 0;
const kindShaped = new Set([...s.slice(iBody).matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+){2,})`/g)].map((m) => m[1]));
const novel = [...kindShaped].filter((k) => !declaredKinds.has(k) && !unionKinds.has(k) && !allow.has(k));
check("C7 no unregistered kind-shaped term", novel.length === 0, novel.join(","));

// ---------------------------------------------------------------------------
// C8 — pinned-clause registry (the C27-F1 lesson made mechanical): the v33
// fold's span replacement silently deleted a sentence the v32 fold had added.
// Every normative clause that a fold inserted (v29–v34) is pinned here as a
// whitespace-insensitive string that MUST survive every later edit. A fold
// that legitimately REPLACES a pinned clause must edit THIS registry in the
// same commit — the ratchet is deliberate friction, the same kind that kept
// the Change Ledger honest.
const PINS = [
  "A closed fault is never reopened by an unsupported read, and no later validation rewrites it.",
  "the fault is one durable fact",
  "closes the durable FAULT only",
  "which is local readability state and never a clean verdict",
  "a fault already present with the same identity, open or CLOSED, is NOT re-appended",
  "the restored blob is INERT",
  "named a revision record as the sole identity is WITHDRAWN",
  "recomputedDigest NULL (no stored bytes to recompute)",
  "no decision value is added and no historical verdict is rewritten",
  "replay verification IS the authoritative validation",
  "NEVER admits on the explanation alone",
  "IN THE SAME revision; a bump that does neither is OUT OF CONTRACT",
];
const flatBody = body.replace(/\s+/g, " ");
const missing = PINS.filter((p) => !flatBody.includes(p));
check("C8 all pinned clauses survive", missing.length === 0, missing.map((m) => m.slice(0, 40)).join(" | "));

// ---------------------------------------------------------------------------
// Report
for (const line of ok) console.log(`contract-check: PASS ${line}`);
if (fails.length) {
  for (const line of fails) console.error(`contract-check: FAIL ${line}`);
  console.error(`contract-check: FAILED — ${fails.length} of ${ok.length + fails.length} checks`);
  process.exit(1);
}
console.log(`contract-check: OK — ${ok.length} checks on ${path} (contract v${V})`);
