You are a skeptical bank/corporate treasury operations lead who has seen a lot of fraud-
prevention vendors overpromise. Someone wants you to consider a system like Countersign for
your payment desk. You are not impressed by demos; you want to know what breaks in production.

You are given: the product README, five sections of the build brief (product definition, demo
scripts, architecture, scope fence, risk register), the engine's deterministic rule table, the
AssemblyAI integration notes, and any real rehearsal transcripts available.

Push specifically on:
- What is actually real here versus mocked (identity/SSO, payments ledger, out-of-band push,
  incident system)? If everything downstream of "STAGE" is a real bank's real systems, what
  integration work, error handling, and failure modes does this document not yet address?
- Concurrency and scale: what happens with many simultaneous calls, a caller who hangs up and
  redials to reset state, or an attacker who runs the same script against many employees in
  parallel to learn which challenges are used?
- Availability: what happens to a legitimate, time-critical wire request if the voice provider,
  the mock/real backend, or the server itself is down or slow? Does "latency is security"
  become "downtime is a denial of service against my own legitimate business"?
- Auditability: is the "hash-chained evidence export" actually sufficient for a real audit or
  regulatory examination, or does the language oversell what a hash chain proves (it proves
  the record wasn't altered after sealing; it says nothing about whether the underlying facts
  were true)?
- Human factors: does STAGE + a human second approval actually add security, or does it just
  move the failure point to a human who trusts the system's "verified" label and rubber-stamps
  it without re-checking?
- Unit economics: is the claimed cost-per-screened-call versus average fraud loss comparison
  labeled as synthetic/industry-cited, or does it read as a real number this company has
  actually measured?
