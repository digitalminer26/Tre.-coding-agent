/**
 * WS3 — validateArgs: the minimal JSON-schema validator catches malformed
 * LLM arguments and stays lenient about the rest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateArgs } from "../src/tools/validate.js";
import type { JsonSchema } from "../src/types.js";

const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({ type: "object", properties, required });

test("valid object passes", () => {
  const schema = obj(
    { path: { type: "string" }, offset: { type: "integer" } },
    ["path"],
  );
  assert.equal(validateArgs(schema, { path: "a.txt" }), undefined);
  assert.equal(
    validateArgs(schema, { path: "a.txt", offset: 5, extra: true }),
    undefined, // extra properties are allowed
  );
});

test("missing required property fails with the property name", () => {
  const schema = obj({ path: { type: "string" } }, ["path"]);
  const err = validateArgs(schema, {});
  assert.ok(err && err.includes('missing required property "path"'), err);
});

test("wrong type fails with path + what was expected + what arrived", () => {
  const schema = obj(
    { path: { type: "string" }, offset: { type: "integer" } },
    ["path"],
  );
  let err = validateArgs(schema, { path: 42 });
  assert.ok(err && err.includes("arguments.path") && err.includes("string"), err);
  err = validateArgs(schema, { path: "x", offset: 1.5 });
  assert.ok(err && err.includes("arguments.offset") && err.includes("integer"), err);
});

test("nested object + array items are validated recursively", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      cfg: {
        type: "object",
        properties: { items: { type: "array", items: { type: "number" } } },
      },
    },
  };
  assert.equal(validateArgs(schema, { cfg: { items: [1, 2.5] } }), undefined);
  const err = validateArgs(schema, { cfg: { items: [1, "two"] } });
  assert.ok(
    err && err.includes("arguments.cfg.items[1]") && err.includes("number"),
    err,
  );
});

test("enum: membership checked", () => {
  const schema: JsonSchema = { type: "string", enum: ["a", "b"] };
  assert.equal(validateArgs(schema, "a"), undefined);
  const err = validateArgs(schema, "c");
  assert.ok(err && err.includes('"a"'), err);
});

test("arrays where objects expected, nulls, weird values: reported, never thrown", () => {
  const schema = obj({ path: { type: "string" } }, ["path"]);
  for (const value of [null, 42, "str", true, ["x"], undefined]) {
    const err = validateArgs(schema, value);
    assert.ok(err, `expected failure for ${JSON.stringify(value)}`);
  }
  // number accepts integers and floats, rejects NaN
  const num: JsonSchema = { type: "number" };
  assert.equal(validateArgs(num, 3), undefined);
  assert.equal(validateArgs(num, 3.5), undefined);
  assert.ok(validateArgs(num, Number.NaN));
});

test("no type constraint: anything passes (lenient on unknown keywords)", () => {
  const schema: JsonSchema = {
    type: "object",
    [ "minLength" ]: 5, // unknown keyword — ignored
    properties: { anything: { type: "string" } },
  };
  assert.equal(validateArgs(schema, { anything: "ok", weird: 1 }), undefined);
});
