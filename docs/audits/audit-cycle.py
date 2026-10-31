#!/usr/bin/env python3
"""P3b audit cycle driver: send the diff + full source context to deepseek/deepseek-v4.1-flash-1017 (read-only auditor)."""
import json, sys, urllib.request, pathlib, subprocess, os

ROOT = pathlib.Path("/Users/xilcilus/projects/Tre.-coding-agent")
MODELS = json.load(open(os.path.expanduser("~/.tre/tre/models.json")))
ENTRY = next(m for m in MODELS["models"] if m["id"] == "deepseek/deepseek-v4.1-flash-1017")

prompt_file = sys.argv[1]
cycle = sys.argv[2] if len(sys.argv) > 2 else "c0"
files = sys.argv[3:] if len(sys.argv) > 3 else [
    "src/steer/file-queue.ts", "src/session/session.ts", "src/telegram/driver.ts",
    "src/loop/agent-loop.ts",
]

diff = subprocess.run(["git", "-C", str(ROOT), "diff"], capture_output=True, text=True).stdout
parts = [pathlib.Path(prompt_file).read_text(), "\n\n===== UNCOMMITTED DIFF =====\n", diff]
for f in files:
    parts.append(f"\n\n===== FILE: {f} (full, current) =====\n")
    parts.append((ROOT / f).read_text())
# Keep reasoning short so the reply contains FINDINGS, not a reasoning-only
# wall that exhausts max_tokens (cycle-1 lesson).
user_msg = ("Be concise: ≤4 sentences per numbered question, then the numbered findings. "
            "Do not restate the code.\n\n" + "".join(parts))

body = json.dumps({
    "model": ENTRY["id"],
    "messages": [
        {"role": "system", "content": "You are a read-only adversarial code auditor. Never propose stylistic-only findings; every finding must be a provable defect scenario from the code. Answer every numbered question in the prompt. Be concise."},
        {"role": "user", "content": user_msg},
    ],
    "max_tokens": 32768,
    "temperature": 0,
    "reasoning": {"effort": "low"},
}).encode()
req = urllib.request.Request(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {ENTRY['apiKey']}", "Content-Type": "application/json"},
    data=body,
)
out = ROOT / "docs" / "audits" / f"audit-p3b-{cycle}.txt"
with urllib.request.urlopen(req, timeout=1800) as r:
    j = json.load(r)
text = j["choices"][0]["message"].get("content") or j["choices"][0]["message"].get("reasoning") or ""
out.write_text(text)
u = j.get("usage", {})
print(f"wrote {out} ({len(text)} chars); prompt_tokens={u.get('prompt_tokens')} completion_tokens={u.get('completion_tokens')}")
