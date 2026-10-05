/**
 * D19 — models.json lookup: --models wins; otherwise use ~/.tre/tre/models.json
 * and never discover generic project-local models.json files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildModelsSetupGuide,
  findModelsFile,
  hasEndpoint,
  readActiveModelLenient,
} from "../src/config/models.js";

test("findModelsFile: explicit path wins even if it does not exist", () => {
  // The caller reports the missing file; the lookup must not second-guess it.
  assert.equal(findModelsFile("/nonexistent/nope.json", "/tmp", "/nonhome"), "/nonexistent/nope.json");
});

test("findModelsFile: ignores cwd and ancestors; uses ~/.tre/tre/models.json", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(dir, "models.json"), "{}");
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".tre", "tre"), { recursive: true });
  const homeFile = path.join(home, ".tre", "tre", "models.json");
  fs.writeFileSync(homeFile, "{}");
  assert.equal(findModelsFile(undefined, nested, home), homeFile);
});

test("findModelsFile: null when neither walk nor home has one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Even a cwd models.json is ignored; no configured ~/.tre/tre/models.json.
  fs.writeFileSync(path.join(dir, "models.json"), "{}");
  assert.equal(findModelsFile(undefined, dir, path.join(dir, "nohome")), null);
});

// ─────────────────────── startup config guide (deployability) ───────────────────────

/** Pull the pretty-printed template JSON out of a guide (between the first
 *  `{` after "Template" and the `}` that precedes "Then re-run tre."). */
function templateOf(g: string): Record<string, unknown> {
  const start = g.indexOf("{", g.indexOf("Template"));
  const end = g.lastIndexOf("}", g.indexOf("Then re-run tre."));
  return JSON.parse(g.slice(start, end + 1)) as Record<string, unknown>;
}

test("hasEndpoint: baseUrl present → true; blank/absent → false", () => {
  assert.equal(hasEndpoint({ baseUrl: "http://172.30.70.11:8080/v1" }), true);
  assert.equal(hasEndpoint({ baseUrl: "" }), false);
  assert.equal(hasEndpoint({ baseUrl: "   " }), false);
  assert.equal(hasEndpoint({}), false);
});

test("buildModelsSetupGuide: empty model → every REQUIRED field NEEDED, optional unset", () => {
  const g = buildModelsSetupGuide({}, "~/.tre/tre/models.json");
  assert.match(g, /none is configured yet/);
  // Every required field is listed as NEEDED with a placeholder.
  for (const f of ["id", "provider", "baseUrl", "api", "contextWindow", "maxTokens"]) {
    assert.match(g, new RegExp(`${f} — NEEDED`), `required field ${f} must be NEEDED`);
  }
  // Optional fields are listed but marked unset (never block start).
  assert.match(g, /apiKey — \(unset\)/);
  assert.match(g, /temperature — \(unset\)/);
  assert.match(g, /compat — \(unset\)/);
  // The template is valid JSON with the placeholder baseUrl.
  const parsed = templateOf(g);
  const m0 = (parsed.models as Array<Record<string, unknown>>)[0]!;
  assert.equal(m0.baseUrl, "http://<host>:<port>/v1");
});

test("buildModelsSetupGuide: partial model → populated fields shown, blank ones NEEDED", () => {
  const g = buildModelsSetupGuide(
    { id: "Qwen3.8-27B-UD-Q4_K_M", provider: "vks-llama", contextWindow: 131072, maxTokens: 32768 },
    "/path/to/models.json",
  );
  assert.match(g, /id — populated: "Qwen3.8-27B-UD-Q4_K_M"/);
  assert.match(g, /provider — populated: "vks-llama"/);
  assert.match(g, /contextWindow — populated: 131072/);
  assert.match(g, /maxTokens — populated: 32768/);
  // baseUrl was not populated → NEEDED.
  assert.match(g, /baseUrl — NEEDED/);
  // The template carries the populated values and a placeholder for baseUrl.
  const parsed = templateOf(g);
  const m = (parsed.models as Array<Record<string, unknown>>)[0]!;
  assert.equal(m.id, "Qwen3.8-27B-UD-Q4_K_M");
  assert.equal(m.baseUrl, "http://<host>:<port>/v1");
  assert.equal(parsed.default, "Qwen3.8-27B-UD-Q4_K_M");
});

test("buildModelsSetupGuide: populated optional fields are shown, not (unset)", () => {
  const g = buildModelsSetupGuide(
    { id: "m", provider: "p", baseUrl: "http://x/v1", api: "openai-completions", contextWindow: 1, maxTokens: 1, temperature: 0.6 },
    "f.json",
  );
  assert.match(g, /temperature — populated: 0.6/);
  assert.match(g, /apiKey — \(unset\)/);
});

test("readActiveModelLenient: partial file → populated fields, no throw", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "models.json");
  fs.writeFileSync(p, JSON.stringify({ default: "m1", models: [{ id: "m1", provider: "vks", contextWindow: 131072, maxTokens: 32768 }] }));
  const m = readActiveModelLenient(p);
  assert.ok(m);
  assert.equal(m.id, "m1");
  assert.equal(m.provider, "vks");
  assert.equal(hasEndpoint(m), false); // no baseUrl
});

test("readActiveModelLenient: resolves the DEFAULT model, not just the first", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "models.json");
  fs.writeFileSync(p, JSON.stringify({
    default: "second",
    models: [
      { id: "first", provider: "a", baseUrl: "http://a/v1" },
      { id: "second", provider: "b", contextWindow: 1000, maxTokens: 100 },
    ],
  }));
  const m = readActiveModelLenient(p);
  assert.ok(m);
  assert.equal(m.id, "second");
  assert.equal(hasEndpoint(m), false); // second has no baseUrl even though first does
});

test("readActiveModelLenient: bad json / missing file → null; empty models → {}", (t) => {
  assert.equal(readActiveModelLenient("/nonexistent/nope.json"), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  assert.equal(readActiveModelLenient(bad), null);
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ default: "x", models: [] }));
  assert.deepEqual(readActiveModelLenient(empty), {});
});
