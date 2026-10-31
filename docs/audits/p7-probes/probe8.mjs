import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const B = "/Users/xilcilus/projects/Tre.-coding-agent/dist/src";
const { AttemptRunner } = await import(B + "/runner/attempt.js");
const { createEpisodeLayout, episodeDir, GRAPH_SCHEMA_ID } = await import(B + "/episode/journal.js");
const graph = { schema: GRAPH_SCHEMA_ID, episodeId: "ep", goal: "g", tasks: [{ id: "t1", persona: "i", promptRef: "p", dependsOn: [] }] };
const root = await mkdtemp(join(tmpdir(), "p7g-"));
const dir = episodeDir(root, "ep");
await createEpisodeLayout(root, "ep", graph);
const session = join(dir, "sessions", "t1.jsonl"); await writeFile(session, "");
// wrapper spawns a TERM-ignoring grandchild, then dies to SIGTERM itself
const spawner = { kind: "stubborn-grandchild", spawn: () => ({ command: "/bin/sh", args: ["-c", "sh -c 'trap \"\" TERM; sleep 30' & wait"] }) };
const r = await AttemptRunner.open({ root, episodeId: "ep", spawner, stopTimeoutMs: 300 });
const h = await r.run({ episodeId: "ep", taskId: "t1", session });
await new Promise(res => setTimeout(res, 500));
const grp = (pid) => { try { return execFileSync("pgrep", ["-g", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };
console.log("group before:", grp(h.pid));
const stop = await r.stop(h);
console.log("stop():", JSON.stringify(stop));
await new Promise(res => setTimeout(res, 400));
const left = grp(h.pid);
console.log("group after :", left, left.length ? "!! LEAKED — runner reported stopped:true" : "(group empty)");
if (left.length) { for (const p of left) { try { process.kill(Number(p), "SIGKILL"); } catch {} } }
r.close(true);
// and: does the fence let a new attempt start while the leak is still alive?
