/**
 * MCP stdio client — dual-era JSON-RPC 2.0 over newline-delimited stdio.
 *
 * Scope: docs/10-mcp-scope.md §4.2 (era probe + dispatch contract), §4.4
 * (lifecycle, frame admission, byte accounting, stall deadline), §5.9
 * (dual-era ruling). Hand-rolled; zero runtime dependencies.
 *
 * Era decision (the load-bearing part):
 *   1. ONE `server/discover` probe (modern envelope inside `params`),
 *      declared version 2026-07-28, written as a SINGLE JSON line + `\n`.
 *   2. Response → MODERN (valid DiscoverResult, or -32022 with ONE bounded
 *      retry from data.supported — a second non-success is FATAL, not
 *      legacy), LEGACY (any other JSON-RPC error on a valid frame, or the
 *      2s probe timeout → `initialize` handshake), or FATAL (transport
 *      death, framing violation, invalid discovery document).
 *   3. The era is cached per server process; both eras share the framing,
 *      id-multiplexed pending map, timeouts, abort, and death detection.
 *
 * The client owns the transport's stdout/stderr/stdin listeners and the
 * process teardown (transport.kill on failure, transport.close on clean
 * shutdown). spawn.ts provides the McpTransport; tests provide a mock.
 */

// ── Constants (fixed values, scope §4.4) ─────────────────────────────────────

/** Max serialized outbound frame, UTF-8 bytes INCLUDING the final newline. */
export const MCP_FRAME_LIMIT = 1024 * 1024; // 1 MiB
/** Max undrained outbound queue (active write + queued frames), bytes. */
export const MCP_QUEUE_LIMIT = 4 * 1024 * 1024; // 4 MiB
/** Threshold that STARTS the no-progress deadline (not a memory bound). */
export const MCP_STALL_THRESHOLD = 256 * 1024; // 256 KiB
/** No deadline signal (error-free flush or drain) for this long at/above
 *  threshold → terminal transport failure. */
export const MCP_STALL_MS = 10_000;
/** Per-call timeout (healthy-server bound). */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** Probe timeout (per probe request). */
export const MCP_PROBE_TIMEOUT_MS = 2_000;
/** Whole-startup budget: probe + retry + initialize/initialized + tools/list. */
export const MCP_STARTUP_BUDGET_MS = 5_000;
/** Max concurrent pending requests per server. */
export const MCP_MAX_PENDING = 32;
/** tools/list pagination limits. */
export const MCP_MAX_PAGES = 100;
export const MCP_MAX_TOOLS = 10_000;
/** Retained stderr (ring, tail kept). */
export const MCP_STDERR_RING = 64 * 1024; // 64 KiB

/** The version the client declares on the probe (highest it supports). */
export const MCP_CLIENT_VERSION = "2026-07-28";
/** The legacy handshake version (2025-11-25 line). */
export const MCP_LEGACY_VERSION = "2025-11-25";
/** The recognized modern negotiation error (UnsupportedProtocolVersionError). */
export const MCP_ERR_UNSUPPORTED_VERSION = -32022;
/** Method-not-found — the standard reply to any server→client request. */
export const MCP_ERR_METHOD_NOT_FOUND = -32601;

export const MCP_CLIENT_INFO = { name: "tre", version: "0.3.0" } as const;

/** Injectable timing (defaults are the fixed scope values — tests use
 *  shorter values; production uses the defaults). */
export interface McpClientOptions {
  callTimeoutMs?: number;
  probeTimeoutMs?: number;
  startupBudgetMs?: number;
  stallMs?: number;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type McpState = "disabled" | "starting" | "ready" | "failed";
export type McpEra = "modern" | "legacy";

/** A transport the client can talk JSON-RPC over. spawn.ts implements this
 *  with a real child process; tests implement it with mock streams. */
export interface McpTransport {
  /** The child's stdin — the client writes frames (single write per frame,
   *  with a flush-completion callback). */
  stdin: NodeJS.WritableStream;
  /** The child's stdout — newline-delimited JSON-RPC. The client attaches
   *  its 'data' listener. */
  stdout: NodeJS.ReadableStream;
  /** The child's stderr — retained in a bounded ring by the client. */
  stderr: NodeJS.ReadableStream;
  /** Close stdin (graceful start of shutdown). */
  close(): void;
  /** Kill the process group (teardown). */
  kill(): void;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A mapped tools/call result (the adapter turns this into a ToolResult). */
export interface McpToolCallResult {
  /** Text blocks (in order), plus the structuredContent block if present. */
  texts: string[];
  /** The server's isError flag (true → the call failed in-band). */
  isError: boolean;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}
/** The server is saturated (pending cap) — in-band, server stays healthy. */
export class McpBusyError extends McpError {}
/** A per-call failure (protocol error, timeout, abort, transport) — in-band. */
export class McpCallError extends McpError {
  /** Set when the failure is a JSON-RPC protocol error (carries code/msg). */
  rpc?: RpcError;
}
/** The server is not (or no longer) running. */
export class McpNotRunningError extends McpError {}
/** A startup failure (probe/handshake/tools-list/admission). */
export class McpStartupError extends McpError {}

type FrameClass = "tool" | "startup" | "mandatory" | "best-effort";

interface Frame {
  id: number;
  data: Buffer;
  bytes: number;
  cls: FrameClass;
  writeStarted: boolean;
  released: boolean;
}

interface Pending {
  id: number;
  tool?: string;
  timer: NodeJS.Timeout;
  frame: Frame | null;
  settled: boolean;
  /** Call path: resolves/rejects the caller's promise. */
  deferred?: { resolve: (v: unknown) => void; reject: (e: Error) => void };
  /** Probe path: classifies the response (or timeout/fatal). */
  probeResult?: (result: unknown, error: RpcError | null) => void;
  probeTimeout?: () => void;
  probeFatal?: (reason: string) => void;
}

interface Diagnostics {
  /** Late/unknown response ids (counted, dropped). */
  lateResponses: number;
  /** Envelope-valid notifications with unhandled methods. */
  unknownNotifications: number;
  /** notifications/tools/list_changed (recorded for tier-2 re-list). */
  toolListChanged: number;
  /** Server-sent notifications/cancelled (unmatched; never aborts a call). */
  unmatchedCancelled: number;
  /** Outbound frames dropped (best-effort admission failures). */
  droppedFrames: number;
  /** Server→client requests answered -32601 (a counter, not coalesced). */
  serverRequestsRejected: number;
  /** Retained stderr (64 KiB ring, tail kept). */
  stderr: string;
}

interface ProbeOutcome {
  kind: "modern" | "legacy" | "fatal";
  result?: unknown;
  error?: RpcError;
  detail?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function makeDeferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v) => res(v);
    reject = (e) => rej(e);
  });
  return { promise, resolve, reject };
}

// ── The client ───────────────────────────────────────────────────────────────

export class McpClient {
  private state: McpState = "starting";
  private failReason = "";
  private era: McpEra | null = null;
  private negotiatedVersion = MCP_CLIENT_VERSION;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Frame[] = [];
  private writing = false;
  private undrained = 0;
  private stallTimer: NodeJS.Timeout | null = null;
  private budgetTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private stdoutBuf = "";
  private diags: Diagnostics = {
    lateResponses: 0,
    unknownNotifications: 0,
    toolListChanged: 0,
    unmatchedCancelled: 0,
    droppedFrames: 0,
    serverRequestsRejected: 0,
    stderr: "",
  };

  private readyD: ReturnType<typeof makeDeferred<void>> | null = null;

  private onStdoutBound = (c: Buffer | string) => this.onStdout(c);
  private onStderrBound = (c: Buffer | string) => this.onStderr(c);
  private onStdinErrorBound = (err: Error) =>
    this.fail("stdin error: " + err.message);
  /** EOF on the child's stdout is transport death (the process is gone). */
  private onStdoutEndBound = () => {
    if (this.closed) return;
    this.fail("transport death: stdout closed (EOF)");
  };
  /** A `drain` event is a DEADLINE SIGNAL ONLY — it never changes byte
   *  accounting or advances the frame queue (that is the error-free
   *  flush-completion's job). */
  private onDrainBound = () => {
    if (this.closed) return;
    if (this.undrained >= MCP_STALL_THRESHOLD) this.resetStall();
    else this.maybeCancelStall();
  };

  constructor(
    private serverName: string,
    private transport: McpTransport,
    private opts: McpClientOptions = {},
  ) {
    this.transport.stdout.on("data", this.onStdoutBound);
    this.transport.stdout.on("end", this.onStdoutEndBound);
    this.transport.stderr.on("data", this.onStderrBound);
    this.transport.stdin.on("error", this.onStdinErrorBound);
    this.transport.stdin.on("drain", this.onDrainBound);
  }

  getState(): { state: McpState; reason: string; era: McpEra | null } {
    return { state: this.state, reason: this.failReason, era: this.era };
  }

  getDiagnostics(): Readonly<Diagnostics> {
    return this.diags;
  }

  /** Queue/pending stats (for tests and the /mcp status line). */
  getStats(): { undrained: number; queued: number; pending: number } {
    return {
      undrained: this.undrained,
      queued: this.queue.length,
      pending: this.pending.size,
    };
  }

  /** Begin the startup sequence (probe → era → tools/list). Resolves with
   *  the tool list when the server is `ready`; rejects with
   *  McpStartupError on any startup failure (the server is torn down). */
  private startPromise: Promise<McpTool[]> | null = null;

  start(): Promise<McpTool[]> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== "starting") {
      return Promise.reject(
        new McpStartupError(
          `server ${this.serverName} is ${this.state}` +
            (this.failReason ? ` (${this.failReason})` : ""),
        ),
      );
    }
    this.readyD = makeDeferred<void>();
    // Absorb the rejection if no consumer ever awaits readyD (e.g. startup
    // fails before any callTool/listTools reaches ensureReady). Consumers
    // await their OWN derived promise, so they still see the rejection.
    this.readyD.promise.catch(() => {});
    this.budgetTimer = setTimeout(() => {
      this.fail("startup timeout (5s budget)");
    }, this.opts.startupBudgetMs ?? MCP_STARTUP_BUDGET_MS);
    this.budgetTimer.unref?.();
    this.startPromise = this.runStartup();
    return this.startPromise;
  }

  private async runStartup(): Promise<McpTool[]> {
    try {
      // Era probe.
      const probe = await this.probe();
      if (probe.kind === "fatal") {
        throw new McpStartupError("probe fatal: " + (probe.detail ?? "unknown"));
      }
      if (probe.kind === "legacy") {
        this.era = "legacy";
        await this.legacyHandshake();
      } else {
        // MODERN — decide whether the declared version is mutually
        // supported, else ONE bounded retry with a supported version.
        let retryVersion: string | null = null;
        if (probe.error?.code === MCP_ERR_UNSUPPORTED_VERSION) {
          retryVersion = this.pickSupportedVersion(probe.error.data);
          if (!retryVersion) {
            throw new McpStartupError(
              "probe -32022 with no usable supported version",
            );
          }
        } else {
          // A valid DiscoverResult — the negotiated version must be one the
          // server supports.
          const sv = (probe.result as { supportedVersions: string[] })
            .supportedVersions;
          if (!sv.includes(MCP_CLIENT_VERSION)) {
            retryVersion = sv.length ? sv[0] ?? null : null;
            if (!retryVersion) {
              throw new McpStartupError(
                "DiscoverResult supports no client version",
              );
            }
          }
        }
        if (retryVersion) {
          this.negotiatedVersion = retryVersion;
          const retry = await this.probe(retryVersion);
          if (retry.kind !== "modern" || retry.result == null) {
            // A second non-success is FATAL, not legacy (the server proved
            // modern on the first probe).
            const detail =
              retry.kind === "fatal"
                ? retry.detail
                : retry.error
                  ? `error ${retry.error.code} ${retry.error.message}`
                  : "no result";
            throw new McpStartupError(
              "probe retry failed (server proved modern): " + detail,
            );
          }
        }
        this.era = "modern";
      }
      const tools = await this.listToolsStartup();
      if (this.budgetTimer) {
        clearTimeout(this.budgetTimer);
        this.budgetTimer = null;
      }
      if (this.state === "starting") this.state = "ready";
      this.readyD?.resolve();
      return tools;
    } catch (e) {
      if (this.state === "starting") {
        const msg = e instanceof Error ? e.message : String(e);
        this.fail(msg);
      }
      throw e;
    }
  }

  /** One server/discover probe. Resolves with the classified outcome. */
  private probe(version: string = MCP_CLIENT_VERSION): Promise<ProbeOutcome> {
    const d = makeDeferred<ProbeOutcome>();
    const id = this.nextId++;
    const params: Record<string, unknown> = {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { ...MCP_CLIENT_INFO },
      },
    };
    // Register the pending entry BEFORE the frame is written: a fast server
    // can answer within the same tick (the write callback is synchronous),
    // and the response must find its pending entry.
    const p: Pending = {
      id,
      timer: setTimeout(() => {
        this.settleProbeTimeout(id);
      }, this.opts.probeTimeoutMs ?? MCP_PROBE_TIMEOUT_MS),
      frame: null,
      settled: false,
      probeResult: (result, error) => {
        if (error) {
          if (error.code === MCP_ERR_UNSUPPORTED_VERSION) {
            d.resolve({
              kind: "modern",
              error: {
                code: error.code,
                message: error.message,
                data: error.data,
              },
            });
          } else {
            // Any other JSON-RPC error on a valid frame → legacy fallback.
            d.resolve({
              kind: "legacy",
              detail: `probe error ${error.code} ${error.message}`,
            });
          }
          return;
        }
        // A result — validate as DiscoverResult (a server claiming modern
        // but emitting an invalid discovery document is FATAL, not legacy).
        if (
          !isObj(result) ||
          typeof result.resultType !== "string" ||
          !Array.isArray(result.supportedVersions)
        ) {
          d.resolve({
            kind: "fatal",
            detail: "invalid DiscoverResult (resultType/supportedVersions missing)",
          });
          return;
        }
        d.resolve({ kind: "modern", result });
      },
      probeTimeout: () => {
        d.resolve({ kind: "legacy", detail: "probe timeout (2s)" });
      },
      probeFatal: (reason) => {
        d.resolve({ kind: "fatal", detail: reason });
      },
    };
    this.pending.set(id, p);
    const frame = this.admit(
      { jsonrpc: "2.0", id, method: "server/discover", params },
      "startup",
    );
    if (!frame) {
      // fail() already ran (startup class): settleAll settled the probe
      // entry (probeFatal → d resolved fatal) and cleared the timer.
      return d.promise;
    }
    p.frame = frame;
    return d.promise;
  }

  private pickSupportedVersion(data: unknown): string | null {
    if (!isObj(data)) return null;
    const supported = data.supported;
    if (!Array.isArray(supported)) return null;
    const list = supported.filter((v): v is string => typeof v === "string");
    if (list.includes(MCP_CLIENT_VERSION)) return MCP_CLIENT_VERSION;
    return list.length ? list[0] ?? null : null;
  }

  /** Legacy (2025-11-25) handshake: initialize → notifications/initialized. */
  private async legacyHandshake(): Promise<void> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: MCP_LEGACY_VERSION,
        capabilities: {}, // tier 1 advertises NOTHING.
        clientInfo: { ...MCP_CLIENT_INFO },
      },
      "startup",
    );
    if (!isObj(result) || typeof result.protocolVersion !== "string") {
      throw new McpStartupError(
        "invalid initialize result (protocolVersion missing)",
      );
    }
    // Server capabilities: recorded, not subscribed (tier 1).
    // Best-effort initialized notification (drop + count if it does not fit;
    // a dropped initialized degrades gracefully — the session continues).
    this.admit(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "best-effort",
    );
  }

  /** Startup tools/list (paginated). A malformed result is a STARTUP failure. */
  private async listToolsStartup(): Promise<McpTool[]> {
    return this.paginateTools(true);
  }

  /** Shared pagination for tools/list (startup + ready-state). */
  private async paginateTools(startup: boolean): Promise<McpTool[]> {
    const fail = (msg: string): never => {
      if (startup) throw new McpStartupError(msg);
      throw new McpCallError(msg);
    };
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      if (pages >= MCP_MAX_PAGES || tools.length >= MCP_MAX_TOOLS) {
        fail("tools/list limit exceeded (100 pages / 10000 tools)");
      }
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) fail("tools/list cursor loop (repeated cursor)");
        seenCursors.add(cursor);
      }
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) params.cursor = cursor;
      const result = await this.request("tools/list", params, startup ? "startup" : "tool");
      if (!isObj(result) || !Array.isArray(result.tools)) {
        fail("invalid tools/list result (tools array missing)");
      }
      const page = result as { tools: unknown[]; nextCursor?: unknown };
      for (const t of page.tools) {
        const entry = t as Record<string, unknown>;
        const name = entry.name;
        if (!isObj(t) || typeof name !== "string") {
          throw startup ? new McpStartupError("invalid tools/list entry (name missing)") : new McpCallError("invalid tools/list entry (name missing)");
        }
        tools.push({
          name,
          description: typeof entry.description === "string" ? entry.description : undefined,
          inputSchema: entry.inputSchema,
        });
        if (tools.length >= MCP_MAX_TOOLS) {
          fail("tools/list limit exceeded (10000 tools)");
        }
      }
      pages++;
      const nc = page.nextCursor;
      if (typeof nc === "string" && nc.length > 0) {
        cursor = nc;
        continue;
      }
      break;
    }
    return tools;
  }

  private meta(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": this.negotiatedVersion,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { ...MCP_CLIENT_INFO },
    };
  }

  /** A low-level request. Resolves with the `result`, rejects with
   *  McpCallError (protocol error / timeout / transport), McpBusyError
   *  (saturation / tool-frame admission), or McpStartupError (startup
   *  admission). */
  private request(
    method: string,
    params: Record<string, unknown>,
    cls: FrameClass,
    tool?: string,
  ): Promise<unknown> {
    if (this.closed || this.state === "failed") {
      return Promise.reject(
        new McpCallError(`MCP server ${this.serverName} is not running`),
      );
    }
    if (this.state === "disabled") {
      return Promise.reject(new McpNotRunningError(`server ${this.serverName} is disabled`));
    }
    if (this.pending.size >= MCP_MAX_PENDING) {
      return Promise.reject(
        new McpBusyError(`MCP server ${this.serverName} busy (${MCP_MAX_PENDING} pending)`),
      );
    }
    // Modern era: every request carries the _meta envelope (negotiated
    // version). The probe builds its own (declared version).
    if (this.era === "modern" && !hasOwn(params, "_meta")) {
      params._meta = this.meta();
    }
    const id = this.nextId++;
    const d = makeDeferred<unknown>();
    const timer = setTimeout(() => {
      this.settle(id, null, new McpCallError(`call ${method} timed out (60s)`));
    }, this.opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS);
    // Register the pending entry BEFORE the frame is written: a fast server
    // can answer within the same tick, and the response must find it.
    const p: Pending = {
      id,
      tool,
      timer,
      frame: null,
      settled: false,
      deferred: d,
    };
    this.pending.set(id, p);
    const frame = this.admit({ jsonrpc: "2.0", id, method, params }, cls);
    if (!frame) {
      // admit() already applied the per-class failure policy.
      if (cls === "tool") {
        // In-band: remove the pending entry and reject busy.
        this.pending.delete(id);
        clearTimeout(timer);
        d.reject(
          new McpBusyError(`MCP server ${this.serverName} busy (frame not admitted)`),
        );
      }
      // startup/mandatory: fail() already ran — settleAll settled the entry
      // (d rejected with the transport error) and cleared the timer.
      return d.promise;
    }
    p.frame = frame;
    return d.promise;
  }

  /** List the server's tools (ready-state; tier-2 re-list). */
  async listTools(): Promise<McpTool[]> {
    await this.ensureReady();
    return this.paginateTools(false);
  }

  /** Call a tool. NEVER throws for a server-side issue — every failure is
   *  in-band (isError): protocol errors, timeouts, aborts, saturation, and
   *  a dead server all map to a result. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolCallResult> {
    let result: unknown;
    try {
      await this.ensureReady();
      result = await this.request("tools/call", { name, arguments: args }, "tool", name);
    } catch (e) {
      if (e instanceof McpCallError && e.rpc) {
        return {
          texts: [`MCP protocol error ${e.rpc.code}: ${e.rpc.message}`],
          isError: true,
        };
      }
      if (e instanceof McpBusyError) {
        return { texts: [`MCP server ${this.serverName} busy`], isError: true };
      }
      if (e instanceof McpError) {
        return { texts: [e.message], isError: true };
      }
      throw e;
    }
    return this.mapCallResult(result);
  }

  /** Map a tools/call result. A malformed result is an in-band isError —
   *  a result-payload failure, NOT an envelope violation (the server is
   *  NOT torn down). */
  private mapCallResult(result: unknown): McpToolCallResult {
    if (!isObj(result)) {
      return {
        texts: ["MCP tools/call returned a malformed result (not an object)"],
        isError: true,
      };
    }
    // resultType: modern requires "complete"; "input_required" is unsupported
    // (MRTR is tier 3); legacy may omit it. A malformed/unknown type fails
    // THIS CALL in-band.
    if (result.resultType !== undefined) {
      if (result.resultType === "input_required") {
        return {
          texts: [
            "MCP server requested interactive input (input_required) — unsupported in tier 1 (MRTR is tier 3)",
          ],
          isError: true,
        };
      }
      if (result.resultType !== "complete") {
        return {
          texts: [
            `MCP tools/call returned an unknown resultType: ${JSON.stringify(result.resultType)}`,
          ],
          isError: true,
        };
      }
    }
    const texts: string[] = [];
    const content = result.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          texts.push(b.text);
        } else if (isObj(b) && typeof b.type === "string" && b.type !== "text") {
          texts.push(`[non-text content block: ${b.type}]`);
        }
      }
    }
    // structuredContent — deterministic rule: presence and emptiness decide.
    const sc = result.structuredContent;
    if (sc !== undefined && sc !== null) {
      const scText = JSON.stringify(sc, null, 2);
      if (texts.length > 0) {
        texts.push("[structuredContent]\n" + scText);
      } else {
        texts.push(scText);
      }
    }
    return { texts, isError: result.isError === true };
  }

  /** Abort a pending call by tool name. ONE order: (1) capture the write
   *  state, (2) settle exactly once as aborted, (3) act on the write state.
   *  Returns true if a call was aborted. */
  abortCall(tool: string): boolean {
    for (const p of this.pending.values()) {
      if (p.tool === tool && !p.settled) {
        const f = p.frame;
        const writeStarted = f ? f.writeStarted : false;
        this.settle(p.id, null, new McpCallError(`call ${tool} aborted`));
        if (f && !writeStarted) {
          // UNSENT — remove from the queue; do NOT send
          // notifications/cancelled (the server never saw the request).
          this.removeUnsent(f);
        } else if (f) {
          // WRITE-STARTED — best-effort notifications/cancelled (drop +
          // count if it does not fit). Never truncates the active write.
          this.admit(
            {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: p.id },
            },
            "best-effort",
          );
        }
        return true;
      }
    }
    return false;
  }

  /** Wait until the server is ready (resolves if already ready; rejects if
   *  it fails while waiting or is closed). */
  private ensureReady(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.closed || this.state === "failed") {
      return Promise.reject(
        new McpNotRunningError(
          `MCP server ${this.serverName} is not running` +
            (this.failReason ? ` (${this.failReason})` : ""),
        ),
      );
    }
    if (this.state === "disabled") {
      return Promise.reject(new McpNotRunningError(`server ${this.serverName} is disabled`));
    }
    if (!this.readyD) {
      return Promise.reject(new McpNotRunningError(`server ${this.serverName} not started`));
    }
    return this.readyD.promise;
  }

  // ── Inbound (stdout) ───────────────────────────────────────────────────────

  private onStdout(chunk: Buffer | string): void {
    if (this.closed) return;
    this.stdoutBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      // Frame bound: a line > 1 MiB is a protocol violation (no strike
      // counter — a server that cannot frame its output cannot recover).
      if (Buffer.byteLength(line, "utf8") > MCP_FRAME_LIMIT) {
        this.fail("stdout frame exceeds 1 MiB (protocol violation)");
        return;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        this.fail("stdout line is not valid JSON (framing violation)");
        return;
      }
      this.dispatch(obj);
    }
    // No-newline growth beyond the frame limit (the buffer IS the partial
    // frame).
    if (Buffer.byteLength(this.stdoutBuf, "utf8") > MCP_FRAME_LIMIT) {
      this.fail("stdout frame exceeds 1 MiB (no-newline growth)");
    }
  }

  private onStderr(chunk: Buffer | string): void {
    this.diags.stderr += chunk.toString("utf8");
    if (this.diags.stderr.length > MCP_STDERR_RING) {
      this.diags.stderr = this.diags.stderr.slice(-MCP_STDERR_RING);
    }
  }

  /** Classify by SHAPE first (method + id presence), then by pending state —
   *  so an id collision can never be misread as a pending request's answer. */
  private dispatch(obj: unknown): void {
    const v = this.validateEnvelope(obj);
    if (!v.ok) {
      this.fail("envelope violation: " + v.reason);
      return;
    }
    const m = v.value;
    const hasMethod = hasOwn(m, "method");
    const hasId = hasOwn(m, "id");
    if (!hasMethod && hasId) {
      // RESPONSE.
      const id = m.id;
      if (typeof id === "number" && Number.isInteger(id) && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        const hasResult = hasOwn(m, "result");
        const hasError = hasOwn(m, "error");
        if (p.probeResult) {
          this.settleProbe(id, hasError ? (m.error as RpcError) : null, hasResult ? m.result : null);
        } else {
          const err = hasError
            ? this.rpcToCallError(m.error as RpcError)
            : null;
          this.settle(id, hasResult ? m.result : null, err);
        }
        return;
      }
      // Non-matching (late/unknown id, a string id, or a null id) — counted,
      // dropped. The call it was meant for expires on its 60s timeout.
      this.diags.lateResponses++;
      return;
    }
    if (hasMethod && !hasId) {
      // NOTIFICATION.
      this.dispatchNotification(m.method as string);
      return;
    }
    // REQUEST (a string method + a PRESENT id — presence is the own-property
    // test, so id: null is a request). Answer -32601, echo the id verbatim.
    this.replyServerRequest(m.id);
  }

  /** Validate the JSON-RPC envelope. Inbound REQUEST ids and params are NOT
   *  validated (the request is answered -32601 with its id echoed verbatim,
   *  whatever their shapes). */
  private validateEnvelope(
    obj: unknown,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
    if (!isObj(obj)) return { ok: false, reason: "not a non-null object" };
    if (obj.jsonrpc !== "2.0") return { ok: false, reason: "jsonrpc is not '2.0'" };
    const hasMethod = hasOwn(obj, "method");
    const hasId = hasOwn(obj, "id");
    if (hasMethod && typeof obj.method !== "string") {
      return { ok: false, reason: "method is present but not a string" };
    }
    if (!hasMethod && !hasId) {
      return { ok: false, reason: "line has neither method nor id" };
    }
    if (!hasMethod && hasId) {
      // RESPONSE.
      const id = obj.id;
      const idOk =
        id === null ||
        typeof id === "string" ||
        (typeof id === "number" && Number.isFinite(id) && Number.isInteger(id));
      if (!idOk) {
        return {
          ok: false,
          reason: "response id is an object/boolean/array/fractional/non-finite number",
        };
      }
      if (hasOwn(obj, "params")) {
        return { ok: false, reason: "response has a stray params" };
      }
      const hasResult = hasOwn(obj, "result");
      const hasError = hasOwn(obj, "error");
      if (hasResult === hasError) {
        return {
          ok: false,
          reason: hasResult
            ? "response has both result and error"
            : "response has neither result nor error",
        };
      }
      if (id === null && hasResult) {
        return { ok: false, reason: "null response id is only allowed for an error" };
      }
      if (hasError) {
        const e = obj.error;
        if (!isObj(e)) return { ok: false, reason: "error is not a non-null object" };
        if (typeof e.code !== "number" || !Number.isInteger(e.code)) {
          return { ok: false, reason: "error.code is not an integer" };
        }
        if (typeof e.message !== "string") {
          return { ok: false, reason: "error.message is not a string" };
        }
      }
      return { ok: true, value: obj };
    }
    if (hasMethod && !hasId) {
      // NOTIFICATION — params must be absent or a JSON object (a deliberate
      // narrowing: MCP uses named parameters, never by-position arrays).
      if (hasOwn(obj, "params") && !isObj(obj.params)) {
        return { ok: false, reason: "notification params is not an object" };
      }
      if (hasOwn(obj, "result") || hasOwn(obj, "error")) {
        return { ok: false, reason: "notification carries result/error" };
      }
      return { ok: true, value: obj };
    }
    // REQUEST (method + present id) — but a non-response line carrying
    // result/error is still a violation.
    if (hasOwn(obj, "result") || hasOwn(obj, "error")) {
      return { ok: false, reason: "request carries result/error" };
    }
    return { ok: true, value: obj };
  }

  private dispatchNotification(method: string): void {
    switch (method) {
      case "notifications/cancelled":
        // Valid only for a server→client request; tier 1 retains none (every
        // server request is answered -32601 immediately), so this is
        // unmatched and NEVER aborts a client→server call — even on an id
        // collision.
        this.diags.unmatchedCancelled++;
        break;
      case "notifications/tools/list_changed":
        // Recorded for the tier-2 re-list rule; no tier-1 behavior.
        this.diags.toolListChanged++;
        break;
      default:
        // Any other envelope-VALID notification: recorded, ignored — never
        // an error, never a crash.
        this.diags.unknownNotifications++;
        break;
    }
  }

  /** Answer a server→client request with -32601 (MANDATORY control — an
   *  admission failure terminal-fails the server). Echo the id VERBATIM
   *  (id: null stays null); params are never inspected. One reply per
   *  request while the transport is healthy — never coalesced. */
  private replyServerRequest(id: unknown): void {
    this.diags.serverRequestsRejected++;
    this.admit(
      {
        jsonrpc: "2.0",
        id,
        error: { code: MCP_ERR_METHOD_NOT_FOUND, message: "method not supported" },
      },
      "mandatory",
    );
  }

  private rpcToCallError(e: RpcError): McpCallError {
    const err = new McpCallError(`MCP protocol error ${e.code}: ${e.message}`);
    err.rpc = e;
    return err;
  }

  // ── Outbound (frame queue + byte accounting) ──────────────────────────────

  /** Admit a frame. Returns the frame (with its id) or null. Applies the
   *  per-class failure policy on admission failure. Admission happens
   *  BEFORE reserve: a rejected frame is never enqueued. */
  private admit(
    obj: Record<string, unknown>,
    cls: FrameClass,
  ): Frame | null {
    const line = JSON.stringify(obj) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MCP_FRAME_LIMIT) {
      this.admissionFailure(cls, "frame exceeds 1 MiB");
      return null;
    }
    if (this.undrained + bytes > MCP_QUEUE_LIMIT) {
      this.admissionFailure(cls, "queue exceeds 4 MiB");
      return null;
    }
    const frame: Frame = {
      id: typeof obj.id === "number" ? obj.id : -1,
      data: Buffer.from(line, "utf8"),
      bytes,
      cls,
      writeStarted: false,
      released: false,
    };
    this.undrained += bytes;
    this.queue.push(frame);
    this.maybeStartStall();
    this.writeNext();
    return frame;
  }

  private admissionFailure(cls: FrameClass, reason: string): void {
    switch (cls) {
      case "tool":
        // In-band isError; the server stays healthy (the caller rejects).
        this.diags.droppedFrames++;
        break;
      case "startup":
        this.fail("startup frame not admitted: " + reason);
        break;
      case "mandatory":
        // Dropping a -32601 reply would leave the server request
        // unanswered and can stall the server → terminal.
        this.fail("mandatory control frame not admitted: " + reason);
        break;
      case "best-effort":
        // Dropped + counted; NO teardown (the session continues).
        this.diags.droppedFrames++;
        break;
    }
  }

  private writeNext(): void {
    if (this.writing || this.closed) return;
    // The active frame LEAVES the queue when its write starts (its bytes
    // stay counted in `undrained` until the error-free flush releases them).
    const f = this.queue.shift();
    if (!f) return;
    this.writing = true;
    f.writeStarted = true;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return; // exactly-once guard (callback + drain never double).
      done = true;
      this.writing = false;
      if (err) {
        // A callback WITH an error is a transport failure — NOT a deadline
        // reset, NOT counted progress.
        this.onWriteError(f, err);
        return;
      }
      this.onFlush(f);
    };
    try {
      const ret = this.transport.stdin.write(f.data, (err?: Error | null) => {
        finish(err ?? null);
      });
      // `ret === false` signals backpressure; the deadline signal is the
      // error-free callback OR a drain event (handled separately).
      void ret;
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** onFlush: release the frame's bytes EXACTLY ONCE, dispatch the next
   *  queued frame, and treat the error-free flush as a deadline signal. */
  private onFlush(f: Frame): void {
    if (f.released) return;
    f.released = true;
    this.undrained -= f.bytes;
    if (this.undrained < 0) this.undrained = 0;
    this.maybeCancelStall();
    this.resetStall();
    this.writeNext();
  }

  private onWriteError(f: Frame, err: Error): void {
    if (f.released) return;
    f.released = true;
    this.undrained -= f.bytes;
    if (this.undrained < 0) this.undrained = 0;
    this.fail("stdin write error: " + err.message);
  }

  /** Remove an UNSENT frame from the queue and release its reserved bytes
   *  immediately. Unsent removal is NOT write progress: re-evaluate the
   *  threshold and cancel the timer if below 256 KiB. */
  private removeUnsent(f: Frame): void {
    if (f.writeStarted || f.released) return;
    const i = this.queue.indexOf(f);
    if (i >= 0) this.queue.splice(i, 1);
    f.released = true;
    this.undrained -= f.bytes;
    if (this.undrained < 0) this.undrained = 0;
    this.maybeCancelStall();
    if (!this.writing) this.writeNext();
  }

  // ── Stall deadline ─────────────────────────────────────────────────────────

  private maybeStartStall(): void {
    if (this.stallTimer || this.closed) return;
    // Start at AT 256 KiB exactly (not strictly above).
    if (this.undrained >= MCP_STALL_THRESHOLD) {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        this.fail("write stall: no progress for 10s at/above 256 KiB");
      }, this.opts.stallMs ?? MCP_STALL_MS);
    }
  }

  private resetStall(): void {
    if (!this.stallTimer) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.maybeStartStall();
  }

  private maybeCancelStall(): void {
    if (this.stallTimer && this.undrained < MCP_STALL_THRESHOLD) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // ── Pending settlement ─────────────────────────────────────────────────────

  private settle(id: number, result: unknown, error: Error | null): void {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.deferred) {
      if (error) p.deferred.reject(error);
      else p.deferred.resolve(result);
    }
  }

  private settleProbeTimeout(id: number): void {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.probeTimeout?.();
  }

  private settleProbe(id: number, error: RpcError | null, result: unknown): void {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.probeResult?.(result, error);
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  /** Terminal failure: settle all pending (in-band transport failure), tear
   *  down the transport. A server that stays alive after a fatal response
   *  must not be left running. */
  fail(reason: string): void {
    if (this.closed) return;
    if (this.state === "failed") return;
    this.state = "failed";
    this.failReason = reason;
    this.settleAll(
      new McpCallError(
        `MCP server ${this.serverName} transport failure: ${reason}`,
      ),
    );
    this.readyD?.reject(
      new McpNotRunningError(
        `MCP server ${this.serverName} is not running (${reason})`,
      ),
    );
    this.teardown();
  }

  private settleAll(error: Error): void {
    for (const p of [...this.pending.values()]) {
      if (p.settled) continue;
      p.settled = true;
      clearTimeout(p.timer);
      this.pending.delete(p.id);
      if (p.probeFatal) {
        p.probeFatal(error.message);
      } else if (p.deferred) {
        p.deferred.reject(error);
      }
    }
  }

  private teardown(): void {
    this.closed = true;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.budgetTimer) {
      clearTimeout(this.budgetTimer);
      this.budgetTimer = null;
    }
    // Stop dispatch first; clear the queue and reset accounting to zero
    // (all outstanding reservations marked released). Late callbacks/drain
    // events from this failed transport are inert: the per-frame released
    // guards + the closed flag make them no-ops.
    this.queue = [];
    this.undrained = 0;
    this.writing = false;
    this.transport.stdout.off("data", this.onStdoutBound);
    this.transport.stdout.off("end", this.onStdoutEndBound);
    this.transport.stderr.off("data", this.onStderrBound);
    this.transport.stdin.off("error", this.onStdinErrorBound);
    this.transport.stdin.off("drain", this.onDrainBound);
    this.transport.kill();
  }

  /** Clean shutdown (idempotent): settle pending, close the transport
   *  (graceful: close stdin → SIGTERM → SIGKILL, per the transport). */
  close(): void {
    if (this.closed) return;
    this.settleAll(new McpCallError(`MCP server ${this.serverName} closed`));
    this.readyD?.reject(new McpNotRunningError(`MCP server ${this.serverName} closed`));
    this.teardown();
    this.transport.close();
  }
}
