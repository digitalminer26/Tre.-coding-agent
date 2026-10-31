import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const B = "/Users/xilcilus/projects/Tre.-coding-agent/dist/src";
const { AttemptRunner } = await import(B + "/runner/attempt.js");
const { createEpisodeLayout, episodeDir, GRAPH_SCHEMA_ID } = await import(B + "/episode/journal.js");
const graph = { schema: GRAPH_SCHEMA_ID, episodeId: "ep", goal: "g", tasks: [{ id: "t1", persona: "i", promptRef: "p", dependsOn: [] }] };
const root = await mkdtemp(join(tmpdir(), "p7i-"));
await createEpisodeLayout(root, "ep", graph);
const session = join(episodeDir(root, "ep"), "sessions", "t1.jsonl"); await writeFile(session, "");
const spawner = { kind: "sleep", spawn: () => ({ command: "/bin/sleep", args: ["25"] }) };
const r = await AttemptRunner.open({ root, episodeId: "ep", spawner });
const task = { episodeId: "ep", taskId: "t1", session };
// concurrent: both calls pass the (async) fence before either registers its child
const res = await Promise.allSettled([r.run(task), r.run(task)]);
for (const [i, x] of res.entries()) console.log(i === 0 ? "run#1:" : "run#2:", x.status === "fulfilled" ? `SPAWNED ${x.value.attemptId} pid ${x.value.pid}` : `refused ${x.reason.code}`);
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } };
const pids = res.map(x => x.status === "fulfilled" ? x.value.pid : null).filter(Boolean);
console.log("both alive?", pids.map(alive), "| tracked children:", r.hasLiveChildren);
try { await r.stop({ session }); } catch (e) { console.log("stop:", e.code); }
console.log("after single stop():", pids.map(p => `${p}->${alive(p)}`), "<- untracked worker still running");
r.close(true);
for (const p of pids) { try { process.kill(p, "SIGKILL") } catch {} }
