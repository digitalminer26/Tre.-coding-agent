/**
 * WS7 — safety & permissions (PLAN.md §WS7).
 *
 * This is the `beforeToolCall` hook that gives the agent its two permission
 * boundaries, plus the destructive-command classifier:
 *
 *   1. PATH SANDBOX — write/edit are confined to the project root.
 *      The hook resolves each path argument against the root and REWRITES
 *      `args.path` to the absolute result, so the tool operates on exactly
 *      the file that was checked (this is what gives the CLI's `--cwd` its
 *      real meaning — tools no longer depend on the process cwd). Two
 *      checks, in order:
 *        - lexical: path.resolve(root, p) must stay under the root
 *          (kills `../` escapes and absolute paths outside)
 *        - realpath: the deepest EXISTING ancestor is realpath'd and must
 *          stay under the REAL root (kills symlinks that point outside)
 *      A refused path is a BLOCK → an isError result the model reads (I3).
 *      `read` is NOT sandboxed: by design it may read any file on the
 *      system (no root restriction, no approval prompt).
 *
 *   2. APPROVAL GATE — bash/write/edit are "gated". Default mode `ask`:
 *      prompt per gated call; anything but y denies.
 *        - mode "ask" (default): prompt per gated call
 *        - mode "yes": auto-approve gated calls — EXCEPT destructive
 *          bash commands (see 3)
 *        - mode "no": never prompt; gated calls are blocked outright
 *          (fail-closed; for non-interactive runs)
 *      A denial is a BLOCK → an isError result the model reads.
 *
 *   3. DESTRUCTIVE CONFIRMATION — DECISION (D8, PLAN.md): bash commands
 *      matching a destructive pattern require an explicit human confirm
 *      in EVERY mode (even when the target path is inside the workspace). Rationale: `--yes` is convenience for "let the
 *      agent work in my project", not a standing permission to destroy
 *      the machine. The patterns are intentionally conservative —
 *      over-prompting is safe, under-prompting is not:
 *        - rm with a recursive flag (-r / -R / --recursive), force or not
 *        - git push -f / --force / --force-with-lease
 *        - dd writing to /dev/* (raw block device)
 *        - shell redirection to raw block devices (>/dev/sd*, ...)
 *        - mkfs* (filesystem creation)
 *        - the classic fork bomb
 *        - shutdown / reboot / halt / poweroff
 *      Deliberately NOT listed: "dangerous but not destructive" (curl|sh,
 *      sudo, exfiltration) — the approval gate covers those whenever
 *      "yes" mode is off.
 *
 * I3: this hook never throws. A failing ask() (closed stdin, throw) is
 * treated as DENY (fail-closed). The pipeline turns a block into
 * `Tool "<name>" was blocked: <reason>` — an isError ToolResult the
 * model reads and adapts to (D7).
 */
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { BeforeToolCall } from "./pipeline.js";

/** Human prompt. `false` (or a throw) means "no". */
export type AskApproval = (question: string) => boolean | Promise<boolean>;

/** ask = prompt per gated call (default); yes = auto-approve except
 *  destructive; no = never prompt, always block gated calls. */
export type ApprovalMode = "ask" | "yes" | "no";

export interface SafetyOptions {
  /** Project root. Must exist — checked per call, fail-closed if not. */
  root: string;
  mode?: ApprovalMode;
  /** Human prompt. Required for mode "ask" (and destructive under "yes");
   *  if absent, those calls are denied (fail-closed). */
  ask?: AskApproval;
}

/** Tools whose `path` argument is sandboxed to the root. `read` is NOT
 *  here: it may read any file on the system (no root restriction, no
 *  approval prompt) — see the module header. */
const PATH_TOOLS = new Set(["write", "edit"]);
/** Tools that require approval. `read` is ungated (unrestricted reads). */
const GATED_TOOLS = new Set(["bash", "write", "edit"]);

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Check that `p` (relative or absolute) lands under `root`, and return the
 * canonical absolute path. `root` must exist (realpath'd). Any failure is
 * a refusal — never a throw.
 */
export async function checkPathWithinRoot(
  root: string,
  p: string,
): Promise<PathCheck> {
  const resolved = path.resolve(root, p);

  // Lexical containment (handles `../` and absolute paths).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return {
      ok: false,
      reason:
        `path "${p}" resolves to ${resolved}, which is outside the ` +
        `project root ${root} — use a path inside the working directory`,
    };
  }

  // Realpath containment (handles symlinks pointing outside).
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: `project root ${root} does not exist` };
  }
  const real = await realpathExisting(resolved);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return {
      ok: false,
      reason:
        `path "${p}" resolves to ${resolved}, which points outside the ` +
        `project root via a symlink (real path: ${real})`,
    };
  }
  return { ok: true, path: resolved };
}

/** realpath of the deepest existing ancestor of `p` (p may not exist yet). */
async function realpathExisting(p: string): Promise<string> {
  let cur = p;
  for (;;) {
    try {
      return await realpath(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(cur);
        if (parent === cur) return cur; // hit the filesystem root
        cur = parent;
      } else {
        return cur; // permission errors etc. — the lexical check already passed
      }
    }
  }
}

/**
 * Classify a bash command for destructiveness. Returns the human-readable
 * labels of every matched pattern (empty = not destructive). Patterns are
 * regex/token based and deliberately over-trigger: a false positive is an
 * extra prompt, a false negative is a destroyed machine.
 */
export function destructiveBashPatterns(command: string): string[] {
  const hits: string[] = [];
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);

  // rm with a recursive flag: rm -r / rm -R / rm --recursive (force or not)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "rm" && !/\/rm$/.test(t)) continue;
    let recursive = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const f = tokens[j]!;
      if (f === "--recursive") {
        recursive = true;
        continue;
      }
      if (f === "-" || !f.startsWith("-")) break; // end of flags
      if (f.startsWith("--")) continue; // other long flags (--force, ...)
      if (f.slice(1).includes("r") || f.slice(1).includes("R")) recursive = true;
    }
    if (recursive) hits.push("recursive rm");
  }

  // git push -f / --force / --force-with-lease
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const rest = tokens.slice(i + 1);
    const pi = rest.indexOf("push");
    if (pi === -1) continue;
    const force = rest.slice(pi + 1).some((f) => {
      if (f === "--force" || f === "--force-with-lease") return true;
      return f.startsWith("-") && !f.startsWith("--") && f.slice(1).includes("f");
    });
    if (force) hits.push("git push --force");
  }

  if (/\bdd\b/.test(command) && /of=\/dev\//.test(command)) {
    hits.push("dd writing to a raw device");
  }
  if (/>+ *\/dev\/(sd[a-z0-9]+|hd[a-z]+|xvd[a-z]+|nvme|disk)/.test(command)) {
    hits.push("write to a raw block device");
  }
  if (/\bmkfs(\.[a-z0-9]+)?\b/.test(command)) {
    hits.push("mkfs (filesystem creation)");
  }
  if (/:\(\)\s*\{/.test(command)) hits.push("fork bomb");
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(command)) {
    hits.push("system shutdown/reboot");
  }
  return hits;
}

/** The question shown to the human for a gated call. */
function approvalQuestion(
  toolName: string,
  args: Record<string, unknown>,
  destructive: string[],
  outside: string[] = [],
): string {
  const tags: string[] = [];
  if (destructive.length > 0) tags.push(`DESTRUCTIVE: ${destructive.join(", ")}`);
  if (outside.length > 0) tags.push(`outside the workspace: ${outside.join(", ")}`);
  const tag = tags.length > 0 ? ` [${tags.join("; ")}]` : "";
  if (toolName === "bash") {
    const cmd = typeof args.command === "string" ? args.command : String(args.command ?? "");
    const shown = cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    return `Approve bash${tag}: ${shown}? [y/N] `;
  }
  const p = typeof args.path === "string" ? args.path : String(args.path ?? "");
  return `Approve ${toolName}${tag}: ${p}? [y/N] `;
}

/**
 * Build the beforeToolCall hook. Returns `undefined` (run as-is) or
 * `{ blocked }` or `{ args }` (rewritten path). Never throws.
 */
export function makeSafetyHooks(opts: SafetyOptions): BeforeToolCall {
  const root = opts.root;
  const mode = opts.mode ?? "ask"; // default: prompt per gated call

  /** Gate a call; returns a block reason or undefined (allow). */
  const gate = async (
    toolName: string,
    args: Record<string, unknown>,
    destructive: string[],
    outside: string[] = [],
  ): Promise<string | undefined> => {
    if (mode === "no") {
      return (
        `approval is disabled (--no-approve): the "${toolName}" tool requires ` +
        `approval — re-run without --no-approve to allow it`
      );
    }
    if (mode === "yes" && destructive.length === 0) return undefined; // auto-approve
    const question = approvalQuestion(toolName, args, destructive, outside);
    let ok = false;
    if (opts.ask) {
      try {
        ok = (await opts.ask(question)) === true;
      } catch {
        ok = false; // fail-closed: a broken prompt is a denial
      }
    }
    if (!ok) {
      return destructive.length > 0
        ? `the user DENIED this destructive command (${destructive.join(", ")}) — do not retry it`
        : `the user denied the "${toolName}" call — do not retry it unchanged`;
    }
    return undefined;
  };

  return async (tool, call) => {
    const args = call.arguments;

    // 1. path sandbox (read/write/edit)
    if (PATH_TOOLS.has(tool.name)) {
      const p = args.path;
      if (typeof p !== "string" || p.length === 0) {
        return {
          blocked:
            'missing required string argument "path" (the validation layer should have caught this)',
        };
      }
      const check = await checkPathWithinRoot(root, p);
      if (!check.ok) return { blocked: check.reason };
      const newArgs = { ...args, path: check.path };

      // 2. approval gate (write/edit; read is ungated and unrestricted)
      if (GATED_TOOLS.has(tool.name)) {
        const blocked = await gate(tool.name, newArgs, []);
        if (blocked !== undefined) return { blocked };
      }
      if (newArgs !== args) return { args: newArgs }; // rewrite for the tool
      return undefined;
    }

    // 3. bash: destructive classification + approval gate. Every bash call
    //    prompts in "ask" mode (even read-only); "yes" auto-approves
    //    non-destructive; "no" blocks. Destructive bash confirms in every mode.
    if (tool.name === "bash") {
      const cmd = typeof args.command === "string" ? args.command : "";
      const destructive = cmd.length > 0 ? destructiveBashPatterns(cmd) : [];
      const blocked = await gate(tool.name, args, destructive);
      if (blocked !== undefined) return { blocked };
    }
    return undefined;
  };
}

/**
 * Serialize prompts: a parallel tool batch may contain several gated calls,
 * and only one question may be on screen at a time. FIFO queue.
 */
export function makeAskQueue(inner: AskApproval): AskApproval {
  let tail: Promise<unknown> = Promise.resolve();
  return (q) => {
    const p = tail.then(() => inner(q));
    tail = p.catch(() => {});
    return p;
  };
}
