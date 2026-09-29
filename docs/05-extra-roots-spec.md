# Spec — `--extra-root`: explicitly assigned directories outside the workspace

**Status: IMPLEMENTED (C35 / D21); persistence added in C36 / D22 (`tre.json`).**
This is a **guardrail-zone** change (touches
`sandbox.ts`, `safety.ts`, `bash.ts`) — the agent does all the work, the
**human commits** it with `GUARDRAIL_BYPASS=1`. See §9.

> **Numbering correction (2026-09-27):** this spec was filed as "C27/D14" (commit
> `40fabfb`) and its header said "next decision = D17". Both were stale: the
> decision log (HANDOFF.md) had already spent D14–D20 (pinned input layout,
> `/display-bottom`, `/` menu, self-improve readiness, rename+gate, quiet
> file-access, sessions-outside-repo), and the source contracts run to C34.
> The correct identifiers for this increment are therefore **C35** (next contract
> after C34) and **D21** (next decision after D20). Recorded accordingly.

---

## 1. Problem

The sandbox boundary is a single value: `root = path.resolve(args.cwd)`
(`src/cli/main.ts:871`). Everything derives from it — the bash kernel policy
(`generateBashSandboxPolicy(root)`), the write/edit path sandbox
(`safety.ts` → `checkPathWithinRoot(root, …)`), and the prompt's "Working
directory" section. So the agent can only operate inside **one** directory.

Two real cases this blocks:

1. **Sibling project.** The workspace is `~/projects/Tre.-coding-agent`, but a
   task needs to read/write `~/projects/other-repo`. Today the only fix is
   `--cwd ~/projects`, which widens the *entire* boundary (skills, sessions,
   the model's mental workspace) to the parent — too coarse.
2. **The sandbox wall.** A prior session looped on `git push` (ssh → `~/.ssh`
   denied). The stall guard (C26) now stops that loop cleanly, but the user
   still has no *contract* for "I explicitly allow this one directory" short of
   `--no-sandbox` (which removes the boundary entirely).

The kernel policy is already **allowlist-by-enumeration with last-match-wins**
(`sandbox.ts` module header): "one more allowed directory" is literally one
more pair of rules. The architecture supports N regions; only the plumbing is
hardwired to 1.

## 2. The contract (C35)

**Flag:** `--extra-root <dir>` (repeatable). Each `<dir>` is an *additional*
directory the agent may read and write, **in addition to** the workspace
(`--cwd`). The workspace remains the primary root (working directory, skills,
sessions, the prompt's "Working directory"); extra roots are boundary regions
only.

**Semantics — one boundary concept, two layers that MUST move together:**

| Layer | Today (1 root) | With extra roots (N) |
|---|---|---|
| **bash** (kernel) | `generateBashSandboxPolicy(root)` re-allows the workspace subpath | re-allow the workspace **and each extra root** subpath (real path), last-match-wins |
| **write/edit** (WS7) | `checkPathWithinRoot(root, p)` | `checkPathWithinRoots(roots, p)` — allowed if under **any** root |
| **read** | unrestricted (unchanged) | unchanged |
| **prompt** | "All relative paths resolve against `<root>`" | lists the workspace + each extra root |

> **Why both layers at once:** if bash could write an extra root but the
> `write`/`edit` tools could not, the model gets contradictory signals and the
> stall guard (C26) fires on the tool path. The boundary is *one* concept with
> *one* source of truth — it cannot be half-applied.

**Enumeration, not a hole.** An extra root re-allows **its own subpath only** —
never its parent or siblings. The confinement property is identical to the
workspace: a path outside every root (workspace + extra roots) is still denied
by the kernel and still refused by the file-tool hook.

## 3. The sensitive-root guard (what makes it a contract)

The sandbox's entire purpose is keeping the model off secret surfaces. An
explicit "allow this dir" must not become an escape hatch for them. At startup,
**each `--extra-root` is validated; the run REFUSES to start** (fail-closed,
like `--cwd` on a missing dir) if the root's **real path**:

- **is sensitive** — matches any existing `SENSITIVE_PATH` / `SENSITIVE_FILENAME`
  pattern (`safety.ts:444`): `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.config/gcloud`, `~/.docker`, `~/.netrc`, `id_rsa*`/`*.pem`/`*.key`/
  `.env`-family, etc.; **or**
- **is outside the current user's home dir** — i.e. not under
  `path.resolve(os.homedir())`. This refuses `/etc`, `/usr`, `/Library`,
  `/System`, `/var/root`, `/cores`, other users' homes (`/Users/<other>`),
  keychains, Preboot, `/Volumes/*`, and `/` itself.

So the v1 rule is: **an extra root must be a non-sensitive directory under the
current user's home.** That covers the real cases (sibling project dirs, a
second repo, a scratch dir) while keeping every secret surface denied.

> **Deliberately out of scope (v1):** extra roots *outside* the home dir
> (e.g. an external mount `/Volumes/MyDrive`, `/opt/tooling`). Allowing those
> would re-open exactly the surfaces the sandbox exists to protect; the escape
> for that is `--no-sandbox`. Revisit only if a real need appears.

**Refusal message** (stderr, **exit 2** — same as `--cwd` on a missing dir,
before the loop starts):
```
error: --extra-root <dir> does not exist
error: --extra-root <dir> is not a directory
error: --extra-root <dir> (real: <real>) is a sensitive path (<label>) — secret surfaces cannot be extra roots
error: --extra-root <dir> (real: <real>) is outside your home directory (<home>) — only non-sensitive dirs under it are allowed
```

## 4. Code touch points (exact)

### 4.1 `src/tools/sandbox.ts` *(guardrail)*
```ts
// signature gains an optional second arg (default [] → byte-identical policy
// for all existing callers):
export function generateBashSandboxPolicy(
  workspace: string,
  extraRoots: string[] = [],
): string
```
Inside, after `const w = seString(workspaceRealPath(workspace));` and before the
final `.join("\n")`, compute:
```ts
const er = extraRoots.map((e) => seString(workspaceRealPath(e)));
```
Insert in the **reads** section, immediately BEFORE the workspace read-allow
(so the workspace stays the last matching read rule):
```ts
    // C35 extra roots: same mechanism as the workspace — ancestor metadata
    // re-allows + a read subpath allow. Emitted BEFORE the workspace rule so
    // the workspace remains the last matching read rule.
    ...extraRoots.flatMap((e) => ancestorMetadataRules(workspaceRealPath(e))),
    ...er.map((e) => `(allow file-read* (subpath "${e}"))`),
    `(allow file-read* (subpath "${w}"))`, // workspace — LAST so it wins
```
Insert in the **writes** section, immediately BEFORE the workspace write-allow:
```ts
    ...er.map((e) => `(allow file-write* (subpath "${e}"))`),
    `(allow file-write* (subpath "${w}"))`,
```
`spawnSandboxedBash` opts gain `extraRoots?: string[]`, forwarded:
`generateBashSandboxPolicy(opts.cwd ?? process.cwd(), opts.extraRoots ?? [])`.

> **Inherited-sandbox limitation (document, don't fix):** when
> `TRE_SANDBOX === "1"` (tre running inside another sandboxed tre),
> `spawnSandboxedBash` spawns **unwrapped** — the child inherits the caller's
> confinement and the per-call policy is *not* re-applied. Extra roots are
> therefore **inert** in that case (same as the workspace re-allow today). The
> e2e sandbox-escape scenario (s10) is already skipped under an inherited
> sandbox for the same reason.

### 4.2 `src/tools/bash.ts` *(guardrail)*
`BashToolOptions` gains `extraRoots?: string[]`; `createBashTool` stores it and
passes it in the `spawnSandboxedBash` call (`{ cwd, env, detached, extraRoots }`).

### 4.3 `src/tools/safety.ts` *(guardrail)*
- `SafetyOptions` gains `extraRoots?: string[]` (keep `root` as the primary).
- `checkPathWithinRoot(root, p)` → keep it, but the write/edit hook
  (`makeSafetyHooks`, `safety.ts:1157`) resolves against the **set**:
  ```ts
  const roots = [opts.root, ...(opts.extraRoots ?? [])];
  // allowed if checkPathWithinRoot(r, p).ok for ANY r in roots;
  // the returned canonical path is the one from the matching root.
  ```
  Refusal text names the full boundary: "…outside the working directory
  `<root>` and its extra roots (<list>)".
- The sensitive-path scan (`isSystemicSensitivePath`, `systemicSensitiveBashPaths`)
  keeps using the **primary** `root` only — an extra root never downgrades a
  path from (sys)-sensitive to (ws). (A path under an extra root that is also a
  secret pattern is still systemic-sensitive.)

### 4.4 `src/cli/main.ts`
- Args: `--extra-root <dir>` repeatable → `opts.extraRoots: string[]`.
- After `root` is resolved (`main.ts:871`), validate each extra root per §3
  (exists + non-sensitive + under home); on failure write the §3 message and
  `exit 2` (matching `--cwd` on a missing dir).
- Wire into all three surfaces:
  ```ts
  const tools = allTools.map((t) =>
    t.name === "bash"
      ? createBashTool(root, { sandbox: !args.noSandbox, extraRoots })
      : t);
  const hooks = makeSafetyHooks({ root, mode, ask, extraRoots });
  // buildSystemPrompt({ cwd: root, extraRoots, … })
  ```
- Startup banner (`behaviorSettingsLines`): when non-empty, add
  `  extra roots: <dir1>, <dir2>  (read+write, in addition to the workspace)`.
- Help text: a `--extra-root <dir>` block after `--cwd`.

### 4.5 `src/prompt/system-prompt.ts`
`SystemPromptOptions` gains `extraRoots?: string[]`. The "Working directory"
section becomes:
```
# Working directory
All relative paths resolve against:
`<root>`
Additional read/write roots (in addition to the workspace):
- `<er1>`
- `<er2>`
```
(omitted entirely when empty — prompt stays byte-identical for existing runs).

### 4.6 `docs/02-contracts.md`
Add **C35** (a paragraph after the stall paragraph) describing the extra-root
boundary + the sensitive-root guard + the inherited-sandbox limitation. Record
**D21** in `PLAN.md` §9 when implemented.

## 5. Test plan

**Unit (network-free, in the gate):**
- `sandbox.test.ts` — `generateBashSandboxPolicy(ws, [er])` emits the extra-root
  read+write subpath allows **and** their ancestor-metadata rules, **before**
  the workspace rules (assert ordering: workspace read-allow is still the last
  `file-read*` subpath rule). `extraRoots=[]` → policy byte-identical to today
  (regression pin).
- `safety.test.ts` — write/edit allowed under an extra root, refused outside all
  roots; a sensitive path under an extra root is still (sys)-sensitive.
- `cli.test.ts` — `--extra-root` parse (repeatable); refusal on missing dir, on
  a sensitive dir (`~/.ssh`), and on an outside-home dir (`/etc`, `/Users/x`);
  acceptance of a sibling under home.
- `prompt.test.ts` — extra roots render in the Working-directory section; absent
  → byte-identical prompt.

**Kernel canary (MANDATORY — guardrail change; run in a sandboxed shell):**
1. Extra root **readable + writable** by the sandboxed bash child
   (`touch`/`cat` a file in it).
2. A **sibling** of the extra root (not assigned) is still **denied**.
3. The **workspace** still works (regression).
4. `~/.ssh` (or another secret) is still **denied** even with a sibling extra
   root assigned.
5. `node` can `realpathSync` into the extra root (ancestor-metadata chain works).

**e2e (`test/e2e.sh`):** scenario 19 — a one-shot run launched with
`--cwd <workdir> --extra-root <sibling>` has the model write a file into the
sibling via the `write` tool **and** via `bash` — both succeed; a write to a
non-assigned sibling is refused. (Skipped under an inherited sandbox, like s10.)

## 6. Out of scope (v1)
- Extra roots outside the home dir (external mounts, `/opt`) — §3.
- Per-root read-only vs read-write (all extra roots are read+write).
- ~~Config-file persistence of extra roots~~ — **DONE in C36 (D22):** a
  `tre.json` (nearest above the launch dir, then `~/.tre/tre.json`) with
  `{ "extraRoots": [ ... ] }` is the durable baseline; the `--extra-root` flag
  appends to it. Each entry is validated exactly like a flag value (fail-closed
  on a malformed file or a refused entry). See `docs/02-contracts.md` C36.
- Changing the `read` tool (it stays unrestricted).

## 7. Definition of done
1. `tsc` clean; **full suite green** (no new failures).
2. Kernel canary (§5) passes on this machine.
3. e2e extra-root scenario passes (or is correctly skipped under inheritance).
4. `docs/02-contracts.md` C35 + the decision log (HANDOFF.md) D21 recorded.
5. `HANDOFF.md` top section updated.
6. Committed **by the human** (§9).

## 8. Sequencing
The stall guard (C26) is done and green (commit `f393fb2`). This is the **next**
increment. It must land as **one** increment — the bash kernel boundary and the
file-tool root set move together (§2). Estimated ~200 lines across 6 files.

## 9. Commit strategy (guardrail zone)
This change touches `sandbox.ts`, `safety.ts`, and `bash.ts` — **all guardrail
zone**. The pre-commit hook will **reject** an agent commit. Per protocol the
agent does all the work (code + tests + docs, gate green, canary passed), then
**stops** and hands off. The human commits:
```sh
GUARDRAIL_BYPASS=1 git add -A
GUARDRAIL_BYPASS=1 git commit -m "Add --extra-root: explicitly assigned non-sensitive dirs under home as additional read/write roots (C35/D21)"
```
The agent must never set `GUARDRAIL_BYPASS`.
