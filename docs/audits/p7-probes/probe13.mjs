import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const B = "/Users/xilcilus/projects/Tre.-coding-agent/dist/src";
const { AttemptRunner } = await import(B + "/runner/attempt.js");
const { createEpisodeLayout, episodeDir, GRAPH_SCHEMA_ID } = await import(B + "/episode/journal.js");
const graph = { schema: GRAPH_SCHEMA_ID, episodeId: "ep", goal: "g", tasks: [{ id: "t1", persona: "i", promptRef: "p", dependsOn: [] }] };
const root = await mkdtemp(join(tmpdir(), "p7l-"));
await createEpisodeLayout(root, "ep", graph);
const session = join(episodeDir(root, "ep"), "sessions", "t1.jsonl"); await writeFile(session, "");
const spawner = { kind: "sleep", spawn: () => ({ command: "/bin/sleep", args: ["20"] }) };
const task = { episodeId: "ep", taskId: "t1", session };
// ONE process, ONE runner, NO restart. Just retry a task a few times.
const r = await AttemptRunner.open({ root, episodeId: "ep", spawner });
for (let i = 1; i <= 4; i++) {
  try { const h = await r.run(task); console.log(`attempt ${i}: spawned ${h.attemptId}`); await r.stop(h); }
  catch (e) { console.log(`attempt ${i}: REFUSED ${e.code} — ${e.message.split("—")[0].trim()}`); break; }
}
r.close(true);
