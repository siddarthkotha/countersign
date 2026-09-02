# Vercel WebSocket & Plan Compatibility Check
2026-09-02

## (1) Long-Lived WebSocket SERVER Support

**VERIFIED** – https://vercel.com/docs/functions/websockets

> "Vercel Functions can serve WebSocket connections, keeping a bidirectional connection open between a client and your server-side code."

**Duration limit:** "WebSocket connections close when a Vercel Function reaches its maximum duration."

**Verdict:** WebSocket servers WORK on Vercel Functions, but are bounded by max function duration.

---

## (2) Maximum Execution Duration

**VERIFIED** – https://vercel.com/docs/functions/configuring-functions/duration

| Plan | Default | Max | Extended (Beta) |
|------|---------|-----|-----------------|
| **Hobby** | 300s (5 min) | **300s (5 min)** | — |
| **Pro** | 300s (5 min) | 800s | 1800s (30 min) |

---

## (3) Always-On Node.js / Persistent Container

**NOT FOUND** – https://vercel.com/docs/fluid-compute

Vercel does NOT offer always-on persistent servers. Fluid compute allows "multiple invocations can share the same physical instance" for concurrency, not persistence. Recommendation: Use Vercel Workflows for unlimited execution.

---

## (4) Hobby Plan Cost & Commercial Use

**VERIFIED** – https://vercel.com/docs/plans/hobby

- **Cost:** Free
- **Commercial use:** FORBIDDEN

> "the Hobby plan restricts users to non-commercial, personal use only"

**Verdict:** Hackathon demo requires Pro plan upgrade.
