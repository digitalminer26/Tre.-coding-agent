#!/bin/sh
# guardrail-check.sh — reject commits that touch the guardrail zone.
#
# The zone is the agent's OWN cage: its kernel-sandbox policy
# generator, its approval/gating logic, the bash tool's sandbox wiring,
# this hook infrastructure, and the self-improve protocol skill. A model
# editing these files is loosening its own fence — that requires a human.
#
# A human (not the agent) can override with:  GUARDRAIL_BYPASS=1 git commit ...
#
# Wired in via `git config core.hooksPath scripts/git-hooks` (see
# scripts/git-hooks/pre-commit). Exit 0 = allow, 1 = reject.

if [ "${GUARDRAIL_BYPASS:-0}" = "1" ]; then
  echo "guardrail-check: GUARDRAIL_BYPASS=1 set — allowing (human override)."
  exit 0
fi

PROTECTED='^src/tools/sandbox\.ts$'
PROTECTED="$PROTECTED|^src/tools/safety\.ts$"
PROTECTED="$PROTECTED|^src/tools/bash\.ts$"
PROTECTED="$PROTECTED|^scripts/guardrail-check\.sh$"
PROTECTED="$PROTECTED|^scripts/git-hooks/."
PROTECTED="$PROTECTED|^\.pi/skills/self-improve/SKILL\.md$"

staged=$(git diff --cached --name-only --diff-filter=ACMRD)
[ -z "$staged" ] && exit 0

hits=$(printf '%s\n' "$staged" | grep -E "$PROTECTED")
if [ -z "$hits" ]; then
  exit 0
fi

echo "GUARDRAIL: REJECTED — this commit touches the guardrail zone:" >&2
printf '%s\n' "$hits" | sed 's/^/  - /' >&2
echo "" >&2
echo "These files are the agent's own sandbox/approval cage (or this hook" >&2
echo "itself). If this is a HUMAN decision, commit with:" >&2
echo "  GUARDRAIL_BYPASS=1 git commit ..." >&2
echo "If the AGENT proposed this, stop and ask the user to review the diff." >&2
exit 1
