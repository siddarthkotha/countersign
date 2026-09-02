#!/usr/bin/env bash
# ============================================================
# local-time-gate.sh — Stop hook, founder ask 2026-09-01 8:54 PM CDT:
# "i want to see every output reference a local time."
#
# RULE: every reply to the founder carries the real local clock, read from the
# <local-time> line the user-level UserPromptSubmit hook injects — e.g. "8:54 PM CDT"
# or "Tuesday, September 1 2026, 8:54 PM CDT". A reply with no such stamp is BLOCKED
# once with instructions. Companion to ~/.claude/hooks/local-time-inject.sh (which
# supplies the clock; this one makes sure it is actually written down).
#
# CONTRACT (copied from ambition-pass-gate): fail-safe — any parse problem exits 0
# silently. Loop-safe — stop_hook_active=true passes through (one block per turn max).
# Fires only when the turn produced visible reply text; tool-only turns pass.
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

export LTG_HOOK_JSON="$IN"
python3 <<'PYEOF' 2>/dev/null || exit 0
import sys, json, re, os

try:
    hook = json.loads(os.environ.get("LTG_HOOK_JSON", ""))
except Exception:
    sys.exit(0)

if hook.get("stop_hook_active"):
    sys.exit(0)

tp = hook.get("transcript_path") or ""
if not tp or not os.path.isfile(tp):
    sys.exit(0)

try:
    size = os.path.getsize(tp)
    with open(tp, "rb") as f:
        if size > 5_000_000:
            f.seek(-5_000_000, 2)
        raw = f.read().decode("utf-8", "replace")
    lines = raw.split("\n")
    if size > 5_000_000 and lines:
        lines = lines[1:]
except Exception:
    sys.exit(0)

events = []
for ln in lines:
    ln = ln.strip()
    if not ln:
        continue
    try:
        events.append(json.loads(ln))
    except Exception:
        continue

def content_blocks(ev):
    msg = ev.get("message") or {}
    c = msg.get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return c if isinstance(c, list) else []

last_user_idx = None
for i, ev in enumerate(events):
    if ev.get("type") != "user":
        continue
    blocks = content_blocks(ev)
    texts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
    if not texts:
        continue
    joined = "\n".join(texts)
    if "<system-reminder>" in joined or "task-notification" in joined:
        continue
    last_user_idx = i

if last_user_idx is None:
    sys.exit(0)

reply_parts = []
for ev in events[last_user_idx + 1:]:
    if ev.get("type") != "assistant":
        continue
    for b in content_blocks(ev):
        if isinstance(b, dict) and b.get("type") == "text":
            reply_parts.append(b.get("text", ""))

reply = "\n".join(reply_parts).strip()
if not reply:
    sys.exit(0)  # tool-only turn, nothing shown to the founder

# Accept "8:54 PM CDT", "08:54 PM CST", "8:54 pm CDT" — an hour:minute with meridiem and a zone.
if re.search(r"\b\d{1,2}:\d{2}\s?(AM|PM|am|pm)\s+[A-Z]{2,5}\b", reply):
    sys.exit(0)

print(json.dumps({
    "decision": "block",
    "reason": ("local-time-gate (founder law 2026-09-01): this reply carries no local time. "
               "Add the real local clock from the <local-time> line in your context "
               "(format like '8:54 PM CDT', with date when the day matters) at the top of the "
               "reply. Never infer the hour from session length; copy it from the injected line.")
}))
sys.exit(0)
PYEOF
exit 0
