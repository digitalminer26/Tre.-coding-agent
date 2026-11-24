#!/usr/bin/env python3
"""S5-log audit cycle driver: send the full source (+ test suite +
findings brief) to anthropic/claude-haiku-5.5 as a read-only
adversarial auditor. Usage: s5log-audit-cycle.py <prompt-file> <cycle-tag> [extra files...]
"""
import json, sys, urllib.request, pathlib, os

ROOT = pathlib.Path("/Users/xilcilus/projects/Tre.-coding-agent")
MODELS = json.load(open(os.path.expanduser("~/.tre/tre/models.json")))
ENTRY = next(m for m in MODELS["models"] if m["id"] == "anthropic/claude-haiku-5.5")

prompt_file = sys.argv[1]
cycle = sys.argv[2] if len(sys.argv) > 2 else "c1"
files = sys.argv[3:] if len(sys.argv) > 3 else [
    "src/findings/s5log.ts",
]

parts = [pathlib.Path(prompt_file).read_text()]
for f in files:
    parts.append(f"\n\n===== FILE: {f} (full, current) =====\n")
    parts.append((ROOT / f).read_text())
user_msg = (
    "Be concise: <=4 sentences per numbered question, then the numbered findings. "
    "Do not restate the code.\n\n" + "".join(parts)
)

body = json.dumps({
    "model": ENTRY["id"],
    "messages": [
        {"role": "system", "content":
         "You are a read-only adversarial code auditor. Never propose stylistic-only "
         "findings; every finding must be a provable defect scenario from the code "
         "(concrete interleaving / call sequence -> wrong observable outcome). "
         "Answer every numbered question in the prompt. Be concise."},
        {"role": "user", "content": user_msg},
    ],
    "max_tokens": 16384,
    "temperature": 0,
    "reasoning": {"effort": "low"},
}).encode()
req = urllib.request.Request(
    ENTRY["baseUrl"] + "/chat/completions",
    headers={
        "Authorization": f"Bearer {ENTRY['apiKey']}",
        "Content-Type": "application/json",
        **{k: v for k, v in (ENTRY.get("headers") or {}).items()},
    },
    data=body,
)
out = ROOT / "docs" / "audits" / f"s5log-{cycle}.txt"
with urllib.request.urlopen(req, timeout=1800) as r:
    j = json.load(r)
msg = j["choices"][0]["message"]
text = (msg.get("content") or "") or (msg.get("reasoning") or "")
if not text.strip():
    text = "[EMPTY CONTENT] raw=" + json.dumps(msg)[:2000]
out.write_text(text)
u = j.get("usage", {})
print(f"wrote {out} ({len(text)} chars); prompt_tokens={u.get('prompt_tokens')} completion_tokens={u.get('completion_tokens')}")
