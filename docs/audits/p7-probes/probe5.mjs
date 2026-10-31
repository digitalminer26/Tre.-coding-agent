import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const B = "/Users/xilcilus/projects/Tre.-coding-agent/dist/src";
const { AttemptRunner } = await import(B + "/runner/attempt.js");
const { createEpisodeLayout, episodeDir, DecisionJournal, newDecisionId, writeEpisodeState, STATE_SCHEMA_ID, GRAPH_SCHEMA_ID } = await import(B + "/episode/journal.js");
const graph = { schema: GRAPH_SCHEMA_ID, episodeId: "ep", goal: "g", tasks: [{ id: "t1", persona: "i", promptRef: "p", dependsOn: [] }, { id: "t2", persona: "i", promptRef: "p", dependsOn: [] }] };
const root = await mkdtemp(join(tmpdir(), "p7e-"));
const dir = episodeDir(root, "ep");
await createEpisodeLayout(root, "ep", graph);
const session = join(dir, "sessions", "shared.jsonl"); await writeFile(session, "");

// t2 crashed BETWEEN intent and resolve — on a session path t1 now wants
const j = await DecisionJournal.forEpisode(dir);
await j.append({ schema: "tre-supervisor/1", id: newDecisionId(), ts: Date.now(), episodeId: "ep", taskId: "t2",
  kind: "attempt", attemptId: "t2-a1", sessionPath: session, spawnOutcome: null });
await writeEpisodeState(join(dir, "state.json"), { schema: STATE_SCHEMA_ID, episodeId: "ep", tasks: { t2: { status: "running", attemptId: "t2-a1", session, pid: 999996 } } });

const spawner = { kind: "sleep", spawn: () => ({ command: "/bin/sleep", args: ["20"] }) };
const r = await AttemptRunner.open({ root, episodeId: "ep", spawner, probes: { pidAlive: async () => ({ running: false, sameUid: false }) } });

// t1 wants the SAME session file t2's unresolved intent claims
const t1 = { episodeId: "ep", taskId: "t1", session };
try {
  const h = await r.run(t1);
  console.log("!! t1 SPAWNED", h.attemptId, "on a session path claimed by unresolved t2-a1");
  await r.stop(h);
} catch (e) { console.log("t1 refused:", e.code, "|", e.message.split("—")[0].trim()); }

// and a t2 attempt that spawned ok but whose hint row is missing
await j.append({ schema: "tre-supervisor/1", id: newDecisionId(), ts: Date.now(), episodeId: "ep", taskId: "t2",
  kind: "attempt", attemptId: "t2-a2", sessionPath: session, spawnOutcome: "ok" });
await writeEpisodeState(join(dir, "state.json"), { schema: STATE_SCHEMA_ID, episodeId: "ep", tasks: {} });
try {
  const h = await r.run(t1);
  console.log("!! t1 SPAWNED", h.attemptId, "alongside spawned-ok t2-a2 (foreign task, same session)");
  await r.stop(h);
} catch (e) { console.log("t1 refused (spawned-ok foreign):", e.code, "|", e.message.split("—")[0].trim()); }
r.close(true);
