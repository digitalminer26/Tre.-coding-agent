/**
 * P18 cycle 2 (sol audit, round 2) — named regressions for the findings on
 * the cycle-1 fixes (F3–F10). Each test pins the FIXED behavior.
 *
 * F3  corrections bind to a per-append CLAIM identity (collision-free
 *     across processes and log merges), not just (id,ts)
 * F4  LEGACY means genuinely ABSENT — a present-but-malformed binding
 *     (refId:42, half-bound pair, malformed claim) is unreadable, never a
 *     silent downgrade to the unrestricted legacy refund
 * F5  the refund dedupe key is the COMPLETE identity (claim when present,
 *     else (refId,refTs)) — indistinguishable duplicates refund ONCE
 * F6  bridge send files are EXCLUSIVE per send (no shared out.txt race)
 * F8  the success line is matched at column zero, count positive, and
 *     "sent + skipped" in one transcript fails closed
 * F9  sanitizeLogLine strips U+2028/U+2029 and caps line length
 * F10 activate() never throws even when the log SINK throws
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyTelegramSendOutput } from "../src/telegram/bridge.js";
import { sanitizeLogLine, LOG_LINE_CAP, activate } from "../src/host/activate.js";
import { makeEscalationChannel, ESCALATION_SCHEMA, type EscalationRecord } from "../src/escalation/channel.js";
import { createEpisodeLayout, type EpisodeGraph } from "../src/episode/journal.js";
import { runHostEpisode } from "../src/host/supervise.js";

type Rec = Record<string, unknown>;

const valid = (over: Rec = {}): Rec => ({
  episodeId: "ep1",
  taskId: "t2",
  blocker: "repeated-strategy",
  decisionNeeded: "approve model-swap beyond budget, rewrite t2, or abort",
  evidence: ["journal:act-abc", "session:w1"],
  attempts: [{ action: "backoff-retry", strategyId: "backoff:v1", detail: "denied: budget-usd" }],
  ...over,
});

// A shared-log harness: two channels, one array log, deterministic order.
function shared() {
  const log: unknown[] = [];
  const deps = {
    append: async (rec: unknown) => { log.push(structuredClone(rec)); },
    read: async () => log,
    now: () => 1000, // frozen clock: both instances derive the SAME (id,ts)
  };
  return { log, deps };
}

// ─── F3: per-append claim identity ─────────────────────────────────────────

test("P18-C2-F3: every raised record carries a unique claim; corrections carry refClaim", async () => {
  let refusedFirst = true;
  const log: unknown[] = [];
  const ch = makeEscalationChannel({
    append: async (rec: unknown) => { log.push(rec); },
    read: async () => log,
    deliver: async () => { if (refusedFirst) { refusedFirst = false; return { channel: "x:disabled", refused: true }; } return undefined; },
    now: () => 5,
  });
  const r1 = await ch.raise(valid() as never);
  assert.ok(r1 !== null);
  const claim1 = (r1!.record as EscalationRecord).claim;
  assert.equal(typeof claim1, "string", "a raised line carries a claim");
  assert.ok(claim1 !== undefined && claim1.startsWith(`${r1!.record.escalationId}#`), "claim is namespaced to the key");
  const corr = log.find((l) => (l as Rec).kind === "deliveryRefused") as Rec;
  assert.ok(corr !== undefined, "the refusal appended a correction");
  assert.equal(corr.refClaim, claim1, "the correction binds to the line's claim");

  // A second raise (new evidence) appends a DISTINCT claim.
  const r2 = await ch.raise(valid({ evidence: ["journal:new"] }) as never);
  const claim2 = (r2!.record as EscalationRecord).claim;
  assert.notEqual(claim2, claim1, "two appends never share a claim");
});

test("P18-C2-F3: cross-instance — a refund NEVER matches a line with a different claim (A4 closed by identity)", async () => {
  // The A4 barrier: BOTH instances derive their line from the SAME empty
  // snapshot (read returns a frozen copy), so they collide on (id, ts).
  const log: unknown[] = [];
  let snapshot: unknown[] = [];
  const deps = {
    append: async (rec: unknown) => { log.push(structuredClone(rec)); },
    read: async () => snapshot,
    now: () => 1000, // frozen clock: both derive the SAME (id,ts)
  };
  const chA = makeEscalationChannel({ ...deps, deliver: async () => ({ channel: "x:disabled", refused: true }) });
  const chB = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const rA = await chA.raise(valid() as never);   // A reserves against the empty log, refuses
  const rB = await chB.raise(valid() as never);   // B reserves against the SAME snapshot, sends
  assert.equal(rA!.record.id, rB!.record.id, "the collision is real: same line id");
  assert.equal(rA!.record.ts, rB!.record.ts);
  assert.notEqual(rA!.record.claim, rB!.record.claim, "…but the claims differ (F3)");
  // Replay: the latest line is B's (successful, deliveredCount 1). A's
  // correction names A's claim → it must NOT refund B's earned burn.
  snapshot = log.map((l) => structuredClone(l)); // the merged log becomes visible
  const pend = await chA.pending();
  const rec = pend.find((p) => p.escalationId === rA!.record.escalationId);
  assert.ok(rec !== undefined);
  assert.equal(rec.deliveredCount, 1, "B's successful send is NOT refunded by A's correction");
});

test("P18-C2-F3: same-instance refund still works (claim matches)", async () => {
  const { log, deps } = shared();
  const ch = makeEscalationChannel({ ...deps, deliver: async () => ({ channel: "x:disabled", refused: true }) });
  const r1 = await ch.raise(valid() as never);
  assert.equal(r1!.delivered, false);
  // Fresh process on the same log: the budget was restored durably.
  const ch2 = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const r2 = await ch2.raise(valid({ evidence: ["journal:fresh"] }) as never);
  assert.equal(r2!.delivered, true, "the refusal refunded the budget across restart");
  assert.equal(log.filter((l) => (l as Rec).kind === "deliveryRefused").length, 1);
});

// ─── F4: legacy means GENUINELY ABSENT ────────────────────────────────────

test("P18-C2-F4: a malformed binding on a correction is unreadable — no refund (never a legacy downgrade)", async () => {
  const malformed: Rec[] = [
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c1", ref: "", ts: 1, refId: 42 },          // non-string refId
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c2", ref: "", ts: 1, refId: "x" },          // half-bound: no refTs
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c3", ref: "", ts: 1, refTs: 1 },            // half-bound: no refId
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c4", ref: "", ts: 1, refClaim: 7 },         // malformed claim
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c5", ref: "", ts: 1, refClaim: "" },        // empty claim
    // P18-C3 (audit cycle 2, finding 3): a PRESENT binding whose value
    // is `undefined` (an in-memory hostile line — JSON can't express it)
    // is present-but-invalid, never the "genuinely absent" legacy path.
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c6", ref: "", ts: 1, refId: undefined },
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c7", ref: "", ts: 1, refTs: undefined },
    // P18-C3 F1 (sol audit cycle 3): the CLAIM binding follows the same
    // descriptor rule — a present own-data `refClaim: undefined` is
    // present-but-invalid, never the legacy shape. (The old parser tested
    // `value !== undefined` and let it spend a legacy refund.)
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c10", ref: "", ts: 1, refClaim: undefined },
    // An ACCESSOR binding (get/set field — ownData reports accessor:true,
    // present:false) is the same hostile class as a trap: unreadable,
    // never silently downgraded to a legacy refund.
    Object.defineProperties(
      { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c8", ref: "", ts: 1 },
      { refId: { get: () => "forged", enumerable: true } },
    ),
    Object.defineProperties(
      { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "c9", ref: "", ts: 1, refId: "x", refTs: 1 },
      { refTs: { get: () => 1, enumerable: true } },
    ),
  ];
  for (const bad of malformed) {
    const { log, deps } = shared();
    const ch = makeEscalationChannel({ ...deps, deliver: async () => undefined });
    const r1 = await ch.raise(valid() as never);
    assert.equal(r1!.delivered, true);
    bad.ref = r1!.record.escalationId;
    log.push(bad); // a forged/corrupt correction for the open line
    const ch2 = makeEscalationChannel({ ...deps, deliver: async () => undefined });
    const st = await ch2.pendingStatus();
    const rec = st.open.find((p) => p.escalationId === r1!.record.escalationId);
    assert.equal(rec?.deliveredCount, 1, `${bad.id}: a malformed correction never refunds`);
    assert.equal(st.complete, false, `${bad.id}: the unreadable line is disclosed via complete:false`);
  }
});

test("P18-C2-F4: a malformed CLAIM on an escalation line makes the line unreadable (skipped, disclosed)", async () => {
  const { log, deps } = shared();
  const ch = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const r1 = await ch.raise(valid() as never);
  const idx = log.findIndex((l) => (l as Rec).kind === "escalation");
  (log[idx] as Rec).claim = 42; // corrupt the claim in place
  const ch2 = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const st = await ch2.pendingStatus();
  assert.equal(st.open.find((p) => p.escalationId === r1!.record.escalationId), undefined, "a line with a malformed claim is not believed");
  assert.equal(st.complete, false, "…and the replay is disclosed incomplete");
});

// ─── F5: complete dedupe key ───────────────────────────────────────────────

test("P18-C2-F5: two identical claim-less corrections refund ONCE (idempotent); distinct claims are distinguishable", async () => {
  const { log, deps } = shared();
  const ch = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const r1 = await ch.raise(valid() as never);
  const esc = r1!.record;
  // Two byte-identical legacy-bound corrections (pre-F3 logs / merged
  // duplicates): indistinguishable, so they refund ONCE — never twice.
  const dup = { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "d1", ref: esc.escalationId, ts: 999, refId: esc.id, refTs: esc.ts };
  log.push(dup, structuredClone(dup));
  const ch2 = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const st = await ch2.pendingStatus();
  const rec = st.open.find((p) => p.escalationId === esc.escalationId);
  assert.equal(rec?.deliveredCount, 0, "one refund applied for the two indistinguishable corrections");
});

// ─── F6: exclusive per-send file (source-shape pin) ────────────────────────

test("P18-C2-F6: the bridge writes per-send exclusive files, never the shared out.txt", async () => {
  // Source-shape pin: the exclusive-create flag and the per-send name must
  // stay, and the shared 'out.txt' literal must not return.
  // Source-shape pin: runs from BOTH test/ (tsx) and dist/test/ (node —
  // where ../src doesn't exist), so probe both candidate roots.
  const { existsSync } = await import("node:fs");
  const candidates = ["../src/telegram/bridge.ts", "../../src/telegram/bridge.ts"].map((rel) => new URL(rel, import.meta.url));
  const found = candidates.find((u) => existsSync(u));
  assert.ok(found !== undefined, "bridge.ts source found for the pin");
  const bridgeSrc = await readFile(found!, "utf8");
  assert.match(bridgeSrc, /out\.\$\{process\.pid\}\.\$\{sendSeq\}/, "per-send out.<pid>.<seq>.<rand>.txt");
  assert.match(bridgeSrc, /flag:\s*"wx"/, "exclusive create (wx)");
  assert.match(bridgeSrc, /rmSync\(file/, "the send file is removed after the helper returns");
  assert.ok(!bridgeSrc.includes('"out.txt"') && !bridgeSrc.includes("'out.txt'") && !bridgeSrc.includes("`out.txt`"), "the shared out.txt is gone");
});

// ─── F8: strict success-line grammar ───────────────────────────────────────

test("P18-C2-F8: an indented / nonpositive / contradictory success transcript fails closed", () => {
  // P18-C3 (audit cycle 2, finding 1): the canonical form is the REAL
  // helper print (`… to chat <dest>`); the short hypothetical form the
  // first revision matched is now itself rejected.
  assert.equal(classifyTelegramSendOutput("  telegram: sent 2 message(s) to chat 42\n").sent, false, "column zero required");
  assert.equal(classifyTelegramSendOutput("prefix telegram: sent 2 message(s) to chat 42\n").sent, false, "no prefix match");
  assert.equal(classifyTelegramSendOutput("telegram: sent 0 message(s) to chat 42\n").sent, false, "a zero count is not a send");
  assert.equal(classifyTelegramSendOutput("telegram: sent 2 message(s)\n").sent, false, "a destination-less line is NOT the helper's print (audit cycle 2 F1)");
  const both = classifyTelegramSendOutput("telegram: sent 1 message(s) to chat 42\ntelegram: skipped duplicate send (same content sent 5s ago < 600s cooldown; --force to override)\n");
  assert.equal(both.sent, false, "sent+skipped in one transcript is contradictory → never a delivery");
  assert.equal(both.skippedDuplicate, false, "…and never a refundable skip either — fail closed entirely");
  // The task text can never forge it mid-line or with a suffix:
  assert.equal(classifyTelegramSendOutput("telegram: sent 3 message(s) to chat 42 per the task text\n").sent, false, "a suffixed line is not the helper's print");
  assert.equal(classifyTelegramSendOutput("telegram: sent 3 message(s) to chat 42\n").sent, true, "the canonical column-zero line parses");
  assert.equal(classifyTelegramSendOutput("telegram: sent 3 message(s) to chat 42\r\n").sent, true, "a CRLF suffix is tolerated");
  // The REAL suppression print refunds; the short hypothetical does not:
  const skip = classifyTelegramSendOutput("telegram: skipped duplicate send (same content sent 37s ago < 600s cooldown; --force to override)\n");
  assert.equal(skip.sent, false);
  assert.equal(skip.skippedDuplicate, true, "the installed helper's guard print is refundable");
  assert.equal(classifyTelegramSendOutput("telegram: skipped duplicate send\n").skippedDuplicate, false, "a destination-less skip is not the helper's print");
});

// ─── F9: line separators + cap ─────────────────────────────────────────────

test("P18-C2-F9: sanitizeLogLine strips U+2028/U+2029 and caps the line", () => {
  assert.equal(sanitizeLogLine("a\u2028b\u2029c"), "a ⏎ b ⏎ c", "U+2028/U+2029 are line separators — rendered visibly, never an invisible break");
  assert.equal(sanitizeLogLine("a\u0000b"), "a\u2423b", "NUL renders as the visible placeholder");
  const long = sanitizeLogLine("x".repeat(5000));
  assert.ok(long.length <= LOG_LINE_CAP, `capped at ${LOG_LINE_CAP}`);
  assert.ok(sanitizeLogLine("tab\tok \r ret").includes("ok"), "ordinary text survives");
});

// ─── F10: sink throws cannot escape activate() ─────────────────────────────

test("P18-C2-F10: activate() returns a code even when the log sink throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p18c2-f10-"));
  const code = await activate(["--graph", join(dir, "missing.json"), "--task", "t", "--episodes-root", dir], () => {
    throw new Error("sink exploded");
  });
  assert.equal(typeof code, "number", "a throwing sink never rejects activate()");
  // The usage/error path (argv before any work) is firewalled too:
  const code2 = await activate(["--bad\nforged line"], () => { throw new Error("sink exploded"); });
  assert.equal(code2, 2, "the unknown-argument path still returns its code with a dead sink");
});

// ─── C3-F4: mixed-format corrections must NOT double-refund one append ─────

test("P18-C3-F4: a claimed and a claim-less correction for the SAME append refund ONCE (count 2 → 1, not 0)", async () => {
  // sol audit cycle 2 repro: two successful raises (count 2), then two
  // corrections naming the LATEST append — one carrying its claim, one
  // bound only by (id,ts) (a pre-F3 writer). The old dedupe keyed by
  // BINDING FORMAT, so both applied and the same burn refunded twice.
  const { log, deps } = shared();
  const ch = makeEscalationChannel({ ...deps, deliver: async () => ({ channel: "telegram" }) });
  const r1 = await ch.raise(valid() as never);
  const r2 = await ch.raise(valid({ evidence: ["journal:second"] }) as never);
  assert.equal(r2!.record.deliveredCount, 2, "two sends burned two budget");
  const esc = r2!.record;
  log.push(
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "m1", ref: esc.escalationId, ts: 999, refClaim: esc.claim },                    // claimed binding
    { schema: ESCALATION_SCHEMA, kind: "deliveryRefused", id: "m2", ref: esc.escalationId, ts: 999, refId: esc.id, refTs: esc.ts },            // same append, (id,ts)-only binding
  );
  const ch2 = makeEscalationChannel({ ...deps, deliver: async () => undefined });
  const st = await ch2.pendingStatus();
  const rec = st.open.find((p) => p.escalationId === esc.escalationId);
  assert.equal(rec?.deliveredCount, 1, "ONE target append refunds ONE burn regardless of binding format");
  assert.equal(st.complete, true, "both corrections are well-formed: nothing unreadable");
});

// ─── C3-F2b: an EMPTY lease is ambiguous — never claimable blind ───────────

test("P18-C3-F2: a fresh EMPTY lease is a creation in progress — activation refuses, file untouched", async (t) => {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "p18c3-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = {
    schema: "tre-graph/1" as const,
    episodeId: "ep-emptyfresh",
    goal: "empty lease never claimed blind",
    tasks: [{ id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { baseCommit: "abc", gate: { cmd: "true" } },
  };
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, ""); // empty-but-present: fresh creation window
  const worker = join(root, "worker.sh");
  await writeFile(worker, "#!/bin/sh\nexit 0\n");
  await chmod(worker, 0o755);
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /contended/,
    "a fresh empty lease is never claimed — activation refuses (fail closed)",
  );
  assert.equal(await readFile(leasePath, "utf8"), "", "the ambiguous empty lease is left EXACTLY as found (no blind write)");
});

test("P18-C3-F2: an EMPTY lease older than the abandon bound is recovery-eligible (disclosed takeover, under lock)", async (t) => {
  const { rm, utimes } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "p18c3-aband-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = {
    schema: "tre-graph/1" as const,
    episodeId: "ep-abandon",
    goal: "crashed creator recovery",
    tasks: [{ id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { baseCommit: "abc", gate: { cmd: "true" } },
  };
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, "");
  const old = Date.now() / 1000 - 60; // mtime 60s ago: past the 10s bound
  await utimes(leasePath, old, old);
  const worker = join(root, "worker.sh");
  await writeFile(worker, "#!/bin/sh\nexit 0\n");
  await chmod(worker, 0o755);
  const lines: string[] = [];
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  // (the run completed — activation was ADMITTED, not refused) and the
  // takeover was disclosed; the lease rode our ownership token and was
  // released by normal cleanup.
  assert.ok(lines.some((l) => /older than .*creator died before first write/.test(l)), "the takeover is disclosed");
});

// ─── C3-F2: stale-lease takeover is SERIALIZED, not optimistic ─────────────

test("P18-C3-F2: two activations that both see the same stale lease — ONE takes over, the other is refused", async (t) => {
  // sol audit cycle 2 repro: barrier-synchronized stale takeovers used to
  // BOTH swap the lease and enter protected setup (the read-then-rename
  // "CAS" compared bytes nobody had changed). Now recovery runs under an
  // mkdir lock with re-verification: exactly one winner.
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "p18c3-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = {
    schema: "tre-graph/1" as const,
    episodeId: "ep-barrier",
    goal: "serialized takeover",
    tasks: [{ id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { baseCommit: "abc", gate: { cmd: "true" } },
  };
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  // A stale lease (pid beyond every OS pid_max).
  await writeFile(join(dir, "host.lease"), JSON.stringify({ pid: 4194303, episodeId: epGraph.episodeId, claimedAt: 1 }) + "\n");
  const worker = join(root, "worker.sh");
  await writeFile(worker, "#!/bin/sh\nsleep 1\nexit 0\n");
  await chmod(worker, 0o755);
  const linesA: string[] = [];
  const linesB: string[] = [];
  const opts = (log: (l: string) => void) => ({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log });
  // Fire both concurrently: both observe the stale lease before either
  // completes recovery — the lock decides, never the byte-compare.
  const [a, b] = await Promise.allSettled([runHostEpisode(opts((l) => linesA.push(l))), runHostEpisode(opts((l) => linesB.push(l)))]);
  const ok = [a, b].filter((r) => r.status === "fulfilled");
  const refused = [a, b].filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, `exactly ONE activation holds the episode (${ok.length} fulfilled)`);
  assert.equal(refused.length, 1, "the other is refused (the lease is held by a live activation)");
  const all = [...linesA, ...linesB];
  const takeovers = all.filter((l) => /stale lease .* taking over/.test(l));
  assert.equal(takeovers.length, 1, "exactly ONE disclosed takeover");
});
