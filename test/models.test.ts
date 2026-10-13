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
  loadModelsFile,
  readActiveModelLenient,
  resolveModel,
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

// Audit finding E: compactionReserve normalization. A finite, non-negative
// number is preserved (0 is VALID — "compact as early as possible"); a
// negative, non-finite, or non-numeric value is a config error and is DROPPED
// (left unset) so the trigger falls back to DEFAULT_COMPACTION_RESERVE instead
// of firing at a nonsense threshold. Tested through the REAL normalization
// path (loadModelsFile → resolveModel → normalizeModel), which is what feeds
// the compaction trigger (readActiveModelLenient is the raw setup-guide path).
test("compactionReserve: finite non-negative preserved; negative/non-numeric dropped", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = (reserve: unknown) => {
    const p = path.join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
    const entry: Record<string, unknown> = {
      id: "m", provider: "p", baseUrl: "http://x/v1", api: "openai-completions",
      contextWindow: 131072, maxTokens: 32768,
    };
    if (reserve !== undefined) entry.compactionReserve = reserve;
    fs.writeFileSync(p, JSON.stringify({ default: "m", models: [entry] }));
    return resolveModel(loadModelsFile(p));
  };
  // valid values are preserved verbatim (0 is legal).
  assert.equal(mk(0).compactionReserve, 0);
  assert.equal(mk(8192).compactionReserve, 8192);
  assert.equal(mk(16384.5).compactionReserve, 16384.5); // float is a valid token count
  // config errors are dropped (left unset → the trigger defaults to 16384).
  assert.equal(mk(-1).compactionReserve, undefined);
  assert.equal(mk("16384").compactionReserve, undefined); // string is not a number
  assert.equal(mk(undefined).compactionReserve, undefined); // absent
});

// Per-model `headers` (OpenRouter attribution / custom request headers): a
// plain object of valid HTTP header name → value is preserved verbatim;
// anything else is a config error. Control characters in values (a stray
// newline = header injection) and invalid names (empty, spaces) are rejected
// at LOAD time — undici's fetch would otherwise fail every request to the
// model with an opaque TypeError.
test("headers: valid object preserved; malformed entries are config errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = (headers: unknown) => {
    const p = path.join(dir, `h-${Math.random().toString(36).slice(2)}.json`);
    const entry: Record<string, unknown> = {
      id: "m", provider: "p", baseUrl: "http://x/v1", api: "openai-completions",
      contextWindow: 131072, maxTokens: 32768,
    };
    if (headers !== undefined) entry.headers = headers;
    fs.writeFileSync(p, JSON.stringify({ default: "m", models: [entry] }));
    return resolveModel(loadModelsFile(p));
  };
  // valid: preserved verbatim (hyphens, dots, digits, underscores are legal
  // token characters).
  const ok = mk({
    "X-Title": "tre.",
    "HTTP-Referer": "https://example.com",
    "X_Custom-1.0": "ok",
  });
  assert.deepEqual(ok.headers, {
    "X-Title": "tre.",
    "HTTP-Referer": "https://example.com",
    "X_Custom-1.0": "ok",
  });
  // absent: left unset.
  assert.equal(mk(undefined).headers, undefined);
  // malformed values: config errors.
  assert.throws(() => mk({ "X-Title": "" }), /headers/); // empty value
  assert.throws(() => mk({ "X-Title": "a\r\nX-Injected: yes" }), /headers/); // newline = header injection
  assert.throws(() => mk({ "X-Title": "a\u0000b" }), /headers/); // NUL control char
  assert.throws(() => mk({ "X-Title": 5 }), /headers/); // non-string value
  // malformed names: config errors.
  assert.throws(() => mk({ "": "x" }), /headers/); // empty name
  assert.throws(() => mk({ "X Bad": "x" }), /headers/); // space is not a token char
  // not an object at all: config errors.
  assert.throws(() => mk(["X-Title"]), /headers/); // array, not object
  assert.throws(() => mk("X-Title: tre."), /headers/); // string, not object
  assert.throws(() => mk(null), /headers/); // null
});
