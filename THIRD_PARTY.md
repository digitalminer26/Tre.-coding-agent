# Third-Party Sources

Aggregate citation table for this repo. Kept in sync per
`docs/03-citation-policy.md` rule 4 — every commit that adds L1/L2 code adds its row
here.

| File(s)                | Source             | Level | What was taken                                                                                                     |
|------------------------|--------------------|-------|--------------------------------------------------------------------------------------------------------------------|
| src/session/session.ts | pi 0.85.1 (agent-core) | L2 | Append-only JSONL session log + resume-by-replay (context rebuilt from the log, honoring compaction boundaries); simplified: 4 entry kinds, no branching/branchSummary/custom entries |
| src/types.ts           | pi 0.85.1 (agent-core) | L2 | Provider-neutral message model (ContentBlock union, Usage, StopReason), event vocabulary (`partial` on every event), Tool protocol (`execute(toolCallId, args, signal, onUpdate)`, error-as-result); simplified: no bashExecution/custom/branchSummary kinds, no per-tool usage/cost, no prepareArguments; added: StopReason "budget"/"loop"/"stall", result `details` |
| src/loop/agent-loop.ts | pi 0.85.1 (agent-core) | L2 | Inner loop: stream into one context slot, parallel dispatch (sequential opt-out), results in call order, `prepareNextTurn` hook, batch `terminate`; simplified: no outer/inner split, no follow-up queue; added: `length`→fail-all guard, no-call `length` nudge (C22), per-cycle budget + auto-continuation (C26), identical-batch loop detection (C26), stall stop, steering keep-alive |
| src/tools/pipeline.ts  | pi 0.85.1 (agent-core) | L2 | Per-call pipeline: validate → beforeToolCall (rewrite or block) → execute(signal, onUpdate) → afterToolCall, errors in-band; simplified: no prepareArguments; added: stall guard (3 consecutive permission-denial failures stop the run) |
| src/tools/truncate.ts  | pi 0.85.1 (pi-ai)    | L2 | Truncation RULES (2000 lines / 50 KB, head-vs-tail per tool, whole lines only, temp-file recovery); implementation L3 |
| src/wire/openai-completions.ts | pi 0.85.1 (pi-ai) | L2 | OpenAI-compatible wire shape (request building, assistant content as string, tool args as JSON string, per-model compat flags), SSE → normalized events, best-effort salvage parse of truncated tool-call JSON; implementation L3 |
| src/prompt/system-prompt.ts | pi 0.85.1 (agent-core) | L2 | Section SHAPE of the system prompt (identity, one line per enabled tool, tool-derived guidelines, project-context files verbatim, skills index, working directory); section contents L3 |
| src/prompt/skills.ts   | pi 0.85.1 (agent-core) | L2 | Skills pattern (SKILL.md + YAML frontmatter, index in prompt, body on demand); added: `always: true` frontmatter |

## License

Portions of this project are derived from [pi](https://github.com/earendil-works/pi)
(© Mario Zechner), used under the MIT License:

```
MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
