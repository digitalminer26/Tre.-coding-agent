// Adversarial repro (rev model, DESIGN.md): faithful driver-loop simulation
// (disarm + rev mirror applied like run.tsx does) for (1) same-content
// external replacement and (2) foreign A→B→A. Both must END EXPIRED while
// the owning run is still busy. The ownership identity is the monotonic
// per-write `rev` — `updatedAt` is only the expiry clock — so the old
// equal-stamp ambiguity cannot exist: any second write (identical content,
// same millisecond or not) carries rev+1 and is a foreign write.
import { makeInitialState, applyEvent, subtasksBusyArmed, subtasksPollTick } from "../dist/src/tui/state.js";

const t0 = 1_000_000;
const A = [{ id: 1, name: "mine", status: "in-progress" }];
const B = [{ id: 1, name: "other work", status: "in-progress" }];
const subEnd = (id, subtasks, action, updatedAt, rev) => ({
  type: "tool_execution_end", toolCallId: id,
  result: { role: "toolResult", toolCallId: id, toolName: "subtask",
    content: [{ type: "text", text: "ok" }], isError: false,
    details: { subtasks, action, ...(updatedAt ? { updatedAt } : {}), ...(rev ? { rev } : {}) },
    timestamp: 0 },
});
const fileSig = (f) => JSON.stringify({ items: f.items, updatedAt: f.updatedAt, rev: f.rev ?? 0 });
let fails = 0;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) fails++; };

// The driver's tick, exactly as run.tsx wires it (rev fields included).
function driverTick(st, file, lastSig, now, staleMs) {
  const r = subtasksPollTick({
    state: {
      subtasks: st.subtasks, subtasksExpired: st.subtasksExpired, subtasksUpdatedAt: st.subtasksUpdatedAt,
      busyArmed: subtasksBusyArmed(st),
      subtasksArmedSig: st.subtasksArmedSig,
      subtasksArmedRev: st.subtasksArmedRev,
      subtasksRev: st.subtasksRev,
    },
    file, lastSig, now, staleMs,
  });
  if (r.disarm && st.subtasksArmedRun !== null) {
    st = { ...st, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  }
  if (r.push) st = { ...st, subtasks: r.subtasks, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: r.subtasksUpdatedAt, subtasksRev: r.rev };
  return { st, sig: r.push ? r.sig : lastSig, r };
}

// (1) SAME-CONTENT external replacement: another process rewrites the same
// items (rev+1 — a distinct write even in the same millisecond), then goes
// quiet. Run A is still busy the whole time.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  let { st, sig } = { st: s, sig: fileSig({ items: A, updatedAt: t0, rev: 5 }) };
  // external same-content rewrite (rev 6) at t0+1000
  let res = driverTick(st, { items: A, updatedAt: t0 + 1_000, rev: 6 }, sig, t0 + 1_001, 90_000);
  st = res.st; sig = res.sig;
  check("same-content rewrite (newer rev) disarms the arm", st.subtasksArmedRun === null);
  // quiet past the window, run A STILL busy
  res = driverTick(st, { items: A, updatedAt: t0 + 1_000, rev: 6 }, sig, t0 + 92_000, 90_000);
  st = res.st;
  check("same-content external list expires while the run is busy", st.subtasksExpired === true);
  // and stays expired (no churn/resurrection)
  const res2 = driverTick(st, { items: A, updatedAt: t0 + 1_000, rev: 6 }, fileSig({ items: A, updatedAt: t0 + 1_000, rev: 6 }), t0 + 100_000, 90_000);
  check("stays expired (no resurrection)", res2.r.push === false && res2.st.subtasksExpired === true);
}

// (2) FOREIGN A→B→A: replacement B (rev 6) disarms; a stale restore of A's
// content at rev 7 must NOT regain the exemption; expires past the window.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  let st = s;
  let sig = fileSig({ items: A, updatedAt: t0, rev: 5 });
  let res = driverTick(st, { items: B, updatedAt: t0 + 1_000, rev: 6 }, sig, t0 + 1_001, 90_000); // B replaces
  st = res.st; sig = res.sig;
  check("B replacement disarms", st.subtasksArmedRun === null);
  res = driverTick(st, { items: A, updatedAt: t0 + 5_000, rev: 7 }, sig, t0 + 96_000, 90_000); // A→B→A stale restore, past window
  st = res.st;
  check("A→B→A restore expires (no regained exemption)", st.subtasksExpired === true);
}

// (3) CONTROL: the owning run's own marks keep the field alive (no false
// disarm on the run's own writes).
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  let st = s;
  let sig = fileSig({ items: A, updatedAt: t0, rev: 5 });
  let res = driverTick(st, { items: A, updatedAt: t0, rev: 5 }, sig, t0 + 30_000, 90_000);
  st = res.st;
  check("owning run mid-flight: no disarm, stays alive", st.subtasksArmedRun === t0 && st.subtasksExpired === false);
  // The run's OWN next mark (rev 6, still LIVE) re-arms cleanly — no
  // disarm, the exemption follows the new rev. (A settled `done` list
  // always expires past the window — the exemption only protects live
  // items, pre-existing F1 semantics.)
  const A2 = A.map((x) => ({ ...x, status: "in-progress", name: "mine (renamed)" }));
  s = applyEvent(st, subEnd("t2", A2, "mark", t0 + 40_000, 6));
  check("own mark re-arms (rev moves)", s.subtasksArmedRun === t0 && s.subtasksArmedRev === 6);
  res = driverTick(s, { items: A2, updatedAt: t0 + 40_000, rev: 6 },
    fileSig({ items: A, updatedAt: t0, rev: 5 }), t0 + 200_000, 90_000);
  check("own write's rev → no disarm (equal rev exempt)", res.r.disarm === false && res.st.subtasksExpired === false);
}

// (4) REV-MODEL ADVERSARIALS.
// (4a) The same-MILLISECOND hole (the old equal-stamp hole): foreign B
// written in the armed millisecond carries rev 6 → B expires, the arm
// DISARMS, and the subsequent A→B→A restore cannot regain the exemption.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  let { st, sig } = { st: s, sig: fileSig({ items: A, updatedAt: t0, rev: 5 }) };
  let res = driverTick(st, { items: B, updatedAt: t0, rev: 6 }, sig, t0 + 200_000, 90_000);
  st = res.st; sig = res.sig;
  check("4a: same-ms foreign B (rev 6) expires AND disarms", res.r.subtasksExpired === true && res.r.disarm === true);
  check("4a: arm cleared", st.subtasksArmedRun === null);
  res = driverTick(st, { items: A, updatedAt: t0 + 5_000, rev: 7 }, sig, t0 + 210_000, 90_000);
  check("4a: A→B→A restore after the disarm expires (no regained exemption)", res.st.subtasksExpired === true);
}

// (4b) An OLDER-rev snapshot while the owning run is armed (lagging read /
// rollback): NEVER mirrored (the display keeps the owned snapshot), NEVER
// disarmed (a lagging observation cannot supersede the armed write).
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  const res = driverTick(s, { items: A, updatedAt: t0 - 1_000, rev: 4 }, fileSig({ items: A, updatedAt: t0, rev: 5 }), t0 + 200_000, 90_000);
  check("4b: older-rev snapshot → not mirrored, not disarmed, arm survives",
    res.r.push === false && res.r.disarm === false && res.st.subtasksArmedRun === t0 && res.st.subtasksExpired === false);
}

// (4c) A strictly-newer rev snapshot (foreign rewrite) disarms.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  const res = driverTick(s, { items: A, updatedAt: t0 + 1_000, rev: 6 }, fileSig({ items: A, updatedAt: t0, rev: 5 }), t0 + 2_000, 90_000);
  check("4c: newer rev → disarm (fresh → shown by deadline)", res.r.disarm === true && res.r.subtasksExpired === false);
}

// (4d) CONTROL: the armed write itself (equal rev, equal content) stays
// exempt with no disarm for the whole run — no false positive.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  const res = driverTick(s, { items: A, updatedAt: t0, rev: 5 }, fileSig({ items: A, updatedAt: t0, rev: 5 }), t0 + 999_999, 90_000);
  check("4d: armed write exempt, no disarm, no push churn", res.r.disarm === false && res.r.push === false && res.st.subtasksExpired === false);
}

// (4e) F3 driver loop: armed at rev 5; the file rolls back to rev 4 with
// foreign content (never accepted); the exact restore (rev 5, armed
// content) re-exempts; a rev-6 foreign restore disarms and the deadline
// then decides. The old model accepted the older snapshot into state, and
// the exact restore revived a stale exemption — the rev model never does.
{
  let s = { ...makeInitialState("m"), busy: true, runStartedAt: t0 };
  s = applyEvent(s, subEnd("t1", A, "create", t0, 5));
  let { st, sig } = { st: s, sig: fileSig({ items: A, updatedAt: t0, rev: 5 }) };
  let res = driverTick(st, { items: B, updatedAt: t0 - 5_000, rev: 4 }, sig, t0 + 200_000, 90_000);
  st = res.st;
  check("4e: older replacement never mirrored (display keeps the owned list)",
    res.r.push === false && st.subtasks[0].name === "mine" && st.subtasksArmedRun === t0);
  res = driverTick(st, { items: A, updatedAt: t0, rev: 5 }, sig, t0 + 300_000, 90_000);
  check("4e: exact restore (rev = armed) → exempt (it IS the armed write)",
    res.r.subtasksExpired === false && res.r.disarm === false);
  res = driverTick(st, { items: A, updatedAt: t0 + 250_000, rev: 6 }, sig, t0 + 250_001, 90_000);
  check("4e: rev-6 foreign restore disarms", res.r.disarm === true && res.st.subtasksArmedRun === null);
  res = driverTick(res.st, { items: A, updatedAt: t0 + 250_000, rev: 6 }, fileSig({ items: A, updatedAt: t0 + 250_000, rev: 6 }), t0 + 340_001, 90_000);
  check("4e: post-disarm the restored list follows the deadline", res.st.subtasksExpired === true);
}

process.exit(fails === 0 ? 0 : 1);
