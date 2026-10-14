// SPIKE — `sandbox:true` + `npx` (MCP tier 1, docs/10-mcp-scope.md §8.4).
//
// Empirical verification of the doc's SPIKE, run 2026-10-14 in NO-SANDBOX mode
// (the D12 nested-sandbox limit that blocked the earlier attempt is absent:
// TRE_SANDBOX unset, so `sandbox-exec` can apply a fresh policy).
//
// It uses the REAL `generateBashSandboxPolicy` from dist + the REAL spawn shape
// (`sandbox-exec -f <policy> /bin/bash -c <cmd>`), then runs a battery of
// probes and prints a machine-readable summary. The conclusion:
//
//   VERDICT: the doc's CONCLUSION holds (a sandboxed npx server fails at
//   spawn), but its REASONING is wrong. It is NOT "npx cannot exec the node
//   runtime" — the node BINARY execs fine under the policy. npx fails because
//   it is a SHELL SCRIPT (`#!/usr/bin/env node`): the kernel's shebang handler
//   must file-READ the script to find the interpreter, and the policy denies
//   file-read* on /Users. A SECOND, independent failure then blocks the
//   npx-installed server code itself (node cannot file-read JS under ~/.npm).
//
//   The constructive alternative the ruling recommends DOES work: a server
//   whose runtime + code live in an ALLOWED top (the workspace) runs fine
//   under sandbox:true, and outbound network stays open.
//
// Run:  node test/spike-sandbox-npx.mjs <workspace> [extraRoots...]
// Exit: 0 if the battery matches the expected verdict, 1 otherwise.

import { generateBashSandboxPolicy } from "../dist/src/tools/sandbox.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = process.argv[2] || process.cwd();
const extraRoots = process.argv.slice(3);

const policy = generateBashSandboxPolicy(workspace, extraRoots);
const dir = await mkdtemp(path.join(tmpdir(), "spike-sb-"));
const policyPath = path.join(dir, `policy-${randomBytes(8).toString("hex")}.sb`);
await writeFile(policyPath, policy, { mode: 0o600 });

const nodeBin = process.execPath; // the running node (nvm on this machine)
const npxBin = path.join(path.dirname(nodeBin), "npx");
const home = process.env.HOME;
const npmCache = path.join(home, ".npm");

function sandboxRun(command, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("sandbox-exec", ["-f", policyPath, "/bin/bash", "-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, TRE_SANDBOX: "1", ...env },
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// scratch JS files in three locations
const jsWs = path.join(workspace, "test", "_spike_probe_ws.js");
const jsNpm = path.join(npmCache, "_spike_probe_npm.js");
const jsNvm = path.join(path.dirname(nodeBin), "_spike_probe_nvm.js");
const jsSrc = "console.log('JS_RAN', process.argv[2]||'');";
for (const f of [jsWs, jsNpm, jsNvm]) await writeFile(f, jsSrc);

const results = [];
async function probe(name, cmd, expect) {
  const r = await sandboxRun(cmd);
  const pass = expect(r);
  results.push({ name, pass, code: r.code, out: r.out.split("\n")[0] || "", err: r.err.split("\n")[0] || "" });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}\n       rc=${r.code}  out=${r.out.split("\n")[0] || "-"}${r.err ? "  err=" + r.err.split("\n")[0] : ""}`);
  return r;
}

console.log("=== SPIKE: sandbox:true + npx (nvm node, ~/.npm cache) ===");
console.log("workspace:", workspace);
console.log("node:", nodeBin);
console.log("npx:", npxBin);
console.log("npm cache:", npmCache);
console.log("");

// P1 — the node BINARY execs under the policy (the doc claims it cannot).
await probe("P1 node binary execs under policy (doc says it can't)",
  `"${nodeBin}" --version`, (r) => r.code === 0 && /v\d/.test(r.out));

// P2 — file-READ of the node binary is denied.
await probe("P2 file-READ of node binary denied",
  `head -c 4 "${nodeBin}" 2>&1; echo rc=$?`, (r) => /Operation not permitted/.test(r.out + r.err));

// P3 — file-READ of the npx script is denied.
await probe("P3 file-READ of npx script denied",
  `head -1 "${npxBin}" 2>&1; echo rc=$?`, (r) => /Operation not permitted/.test(r.out + r.err));

// P4 — EXEC of the npx script fails (kernel shebang needs the read above).
await probe("P4 exec npx script fails (kernel shebang)",
  `"${npxBin}" --version 2>&1; echo rc=$?`, (r) => /Operation not permitted/.test(r.out + r.err));

// P5 — node running JS from the WORKSPACE (allowed top) works.
await probe("P5 node runs JS in workspace (allowed top)",
  `"${nodeBin}" "${jsWs}" ok`, (r) => r.code === 0 && /JS_RAN/.test(r.out));

// P6 — node running JS from ~/.npm (denied top) fails → the npx-installed
//      server code cannot be loaded.
await probe("P6 node runs JS in ~/.npm (denied top) fails",
  `"${nodeBin}" "${jsNpm}" ok 2>&1; echo rc=$?`, (r) => !/JS_RAN/.test(r.out));

// P7 — node running JS from ~/.nvm (denied top) fails.
await probe("P7 node runs JS in ~/.nvm (denied top) fails",
  `"${nodeBin}" "${jsNvm}" ok 2>&1; echo rc=$?`, (r) => !/JS_RAN/.test(r.out));

// P8 — node reading the npx script AS JS (bypassing the kernel shebang) fails.
// (Assert the loader error, not the absence of "npx" — the stack trace
// contains the script's path, so an absence check would misfire.)
await probe("P8 node reads npx script as JS (bypass shebang) fails",
  `"${nodeBin}" "${npxBin}" --version 2>&1; echo rc=$?`,
  (r) => /cjs\/loader|Cannot find module|ENOENT|EACCES|Operation not permitted/.test(r.out + r.err));

// P9 — file-READ of the npm cache dir is denied.
await probe("P9 file-READ of ~/.npm dir denied",
  `ls "${npmCache}" >/dev/null 2>&1 && echo READ_OK || echo READ_FAIL`, (r) => /READ_FAIL/.test(r.out));

// P10 — file-WRITE to the npm cache dir is denied.
await probe("P10 file-WRITE to ~/.npm dir denied",
  `touch "${npmCache}/.spike-probe" 2>/dev/null && echo WRITE_OK || echo WRITE_FAIL; rm -f "${npmCache}/.spike-probe" 2>/dev/null`, (r) => /WRITE_FAIL/.test(r.out));

// P11 — file-WRITE to /tmp (=/private/tmp, denied) fails.
await probe("P11 file-WRITE to /tmp denied",
  `echo x > /tmp/.spike-tmp 2>/dev/null && echo TMPC_WRITE_OK || echo TMPC_WRITE_FAIL; rm -f /tmp/.spike-tmp 2>/dev/null`, (r) => /TMPC_WRITE_FAIL/.test(r.out));

// P12 — outbound network is OPEN under the policy (the doc's network-open claim).
await probe("P12 outbound network open (dns.lookup)",
  `"${nodeBin}" -e 'const d=require("dns");d.lookup("example.com",(e,a)=>{console.log(e?"NET_FAIL "+e.code:"NET_OK "+a);process.exit(0)});setTimeout(()=>{console.log("NET_TIMEOUT");process.exit(0)},4000)' 2>&1`,
  (r) => /NET_OK/.test(r.out));

// control — the SAME npx invocation UNSANDBOXED works.
{
  const child = spawn("/bin/bash", ["-c", `"${npxBin}" --version`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
  });
  let out = "";
  await new Promise((res) => { child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d)); child.on("close", res); });
  const pass = child.exitCode === 0 && /\d+\.\d+/.test(out);
  results.push({ name: "P13 control: unsandboxed npx works", pass, code: child.exitCode, out: out.trim().split("\n")[0] || "", err: "" });
  console.log(`[${pass ? "PASS" : "FAIL"}] P13 control: unsandboxed npx works\n       rc=${child.exitCode}  out=${out.trim().split("\n")[0] || "-"}`);
}

// cleanup
await Promise.all([jsWs, jsNpm, jsNvm].map((f) => rm(f).catch(() => {})));
await rm(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log("\n=== SUMMARY ===");
console.log(`${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name} (rc=${f.code} out=${f.out})`);
}
console.log("\nVERDICT:");
console.log("  A sandboxed `npx` server FAILS at spawn — but NOT because the node");
console.log("  runtime can't be exec'd (P1: it can). It fails because:");
console.log("   (a) npx is a shell script; the kernel shebang handler can't file-READ");
console.log("       it under the /Users deny (P3/P4), and");
console.log("   (b) node can't file-READ the npx-installed server code under ~/.npm");
console.log("       (P6/P8) — a second, independent failure.");
console.log("  The constructive alternative WORKS: runtime+code in an allowed top");
console.log("  (workspace) runs fine (P5), and outbound network stays open (P12).");
process.exit(failed.length ? 1 : 0);
