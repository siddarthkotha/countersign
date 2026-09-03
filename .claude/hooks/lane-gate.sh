#!/usr/bin/env bash
# ============================================================
# lane-gate.sh — Stop hook, founder-ratified 2026-09-02 ("why wasn't this enforced?").
#
# RULE (founder orchestration law, previously PROSE ONLY in ~/.claude/CLAUDE.md):
#   "Parallel by default ... STATE the split (agents: X; main: Z; held: W because
#    <dependency>). 'Waiting' is only legal when zero dependency-free work exists."
#
# MECHANICAL FORM: whenever a turn reports on background work — it launched an Agent, or
# its reply says something is running / in flight / waiting / dispatched — the reply MUST
# carry a line beginning "Lanes:" that names what is running and what is held, and every
# held item must carry its dependency ("because", "until", "needs", "blocked on", or
# "held: none"). Otherwise the stop is BLOCKED once with instructions to list the backlog,
# launch every dependency-free item, and then state the split.
#
# Sized against bureaucracy: never fires on plain answers, reads, or turns with no
# background work. CONTRACT (copied from ambition-pass-gate): fail-safe — any parse
# problem exits 0 silently. Loop-safe — stop_hook_active=true passes through.
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

export LANE_HOOK_JSON="$IN"
python3 <<'PYEOF' 2>/dev/null || exit 0
import sys, json, re, os

try:
    hook = json.loads(os.environ.get("LANE_HOOK_JSON", ""))
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
    # A hook's own feedback is not a founder message; judging the slice after it would
    # drop the reply that already carried the split line (false block on 2026-09-02).
    if joined.lstrip().startswith("Stop hook feedback") or "hook blocking error" in joined:
        continue
    last_user_idx = i

if last_user_idx is None:
    sys.exit(0)

launched, reply_parts = False, []
for ev in events[last_user_idx + 1:]:
    if ev.get("type") != "assistant":
        continue
    for b in content_blocks(ev):
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            reply_parts.append(b.get("text", ""))
        elif b.get("type") == "tool_use" and b.get("name") == "Agent":
            launched = True

reply = "\n".join(reply_parts)

# The final assistant text is sometimes not yet flushed to the transcript when Stop hooks
# run (observed 2026-09-02: three false blocks, each on a turn whose reply followed tool
# calls). Prefer the message the harness hands us directly; otherwise fall back to the last
# assistant text anywhere in the transcript rather than judging an empty slice.
direct = hook.get("last_assistant_message")
if isinstance(direct, str) and direct.strip():
    reply = direct
elif not reply.strip():
    for ev in reversed(events):
        if ev.get("type") != "assistant":
            continue
        texts = [b.get("text", "") for b in content_blocks(ev)
                 if isinstance(b, dict) and b.get("type") == "text"]
        if texts:
            reply = "\n".join(texts)
            break
    if not reply.strip():
        sys.exit(0)

reports_background = bool(re.search(
    r"\b(running|in flight|still (building|running|writing)|waiting (on|for)|dispatched|"
    r"background|lanes?)\b", reply, re.I))

if not (launched or reports_background):
    sys.exit(0)

m = re.search(r"\**lanes:\**\s*(.+)$", reply, re.I | re.M)
ok = False
if m:
    line = m.group(1)
    if re.search(r"held:\s*none", line, re.I):
        ok = True
    elif re.search(r"held:", line, re.I) and re.search(
            r"\b(because|until|needs?|blocked on|waits? (on|for)|after)\b", line, re.I):
        ok = True

reasons = []
if not ok:
    reasons.append(
        "lane-gate (founder orchestration law, mechanical since 2026-09-02): this turn "
        "reports background work without stating the split. Before finishing: (1) list the "
        "open backlog; (2) LAUNCH every item that touches files no running lane touches — "
        "'waiting' is only legal when zero dependency-free work exists; (3) end the reply "
        "with ONE line: 'Lanes: running: <names> · held: <item> because <dependency>' "
        "(or 'held: none')."
    )

# --- v2: backlog.json cross-check (founder ask 2026-09-02, H1) ------------------------
# Only reached on turns that already trip the outer gate above (launched an Agent, or the
# reply reports background work) -- same "sized against bureaucracy" scoping as v1.
try:
    backlog_path = os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".claude", "backlog.json")
    with open(backlog_path, "r") as f:
        backlog = json.load(f)
    items = backlog.get("items")
    if not isinstance(items, list):
        items = []
except Exception:
    items = []

open_items = [it.get("title", it.get("id", "(untitled)")) for it in items
              if isinstance(it, dict) and it.get("status") == "open"]
held_missing = [it.get("title", it.get("id", "(untitled)")) for it in items
                if isinstance(it, dict) and it.get("status") == "held"
                and not str(it.get("held_because", "")).strip()]

# "AND the turn launched no Agent tool AND the reply reports background work": since we
# only get here when (launched OR reports_background) is already true, "not launched"
# alone implies reports_background is true.
if open_items and not launched:
    reasons.append(
        "backlog.json has open item(s) with no lane and no hold reason: "
        + "; ".join(open_items)
        + " -- launch or hold-with-reason each."
    )

if held_missing:
    reasons.append(
        "backlog.json has held item(s) with an empty held_because: "
        + "; ".join(held_missing)
        + " -- record why each is held."
    )

if not reasons:
    sys.exit(0)

print(json.dumps({
    "decision": "block",
    "reason": " | ".join(reasons)
}))
sys.exit(0)
PYEOF
exit 0
