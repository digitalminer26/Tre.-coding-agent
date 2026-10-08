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

The agent's `write` tool is confined to the workspace root and its `bash` is
kernel-sandboxed (no writes outside the workspace), so an agent-created skill
MUST live in `<cwd>/.tre/skills/`. `~/.tre/agent/skills/` is for the USER (or
a `--no-sandbox` run) — e.g. machine-wide preferences. Don't instruct the
model to write there; it can't.

## Deployment policy

**Skills are deployment-specific — they are NOT committed to the repo by
default.** Different deployments communicate, authenticate, and operate
differently (telegram vs slack vs email; different endpoints, different
machines). The repo's `.gitignore` ignores `.tre/skills/` wholesale; the two
exceptions (`git-commit`, `self-improve`) are the repo's own development
protocol and were force-added deliberately. If a skill is meant to be shared
with every deployment, add it with `git add -f` and say so in HANDOFF.md.

Per-machine state and secrets a skill needs (tokens, offsets) go in
gitignored workspace files (e.g. `.tre/<skill>.json`, `.tre/<skill>/`), never
in the skill dir itself and never in git.

## The read asymmetry (sandbox)

- The `read` FILE tool is NOT kernel-sandboxed — it is root-confined +
  sensitive-path gated. The model CAN read `~/.tre/...` files.
- `bash` IS kernel-sandboxed — `cat ~/.tre/...` → "Operation not permitted".

If a skill needs the model to read a file outside the workspace, rely on the
`read` tool, not bash. (The agent can also NOT read its own session file —
sessions live outside the repo for a different reason: D20.)

## Network under the sandbox

- `curl` and `git` **FAIL TLS**: LibreSSL cannot read
  `/private/etc/ssl/openssl.cnf` (sandbox-denied) → "Operation not permitted"
  → "remote helper aborted session" / abort.
- `python3` (`/usr/bin/python3`, stdlib `urllib`) **WORKS** for HTTPS.
- node's `https` module works too, but `node` is **NOT on the sandboxed bash
  PATH** (nvm dir denied) — a skill's helper must be a system binary
  (`/usr/bin/python3`), never `node`/`npx`/`curl`/`git`.
- A skill that needs network therefore: `python3` stdlib (or another system
  binary with working TLS), invoked by absolute or system PATH.

## Secrets

- Per-machine credentials belong in a gitignored file under the MACHINE
  config root `~/.tre` (e.g. `~/.tre/telegram.json`) — the agent can write
  AND read it (C38 makes `~/.tre` an implicit root), it never enters git,
  and it works from any launch dir. (Pre-C40 these lived in the workspace
  `.tre/` — moved to `~/.tre` for the config-consistency cleanup.)
- Name it plainly (`.json`). Sensitive-path patterns (`~/.ssh`, `*.key`,
  `*.pem`, `.env*`, …) BLOCK reads in EVERY mode — a secret file whose name
  matches them would be unreadable by the agent's own `read` tool.
- The skill must say "never echo the secret" (tool output, chat, session all
  land in the transcript).
- The user provides the secret; the agent never creates or guesses one.

## bash classification of skill commands

A helper invocation like `python3 <installed-skill-dir>/telegram/telegram.py
send out.txt` is classified **mutating** (not read-only, no sensitive paths)
→ auto-approved in the default `--local` mode when the command stays within
safe locations, prompted in `--ask`, auto-approved in `--yes`, and blocked in
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
2. Secrets/state → gitignored workspace files; add them to `.gitignore`.
3. Test with a fake credential (expect a clean auth error, not a crash).
4. Verify the loader indexes it: `loadSkillsIndex('.tre/skills')` shows the
   entry with the right name/description.
5. Leave it UNTRACKED (the `.tre/skills/` ignore covers it). Note in
   HANDOFF.md that the skill is local/deployment-specific.
