# Pre-flip checklist — run BEFORE making this repo public (submission week)

The repo is private during the build (founder ruling 2026-08-26) and flips public at
submission. Judges may lower scores for repos they cannot review, so the flip happens
BEFORE the submission form is filed. Every box below gets checked, with evidence, first:

- [ ] **Secrets scan:** no API keys, tokens, or credentials anywhere in the WORKING TREE
      or the FULL HISTORY (`git log -p | grep`-class sweep + a secrets scanner). `.env`
      never committed. If anything is found in history, rotate the credential — do not
      just delete the file.
- [ ] **Private-reference scan:** zero mentions of the founder's other products, employer,
      personal email addresses, or local machine paths — working tree AND history.
- [ ] **Synthetic-data check:** every identity, company, account number, and phone number
      in seeds, fixtures, transcripts, and tests is fictional; the disclosure line is in
      the README.
- [ ] **License hygiene:** LICENSE present; all dependencies MIT-compatible; any borrowed
      snippet/asset (fonts, audio, images) redistribution-safe and attributed.
- [ ] **Claims audit:** README/deck contain no detection claims (LAW 1), no unmeasured
      performance numbers, no "immutable/sealed" language (LAW 4 phrasing only).
- [ ] **Flip:** `gh repo edit siddarthkotha/countersign --visibility public`, then verify
      logged-out access to the repo, the README rendering, and the demo URL end-to-end.
- [ ] **Restore the sharp positioning line — BOTH surfaces:** the lablab TEAM IDEA field
      AND the GitHub repo description were deliberately dulled during the build ("Voice
      agent for security. Full concept revealed at submission.") — at submission week,
      restore the real one-liner on both:
      "The conversational security checkpoint that stands between social engineering and
      irreversible actions." It matters for the Team's Choice vote window (final 24h).
- [ ] **Submission form:** repo URL + demo URL + video + deck + cover, per BRIEF §7
      checklist. Target Sep 27–28 (deadline Sep 30, 10:00 AM Central — a MORNING deadline).
