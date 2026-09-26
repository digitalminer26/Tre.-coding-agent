/**
 * WS7 — safety & permissions (PLAN.md §WS7).
 *
 * This is the `beforeToolCall` hook that gives the agent its permission
 * boundaries. Two layers:
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
 *      `read` is NOT path-sandboxed: by design it may read any file on the
 *      system (no root restriction).
 *
 *   2. APPROVAL GATE — a classification + mode matrix. Every call is
 *      classified first, then the mode decides:
 *
 *        classification  ask (default)          yes                    no
 *        ─────────────── ─────────────────────  ─────────────────────  ─────────────────────
 *        read-only bash  allow, no prompt       allow, no prompt       ALLOW (only bash class)
 *        reversible bash allow, no prompt       allow, no prompt       block
 *        mutating bash   prompt                 allow, no prompt       block
 *        write/edit      allow, no prompt       allow, no prompt       block
 *        read (plain)   allow, no prompt       allow, no prompt       block (fail-closed)
 *        sensitive       prompt [SENSITIVE]     prompt [SENSITIVE]     block
 *        destructive     prompt [DESTRUCTIVE]   prompt [DESTRUCTIVE]   block
 *
 *      The user is only prompted for SENSITIVE reads and DESTRUCTIVE /
 *      irreversible actions. Everything routine (read-only inspection,
 *      reversible git/npm/filesystem ops, in-workspace writes) runs without
 *      a prompt in "ask" mode. When a prompt IS shown for a plain mutating
 *      command, the question states its reversibility ("not provably
 *      reversible") so the human can weigh it.
 *
 *      - mode "ask" (default): prompt only for sensitive and destructive
 *      - mode "yes": auto-approve everything EXCEPT sensitive and
 *        destructive (both confirm; deny when there is no human)
 *      - mode "no" (fail-closed): allow ONLY read-only, non-sensitive bash;
 *        everything else is blocked outright (no prompts, ever)
 *      A denial is a BLOCK → an isError result the model reads.
 *
 *   3. CLASSIFIERS (pure, exported for tests). Bash check order:
 *      destructive → sensitive → read-only → reversible → mutating.
 *
 *      DESTRUCTIVE — irreversible; prompts in EVERY mode (D8):
 *        - rm with a recursive flag (-r / -R / --recursive), force or not
 *        - git push (ANY — publishing to a remote is irreversible)
 *        - git reset --hard
 *        - git clean with a force flag (-f / -fd / -x)
 *        - git branch -D (force-delete a branch)
 *        - git checkout . / git checkout -- <path> / git restore (without
 *          --source) — all discard uncommitted work
 *        - dd writing to /dev/* (raw block device)
 *        - shell redirection to raw block devices (>/dev/sd*, ...)
 *        - mkfs* (filesystem creation)
 *        - the classic fork bomb
 *        - shutdown / reboot / halt / poweroff
 *
 *      SENSITIVE — reading secret/key material; prompts in EVERY mode:
 *        - bash whose arguments reference sensitive paths: ~/.ssh/, ~/.aws/,
 *          ~/.gnupg/, ~/.kube/, ~/.config/gcloud/, ~/.docker/config.json,
 *          ~/.netrc, /etc/shadow, id_rsa*, id_ed25519*, *.pem, *.key,
 *          *.p12, *.pfx, and .env-family files (.env, .env.*, *.env)
 *        - the `read` tool when the RESOLVED path matches the same
 *          patterns (read stays unrestricted for all non-sensitive paths)
 *
 *      READ-ONLY — inspection; no prompt in any mode that allows it:
 *        - read-only verbs: ls, cat, head, tail, wc, file, stat, du, df,
 *          pwd, whoami, id, echo, printf, which, type, date, uname, grep,
 *          egrep, fgrep, rg, ag, find, tree, sort, uniq, diff, cmp, cut,
 *          column, basename, dirname, realpath, readlink, md5sum, sha1sum,
 *          sha256sum, xxd, od, ps, lsof, netstat, ifconfig
 *        - git read-only subcommands: status, diff, log, show, branch
 *          (list), tag (list), remote, rev-parse, ls-files, describe,
 *          blame, stash list
 *        - kubectl get/describe/version/top
 *        - docker ps/images/inspect/logs/version
 *        - `ip addr` (the read-only form of `ip`)
 *      A compound command (; && || |) counts as read-only ONLY if EVERY
 *      segment is read-only. A command substitution / backtick whose INNER
 *      command is itself read-only counts as a safe opaque argument (e.g.
 *      `echo $(date)`); a substitution whose inner command is not read-only
 *      is NOT read-only (fail-closed). sudo and an output redirect to a real
 *      path (redirects to /dev/null and fd dups like 2>&1 are fine) are NOT
 *      read-only. Anything unrecognized is never read-only (fail-closed).
 *
 *      REVERSIBLE — undoable in practice; no prompt in ask/yes:
 *        - git add, git commit, git stash (push/list), git switch <branch>,
 *          git checkout <branch> (but NOT `checkout .` / `checkout --
 *          <path>` — those are destructive), git branch <newname>,
 *          git tag <newname>, npm run <script>, npm test
 *        - filesystem verbs confined to the workspace by the kernel sandbox
 *          and undoable: mv (mv back), cp (delete the copy), mkdir / rmdir
 *          (rmdir / mkdir), touch (rm), ln (rm the link), chmod / chown
 *          (restore prior mode/owner), sed -i (in-place edit, undo via git),
 *          tee (writes to a file, undo via git)
 *
 *      MUTATING — everything else (curl, pip, unrecognized verbs): prompts
 *      in ask (the question notes it is "not provably reversible"),
 *      auto-allowed in yes, blocked in no.
 *
 *      Deliberately NOT destructive: "dangerous but not destructive"
 *      (curl|sh, exfiltration) — the approval gate covers those whenever
 *      "yes" mode is off.
 *
 * I3: this hook never throws. A failing ask() (closed stdin, throw) is
 * treated as DENY (fail-closed). The pipeline turns a block into
 * `Tool "<name>" was blocked: <reason>` — an isError ToolResult the
 * model reads and adapts to (D7).
 */
import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { BeforeToolCall } from "./pipeline.js";

/** Human prompt. `false` (or a throw) means "no". */
export type AskApproval = (question: string) => boolean | Promise<boolean>;

/** ask = prompt only sensitive+destructive (default); yes = auto-approve
 *  except sensitive+destructive; no = allow only read-only non-sensitive
 *  bash, block everything else. */
export type ApprovalMode = "ask" | "yes" | "no";

export interface SafetyOptions {
  /** Project root. Must exist — checked per call, fail-closed if not. */
  root: string;
  mode?: ApprovalMode;
  /** Human prompt. Required for sensitive/destructive confirmations (and
   *  mutating bash in "ask"); if absent, those calls are denied
   *  (fail-closed). */
  ask?: AskApproval;
}

/** Tools whose `path` argument is sandboxed to the root. `read` is NOT
 *  here: it may read any file on the system (no root restriction) — see
 *  the module header. */
const PATH_TOOLS = new Set(["write", "edit"]);
/** Tools that go through the approval gate. `read` goes through the gate
 *  too, but only as a SENSITIVE check in ask/yes (sensitive paths prompt in
 *  every mode; all other reads are unrestricted) — and in no mode even
 *  plain reads are blocked (fail-closed: no human to confirm anything). */
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

// ─────────────────────────── classification ───────────────────────────

/**
 * Classify a bash command for destructiveness. Returns the human-readable
 * labels of every matched pattern (empty = not destructive). Patterns are
 * regex/token based and deliberately over-trigger: a false positive is an
 * extra prompt, a false negative is a destroyed machine.
 */
export function destructiveBashPatterns(command: string): string[] {
  // The raw scan sees tokens of the WHOLE command, but a destructive verb
  // hidden inside a substitution (`git commit -m "$(rm -rf /)"`) is glued to
  // the `$(` token and invisible to it. Inherit the labels from every
  // substitution's inner command (recursively — each inner is strictly
  // shorter, so this terminates; unbalanced substitutions are ignored here,
  // because the RO/REV classifiers already gate them as unsafe).
  const hits = rawDestructiveHits(command);
  const inners = findSubstitutions(command);
  if (inners !== null) {
    for (const inner of inners) {
      for (const h of destructiveBashPatterns(inner)) {
        if (!hits.includes(h)) hits.push(h);
      }
    }
  }
  return hits;
}

/**
 * `git` subcommand = the FIRST positional argument after the git token,
 * skipping global flags (`-C <path>` and `-c <val>` each consume a value;
 * other leading flags are skipped). Destructive git checks must match the
 * SUBCOMMAND, not a word anywhere in the argument list — `git stash push
 * -m wip` is not `git push`. Returns null when no positional remains.
 */
function gitSubcommand(rest: string[]): { sub: string; args: string[] } | null {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i]!;
    if (t === "-C" || t === "-c") i += 2; // global flags that take a value
    else if (t.startsWith("-")) i += 1; // other leading flags (--git-dir=…)
    else break;
  }
  if (i >= rest.length) return null;
  return { sub: rest[i]!, args: rest.slice(i + 1) };
}

/** The raw token/regex destructive scan (no substitution recursion). */
function rawDestructiveHits(command: string): string[] {
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

  // git push — ANY push (publishing to a remote is irreversible; force
  // pushes are the obvious subset). Only when `push` IS the subcommand —
  // `git stash push -m wip` is a local, undoable operation.
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "push") continue;
    const force = sc.args.some((f) => {
      if (f === "--force" || f === "--force-with-lease") return true;
      return f.startsWith("-") && !f.startsWith("--") && f.slice(1).includes("f");
    });
    hits.push(force ? "git push --force" : "git push (publishes to a remote)");
  }

  // git reset --hard (discards uncommitted work + moves the branch)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "reset") continue;
    if (sc.args.includes("--hard")) hits.push("git reset --hard");
  }

  // git clean with a force flag (-f / -fd / -x): removes untracked files
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "clean") continue;
    const forced = sc.args.some((f) => {
      if (f === "--force") return true;
      if (f.startsWith("--")) return false; // other long flags
      // short flags: an "f" or "x" means force (-f, -fd, -fx, -x, ...);
      // -n / --dry-run does NOT remove anything → not destructive
      return f.startsWith("-") && /f|x/.test(f.slice(1));
    });
    if (forced) hits.push("git clean (removes untracked files)");
  }

  // git branch -D (force-delete a branch)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "branch") continue;
    if (sc.args.some((f) => f === "-D" || f === "--delete")) {
      hits.push("git branch -D (force-delete a branch)");
    }
  }

  // git checkout . / git checkout -- <path> (discard uncommitted work)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "checkout") continue;
    const args = sc.args;
    if (args.includes(".") || args.includes("--")) {
      hits.push("git checkout . / -- <path> (discards uncommitted work)");
    }
  }

  // git restore (without --source: restores from the index/HEAD, discarding
  // uncommitted work)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "git" && !/\/git$/.test(t)) continue;
    const sc = gitSubcommand(tokens.slice(i + 1));
    if (!sc || sc.sub !== "restore") continue;
    if (!sc.args.includes("--source")) {
      hits.push("git restore (discards uncommitted work)");
    }
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

/** Sensitive path patterns, in priority order (first match labels the
 *  prompt). Two groups:
 *  - FILENAME: matches the basename of ANY command token (e.g. `cat
 *    server.key`, `cat .env`, `cat file.env`) — no path context needed.
 *  - PATH: needs a path-like token (starts with ~, /, . or contains /) —
 *    e.g. `cat ~/.ssh/id_rsa`, `cat /etc/shadow`.
 *  Each: a label for the [SENSITIVE: …] tag + a matcher over the path's
 *  segments (split on "/"). */
const SENSITIVE_FILENAME: { label: string; test: (segs: string[]) => boolean }[] = [
  { label: "~/.netrc", test: (s) => s[s.length - 1] === ".netrc" },
  { label: "id_rsa*", test: (s) => s.some((x) => /^id_rsa/.test(x)) },
  { label: "id_ed25519*", test: (s) => s.some((x) => /^id_ed25519/.test(x)) },
  { label: "*.pem", test: (s) => s.some((x) => x.endsWith(".pem")) },
  { label: "*.key", test: (s) => s.some((x) => x.endsWith(".key")) },
  { label: "*.p12", test: (s) => s.some((x) => x.endsWith(".p12")) },
  { label: "*.pfx", test: (s) => s.some((x) => x.endsWith(".pfx")) },
  { label: ".env*", test: (s) => s.some((x) => x === ".env" || /^\.env\./.test(x) || /\.env$/.test(x)) },
];
const SENSITIVE_PATH: { label: string; test: (segs: string[]) => boolean }[] = [
  { label: "~/.ssh/", test: (s) => s.includes(".ssh") },
  { label: "~/.aws/", test: (s) => s.includes(".aws") },
  { label: "~/.gnupg/", test: (s) => s.includes(".gnupg") },
  { label: "~/.kube/", test: (s) => s.includes(".kube") },
  { label: "~/.config/gcloud/", test: (s) => s.includes("gcloud") },
  { label: "~/.docker/config.json", test: (s) => s.includes(".docker") && s[s.length - 1] === "config.json" },
  { label: "/etc/shadow", test: (s) => s[s.length - 1] === "shadow" && s[s.length - 2] === "etc" },
];

/** Expand a leading "~" (or "~user") to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Sensitive patterns matched by a (possibly relative) path. Used for the
 *  `read` tool's RESOLVED path argument. */
function sensitivePathPatterns(p: string): string[] {
  const segs = expandHome(p).split("/").filter((s) => s.length > 0);
  const hits: string[] = [];
  for (const pat of [...SENSITIVE_FILENAME, ...SENSITIVE_PATH]) {
    if (pat.test(segs)) hits.push(pat.label);
  }
  return hits;
}

/**
 * Classify a bash command for sensitive-path access. Returns the labels of
 * every sensitive pattern referenced by a command argument (empty = none).
 * FILENAME patterns are checked against every token (a bare `server.key` or
 * `.env` names a file); PATH patterns need a path-like token (starts with
 * ~, /, or . or contains / — e.g. `cat /etc/shadow`, `cat ~/.ssh/id_rsa`).
 */
export function sensitiveBashPatterns(command: string): string[] {
  const hits: string[] = [];
  for (const t of command.split(/\s+/).filter((x) => x.length > 0)) {
    const segs = expandHome(t).split("/").filter((s) => s.length > 0);
    const pathLike = t.startsWith("~") || t.startsWith("/") || t.startsWith(".") || t.includes("/");
    const pats = pathLike ? [...SENSITIVE_FILENAME, ...SENSITIVE_PATH] : SENSITIVE_FILENAME;
    for (const pat of pats) {
      if (pat.test(segs) && !hits.includes(pat.label)) hits.push(pat.label);
    }
  }
  return hits;
}

/** Read-only verbs (whole command = one of these, with any arguments). */
const READONLY_VERBS = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "pwd",
  // shell no-ops that start most model commands: cd (changes only the
  // subshell's cwd), test/[ (evaluate), true/false, sleep, env print
  "cd", "test", "[", "true", "false", "sleep", "env", "printenv",
  "whoami", "id", "echo", "printf", "which", "type", "date", "uname",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "tree", "sort", "uniq",
  "diff", "cmp", "cut", "column", "basename", "dirname", "realpath",
  "readlink", "md5sum", "sha1sum", "sha256sum", "xxd", "od", "ps", "lsof",
  "netstat", "ifconfig",
]);

/** git subcommands that are read-only. */
const GIT_READONLY_SUBS = new Set([
  "status", "diff", "log", "show", "remote", "rev-parse", "ls-files",
  "describe", "blame",
]);
/** git subcommands that are read-only ONLY in their listed form. */
const GIT_READONLY_RESTRICTED: Record<string, (rest: string[]) => boolean> = {
  branch: (r) => r.length === 0, // `git branch` (list)
  tag: (r) => r.length === 0, // `git tag` (list)
  stash: (r) => r.length >= 1 && r[0] === "list", // `git stash list`
};

/**
 * Filesystem verbs that are undoable in practice (mv → mv back, cp → delete
 * the copy, mkdir/rmdir → the opposite, touch → rm, ln → rm the link,
 * chmod/chown → restore prior mode/owner, sed -i / tee → in-place edit
 * undone via git). They are NOT read-only, so they must be classified
 * reversible to skip the prompt; the kernel sandbox confines them to the
 * workspace, which is what keeps them reversible in practice.
 */
const REVERSIBLE_FS_VERBS = new Set([
  "mv", "cp", "mkdir", "rmdir", "touch", "ln", "chmod", "chown", "sed", "tee",
]);

/** kubectl subcommands that are read-only. */
const KUBECTL_READONLY = new Set(["get", "describe", "version", "top"]);
/** docker subcommands that are read-only. */
const DOCKER_READONLY = new Set(["ps", "images", "inspect", "logs", "version"]);

/**
 * Is this bash command read-only (inspection)?
 *
 * Rules (fail-closed — anything unrecognized is NOT read-only):
 *  - a compound command (; && || |) is read-only ONLY if EVERY segment is
 *  - $( ), backticks, sudo, and output redirects to a real path
 *    (>/dev/null and fd dups like 2>&1 are fine) disqualify
 *  - each segment: a read-only verb, or a read-only git/kubectl/docker/ip
 *    subcommand form
 */
/**
 * Verdict on a command's shell constructs (command substitutions, backticks,
 * sudo, output redirects), evaluated for a given classifier PURPOSE:
 *  - "safe": no constructs, or every substitution's inner command is
 *    acceptable for the purpose — read-only inners are always acceptable;
 *    a reversible (mutating) inner is acceptable only for the "reversible"
 *    purpose (it has side effects, so it is NOT read-only). The safe
 *    substitutions count as opaque arguments.
 *  - "unsafe": a construct is not provably safe for the purpose (a
 *    substitution whose inner is not acceptable, or sudo, or a redirect to
 *    a real path) — the command is not read-only/reversible
 *  - "destructive": a substitution's inner command is destructive — the
 *    whole command is destructive (prompts in every mode)
 * Fail-closed: anything unrecognized (an unbalanced substitution, deep
 * nesting) is "unsafe".
 */
type ConstructVerdict =
  | { kind: "safe" }
  | { kind: "unsafe" }
  | { kind: "destructive"; labels: string[] };

/** Which classifier asked for the construct verdict. */
type ConstructPurpose = "readonly" | "reversible";

/** Maximum substitution nesting depth before we give up (fail-closed). */
const MAX_SUB_DEPTH = 4;

/**
 * Classify a command's shell constructs for a given classifier purpose. See
 * ConstructVerdict. A command with no constructs (or only substitutions
 * whose inners are acceptable for the purpose) is "safe"; sudo and a
 * redirect to a real path are "unsafe"; a substitution whose inner command
 * is destructive makes the whole command "destructive".
 */
function constructVerdict(command: string, purpose: ConstructPurpose, depth = 0): ConstructVerdict {
  // sudo is never safe
  if (/\bsudo\b/.test(command)) return { kind: "unsafe" };
  // Output redirect to a real path (not /dev/null, not a pure fd dup).
  for (const m of command.matchAll(/>{1,2} *([^|\s;&)]*)/g)) {
    const target = (m[1] ?? "").trim();
    if (target === "" || target === "/dev/null") continue;
    if (/^\d+$/.test(target)) continue; // fd dup (2>&1 has no target here)
    return { kind: "unsafe" };
  }
  // Command substitutions: $(...) and backticks.
  const inners = findSubstitutions(command);
  if (inners === null) return { kind: "unsafe" }; // unbalanced — fail closed
  if (inners.length === 0) return { kind: "safe" };
  if (depth > MAX_SUB_DEPTH) return { kind: "unsafe" };
  const labels: string[] = [];
  let unsafe = false;
  for (const inner of inners) {
    const v = substitutionInnerVerdict(inner, purpose, depth + 1);
    if (v.kind === "destructive") {
      for (const l of v.labels) if (!labels.includes(l)) labels.push(l);
    } else if (v.kind === "unsafe") {
      unsafe = true;
    }
  }
  if (labels.length > 0) return { kind: "destructive", labels };
  if (unsafe) return { kind: "unsafe" };
  return { kind: "safe" };
}

/**
 * Verdict on a command substitution's INNER command for a given purpose:
 * "safe" if it is acceptable for the purpose (read-only inners always; a
 * reversible inner only for the "reversible" purpose), "destructive" if it
 * is destructive, "unsafe" otherwise (fail-closed).
 */
function substitutionInnerVerdict(inner: string, purpose: ConstructPurpose, depth: number): ConstructVerdict {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return { kind: "unsafe" };
  if (depth > MAX_SUB_DEPTH) return { kind: "unsafe" };
  // Nested constructs inside the inner command (substitutions, sudo, ...).
  const nested = constructVerdict(trimmed, purpose, depth);
  if (nested.kind === "destructive") return nested;
  if (nested.kind === "unsafe") return { kind: "unsafe" };
  // Read-only inners are acceptable for BOTH purposes.
  if (isReadOnlyBashDepth(trimmed, depth)) return { kind: "safe" };
  // A reversible (mutating) inner is acceptable only for the reversible
  // classifier — it has side effects, so it is NOT a read-only argument.
  if (purpose === "reversible" && isReversibleBashDepth(trimmed, depth)) return { kind: "safe" };
  // Destructive at the top level (rm -rf, git push, ...).
  const destr = destructiveBashPatterns(trimmed);
  if (destr.length > 0) return { kind: "destructive", labels: destr };
  return { kind: "unsafe" };
}

/**
 * Find all command substitutions in `command`: `$(...)` and backtick
 * `` `...` ``. Returns the inner command text of each (respecting quotes,
 * nesting, and heredocs). Returns `null` if any substitution is UNBALANCED
 * (unterminated) — the caller treats the whole command as unsafe
 * (fail-closed).
 */
function findSubstitutions(command: string): string[] | null {
  const inners: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      // single-quoted: no expansion; skip to the closing quote
      i++;
      while (i < n && command[i] !== "'") i++;
      i++; // skip the closing quote (or run past the end)
      continue;
    }
    if (c === '"') {
      // double-quoted: $( ) inside IS expanded, so keep scanning (just
      // skip the quote char itself)
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const r = extractBalanced(command, i + 2, "(", ")");
      if (r === null) return null; // unbalanced — fail closed
      inners.push(r.text);
      i = r.end;
      continue;
    }
    if (c === "`") {
      const r = extractBacktick(command, i + 1);
      if (r === null) return null; // unbalanced — fail closed
      inners.push(r.text);
      i = r.end;
      continue;
    }
    i++;
  }
  return inners;
}

/**
 * Extract a balanced `open...close` region starting at `start` (just after
 * the first `open`). Returns the inner text and the index just past the
 * matching `close`, or null if unbalanced. Respects quotes, nested
 * substitutions, and heredocs.
 */
function extractBalanced(
  command: string,
  start: number,
  open: string,
  close: string,
): { text: string; end: number } | null {
  let depth = 1;
  let i = start;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      i++;
      while (i < n && command[i] !== "'") i++;
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (command[i] === "\\") { i += 2; continue; }
        if (command[i] === '"') break;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      const skipped = skipHeredoc(command, i);
      if (skipped === -1) return null; // unterminated heredoc
      i = skipped;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      depth++;
      i += 2;
      continue;
    }
    if (c === "`") {
      const r = extractBacktick(command, i + 1);
      if (r === null) return null;
      i = r.end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: command.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/** Extract a backtick `` `...` `` region starting at `start` (just after
 *  the opening backtick). Returns the inner text and the index just past
 *  the closing backtick, or null if unbalanced. */
function extractBacktick(command: string, start: number): { text: string; end: number } | null {
  let i = start;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      i++;
      while (i < n && command[i] !== "'") i++;
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (command[i] === "\\") { i += 2; continue; }
        if (command[i] === '"') break;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const r = extractBalanced(command, i + 2, "(", ")");
      if (r === null) return null;
      i = r.end;
      continue;
    }
    if (c === "`") {
      return { text: command.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/**
 * Given the index of the first `<` of a `<<`/`<<-`/`<<<` operator, return
 * the index just past the heredoc/here-string (or -1 if unterminated). A
 * heredoc body may contain anything (including `)`), so it must be skipped
 * whole when balancing the enclosing substitution.
 */
function skipHeredoc(command: string, i: number): number {
  const n = command.length;
  let d = i + 2;
  if (d < n && command[d] === "<") {
    // here-string <<<: the content is on the same line; skip to end of line
    const nl = command.indexOf("\n", d + 1);
    return nl === -1 ? n : nl + 1;
  }
  if (d < n && command[d] === "-") d++;
  // read the delimiter (possibly quoted)
  let delim = "";
  if (d < n && (command[d] === "'" || command[d] === '"')) {
    const q = command[d];
    d++;
    while (d < n && command[d] !== q) { delim += command[d]!; d++; }
    if (d >= n) return -1;
    d++; // skip the closing quote
  } else {
    while (d < n && !/\s/.test(command[d]!)) { delim += command[d]!; d++; }
  }
  if (delim.length === 0) return -1; // not a heredoc (e.g. `<< 2`)
  // the body starts after the newline following the <<delim
  const nl = command.indexOf("\n", d);
  if (nl === -1) return -1;
  let searchFrom = nl + 1;
  while (searchFrom <= n) {
    const lineEnd = command.indexOf("\n", searchFrom);
    const line = command.slice(searchFrom, lineEnd === -1 ? n : lineEnd);
    if (line.replace(/^\t+/, "") === delim) {
      return (lineEnd === -1 ? n : lineEnd) + 1;
    }
    if (lineEnd === -1) return -1;
    searchFrom = lineEnd + 1;
  }
  return -1;
}

export function isReadOnlyBash(command: string): boolean {
  return isReadOnlyBashDepth(command, 0);
}

/**
 * Read-only check at a given substitution depth. At depth 0 the command's
 * constructs are evaluated (a substitution with a read-only/reversible
 * inner counts as a safe opaque argument); at depth > 0 (we are inside a
 * substitution) constructs are NOT evaluated — the inner command is treated
 * as a plain command (its own substitutions are checked by the outer
 * substitution's verdict, not here).
 */
function isReadOnlyBashDepth(command: string, depth: number): boolean {
  if (command.length === 0) return false;
  if (depth === 0) {
    const v = constructVerdict(command, "readonly", 0);
    if (v.kind !== "safe") return false;
  }
  // Compound: every segment must be read-only.
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return false;
  return segments.every((seg) => isReadOnlySegment(seg.trim()));
}

/** One (non-compound) segment: a single command with its arguments. */
function isReadOnlySegment(seg: string): boolean {
  const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const base = path.basename(tokens[0]!);
  const rest = tokens.slice(1);
  if (base === "git") return isReadOnlyGit(rest);
  if (base === "kubectl") return rest.length > 0 && KUBECTL_READONLY.has(rest[0]!);
  if (base === "docker") return rest.length > 0 && DOCKER_READONLY.has(rest[0]!);
  if (base === "ip") return rest[0] === "addr"; // `ip addr` (read-only form)
  return READONLY_VERBS.has(base);
}

/** `git <sub> …` — read-only only for the listed subcommand forms. */
function isReadOnlyGit(rest: string[]): boolean {
  if (rest.length === 0) return false;
  // Skip global flags (e.g. `git -C dir status`) — fail-closed on anything
  // we don't recognize as a flag.
  let i = 0;
  while (rest[i]!.startsWith("-")) {
    if (rest[i] === "-C") i += 2; // -C <path>
    else i += 1;
    if (i >= rest.length) return false;
  }
  const sub = rest[i]!;
  const subRest = rest.slice(i + 1);
  if (GIT_READONLY_SUBS.has(sub)) return true;
  const restricted = GIT_READONLY_RESTRICTED[sub];
  if (restricted) return restricted(subRest);
  return false;
}

/**
 * Is this bash command reversible (safe to undo via git / re-run)?
 * Fail-closed: only the explicitly listed forms qualify.
 *  - git add, git commit, git stash (push/list), git switch <branch>,
 *    git checkout <branch> (NOT `checkout .` / `checkout -- <path>` —
 *    those are destructive), git branch <newname>, git tag <newname>,
 *    npm run <script>, npm test
 * Compounds qualify only if EVERY segment is individually reversible or
 * read-only — the model's standard `git add -A && git commit -m "msg"` and
 * `npm run build 2>&1 | tail -3` are; anything with a merely unknown
 * mutating segment stays gated (fail-closed).
 */
export function isReversibleBash(command: string): boolean {
  return isReversibleBashDepth(command, 0);
}

/**
 * Reversible check at a given substitution depth. At depth 0 the command's
 * constructs are evaluated (a substitution with a read-only/reversible
 * inner counts as a safe opaque argument); at depth > 0 (we are inside a
 * substitution) constructs are NOT evaluated — the inner command is treated
 * as a plain command.
 */
function isReversibleBashDepth(command: string, depth: number): boolean {
  if (command.length === 0) return false;
  if (depth === 0) {
    const v = constructVerdict(command, "reversible", 0);
    if (v.kind !== "safe") return false;
  }
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return false;
  // Every segment must be a reversible mutation or read-only, and at least
  // one segment must mutate (a purely read-only compound is read-only, not
  // "reversible" — the gate treats both as no-prompt, so this only keeps
  // the classifiers' meanings orthogonal).
  let hasMutation = false;
  for (const seg of segments) {
    const t = seg.trim();
    if (isReversibleSegment(t)) hasMutation = true;
    else if (!isReadOnlySegment(t)) return false;
  }
  return hasMutation;
}

/** One (non-compound) segment: a reversible mutation (the git/npm forms above). */
function isReversibleSegment(seg: string): boolean {
  const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  const base = path.basename(tokens[0]!);
  const rest = tokens.slice(1);
  if (base === "npm") {
    if (rest[0] === "test") return true;
    // npm run <script> — rest = ["run", "<script>"] (at least 2 tokens)
    if (rest[0] === "run" && rest.length >= 2) return true;
    return false;
  }
  // Undoable filesystem verbs (see REVERSIBLE_FS_VERBS). `sed` only in its
  // in-place form (`-i` / `--in-place`): without it, sed prints to stdout
  // and is read-only, not a mutation at all.
  if (REVERSIBLE_FS_VERBS.has(base)) {
    if (base === "sed") {
      return rest.some((f) => f === "-i" || f.startsWith("--in-place"));
    }
    return true;
  }
  if (base !== "git") return false;
  // Skip global flags (e.g. `git -C dir add .`).
  let i = 0;
  while (rest[i]!.startsWith("-")) {
    if (rest[i] === "-C") i += 2;
    else i += 1;
    if (i >= rest.length) return false;
  }
  const sub = rest[i]!;
  const subRest = rest.slice(i + 1);
  switch (sub) {
    case "add":
      return true;
    case "commit":
      return true;
    case "switch":
      return subRest.length >= 1; // git switch <branch>
    case "stash":
      return subRest.length === 0 || subRest[0] === "push" || subRest[0] === "list";
    case "branch":
      // git branch <newname> — create (NOT -d/-D/-m/-c/-M: destructive or
      // rename; those go to the destructive classifier or stay mutating)
      return subRest.length === 1 && !subRest[0]!.startsWith("-");
    case "tag":
      // git tag <newname> — create (NOT -d: delete)
      return subRest.length === 1 && !subRest[0]!.startsWith("-");
    case "checkout":
      // git checkout <branch> — switch branches. NOT `checkout .` /
      // `checkout -- <path>` (discard uncommitted work — destructive).
      return (
        subRest.length >= 1 &&
        !subRest.includes("--") &&
        !subRest.includes(".") &&
        !subRest[0]!.startsWith("-")
      );
    default:
      return false;
  }
}

// ─────────────────────────── approval gate ───────────────────────────

/** The question shown to the human for a gated call. */
function approvalQuestion(
  toolName: string,
  args: Record<string, unknown>,
  destructive: string[],
  sensitive: string[],
  outside: string[] = [],
): string {
  const tags: string[] = [];
  if (destructive.length > 0) tags.push(`DESTRUCTIVE: ${destructive.join(", ")}`);
  if (sensitive.length > 0) tags.push(`SENSITIVE: ${sensitive.join(", ")}`);
  if (outside.length > 0) tags.push(`outside the workspace: ${outside.join(", ")}`);
  // A plain gated call (no destructive/sensitive tag) is a mutation the
  // classifier could not prove reversible — say so, so the human weighs the
  // reversibility of the action, not just its text.
  if (tags.length === 0) tags.push("not provably reversible");
  const tag = ` [${tags.join("; ")}]`;
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
  const mode = opts.mode ?? "ask"; // default: prompt only sensitive+destructive

  /** Prompt the human; fail-closed on any failure (no ask → deny). */
  const confirm = async (question: string): Promise<boolean> => {
    if (!opts.ask) return false;
    try {
      return (await opts.ask(question)) === true;
    } catch {
      return false; // fail-closed: a broken prompt is a denial
    }
  };

  /**
   * Gate a call; returns a block reason or undefined (allow).
   * `needsConfirm` (destructive or sensitive) prompts in EVERY mode;
   * `gated` (mutating bash, write/edit) prompts only in "ask";
   * `readOnly` is the ONLY class "no" mode allows.
   */
  const gate = async (
    toolName: string,
    args: Record<string, unknown>,
    destructive: string[],
    sensitive: string[],
    readOnly: boolean,
    gated: boolean,
    outside: string[] = [],
  ): Promise<string | undefined> => {
    const needsConfirm = destructive.length > 0 || sensitive.length > 0;

    if (mode === "no") {
      if (readOnly && !needsConfirm) return undefined; // the only allowed class
      return (
        `approval is disabled (--no-approve): the "${toolName}" tool requires ` +
        `approval — re-run without --no-approve to allow it`
      );
    }
    if (!needsConfirm && !(gated && mode === "ask")) return undefined; // allow

    // Prompt: sensitive/destructive confirm (every mode) or a gated call
    // in "ask" mode.
    const question = approvalQuestion(toolName, args, destructive, sensitive, outside);
    const ok = await confirm(question);
    if (!ok) {
      if (destructive.length > 0) {
        return `the user DENIED this destructive command (${destructive.join(", ")}) — do not retry it`;
      }
      if (sensitive.length > 0) {
        return `the user DENIED access to sensitive material (${sensitive.join(", ")}) — do not retry it`;
      }
      return `the user denied the "${toolName}" call — do not retry it unchanged`;
    }
    return undefined;
  };

  return async (tool, call) => {
    const args = call.arguments;

    // 1. path sandbox (write/edit)
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

      // 2. approval gate (write/edit): no prompt in ask/yes (reversible via
      //    git, path-sandboxed to the root); blocked under --no-approve.
      if (GATED_TOOLS.has(tool.name)) {
        const blocked = await gate(tool.name, newArgs, [], [], false, false);
        if (blocked !== undefined) return { blocked };
      }
      if (newArgs !== args) return { args: newArgs }; // rewrite for the tool
      return undefined;
    }

    // 2b. read: sensitive paths confirm in every mode (fail-closed denial
    //     when there is no human); plain reads are unrestricted in ask/yes
    //     (no root restriction, no prompt) but blocked in no mode
    //     (fail-closed: --no-approve allows only read-only bash).
    if (tool.name === "read") {
      const p = args.path;
      if (typeof p !== "string" || p.length === 0) return undefined; // validation catches it
      const sensitive = sensitivePathPatterns(p);
      const blocked = await gate("read", args, [], sensitive, false, false);
      if (blocked !== undefined) return { blocked };
      return undefined;
    }

    // 3. bash: classify (destructive → sensitive → read-only → reversible)
    //    and apply the mode matrix.
    if (tool.name === "bash") {
      const cmd = typeof args.command === "string" ? args.command : "";
      const destructive = cmd.length > 0 ? destructiveBashPatterns(cmd) : [];
      const sensitive = cmd.length > 0 ? sensitiveBashPatterns(cmd) : [];
      const readOnly = cmd.length > 0 && destructive.length === 0 && isReadOnlyBash(cmd);
      const reversible =
        cmd.length > 0 && destructive.length === 0 && sensitive.length === 0 && isReversibleBash(cmd);
      const gated = !readOnly && !reversible && destructive.length === 0 && sensitive.length === 0;
      const blocked = await gate(tool.name, args, destructive, sensitive, readOnly, gated);
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
