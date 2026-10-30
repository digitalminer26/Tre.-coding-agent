# 04 — Skill authoring constraints

How to create a skill for `tre.` — the hard-won constraints, documented so the
next skill (on any deployment) doesn't re-learn them. All verified empirically
on macOS under the tre. kernel sandbox (2026-09-27, during the telegram skill).

## What a skill is

A directory containing a `SKILL.md` with minimal YAML frontmatter:

```
---
name: my-skill
description: What it does and WHEN to use it.
---
(body — how to use it)
```

Only the **index** (name + description + path) goes into the system prompt;
the body is read ON DEMAND by the model via the `read` tool. Consequences:

- The frontmatter `description` is the only always-visible text — it must say
  what the skill does **and when to use it** (the model decides from it).
- The body can be long (it's read on demand), but keep it actionable:
  commands, not essays.

**Always-active skills** (`always: true` in the frontmatter) are the
exception: their body is included VERBATIM in the system prompt, so they are
in effect from the first message with no trigger needed. Use this ONLY for
skills that must be active even when the user is absent — e.g. a messaging
channel the agent is expected to monitor and answer (the telegram skill).
Every `always` skill pays its body's token cost in every prompt, so keep
bodies tight and keep the set of always-active skills minimal.

## Where skills load from

ONLY two default dirs (`src/cli/main.ts`):

1. `<cwd>/.tre/skills/` — project skills (relative to the launch dir).
2. `~/.tre/agent/skills/` — user skills (machine-wide).

`--skills <dir>` adds more. Anywhere else is invisible to the agent.

### Helper script paths

Do not assume a skill's helper is at `<cwd>/.tre/skills/<name>/` just because
that is the project-skill location. On this deployment, user-installed skills
(and their helpers) live under `~/.tre/agent/skills/<name>/`; for example, the
Telegram helper is `~/.tre/agent/skills/telegram/telegram.py`. A project may
also carry a deployment-specific copy under `<cwd>/.tre/skills/`, but that
path is not guaranteed to exist in every launch directory or checkout. When
invoking a helper, use its actual installed path (or locate it in the active
skill directories) rather than guessing from the current working directory.

## Where an agent can CREATE skills

The agent's `write` tool is confined to the workspace root, its extra roots,
and (since C38) the implicit `~/.tre` root; its `bash` is kernel-sandboxed to
the same boundary. So an agent CAN create a skill in either:

1. `<cwd>/.tre/skills/` — the workspace copy (the normal choice: per-project,
   reviewed with the repo, but per D20-style policy left UNTRACKED).
2. `~/.tre/agent/skills/` — the user skill root (machine-wide; reachable
   because C38 makes `~/.tre` an always-on read+write root). Use this only
   when the skill should apply to every launch dir on the machine.

Anything OUTSIDE those roots (e.g. `/usr/local/share/skills`) is unwritable
from a sandboxed run — don't instruct the model to write there.

## Deployment policy

**Skills are deployment-specific — they are NOT committed to the repo by
default.** Different deployments communicate, authenticate, and operate
differently (telegram vs slack vs email; different endpoints, different
machines). The repo's `.gitignore` ignores `.tre/skills/` wholesale; the one
exception (`self-improve`) is the repo's own development protocol and was
force-added deliberately. (`git-commit` was a second exception until commit
`c6c5188` removed the project-local copy — it now lives in
`~/.tre/agent/skills/` like any user skill.) If a skill is meant to be shared
with every deployment, add it with `git add -f` and say so in HANDOFF.md.

Per-machine state and secrets a skill needs (tokens, offsets) go in gitignored
files under the MACHINE config root `~/.tre` (e.g. `~/.tre/<skill>.json`,
`~/.tre/<skill>/` — C40; pre-C40 these lived in the workspace `.tre/`), never
in the skill dir itself and never in git.

## The read/sandbox boundary (current behavior, re-verified 2026-10-30)

- The `read` FILE tool has **no root restriction** (it may read any file), but
  it IS sensitive-path gated, on the RESOLVED target (lexical path + realpath,
  so a symlink to `~/.aws/...` cannot smuggle past the check): a sensitive
  path resolving OUTSIDE the workspace (system-level: `~/.ssh`, `~/.aws`, …)
  is BLOCKED in every mode; a sensitive path INSIDE the workspace (e.g. a
  project `.env`) is allowed in `yes` and prompted in `ask`; under
  `--no-approve` every `read` is blocked (fail-closed — no human to confirm).
  So the model CAN read most `~/.tre/...` files — EXCEPT the ones whose
  FILENAME is itself on the sensitive list (see Secrets below):
  `telegram.json`, `tokenomics.json`, `~/.bashrc`/`.zshrc`/`.profile`, and
  the `.tre`-anchored `models.json` (endpoint catalog) are blocked from
  `read`/`write`/`edit` under `~/.tre` in EVERY mode, even though `~/.tre`
  is an extra root (an extra root never downgrades a (sys) sensitive path).
- `bash` IS kernel-sandboxed, to workspace + extra roots + the implicit
  `~/.tre` root (C38). Ordinary paths under `~/.tre` **work** (verified:
  a listing of `~/.tre/sessions` succeeds). Before C38 even that failed with
  "Operation not permitted" — older skill docs saying "bash cannot touch
  `~/.tre`" are STALE. But the sensitive FILENAME gate also scans bash
  command tokens: `cat ~/.tre/telegram.json` is BLOCKED in every mode
  (verified). The scan is lexical/best-effort — it cannot see INSIDE a
  helper: a script that opens its own config (e.g. `python3 skill.py`,
  which reads `~/.tre/telegram.json` internally at the kernel level) is
  not caught by the filename gate. (The invocation is still subject to
  approval mode itself: a plain `python3 …` is a gated call — allowed in
  `yes`, prompted in `ask`, blocked under `--no-approve`.)
  That is the intended contract: the MODEL never sees the secret; the
  helper consumes it. Never write a skill step that pipes a credential
  file's contents through a tool (cat/head/jq on it) — those forms are
  blocked, and even when a quoting form slips past the scan the secret
  would land in the transcript.
- Consequence for sessions: sessions live OUTSIDE any repository (D20 — they
  are never project files), under `~/.tre/sessions`, which the C38 implicit
  root makes reachable from the tools. D20's isolation is **repo-level** (the
  agent-under-test cannot edit its history as workspace content), not
  agent-level unreadability — do not write a skill that assumes the agent
  cannot see its own session files.

If a skill needs a file outside the workspace that is NOT under `~/.tre` or
an extra root, rely on the `read` tool (no root restriction, and no prompt
in `yes`/`ask` — except for the sensitive-path gate; under `--no-approve`
every `read` is blocked fail-closed), not bash.

## Network under the sandbox (re-verified 2026-10-30)

The original 2026-09-27 note said curl AND git fail TLS because LibreSSL
could not read `/private/etc/ssl/openssl.cnf`. That cause is FIXED: the
policy now explicitly allows that one file (`src/tools/sandbox.ts`,
"(verified 2026-09-20: error names this exact path)"). Current empirical
state on this deployment's sandboxed bash:

- `git` over **https WORKS** (`git ls-remote https://…` succeeds).
- `curl` still FAILS, but with a different cause: it cannot read its CA
  bundle — `curl: (77) error setting certificate verify locations: CAfile:
  /etc/ssl/cert.pem` (that path lives under the denied `/private` subpath;
  it is not in the policy's allow-list).
- `python3` (`/usr/bin/python3`, stdlib `urllib`) **WORKS** for HTTPS (200).
- node's `https` module works when node is REACHABLE, but node availability
  under the sandbox is DEPLOYMENT-DEPENDENT: on this machine the nvm bin dir
  is on the (inherited) PATH and node runs fine; on deployments where the
  nvm dir was denied or node was never on the PATH it is not. Never assume
  it — a skill's helper should be a system binary (`/usr/bin/python3`),
  which exists everywhere macOS does. Probe (`command -v node`) if a skill
  genuinely wants node; do not hardcode it.
- A skill that needs network therefore: `python3` stdlib (or another system
  binary with working TLS). curl is not a reliable helper; git-over-https
  happens to work here but is deployment/policy-dependent — don't build a
  skill's network path on it.

## Secrets

- Per-machine credentials belong in a gitignored file under the MACHINE
  config root `~/.tre` — it never enters git and works from any launch dir.
  (Pre-C40 these lived in the workspace `.tre/` — moved to `~/.tre` for the
  config-consistency cleanup.) HOW the agent writes it matters: the exact
  names below are sensitive FILENAMES, so at `~/.tre` level the `write`/
  `edit` tools AND bash commands naming the file are blocked in every mode
  — e.g. the agent cannot `write ~/.tre/telegram.json` directly (the live
  telegram skill's "the agent writes the config (the write tool)" setup
  step PREDATES the sensitive-filename list and no longer works as
  written). Spell out a setup route that works: create the file with a
  command whose tokens don't name the sensitive path (e.g. a `python3`
  heredoc building the JSON), or have the user create it; verify against
  the safety list before writing a skill's setup text.
- Naming (`src/tools/safety.ts` is authoritative — the list grows):
  patterns like `~/.ssh`, `*.key`, `*.pem`, `*.p12`, `.env*`, plus the
  explicit credential names `telegram.json`, `tokenomics.json`, the shell
  rc files, and the `.tre`-anchored `models.json`. A sensitive path
  OUTSIDE the workspace (system-level — e.g. a machine-config file whose
  name or path matches one of the patterns above) is BLOCKED from
  `read`/`write`/`edit`/bash in every mode. Ordinary (non-matching) files
  under `~/.tre` are NOT system-level — they stay reachable through the
  C38 implicit root (see the read/sandbox boundary above). A NEW skill secret therefore should NOT reuse one of those names:
  name it distinctly (e.g. `~/.tre/<skillname>-config.json`), and it is
  writable/readable through the C38 implicit root in `yes`/`ask` (verified
  for non-listed names under `~/.tre`; under `--no-approve` every read AND
  write call is blocked fail-closed). A sensitive path INSIDE the workspace
  behaves differently (allowed in `yes`, prompted in `ask`) — see the
  read/sandbox boundary above.
- The skill must say "never echo the secret" (tool output, chat, session all
  land in the transcript).
- The user provides the secret; the agent never creates or guesses one.

## bash classification of skill commands

A helper invocation like `python3 <installed-skill-dir>/telegram/telegram.py
send out.txt` is classified **mutating** (not read-only, no sensitive paths)
→ auto-approved in the default `--yes` mode (mutating bash that stays within
the sandboxed workspace is allowed), prompted in `--ask`, and blocked in
`--no-approve`. If a skill's commands must run in fail-closed mode they need
to be read-only — usually not worth it.

## State

Keep per-machine state (offsets, cursors) in a small file the helper manages
(e.g. `~/.tre/telegram/last_update_id`), under the machine config root —
gitignored where the repo is involved, and reachable from any launch dir.
When the remote API CONSUMES what you read (Telegram `getUpdates` with a
positive offset deletes the updates): **print first, then persist the
offset** — duplicates are the safer failure mode, loss is not.

## Verification without credentials

Test the full runtime path with a FAKE token: a clean `HTTP 401
Unauthorized` proves network + TLS + script + config loading all work,
isolating the only unknown (the real token). Verify the error paths too
(missing config, missing field) — they must give actionable messages, and
they're what the model will actually hit in a fresh deployment.

## Recipe (checklist)

1. `mkdir -p .tre/skills/<name>`; write `SKILL.md` (frontmatter: `name` +
   `description` with a WHEN clause; `always: true` only for user-absent
   channels like telegram) and any helper (system binary, stdlib).
2. Secrets/state → gitignored files under the MACHINE config root `~/.tre`
   (e.g. `~/.tre/<skill>.json`, `~/.tre/<skill>/`), NOT workspace files (C40) —
   they must be reachable from any launch dir and can never enter git.
3. Test with a fake credential (expect a clean auth error, not a crash).
4. Verify the loader indexes it: `loadSkillsIndex('.tre/skills')` shows the
   entry with the right name/description.
5. Leave it UNTRACKED (the `.tre/skills/` ignore covers it). Note in
   HANDOFF.md that the skill is local/deployment-specific.
