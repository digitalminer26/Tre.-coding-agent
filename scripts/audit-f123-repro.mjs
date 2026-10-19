// Audit findings F1/F2/F3 — end-to-end repro against the pure state layer,
// updated to the REV MODEL (DESIGN.md): the arm's ownership identity is the
// monotonic per-write `rev`, NOT (items, stamp) — `updatedAt` is only the
// expiry clock. The three findings the rev model closes (F1-legacy, F2, F3)
// get explicit sections at the end; the original F1/F2/F3/F1b/F1c sections
// are kept as no-regression checks under the new identity.
// Run: node scripts/audit-f123-repro.mjs   (against the dist build)
import {
  makeInitialState,
  applyEvent,
  subtasksExpired,
  subtasksBusyArmed,
  subtaskItemsSig,
  subtasksPollTick,
} from "../dist/src/tui/state.js";

const t0 = 1_000_000;
const live = [{ id: 1, name: "a", status: "in-progress" }];
const done = [{ id: 1, name: "a", status: "done" }];
const subEnd = (id, subtasks, action, updatedAt, rev) => ({
  type: "tool_execution_end",
  toolCallId: id,
  result: {
    role: "toolResult", toolCallId: id, toolName: "subtask",
    content: [{ type: "text", text: "ok" }], isError: false,
    details: {
      subtasks,
      ...(action ? { action } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(rev ? { rev } : {}),
    },
    timestamp: 0,
  },
});
const subStart = (id, action) => ({
  type: "tool_execution_start",
  toolCall: { type: "toolCall", id, name: "subtask", arguments: { action } },
});
// The tick's file signature (the poller's change detector) covers the whole
// file snapshot — items, the expiry clock AND the write revision.
const fileSig = (f) => JSON.stringify({ items: f.items, updatedAt: f.updatedAt, rev: f.rev ?? 0 });
// The driver's state view handed to the tick (exactly what run.tsx wires).
const tickState = (s, busyArmed = subtasksBusyArmed(s)) => ({
  ...s,
  busyArmed,
  subtasksArmedSig: s.subtasksArmedSig,
  subtasksArmedRev: s.subtasksArmedRev,
  subtasksRev: s.subtasksRev,
});
let fails = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) fails++; };

// ── F1: an unrelated later run must NOT keep an abandoned live list alive ──
{
  // Run A: create a live list, then the run ends (abandoned mid-flight).
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "create", t0));
  check("F1: create arms the exemption for run A", s.subtasksArmedRun === t0 && subtasksBusyArmed(s));

  // Run A ends; the file never changes again. The deadline passes.
  s = { ...s, busy: false }; // agent_end: run A is over, list left live
  const file = { items: live, updatedAt: t0 };
  let sig = fileSig(file);
  let r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: sig, now: t0 + 200_000, staleMs: 90_000,
  });
  check("F1: idle past the window → expired", r.push && r.subtasksExpired === true);
  s = { ...s, subtasksExpired: true };

  // Run B starts (unrelated, no subtask work) while the list is live.
  s = applyEvent({ ...s, busy: false }, { type: "agent_start" });
  check("F1: agent_start un-arms run A's exemption", s.subtasksArmedRun === null);
  r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: sig, now: t0 + 210_000, staleMs: 90_000,
  });
  check("F1: unrelated busy run keeps it expired (no resurrection)", r.push === false && r.subtasksExpired === true);

  // THE STICKY-FLAG HOLE: display flag false + busy + foreign live list.
  const s2 = { ...makeInitialState("m"), busy: true, runStartedAt: t0 + 300_000, subtasksExpired: false };
  r = subtasksPollTick({
    state: tickState(s2),
    file, lastSig: null, now: t0 + 500_000, staleMs: 90_000,
  });
  check("F1: flag-false + busy + foreign live list → expired (old sticky hole)", r.subtasksExpired === true);
}

// ── F2: an observational `list` from a tool WITHOUT details.action ─────────
{
  // Older/custom tool: result carries {subtasks} only. The start event
  // carries the action (the schema requires it) → the TUI sees `list`.
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0, subtasksExpired: true };
  s = applyEvent(s, subStart("t1", "list"));
  s = applyEvent(s, subEnd("t1", done)); // no details.action
  check("F2: start-captured list does NOT re-arm", s.subtasksArmedRun === null && s.subtasksExpired === true);
  check("F2: but the snapshot still refreshes", s.subtasks[0].status === "done");

  // No start event either → content heuristic: identical = read.
  let s3 = { ...makeInitialState("m"), busy: true, runStartedAt: t0, subtasksExpired: true, subtasks: done };
  s3 = applyEvent(s3, subEnd("t3", done));
  check("F2: identical untagged snapshot = read (no arm)", s3.subtasksArmedRun === null && s3.subtasksExpired === true);
  s3 = applyEvent(s3, subEnd("t4", live));
  check("F2: changed untagged snapshot = activity (arm)", s3.subtasksArmedRun === t0 && s3.subtasksExpired === false);
}

// ── F3: sessionless (in-memory) list settles to "none" ──────────────────────
{
  // A LEGACY result carries NO updatedAt — the TUI must stamp the RECEIPT
  // time (the CLOCK). Rev model: it also arms rev 0 (no write identity) —
  // the receipt time never becomes an ownership key (F1-legacy below).
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  const before = Date.now();
  s = applyEvent(s, subEnd("t1", done, "create")); // no updatedAt → receipt stamp
  const after = Date.now();
  check(
    "F3: legacy activity stamps the RECEIPT time (no stamp in the result)",
    s.subtasksUpdatedAt >= before && s.subtasksUpdatedAt <= after,
  );
  check("F3: legacy activity arms with NO write identity (rev 0)", s.subtasksArmedRev === 0);
  let r = subtasksPollTick({
    state: tickState(s),
    file: null, lastSig: null, now: s.subtasksUpdatedAt + 90_001, staleMs: 90_000,
  });
  check("F3: sessionless settled list expires past the window", r.push && r.subtasksExpired === true);
  // Sessionless LIVE list under an armed run stays.
  let s2 = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s2 = applyEvent(s2, subEnd("t1", live, "mark", t0));
  r = subtasksPollTick({
    state: tickState(s2),
    file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000,
  });
  check("F3: armed sessionless live list stays", r.push === false && r.subtasksExpired === false);
  // …and once its run is over, it settles too.
  const idle = { ...s2, busy: false };
  r = subtasksPollTick({
    state: tickState(idle),
    file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000,
  });
  check("F3: sessionless live list settles after its run ends", r.push && r.subtasksExpired === true);
}

// ── F1b: an external REPLACEMENT list must not inherit this run's exemption ─
{
  // Run A creates a live list (arms the exemption for run A + that
  // snapshot). Another process then REPLACES the session's list; the
  // poller mirrors the replacement while run A is still in flight. The
  // foreign list must never inherit run A's exemption, however stale it
  // gets. (Here the arm is the legacy rev-0/content arm — the result
  // carries no rev — so the content signature is the identity, exactly as
  // the rev model prescribes for a rev-0 arm.)
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "create", t0)); // no rev → rev-0 arm
  check("F1b: create arms (run + snapshot identity)", subtasksBusyArmed(s, live));

  // The replacement: another process's list, fresh enough to display.
  const foreign = [{ id: 1, name: "external abandoned work", status: "in-progress" }];
  const file = { items: foreign, updatedAt: t0 + 1_000 };
  let sig = fileSig({ items: live, updatedAt: t0 });
  let r = subtasksPollTick({ state: tickState(s), file, lastSig: sig, now: t0 + 2_000, staleMs: 90_000 });
  check("F1b: the replacement is mirrored (fresh → shown)", r.push && r.subtasksExpired === false);
  s = { ...s, subtasks: r.subtasks, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: r.subtasksUpdatedAt, subtasksRev: r.rev };
  sig = r.sig;

  // THE HOLE: much later, run A is STILL in flight. The foreign list is
  // stale — it must expire, even though run A is busy and armed (for its
  // OWN, now-replaced snapshot).
  r = subtasksPollTick({ state: tickState(s), file, lastSig: sig, now: t0 + 500_000, staleMs: 90_000 });
  check("F1b: the stale foreign list expires despite the armed run", r.push && r.subtasksExpired === true);

  // And the exemption is not re-granted by the mirror: it stays expired
  // while run A keeps running (no resurrection on the next tick).
  const s2 = { ...s, subtasksExpired: true };
  r = subtasksPollTick({ state: tickState(s2), file, lastSig: r.sig, now: t0 + 505_000, staleMs: 90_000 });
  check("F1b: no re-exemption on later ticks (stays expired)", r.push === false && r.subtasksExpired === true);

  // The owning run's OWN snapshot is still protected (identity match).
  check("F1b: the armed snapshot itself stays exempt", subtasksBusyArmed(s, live) === true);
  check("F1b: the foreign snapshot is not exempt", subtasksBusyArmed(s, foreign) === false);
}

// ── F1c (rev model): the arm identity is the WRITE REVISION ─────────────────
{
  // Rev model (DESIGN.md): content equality is NOT ownership and neither
  // is a timestamp — the exemption belongs to the armed write's monotonic
  // `rev`, unique per write (bumped under the session lock).
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "create", t0, 5));
  check("F1c: create arms (write rev)", s.subtasksArmedRev === 5 && subtasksBusyArmed(s, live, 5));

  // Same-content EXTERNAL rewrite (rev 6): not exempt, and it disarms.
  check("F1c: same content, foreign rev → not exempt", subtasksBusyArmed(s, live, 6) === false);
  let file = { items: live, updatedAt: t0 + 1_000, rev: 6 };
  let r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }), now: t0 + 2_000, staleMs: 90_000,
  });
  check("F1c: the same-content rewrite (newer rev) disarms", r.disarm === true);
  // Driver applies the disarm…
  s = { ...s, subtasks: r.subtasks, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: r.subtasksUpdatedAt, subtasksRev: r.rev,
        subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };

  // …then an A→B→A STALE RESTORE while the run is still in flight: the
  // content matches the old arm, but the arm is gone — it must expire.
  file = { items: live, updatedAt: t0 + 3_000, rev: 7 };
  r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: fileSig(file), now: t0 + 200_000, staleMs: 90_000,
  });
  check("F1c: A→B→A restore after the disarm expires (no resurrection)", r.push && r.subtasksExpired === true);

  // Fresh sequence: a restore that arrives with a NEWER rev (write order:
  // armed rev 5 → restore rev 6) disarms even though the content matches —
  // the rev proves it is not the armed write.
  let s2 = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s2 = applyEvent(s2, subEnd("t1", live, "create", t0, 5));
  r = subtasksPollTick({
    state: tickState(s2),
    file: { items: live, updatedAt: t0 + 5_000, rev: 6 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 5_001, staleMs: 90_000,
  });
  check("F1c: same-content restore with newer rev → disarm (not exempt)", r.disarm === true && r.subtasksExpired === false);
  // The disarm is what protects the NEXT window: after applying it, the
  // same file at deadline time expires even though content == armed.
  const s3 = { ...s2, subtasksUpdatedAt: t0 + 5_000, subtasksRev: 6, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  r = subtasksPollTick({
    state: tickState(s3),
    file: { items: live, updatedAt: t0 + 5_000, rev: 6 }, lastSig: fileSig({ items: live, updatedAt: t0 + 5_000, rev: 6 }),
    now: t0 + 95_001, staleMs: 90_000,
  });
  check("F1c: post-disarm deadline expires the restored list", r.push && r.subtasksExpired === true);

  // The owning run's own write (equal rev) is NEVER a disarm, and stays
  // exempt — the long-tool-call case stays protected.
  check("F1c: equal rev → no disarm", subtasksPollTick({
    state: tickState(s2),
    file: { items: live, updatedAt: t0, rev: 5 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 999_999, staleMs: 90_000,
  }).disarm === false);
  // An OLDER-rev snapshot while the owning run is armed (lagging read /
  // rollback): NOT mirrored (the display keeps the owned snapshot), NOT
  // disarmed (a lagging observation cannot supersede the armed write).
  const older = subtasksPollTick({
    state: tickState(s2),
    file: { items: live, updatedAt: t0 - 1_000, rev: 4 }, lastSig: "x", now: t0 + 999_999, staleMs: 90_000,
  });
  check("F1c: older-rev snapshot → skipped (not mirrored), arm survives",
    older.push === false && older.disarm === false && older.subtasksExpired === false);
  // A foreign write in the ARMED MILLISECOND (same updatedAt — invisible to
  // the stamp model — but rev 6): expires AND disarms.
  const b = [{ id: 1, name: "b", status: "in-progress" }];
  r = subtasksPollTick({
    state: tickState(s2),
    file: { items: b, updatedAt: t0, rev: 6 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 200_000, staleMs: 90_000,
  });
  check("F1c: same-ms foreign write (newer rev) → expires AND disarms", r.subtasksExpired === true && r.disarm === true);
  // …and the A→B→A restore after that disarm cannot regain the exemption.
  const s4 = { ...s2, subtasks: b, subtasksExpired: true, subtasksUpdatedAt: t0, subtasksRev: 6, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  r = subtasksPollTick({
    state: tickState(s4),
    file: { items: live, updatedAt: t0 + 5_000, rev: 7 }, lastSig: fileSig({ items: b, updatedAt: t0, rev: 6 }),
    now: t0 + 210_000, staleMs: 90_000,
  });
  check("F1c: A→B→A after the same-ms disarm → expired (no resurrection)", r.push && r.subtasksExpired === true);
  // A legacy sig-only arm (rev 0 — legacy results without details.rev):
  // content match is all it ever claims; the rev is unconstrained.
  const legacyArm = { busy: true, runStartedAt: t0, subtasksArmedRun: t0, subtasksArmedSig: subtaskItemsSig(live) };
  check("F1c: sig-only (rev-0) arm → rev unconstrained", subtasksBusyArmed(legacyArm, live, 12_345) === true);
}

// ── ACCEPTANCE F1-legacy: legacy result ≠ file write time keeps the
//    owning run's live list exempt (the receipt time is the CLOCK only) ──────
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  const before = Date.now();
  s = applyEvent(s, subEnd("t1", live, "create")); // legacy: no updatedAt, no rev
  const after = Date.now();
  check("A-F1-legacy: arms rev 0 (no write identity), content sig fallback",
    s.subtasksArmedRev === 0 && s.subtasksArmedSig === subtaskItemsSig(live));
  // The file the tool actually wrote: same content, DIFFERENT updatedAt
  // (written earlier), no rev. Old model: exact STAMP matching rejected it
  // → the field died mid-tool-call. Rev model: content match → exempt.
  const file = { items: live, updatedAt: t0 - 50_000 };
  let r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: fileSig(file), now: after + 90_001, staleMs: 90_000,
  });
  check("A-F1-legacy: the owning run's live list stays exempt despite the clock divergence",
    r.subtasksExpired === false && r.disarm === false);
  // Driver applies the clock sync; then quiet, still exempt.
  s = { ...s, subtasksUpdatedAt: r.subtasksUpdatedAt };
  r = subtasksPollTick({ state: tickState(s), file, lastSig: r.sig, now: after + 95_000, staleMs: 90_000 });
  check("A-F1-legacy: agreement → no churn, still exempt", r.push === false && r.subtasksExpired === false);
}

// ── ACCEPTANCE F2: identical writes have DISTINCT revs; arming at the
//    first, observing the second (same content, rev+1) DISARMS ───────────────
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "create", t0, 5)); // arm at rev 5
  // A foreign identical rewrite in the SAME millisecond (Date.now
  // collision — the stamp model saw one write): rev 6.
  const file = { items: live, updatedAt: t0, rev: 6 };
  let r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }), now: t0 + 1, staleMs: 90_000,
  });
  check("A-F2: the same-content same-ms rewrite (rev+1) disarms", r.disarm === true);
  // Driver applies the disarm; past the window the list follows the
  // deadline while the run is STILL busy (no resurrection).
  s = { ...s, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0, subtasksUpdatedAt: t0, subtasksRev: 6 };
  r = subtasksPollTick({ state: tickState(s), file, lastSig: fileSig(file), now: t0 + 92_000, staleMs: 90_000 });
  check("A-F2: post-disarm the list follows the deadline (run still busy)", r.push && r.subtasksExpired === true);
}

// ── ACCEPTANCE F3: older replacement → NOT mirrored, NOT disarmed; exact
//    restore re-exempts (it IS the armed write); newer restore disarms ───────
{
  const b = [{ id: 1, name: "other work", status: "in-progress" }];
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "create", t0, 5)); // armed at rev 5
  // 1) the file rolls back to rev 4 with DIFFERENT content: never accepted
  //    into state (the display keeps the owned snapshot), arm survives.
  let r = subtasksPollTick({
    state: tickState(s),
    file: { items: b, updatedAt: t0 - 5_000, rev: 4 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 200_000, staleMs: 90_000,
  });
  check("A-F3: older replacement → not mirrored, not disarmed, owned view survives",
    r.push === false && r.disarm === false && r.subtasksExpired === false);
  // 2) exact restore: rev back to 5 with the armed content → exempt (it IS
  //    the armed write — correct, and no stale exemption was revived
  //    because the older snapshot was never accepted).
  r = subtasksPollTick({
    state: tickState(s),
    file: { items: live, updatedAt: t0, rev: 5 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 300_000, staleMs: 90_000,
  });
  check("A-F3: exact restore (rev = armed) → exempt, no disarm", r.subtasksExpired === false && r.disarm === false);
  // 3) a restore carrying rev 6 (a foreign write at a newer rev) → NOT
  //    exempt and disarms.
  r = subtasksPollTick({
    state: tickState(s),
    file: { items: live, updatedAt: t0 + 250_000, rev: 6 }, lastSig: fileSig({ items: live, updatedAt: t0, rev: 5 }),
    now: t0 + 250_001, staleMs: 90_000,
  });
  check("A-F3: restore at rev > armed → disarm (foreign write, deadline rules)", r.disarm === true);
  s = { ...s, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  r = subtasksPollTick({
    state: tickState(s),
    file: { items: live, updatedAt: t0 + 250_000, rev: 6 }, lastSig: fileSig({ items: live, updatedAt: t0 + 250_000, rev: 6 }),
    now: t0 + 340_001, staleMs: 90_000,
  });
  check("A-F3: post-disarm the restored list follows the deadline", r.push && r.subtasksExpired === true);
}

// ── sanity: the protected case still works ──────────────────────────────────
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", live, "mark", t0, 3));
  const file = { items: live, updatedAt: t0, rev: 3 };
  const r = subtasksPollTick({
    state: tickState(s),
    file, lastSig: fileSig(file), now: t0 + 999_999, staleMs: 90_000,
  });
  check("sanity: the owning run's long tool call keeps the field alive", r.push === false && r.subtasksExpired === false);
}

process.exit(fails === 0 ? 0 : 1);
