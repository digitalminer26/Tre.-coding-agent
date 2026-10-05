import test from "node:test";
import assert from "node:assert/strict";
import { discoverChatGptModel } from "../src/cli/auth-commands.js";

test("discoverChatGptModel selects first model slug from Codex model list", async () => {
  let requested = "";
  const id = await discoverChatGptModel("fake-token", async (input, init) => {
    requested = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-token");
    return new Response(JSON.stringify({ models: [{ slug: "gpt-valid" }, { slug: "gpt-next" }] }), { status: 200 });
  });
  assert.equal(requested, "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
  assert.equal(id, "gpt-valid");
});

test("discoverChatGptModel rejects failed and empty catalogs", async () => {
  await assert.rejects(
    discoverChatGptModel("x", async () => new Response("{}", { status: 401 })),
    /HTTP 401.*catalog was not written/,
  );
  await assert.rejects(
    discoverChatGptModel("x", async () => new Response(JSON.stringify({ models: [] }), { status: 200 })),
    /no usable models/,
  );
});
