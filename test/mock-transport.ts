/**
 * Mock MCP transport for client tests (no child process).
 *
 * A `MockMcpServer` is a tiny in-process JSON-RPC peer: the test drives it
 * with `respondResult` / `respondError` / `sendNotification` /
 * `sendRequest` / `sendRawLine` / `closeStdout`. It records every inbound
 * line (parsed + raw) so tests can assert the exact envelope the client
 * sent (probe keys, negotiated version, no `initialize` on the modern
 * path, single-line framing).
 *
 * The client sees:
 *   - `stdin`: a PassThrough — writing to it is captured into `inbound`
 *     (one entry per line). `pauseWrites` + `interceptWrites` simulate a
 *     stalled pipe (no flush-completion callbacks) for the stall test.
 *   - `stdout`: a PassThrough — the mock pushes lines onto it.
 *   - `stderr`: a PassThrough — the mock pushes text onto it.
 *
 * `onInbound(fn)` registers a handler that receives EVERY inbound line
 * exactly once (the mock dispatches each line to all registered handlers).
 */
import { PassThrough } from "node:stream";
import type { McpTransport } from "../src/mcp/client.js";

export interface InboundLine {
  raw: string;
  obj: Record<string, unknown>;
}

export class MockMcpServer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  /** Every inbound line (parsed). */
  inbound: InboundLine[] = [];
  /** Raw inbound lines, in order (framing assertions). */
  rawLines: string[] = [];
  closed = false;
  killed = false;
  /** When true, stdin writes never call their flush callback (a stalled
   *  pipe). Pair with interceptWrites(). */
  pauseWrites = false;
  /** When true, the NEXT stdin write calls its flush callback with an error
   *  (simulates a transport write rejection — EPIPE / broken pipe). */
  failNextWrite = false;
  private pendingFlushes: Array<() => void> = [];
  private handlers: Array<(l: InboundLine) => void> = [];
  private stdinBuf = "";

  get transport(): McpTransport {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      close: () => {
        this.closed = true;
      },
      kill: () => {
        this.killed = true;
      },
    };
  }

  constructor() {
    this.stdin.on("data", (chunk: Buffer | string) => {
      let text = this.stdinBuf + chunk.toString("utf8");
      let idx: number;
      while ((idx = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, idx);
        text = text.slice(idx + 1);
        if (line.length === 0) continue;
        this.rawLines.push(line);
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          throw new Error(
            "mock: inbound line is not valid JSON: " + line.slice(0, 120),
          );
        }
        const l: InboundLine = { raw: line, obj };
        this.inbound.push(l);
        // Deliver to EVERY registered handler (each line, once).
        for (const h of this.handlers) h(l);
      }
      this.stdinBuf = text;
    });
  }

  /** Register a handler for inbound lines (each line, exactly once). */
  onInbound(fn: (l: InboundLine) => void): void {
    this.handlers.push(fn);
  }

  /** Wrap writes so their flush callback is deferred while paused. */
  interceptWrites(): void {
    const self = this;
    const origWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((
      chunk: Buffer | string,
      encOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const cb2 = typeof encOrCb === "function" ? encOrCb : cb;
      const enc = typeof encOrCb === "string" ? encOrCb : undefined;
      if (self.failNextWrite && cb2) {
        self.failNextWrite = false;
        // Simulate a transport write rejection (EPIPE / broken pipe): the
        // flush callback fires WITH an error, on the next tick.
        setImmediate(() => cb2(new Error("write EPIPE (simulated transport rejection)")));
        return false;
      }
      if (self.pauseWrites && cb2) {
        self.pendingFlushes.push(() => cb2());
        return false;
      }
      return origWrite(chunk, (enc ?? "utf8") as BufferEncoding, cb2);
    }) as typeof this.stdin.write;
  }

  /** Deliver all deferred flush callbacks (resume the pipe). */
  resumeWrites(): void {
    const p = this.pendingFlushes;
    this.pendingFlushes = [];
    for (const f of p) f();
  }

  /** Send a JSON-RPC result to the client (on the mock's stdout). */
  respondResult(id: number | string | null, result: unknown): void {
    this.pushLine({ jsonrpc: "2.0", id, result });
  }

  /** Send a JSON-RPC error to the client. */
  respondError(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.pushLine({
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });
  }

  /** Send a notification (no id). */
  sendNotification(method: string, params?: unknown): void {
    this.pushLine(
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params },
    );
  }

  /** Send a server→client request (method + present id). */
  sendRequest(id: number | string | null, method: string, params?: unknown): void {
    this.pushLine(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );
  }

  /** Send a raw (possibly invalid) line — envelope-violation tests. */
  sendRawLine(line: string): void {
    this.stdout.write(line + "\n");
  }

  /** EOF on the mock's stdout (transport death). */
  closeStdout(): void {
    this.stdout.end();
  }

  private pushLine(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  /** The inbound line for a method (first match). */
  lineFor(method: string): InboundLine | undefined {
    return this.inbound.find((l) => l.obj.method === method);
  }

  /** True if the raw line is exactly one JSON line (no embedded newline). */
  isSingleLine(raw: string): boolean {
    return !raw.includes("\n");
  }
}
