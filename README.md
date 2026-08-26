# Countersign

**The conversational security checkpoint that stands between social engineering and irreversible actions.**

> Countersign doesn't guess who's calling. It makes them prove it.

When a high-risk request arrives by voice — an urgent wire transfer demanded of a corporate
payment desk, a privileged credential reset, a "grandchild needs bail money" call — Countersign
answers first. It conducts a calm, adaptive spoken interrogation (challenge questions,
cross-turn consistency probes, out-of-band checks) while a deterministic policy engine — never
the LLM — computes the verdict from structured evidence. Verified requests are only ever
**staged** for independent human second approval. Failed requests are frozen, an incident is
opened, and a tamper-evident evidence record seals every claim, check, and decision.

Built solo, AI-assisted, on the AssemblyAI Voice Agent API for the AssemblyAI Voice Agent
Hackathon (lablab.ai, September 1–30, 2026).

## Status

Pre-kickoff scaffold. Product code begins with the event build window.

## What Countersign does NOT do

Countersign makes **no acoustic deepfake-detection claims** and uses **no voice biometrics** —
by design. The mechanism is exclusively behavioral verification: what the caller knows, how
their story holds together across turns, and what independent out-of-band checks say. That's a
feature: it's the layer that still works when synthetic voices are perfect.

## Disclosure

All identities, companies, systems, and the attacking voice in the demo are synthetic; the
conversation, interruptions, and tool calls run live. No real personal data appears anywhere
in this repository.

---

*README structure (video, live demo, "why voice", architecture, deny conditions, evidence
format, adversarial corpus, measured latency, setup) fills in as the build progresses.*
