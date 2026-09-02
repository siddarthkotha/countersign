# Render Hosting Tier Check — 2026-09-02

**Source:** https://render.com/docs/free (fetched 2026-09-02); https://render.com/pricing (fetched 2026-09-02)

## Findings

### (1) Free web-service tier exists
**VERIFIED.** From docs/free: "Each workspace receives 750 free instance hours monthly."

### (2) Spin-down behavior and cold start time
**VERIFIED.** From docs/free: "Free web services automatically suspend after **15 minutes** of inactivity. A Free web service spins back up whenever it next receives an HTTP request or new WebSocket connection. This process takes about **one minute**."

### (3) Monthly free hours/instance limits
**VERIFIED.** From docs/free: "Each workspace receives **750 free instance hours** monthly. Once exhausted, all free services suspend until the next calendar month begins. Spun-down services don't consume these hours."

### (4) Starter plan price and spin-down
**NOT FOUND.** Pricing page fetch did not return pricing tier details or Starter plan specifications.

### (5) WebSocket/long-lived connection restrictions on free tier
**VERIFIED.** From docs/free: "The platform counts **inactive WebSocket connections** toward the 15-minute spin-down threshold. Active connections prevent suspension, but free services have **'Service-initiated traffic threshold' restrictions** that may suspend services sending unusually high volumes of outbound traffic."

## Summary for Countersign
Free tier: ✓ available · Cold start: ✓ ~1 min acceptable · 750 hrs/mo: ✓ sufficient for Sep build (≈31 hrs dev, 50+ rehearsals ~20–30 hrs) · WebSocket: ✓ supported, active connections block spin-down · Starter pricing: **pending direct search**.
