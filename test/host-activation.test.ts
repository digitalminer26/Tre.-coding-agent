/**
 * P17 — the activation entry point (src/host/activate.ts, `tre.-episode`).
 *
 * Two kinds of tests:
 *  1. Thinness guards: the file's import set is PINNED (docs/18 §0.1 —
 *     the layer above the host reaches nothing the host did not hand
 *     it), and the exit-code map covers the REAL StopReason enum 1:1
 *     (drift guard against src/supervisor/compose.ts).
 *  2. Behavior: usage errors exit 2, --help exits 0, a setup failure
 *     exits 1, and a real episode over the REAL modules exits 0 —
 *     the same green path host-supervise.test.ts pins at the API level,
 *     run through the CLI contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseActivateArgs, exitCodeForStop, activate } from "../src/host/activate.js";
import { STOP_REASONS } from "../src/supervisor/compose.js";
import { createEpisodeLayout, type EpisodeGraph } from "../src/episode/journal.js";

// ─── Thinness guard: the pinned import set ─────────────────────────────────

const MODULE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*(?:\[\s*\])?\s*(?:\{[^}]*\}|\*\s*)?\s*from\s*)["']([^"']+)["']/g;

test("P17 thinness guard: src/host/activate.ts imports ONLY the pinned set", async () => {
  const content = await readFile("src/host/activate.ts", "utf-8");
  const specs = [...content.matchAll(MODULE_SPEC_RE)].map((m) => m[1]!).sort();
  const allowed = [
    "../telegram/bridge.js", // the bridge factory (docs/19 §6 host decision)
    "../telegram/escalation.js", // the delivery ACT consumer
    "./supervise.js", // the sanctioned host wiring (docs/18 §0.1)
    "node:fs",
    "node:url",
  ].sort();
  assert.deepEqual(specs, allowed, "the activation slice may import ONLY node: builtins + the host + the two Telegram modules");
});

test("P17 guard: the activation slice never mentions process authority beyond stderr/stdout/exit/cwd/argv", async () => {
  const content = await readFile("src/host/activate.ts", "utf-8");
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // No direct filesystem, child-process, or network authority: this slice
  // touches no file and spawns no process — the host owns all of that.
  for (const forbidden of ["spawn(", "appendFile", "readFile", "writeFile(", "fetch(", "child_process", "node:child_process", "process.env"]) {
    assert.ok(!stripped.includes(forbidden), `activate.ts must not contain ${forbidden} — the host owns IO authority`);
  }
});

test("P17 guard: package.json exposes the tre.-episode bin at the built activation slice", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf-8")) as { bin?: Record<string, string>; scripts?: Record<string, string> };
  assert.equal(pkg.bin?.["tre.-episode"], "dist/src/host/activate.js", "bin entry");
  assert.match(pkg.scripts?.build ?? "", /chmod \+x [^&]*dist\/src\/host\/activate\.js/, "build makes the entry executable");
});

// ─── Exit map: 1:1 against the REAL StopReason enum ────────────────────────

test("P17 exit map: every REAL StopReason maps, the map is closed, no stop rides out as 0 unearned", () => {
  const zero = STOP_REASONS.filter((s) => exitCodeForStop(s) === 0);
  assert.deepEqual([...zero].sort(), ["accepted-finish", "completed"], "only the two end-states exit 0");
  assert.equal(exitCodeForStop("loop-error"), 3);
  assert.equal(exitCodeForStop("initial-run-denied"), 4);
  const other = STOP_REASONS.filter((s) => exitCodeForStop(s) === 5);
  assert.deepEqual(
    [...other].sort(),
    ["escalation-exhausted", "finish-unjudged", "halt", "hold", "max-iterations", "no-initial-signal", "parked", "shutdown"].sort(),
    "every bounded/steered non-completion exits 5 (never silently 0)",
  );
  // Closedness: NO mapped value escapes {0,3,4,5}; an unknown string is 5.
  for (const s of STOP_REASONS) {
    assert.ok([0, 3, 4, 5].includes(exitCodeForStop(s)), `${s} maps into the closed set`);
  }
  assert.equal(exitCodeForStop("bogus-stop-value"), 5, "an unmapped stop fails closed to 5");
});

// ─── Arg parsing ───────────────────────────────────────────────────────────

test("parse: the full happy path yields every field", () => {
  const p = parseActivateArgs([
    "--graph", "/x/graph.jsonx", "--task", "t1", "--granted-by", "me",
    "--episodes-root", "/eps", "--worktree", "/wt", "--worker", "./w.sh",
    "--max-iterations", "3", "--telegram",
  ]);
  assert.deepEqual(p, {
    graphPath: "/x/graph.jsonx", taskId: "t1", grantedBy: "me",
    episodesRoot: "/eps", worktreePath: "/wt", workerCommand: "./w.sh",
    maxIterations: 3, telegram: true,
  });
});

test("parse: defaults are minimal — granted-by defaults, telegram defaults OFF", () => {
  const p = parseActivateArgs(["--graph", "g", "--task", "t"]);
  assert.ok(!("help" in p) && !("error" in p));
  assert.equal(p.grantedBy, "cli-activate");
  assert.equal(p.telegram, false);
  assert.ok(!("episodesRoot" in p), "absent options stay ABSENT keys (the host applies its own defaults)");
});

test("parse: usage errors — missing required, unknown flag, dangling value, bad count", () => {
  const errOf = (argv: string[]): string => {
    const p = parseActivateArgs(argv);
    assert.ok("error" in p, `expected a usage error for ${JSON.stringify(argv)}`);
    return p.error;
  };
  assert.equal(errOf(["--task", "t"]), "--graph is required");
  assert.equal(errOf(["--graph", "g"]), "--task is required");
  assert.equal(errOf([]), "--graph is required");
  assert.equal(errOf(["--bogus"]), "unknown argument: --bogus");
  assert.equal(errOf(["--graph"]), "--graph requires a value");
  assert.equal(errOf(["--graph", "--task", "t"]), "--graph requires a value");
  assert.equal(errOf(["--max-iterations", "0"]), "--max-iterations must be a positive integer");
  assert.equal(errOf(["--max-iterations", "1.5"]), "--max-iterations must be a positive integer");
  assert.equal(errOf(["--max-iterations", "-2"]), "--max-iterations must be a positive integer");
  assert.equal(errOf(["--max-iterations", "abc"]), "--max-iterations must be a positive integer");
});

test("parse: --help is a request, not an error", () => {
  assert.deepEqual(parseActivateArgs(["--help"]), { help: true });
  assert.deepEqual(parseActivateArgs(["-h"]), { help: true });
});

// ─── activate(): process-level contract ────────────────────────────────────

test("activate: --help prints usage and exits 0 (through the log sink)", async () => {
  const lines: string[] = [];
  assert.equal(await activate(["--help"], (l) => lines.push(l)), 0);
  assert.match(lines[0] ?? "", /^usage: tre\.-episode --graph <file> --task <id>/);
});

test("activate: a usage error exits 2 and prints the reason + usage (stderr, no episode touched)", async () => {
  const lines: string[] = [];
  assert.equal(await activate(["--task", "t"], (l) => lines.push(l)), 2);
  assert.match(lines[0] ?? "", /--graph is required/);
  assert.ok(lines.some((l) => l.includes("usage: tre.-episode")), "usage follows the reason");
});

async function freshEpisode(t: { diagnostic: (m: string) => void; after: (fn: () => void) => void }): Promise<{ root: string; graphPath: string; graph: EpisodeGraph; worker: string; wt: string }> {
  const root = await mkdtemp(join(tmpdir(), "activate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph: EpisodeGraph = {
    schema: "tre-graph/1",
    episodeId: "ep-activate",
    goal: "prove the CLI entry",
    tasks: [{
      id: "t1",
      persona: "worker",
      promptRef: "prompts/t1.md",
      dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
  };
  const dir = await createEpisodeLayout(root, graph.episodeId, graph);
  const worker = join(root, "worker.sh");
  await writeFile(worker, "#!/bin/sh\nexit 0\n");
  await chmod(worker, 0o755);
  // R3-F2 (audit round-3): acceptance evidence must bind to an
  // OBSERVABLE tree — the unmeasured no-worktree fallback identity now
  // refuses comparison against everything (including itself), so the
  // happy-path activation carries a real git worktree.
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: wt });
  await writeFile(join(wt, "f.txt"), "base\n");
  execFileSync("git", ["add", "f.txt"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: wt });
  return { root, graphPath: join(dir, "graph.json"), graph, worker, wt };
}

test("activate e2e: a real exit-0 episode over the REAL modules exits 0 with the stop summary", async (t) => {
  const { root, graphPath, worker, wt } = await freshEpisode(t);
  const lines: string[] = [];
  const code = await activate(
    ["--graph", graphPath, "--task", "t1", "--episodes-root", root, "--worktree", wt, "--worker", worker, "--max-iterations", "3"],
    (l) => lines.push(l),
  );
  assert.equal(code, 0, `exit code (log: ${lines.join(" | ")})`);
  assert.ok(lines.some((l) => /stopped: accepted-finish/.test(l)), "the host reports the real stop on the log");
});

test("activate: a bad graph file fails CLOSED — honest exit 1, no uncaught throw", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "activate-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graphPath = join(root, "graph.json");
  await writeFile(graphPath, "{ not json");
  const lines: string[] = [];
  assert.equal(await activate(["--graph", graphPath, "--task", "t1", "--episodes-root", root], (l) => lines.push(l)), 1);
  assert.ok(lines.some((l) => /setup failed/.test(l)), "the failure is disclosed, not swallowed");
});

test("activate: a task absent from the graph is a setup failure (exit 1)", async (t) => {
  const { root, graphPath } = await freshEpisode(t);
  assert.equal(await activate(["--graph", graphPath, "--task", "nope", "--episodes-root", root], () => {}), 1);
});

test("activate: --telegram with no machine bridge still runs, and the MISSING delivery is disclosed — never claimed", async (t) => {
  const { root, graphPath, worker, wt } = await freshEpisode(t);
  const lines: string[] = [];
  // HOME points at the tmp dir: no machine-level bot config exists, so the
  // bridge comes up disabled — the documented refusal path (docs/19 §5).
  const realHome = process.env["HOME"];
  process.env["HOME"] = root;
  try {
    const code = await activate(
      ["--graph", graphPath, "--task", "t1", "--episodes-root", root, "--worktree", wt, "--worker", worker, "--telegram"],
      (l) => lines.push(l),
    );
    assert.equal(code, 0);
    assert.ok(lines.some((l) => /bridge disabled/.test(l)), "the disabled bridge is disclosed at wiring time");
    assert.ok(!lines.some((l) => /escalate dispatched/.test(l)), "no delivery is claimed");
  } finally {
    process.env["HOME"] = realHome;
  }
});
