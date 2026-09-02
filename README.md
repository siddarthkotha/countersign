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

## Replay the corpus

`packages/engine/corpus/*.json` holds 18 transcripts replayed through the real engine every
test run (`test/corpus.test.ts`), and every rule mutant breaks at least one of them
(`test/mutants.test.ts`) — G3's evidence that the rulebook is load-bearing, not decorative.
Inspect any file judge-legibly:

`npm run replay -- packages/engine/corpus/scenario-b-miller-fraud.json`

Prints the verdict, every evidence card, and the "what would flip this" counterfactuals; exits
1 if the file no longer matches the engine.

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

## Measured latency (live AssemblyAI Voice Agent API, from the real stack)

| Date (CDT) | Runs | Connect → session.ready | session.ready → first reply audio | Notes |
|---|---|---|---|---|
| 2026-09-02 11:13 AM | 1 | 995 ms | 221 ms | `npm run smoke:live` from the founder's Mac in Austin; single run, no percentiles yet. p50/p95 over 50+ rehearsals land in week 3 (gate G5). |

Method: `packages/server/scripts/smoke-live.ts` mints a token, opens the socket, sends `session.update`, times `session.ready`, then times the first `reply.audio` after the greeting. Opt-in only (`--live` + `ASSEMBLYAI_API_KEY`); never runs in CI.
