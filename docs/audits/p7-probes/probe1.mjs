import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const B = "/Users/xilcilus/projects/Tre.-coding-agent/dist/src";
const { AttemptRunner } = await import(B + "/runner/attempt.js");
const { createEpisodeLayout, episodeDir, readEpisodeState, GRAPH_SCHEMA_ID } = await import(B + "/episode/journal.js");

const graph = { schema: GRAPH_SCHEMA_ID, episodeId: "ep-p7", goal: "g", tasks: [{ id: "t1", persona: "implementer", promptRef: "p", dependsOn: [] }] };
const root = await mkdtemp(join(tmpdir(), "p7a-"));
const dir = episodeDir(root, "ep-p7");
await createEpisodeLayout(root, "ep-p7", graph);
const session = join(dir, "sessions", "t1.jsonl");
await writeFile(session, "");
const spawner = { kind: "sleep", spawn: () => ({ command: "/bin/sleep", args: ["20"] }) };
const task = { episodeId: "ep-p7", taskId: "t1", session };

let r = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner });
let h = await r.run(task); await r.stop(h);
h = await r.run(task); await r.stop(h);
console.log("hint row:", JSON.stringify((await readEpisodeState(join(dir,"state.json"))).tasks.t1));
r.close(true);

r = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner, probes: { pidAlive: async () => ({ running: false, sameUid: false }) } });
try {
  const h3 = await r.run(task);
  console.log("AFTER RESTART: spawned", h3.attemptId);
  await r.stop(h3);
} catch (e) { console.log("AFTER RESTART: REFUSED", e.code, "\n   ", e.message.split("\n")[0]); }
const rec = await r.reconcile(task);
console.log("reconcile:", rec.decision.action, JSON.stringify(rec.decision.reasons, null, 1));
r.close(true);
