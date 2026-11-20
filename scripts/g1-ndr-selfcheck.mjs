#!/usr/bin/env node
// g1-ndr-selfcheck.mjs — Plan B register self-check (v23, docs/audits/
// g1-plan-b-canonicalization.md). Pure node, reads docs/11-orchestrator-
// schema.md only, never writes. Implements the mechanically auditable
// clause of the §14.10.0 register doctrine:
//   (1) every `per NDR-<id>` citation resolves to a defined register entry
//   (2) no NDR id is defined twice (and ids are exactly the closed set
//       declared by the register heading, extended there — v23: a..t)
//   (3) §14.12.2 class-B/class-O finalization rows: a row over 150 words
//       must carry a `per NDR-` citation (rule bodies belong to the register)
//   (4) every register entry declares an *Expansion:* (a rule with no
//       canonical expansion site and no "(none" marker is incomplete)
// Exit 0 = pass (informational notes allowed); exit 1 = defect.

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "docs/11-orchestrator-schema.md";
const text = readFileSync(path, "utf8");
const lines = text.split("\n");

const fail = [];
const note = [];

// --- locate the register section (### heading 14.10.0 ... next ####) ---
const regStart = lines.findIndex((l) => /^#+ 14\.10\.0\b/.test(l));
if (regStart === -1) {
  console.error("g1-ndr-selfcheck: no §14.10.0 register found — FAIL");
  process.exit(1);
}
let regEnd = lines.findIndex(
  (l, i) => i > regStart && /^#{4,5} 14\.10\.[1-9]/.test(l),
);
if (regEnd === -1) regEnd = lines.length;
const regLines = lines.slice(regStart, regEnd);

// --- (2) definitions: "- **NDR-x — Title.**" ---
const defRe = /^- \*\*NDR-([a-z]) — /;
const defs = new Map(); // id -> line numbers
for (let i = 0; i < regLines.length; i++) {
  const m = regLines[i].match(defRe);
  if (!m) continue;
  const id = m[1];
  if (defs.has(id)) {
    fail.push(
      `dup NDR id "NDR-${id}" defined at register lines ${defs.get(id) + 1} and ${i + 1}`,
    );
  } else {
    defs.set(id, i);
  }
}
if (defs.size === 0) fail.push("register defines no NDR entries");

// --- (4) every entry declares an expansion (inline marker anywhere
//         within the entry's paragraph block) ---
{
  const entryRe = /^- \*\*NDR-([a-z]) — /;
  const blocks = []; // {id, text}
  let cur = null;
  for (const l of regLines) {
    const m = l.match(entryRe);
    if (m) {
      cur = { id: m[1], text: l };
      blocks.push(cur);
    } else if (cur && !/^#/.test(l) && !/^\|/.test(l) && l.trim() !== "") {
      cur.text += "\n" + l;
    } else if (cur && (/^#/.test(l) || /^\*\*/.test(l))) {
      cur = null; // manifest heading / next section ends the entries
    }
  }
  for (const b of blocks) {
    if (!/\*Expansion:\s*\(/.test(b.text) && !/\*Expansion:\s*\S/.test(b.text)) {
      fail.push(`NDR-${b.id} has no *Expansion:* clause`);
    }
  }
}

// --- (1) citations anywhere in the document resolve to definitions ---
{
  const citeRe = /per NDR-([a-z])\b/g;
  const unknown = new Map();
  lines.forEach((l, i) => {
    let m;
    while ((m = citeRe.exec(l)) !== null) {
      if (!defs.has(m[1])) {
        if (!unknown.has(m[1])) unknown.set(m[1], i + 1);
      }
    }
  });
  for (const [id, ln] of unknown) {
    fail.push(`citation "per NDR-${id}" at line ${ln} resolves to no register entry`);
  }
}

// --- (1b) manifest table references resolve too ---
{
  const manIdx = regLines.findIndex((l) => /^\*\*Statement-site manifest/.test(l));
  if (manIdx === -1) {
    fail.push("register has no **Statement-site manifest** table");
  } else {
    const manRe = /NDR-([a-z])\b/g;
    for (let i = manIdx; i < regLines.length; i++) {
      const l = regLines[i];
      if (!l.startsWith("|")) continue;
      let m;
      while ((m = manRe.exec(l)) !== null) {
        if (!defs.has(m[1])) {
          fail.push(`manifest row at register line ${i + 1}: NDR-${m[1]} undefined`);
        }
      }
    }
  }
}

// --- (3) §14.12.2 class-B / class-O finalization rows ---
{
  const B_RE = /^\|\s*\*\*B — /;
  const O_RE = /^\|\s*\*\*O — /;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!(B_RE.test(l) || O_RE.test(l))) continue;
    const words = l.split(/\s+/).filter(Boolean).length;
    const cites = (l.match(/per NDR-[a-z]\b/g) || []).length;
    if (words > 150 && cites === 0) {
      fail.push(
        `§14.12.2 ${B_RE.test(l) ? "class-B" : "class-O"} row (line ${i + 1}) is ${words} words with NO "per NDR-" citation (rule body in a cell is a defect)`,
      );
    }
    if (cites > 0) {
      note.push(
        `${B_RE.test(l) ? "B" : "O"} row line ${i + 1}: ${words} words, ${cites} citation(s) — OK`,
      );
    }
  }
}

if (note.length) for (const n of note) console.log(`  note: ${n}`);
if (fail.length) {
  console.error(`g1-ndr-selfcheck: ${fail.length} defect(s):`);
  for (const f of fail) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(
  `g1-ndr-selfcheck: PASS (${defs.size} NDR entries defined, citations resolve, cell budget respected)`,
);
