/**
 * P18 cycle 1 (sol audit) — named regressions for the six confirmed
 * findings A1–A6. Each test pins the FIXED behavior; the comment names
 * the audit repro it closes. Mutation-check notes point at the guard an
 * edit must not silently disable.
 *
 * A1  helper exit 0 ≠ delivery (duplicate guard)  → classified sendResult
 * A2  activation log injection via argv/paths     → sanitized log lines
 * A3  rejected re-activation clobbered live graph → identity-checked seed
 * A4  cross-instance correction misfired a refund → refId/refTs binding + episode lease
 * A5  setup threw outside the never-throw boundary → wiring inside try
 * A6  descriptor-trap port result claimed success → structural failure
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyTelegramSendOutput, makeTelegramBridge } from "../src/telegram/bridge.js";
import { makeTelegramDeliver } from "../src/telegram/escalation.js";
import { makeEscalationChannel, ESCALATION_SCHEMA, type RaiseResult } from "../src/escalation/channel.js";
import { sanitizeLogLine, LOG_LINE_CAP, activate } from "../src/host/activate.js";
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

// ─── A1: a helper exit 0 is NOT an acknowledgment of a fresh send ──────────

test("P18-C1-A1: classifyTelegramSendOutput believes only the helper's success line", () => {
  // P18-C3 (audit cycle 2, finding 1): the fixtures below are PINNED TO
  // THE INSTALLED HELPER (telegram.py) — the exact prints, byte for byte.
  assert.deepEqual(
    classifyTelegramSendOutput("telegram: sent 2 message(s) to chat 42\n"),
    { sent: true, skippedDuplicate: false, detail: "telegram: sent 2 message(s) to chat 42" },
  );
  const dup = classifyTelegramSendOutput("telegram: skipped duplicate send (same content sent 37s ago < 600s cooldown; --force to override)\n");
  assert.equal(dup.sent, false, "the guard-suppressed send is NOT a send");
  assert.equal(dup.skippedDuplicate, true);
  // Unrecognized output (exit 0, no known line) is fail-closed for the claim.
  const unknown = classifyTelegramSendOutput("ok\n");
  assert.equal(unknown.sent, false);
  assert.equal(unknown.skippedDuplicate, false);
  // The detail is one bounded line (log-bound).
  const long = classifyTelegramSendOutput("x".repeat(1000));
  assert.ok(long.detail.length <= 200, "detail is bounded");
});

test("P18-C1-A1: a guard-suppressed send is an explicit refusal (refundable), never a delivery", async () => {
  const deliver = makeTelegramDeliver({
    enabled: true,
    send: async () => {},
    sendResult: async () => ({ sent: false, skippedDuplicate: true, detail: "telegram: skipped duplicate send" }),
  });
  const ch = makeEscalationChannel({ append: async () => {}, deliver, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(res.delivered, false, "the human was NOT asked — never a delivery");
  assert.equal(res.refused, true, "an explicit refusal: the redeliver budget refunds it (W13-F1)");
  assert.match(String(res.channel), /duplicate-suppressed/);
});

test("P18-C1-A1: unattested helper output is a FAILED delivery — never a silent success", async () => {
  const deliver = makeTelegramDeliver({
    enabled: true,
    send: async () => {},
    sendResult: async () => ({ sent: false, skippedDuplicate: false, detail: "something odd" }),
  });
  const ch = makeEscalationChannel({ append: async () => {}, deliver, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(res.delivered, false, "an unattested exit 0 never claims delivery");
  assert.equal(res.refused, undefined, "a failure is not a refundable refusal — it stays burned");
});

test("P18-C1-A1 e2e: the REAL bridge against a scripted helper — sent claims, skip refuses", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "p18a1-home-"));
  const ws = await mkdtemp(join(tmpdir(), "p18a1-ws-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await mkdir(join(home, ".tre"), { recursive: true });
  await writeFile(join(home, ".tre", "telegram.json"), JSON.stringify({ token: "t", chatId: "42" }));
  await mkdir(join(ws, ".tre", "skills", "telegram"), { recursive: true });
  const helper = join(ws, ".tre", "skills", "telegram", "telegram.py");
  await writeFile(helper, `#!/usr/bin/env python3\nimport os\nprint(os.environ.get("FAKE_HELPER_OUT", ""))\n`);
  await chmod(helper, 0o755);
  const prev = process.env["FAKE_HELPER_OUT"];
  try {
    const bridge = makeTelegramBridge(ws, home);
    assert.equal(bridge.enabled, true, "config + helper present");
    // P18-C3: scripted with the REAL helper prints (the classifier now
    // pins the installed telegram.py grammar — destination included).
    process.env["FAKE_HELPER_OUT"] = "telegram: sent 1 message(s) to chat 42";
    const sent = await bridge.sendResult!("x");
    assert.equal(sent.sent, true);
    process.env["FAKE_HELPER_OUT"] = "telegram: skipped duplicate send (same content sent 12s ago < 600s cooldown; --force to override)";
    const dup = await bridge.sendResult!("x");
    assert.equal(dup.sent, false, "the installed helper's skip path is NOT a send");
    assert.equal(dup.skippedDuplicate, true);
  } finally {
    if (prev === undefined) delete process.env["FAKE_HELPER_OUT"];
    else process.env["FAKE_HELPER_OUT"] = prev;
  }
});

// ─── A2: everything activation logs is one bounded, control-free line ──────

test("P18-C1-A2: sanitizeLogLine kills newlines, controls, and length", () => {
  assert.equal(sanitizeLogLine("plain line"), "plain line");
  const forged = sanitizeLogLine("bad --flag\nescalate dispatched via telegram");
  assert.ok(!forged.includes("\n"), "a sanitized line can never forge a second log line");
  assert.match(forged, /⏎/, "the break is disclosed, not silently removed");
  const ansi = sanitizeLogLine(`x\u001b[2J\u0007y`);
  assert.ok(!ansi.includes("\u001b") && !ansi.includes("\u0007"), "control bytes never reach the terminal");
  const long = sanitizeLogLine("a".repeat(LOG_LINE_CAP + 500));
  assert.ok(long.length <= LOG_LINE_CAP, "bounded length");
  assert.ok(long.endsWith("\u2026"), "the clip is disclosed");
});

test("P18-C1-A2 e2e: an unknown argv token carrying a forged dispatch line stays ONE line", async () => {
  const lines: string[] = [];
  const code = await activate(["--bad\nescalate dispatched via telegram"], (l) => lines.push(l));
  assert.equal(code, 2);
  // lines[0] is the argv-echoed usage error (the untrusted line); the
  // follow-ups are the trusted blank + USAGE block through the raw sink.
  assert.ok(lines.length >= 2, "the error was logged");
  assert.ok(!lines[0]!.includes("\n"), "the argv-derived line carries NO raw newline");
  assert.match(lines[0]!, /⏎/, "the injected break is disclosed inline");
  assert.ok(!/^escalate dispatched via telegram$/m.test(lines.join("\n")), "the injected text is never its own log line");
});

// ─── A3: a re-seed NEVER overwrites an existing graph ───────────────────────

const graphA = (over: Partial<EpisodeGraph> = {}): EpisodeGraph => ({
  schema: "tre-graph/1",
  episodeId: "ep-shared",
  goal: "A: accepted scope",
  tasks: [{ id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
  ...over,
});

test("P18-C1-A3: createEpisodeLayout with an IDENTICAL graph is a true no-op; a DIFFERENT one throws and touches nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p18a3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const g = graphA();
  const dir = await createEpisodeLayout(root, g.episodeId, g);
  const graphFile = join(dir, "graph.json");
  const before = await readFile(graphFile, "utf8");
  // Identical desired state (key order irrelevant) → idempotent.
  const sameKeyOrder = graphA({ goal: "A: accepted scope" });
  await createEpisodeLayout(root, g.episodeId, sameKeyOrder);
  assert.equal(await readFile(graphFile, "utf8"), before, "identical re-seed leaves the file byte-identical");
  // sol repro 'rejected-concurrent-writer': graph B over live graph A.
  const gB = graphA({ goal: "B: rejected caller replaced desired scope" });
  await assert.rejects(createEpisodeLayout(root, g.episodeId, gB), /DIFFERENT graph/);
  assert.equal(await readFile(graphFile, "utf8"), before, "the live desired state is UNTOUCHED by the refused re-seed");
  // A corrupt commit marker is corruption, not a re-seed invitation.
  await writeFile(graphFile, "{ broken");
  await assert.rejects(createEpisodeLayout(root, g.episodeId, g), /corrupt/);
});

// ─── A4: refunds are bound to the LINE (id+ts) they refund ─────────────────

async function logChannel(L: unknown[], maxRedeliver = 3) {
  return makeEscalationChannel({
    append: async (r) => { L.push(r as Rec); },
    read: async () => [...L],
    deliver: async () => ({ channel: "telegram" }),
    now: () => 1700000000 + L.length,
    maxRedeliver,
  });
}

test("P18-C1-A4: a correction bound to the LATEST line id+ts refunds it", async () => {
  const L: unknown[] = [];
  const ch = await logChannel(L);
  const r1 = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  const rec = r1.record as unknown as Rec;
  L.push({ schema: ESCALATION_SCHEMA, kind: "deliveryRefused", ref: rec.escalationId, refId: rec.id, refTs: rec.ts, ts: rec.ts as number + 1 });
  const st = await (await logChannel(L)).pendingStatus();
  assert.equal((st.open[0] as { deliveredCount?: number })?.deliveredCount, 0, "the bound refund applies");
});

test("P18-C1-A4 (sol race-refund): a refund bound to an OLDER ts never spends a newer line's earned burn", async () => {
  // The audit repro: two channel instances share the log, both derive the
  // SAME line id (key#0), B's send actually happened (newer ts). A's
  // correction — bound to its own (older) line — must NOT refund B.
  const L: unknown[] = [];
  const ch = await logChannel(L);
  const rA = (await ch.raise(valid() as never)) as RaiseResult;
  const recA = rA.record as unknown as Rec;
  // B's independently derived line: same key + id, newer ts, delivered.
  L.push({ ...recA, ts: (recA.ts as number) + 10, deliveredCount: 1 });
  // A's refusal correction, bound to A's line (the older ts).
  L.push({ schema: ESCALATION_SCHEMA, kind: "deliveryRefused", ref: recA.escalationId, refId: recA.id, refTs: recA.ts, ts: (recA.ts as number) + 20 });
  const st = await (await logChannel(L)).pendingStatus();
  assert.equal((st.open[0] as { deliveredCount?: number })?.deliveredCount, 1, "B's earned delivery survives A's unattributable refund (fail closed)");
});

test("P18-C1-A4: a mismatched refId is skipped; a half-bound (refTs without refId) line is unreadable", async () => {
  const L: unknown[] = [];
  const ch = await logChannel(L);
  const r1 = (await ch.raise(valid() as never)) as RaiseResult;
  const rec = r1.record as unknown as Rec;
  L.push({ schema: ESCALATION_SCHEMA, kind: "deliveryRefused", ref: rec.escalationId, refId: "esc-0000000000000000#0", refTs: rec.ts, ts: 9 });
  const st = await (await logChannel(L)).pendingStatus();
  assert.equal((st.open[0] as { deliveredCount?: number })?.deliveredCount, 1, "a refund naming a different line is dropped");

  const L2: unknown[] = [];
  const ch2 = await logChannel(L2);
  const r2 = (await ch2.raise(valid() as never)) as RaiseResult;
  const rec2 = r2.record as unknown as Rec;
  L2.push({ schema: ESCALATION_SCHEMA, kind: "deliveryRefused", ref: rec2.escalationId, refTs: rec2.ts, ts: 9 }); // half-bound
  const st2 = await (await logChannel(L2)).pendingStatus();
  assert.equal(st2.complete, false, "a half-bound correction fails CLOSED: unreadable, never silently applied");
});

test("P18-C1-A4: a correction with NO refId keeps the legacy key-wise refund (backward compatible)", async () => {
  const L: unknown[] = [];
  const ch = await logChannel(L);
  const r1 = (await ch.raise(valid() as never)) as RaiseResult;
  L.push({ schema: ESCALATION_SCHEMA, kind: "deliveryRefused", ref: r1.record.escalationId, ts: 2 }); // legacy shape
  const st = await (await logChannel(L)).pendingStatus();
  assert.equal((st.open[0] as { deliveredCount?: number })?.deliveredCount, 0, "legacy corrections still refund");
});

// ─── A4 (second half): one supervisor per episode — the lease ──────────────

async function exitZeroWorker(root: string, extra = ""): Promise<string> {
  const p = join(root, "worker.sh");
  await writeFile(p, `#!/bin/sh\n${extra}exit 0\n`);
  await chmod(p, 0o755);
  return p;
}

test("P18-C1-A4 lease: a live same-process activation of one episode is REFUSED before any mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p18-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = graphA({ policy: { baseCommit: "abc", gate: { cmd: "true" } } });
  await createEpisodeLayout(root, graph.episodeId, graph);
  const worker = await exitZeroWorker(root, "sleep 1\n");
  const opts = { episodesRoot: root, graph, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} };
  const first = runHostEpisode(opts);
  await new Promise((r) => setTimeout(r, 100)); // let the first claim the lease
  await assert.rejects(runHostEpisode(opts), /already activated in this process/);
  // The graph is untouched: still the ORIGINAL desired scope.
  const gRaw = JSON.parse(await readFile(join(root, graph.episodeId, "graph.json"), "utf8")) as EpisodeGraph;
  assert.equal(gRaw.goal, "A: accepted scope");
  await first;
  // After the first finishes, the lease file is released.
  const { unlink } = await import("node:fs/promises");
  const lease = join(root, graph.episodeId, "host.lease");
  await assert.rejects(readFile(lease, "utf8"), /ENOENT/, "the lease is released on completion");
  void unlink;
});

test("P18-C1-A4 lease: a stale lease (dead holder pid) is taken over WITH disclosure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p18-lease-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = graphA({ policy: { baseCommit: "abc", gate: { cmd: "true" } } });
  const dir = await createEpisodeLayout(root, graph.episodeId, graph);
  // A pid that cannot exist (beyond every OS pid_max) — the dead holder.
  await writeFile(join(dir, "host.lease"), JSON.stringify({ pid: 4194303, episodeId: graph.episodeId, claimedAt: 1 }) + "\n");
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({ episodesRoot: root, graph, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(["accepted-finish", "max-iterations"].includes(res.result.stopped), `the episode ran to a normal stop (${res.result.stopped})`);
  assert.ok(lines.some((l) => /stale lease .* taking over/.test(l)), "the takeover is disclosed");
});

// ─── A5: nothing between parse and the loop may escape as a throw ──────────

test("P18-C1-A5: a destroyed cwd makes the Telegram wiring FAIL with exit 1 — never a rejection", async (t) => {
  // The audit repro (setup-throw.mjs): a valid parse + --telegram with the
  // process cwd removed. Before the fix, process.cwd() inside the wiring
  // threw OUTSIDE the never-throw boundary and REJECTED activate().
  const gone = await mkdtemp(join(tmpdir(), "p18a5-"));
  const real = process.cwd();
  process.chdir(gone);
  await rm(gone, { recursive: true, force: true });
  try {
    const lines: string[] = [];
    const code = await activate(["--graph", "/nonexistent/g.json", "--task", "t1", "--telegram"], (l) => lines.push(l));
    assert.equal(code, 1, "the documented setup-failure exit — inside the contract");
    assert.ok(lines.some((l) => /setup failed/.test(l)), "and disclosed, never swallowed");
  } finally {
    process.chdir(real);
  }
});

// ─── A6: a throwing descriptor trap is a structural port defect ────────────

test("P18-C1-A6: a port result whose 'channel' descriptor TRAPS is a failed delivery, not a dispatch", async () => {
  const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => trap as never, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(res.delivered, false, "a port that cannot produce a safe result attests NOTHING");
  assert.equal(res.delivery?.ok, false, "disclosed as a failed delivery");
  assert.ok(res.disclosed?.includes("port-defect:channel-descriptor-trap"), "the defect is named");
});

test("P18-C1-A6: an ORDINARY accessor keeps the documented name-only drop (the act stands)", async () => {
  const acc = { get channel(): string { return "telegram"; } };
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => acc, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(res.delivered, true, "the send happened — an accessor drops the NAME, not the ACT");
});
