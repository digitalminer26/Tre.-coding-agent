#!/usr/bin/env node
// test/mcp-mock-server.mjs — a minimal LEGACY-era (2025-11-25) MCP stdio
// server for the live e2e scenario 22 (docs/10-mcp-scope.md tier-1
// acceptance: "live model calls a mock-server tool").
//
// It implements ONLY what the tre. client's startup + one tools/call need:
//   - server/discover → JSON-RPC error -32601 (method not found) → the
//     client classifies the probe as LEGACY and falls back to the
//     initialize handshake (the dual-era design, scope §5.9).
//   - initialize → { protocolVersion, capabilities, serverInfo }.
//   - notifications/initialized → ignored (a notification: no reply).
//   - tools/list → one tool, `ping`, with a string `msg` argument.
//   - tools/call { name: "ping", arguments: { msg } } → a text content
//     block echoing `MCP-MOCK-OK: <msg>` (a legacy ordinary result: no
//     resultType required).
//
// Everything else → -32601. Newline-delimited JSON-RPC 2.0 on stdin/stdout;
// diagnostics (if any) would go to stderr, but this server is silent.
//
// Spawned by the scenario as: node test/mcp-mock-server.mjs
// (the MCP child env carries the allowlisted baseline incl. PATH, so
// `node` resolves; the scenario passes an ABSOLUTE node path anyway).

import process from "node:process";
import readline from "node:readline";

const SERVER_INFO = { name: "tre-mock", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-11-25";

const TOOL = {
  name: "ping",
  description: "Echo a marker string back (mock server for e2e scenario 22).",
  inputSchema: {
    type: "object",
    properties: {
      msg: { type: "string", description: "The string to echo back." },
    },
    required: ["msg"],
  },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    // Non-JSON line: no id to answer, so no reply (the client's admission
    // layer bounds the damage; this mock never sees one in the scenario).
    return;
  }
  if (msg.method === undefined) return; // a response, not a request
  switch (msg.method) {
    case "initialize":
      reply(msg, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "notifications/initialized":
      break; // notification — no reply
    case "tools/list":
      reply(msg, { tools: [TOOL] });
      break;
    case "tools/call": {
      const args = msg.params && typeof msg.params.arguments === "object" && msg.params.arguments !== null ? msg.params.arguments : {};
      if (msg.params && msg.params.name === "ping") {
        const out = `MCP-MOCK-OK: ${typeof args.msg === "string" ? args.msg : ""}`;
        reply(msg, { content: [{ type: "text", text: out }] });
      } else {
        reply(msg, null, { code: -32602, message: `unknown tool: ${msg.params && msg.params.name}` });
      }
      break;
    }
    default:
      // server/discover lands here → -32601 → the client falls back to
      // the legacy handshake (the dual-era design).
      reply(msg, null, { code: -32601, message: `method not found: ${msg.method}` });
  }
});

function reply(req, result, error) {
  const out = { jsonrpc: "2.0", id: req.id };
  if (error) out.error = error;
  else out.result = result;
  process.stdout.write(JSON.stringify(out) + "\n");
}
