# Pre-flip checklist — run BEFORE making this repo public (submission week)

The repo is private during the build (founder ruling 2026-08-26) and flips public at
submission. Judges may lower scores for repos they cannot review, so the flip happens
BEFORE the submission form is filed. Every box below gets checked, with evidence, first:

- [x] **Secrets scan (2026-09-11):** working-tree grep for `sk-`/api_key/Bearer/token/hex/
      base64 patterns (excluding node_modules, .git) turned up only test fixtures with
      obviously fake values (`'secret-key'`, `'secret-admin-token'`, `'test-key-value'`,
      `'fake-aai-dev-mode'`, `packages/server/test/prompt.test.ts` `'northgate-trust-secret'`)
      and doc examples quoting AssemblyAI's own `Bearer YOUR_API_KEY` placeholder syntax. No
      `.env` file exists in the tree; `.gitignore` lines 2-3 exclude `.env`/`.env.*` and
      line 27 keeps `.env.example` (which ships with all values blank). History sweep NOT
      re-run this pass (full-history secrets scanner was already run 2026-09-02 per the
      commit-8afaf2a note below); no new secret-shaped commits since. No Critical finding.
- [x] **Private-reference scan (2026-09-11):** README.md, docs/SUBMISSION-DRAFT.md, and
      packages/web/src are clean (zero hits for the founder's other product name or
      employer). Found in internal docs and design scripts (handoff prose, one log line, and
      the six-looks capture scripts with hardcoded home-directory paths): REDACTED 2026-09-11
      9:55 PM (commit a5a9b24); `git grep` for the other product's name and for home paths now
      returns zero hits outside `.claude/` and `CLAUDE.md`. STILL OPEN, founder: seven
      `.claude/hooks/*.sh` headers, `.claude/statusline.sh`, and `CLAUDE.md:113` name the
      founder's other product in "ported from" comments (edits under `.claude/` prompt on
      autopilot); a plain find-and-replace to "an earlier project" before the flip. Git log
      authors: single author, `43058091+siddarthkotha@users.noreply.github.com` (GitHub's
      own noreply alias, not a personal address) — no action needed.
- [x] **Synthetic-data check (2026-09-11):** `packages/engine/src/seed/meridian.ts` opens
      with an explicit disclosure comment ("ALL FICTIONAL. Meridian Dynamics does not
      exist; nobody here is a real person.") covering the 4 named identities (Robert
      Miller, Dana Whitfield, Marcus Obi, Elena Park), the company, the Hartwell-deal cast
      (Lena Voss, Calder & Finch, First Meridian Trust), and all account/PO/invoice/cost-
      centre numbers (last-4s, `INV-7734`, `PO-6612`, `CC-2210`, etc — narrative test
      digits, not real account numbers). `packages/engine/corpus/*.json` (20 fixture
      files) reuse the same roster plus a few fictional vendor/counterparty names
      (Northgate Partners, Harbor Fidelity, Colinwood Analytics, Sutter Cove) consistent
      with the seed's fictional world; no phone-number-shaped strings found. README.md:244
      carries the disclosure sentence ("All identities, companies, systems, and the
      attacking voice in the demo are synthetic..."). No gap found; no edit needed.
- [x] **License hygiene (2026-09-11):** LICENSE present (MIT, "Copyright (c) 2026 Siddarth
      Kotha" — matches the sole git log author). `npx license-checker --summary`: MIT 172,
      ISC 8, Apache-2.0 5, BSD-2-Clause 2, BSD-3-Clause 2, MIT-0 1, CC-BY-4.0 1,
      UNLICENSED 4 (the 4 UNLICENSED entries are this repo's own workspace packages —
      `@countersign/engine`, `@countersign/server`, `@countersign/web`, `countersign` root
      — not third-party). No copyleft (GPL/LGPL/AGPL) anywhere in the dependency tree. No
      borrowed fonts/audio/image assets found outside node_modules.
- [x] **Claims audit (2026-09-11):** grepped README.md, docs/SUBMISSION-DRAFT.md,
      packages/web/src for detect/deepfake, immutable/sealed/cryptographically guaranteed,
      sub-second, and unlabelled percentages. All "detect(s)" hits are either explicit
      anti-claims (LAW 1 compliant: "never claims to detect...", "not a deepfake
      detector", "no acoustic deepfake-detection claims") or unrelated technical usage
      (AssemblyAI turn-detection, WebSocket link-drop detection, tamper-evidence copy
      "fingerprinted to detect edits" in Footer.tsx — not a voice-fraud detection claim).
      "sealed"/"immutable" hits in CallView.tsx/Footer.tsx are code comments explicitly
      warning against using those words (self-policing, not rendered UI text). The one
      real hit: README.md line 236 used the bare word "immutable" while citing a US
      Bancorp patent's own claim language — FIXED to `what the patent calls "immutable"
      logging` so the word is attributed as a quotation of the patent, not stated as
      Countersign's own property. Percentage claims (74.6%/0% in both README.md and
      SUBMISSION-DRAFT.md) already carry a labelled source (APort Vault CTF, 879
      attempts) — compliant, no unmeasured numbers found. No "sub-second" anywhere.
- [ ] **Flip:** `gh repo edit siddarthkotha/countersign --visibility public`, then verify
      logged-out access to the repo, the README rendering, and the demo URL end-to-end.
      Needs founder: this is the founder's own visibility-flip action; not touched here.
- [ ] **Restore the sharp positioning line — BOTH surfaces:** the lablab TEAM IDEA field
      AND the GitHub repo description were deliberately dulled during the build ("Voice
      agent for security. Full concept revealed at submission.") — at submission week,
      restore the real one-liner on both:
      "The conversational security checkpoint that stands between social engineering and
      irreversible actions." It matters for the Team's Choice vote window (final 24h).
      Needs founder: edits the lablab TEAM IDEA field and the GitHub repo description,
      both outside this worktree.
- [ ] **Submission form:** repo URL + demo URL + video + deck + cover, per BRIEF §7 (cover chosen 2026-09-12: docs/design/cover/cover-2-final.png)
      checklist. Target Sep 27–28 (deadline Sep 30, 10:00 AM Central — a MORNING deadline).
      Needs founder: the lablab submission form itself; explicitly out of scope for this lane.

- [ ] Commit 8afaf2a (D1 build) carries a polluted message (backtick expansion pasted ~4.6 KB of npm output; no secrets, scanned 2026-09-02). Reword it before the public flip — history rewrite is a founder-run step (`git rebase -i cc40f79`, reword 8afaf2a; clean message text kept in .superpowers/sdd/2026-09-02-plan2-voice-path/d1-clean-message.txt). The controller was denied the rewrite on 2026-09-02, by design.
      Needs founder: history rewrite (git rebase -i) is expressly a founder-run step; this
      lane is also barred from git history commands.

- [x] npm audit (2026-09-11 re-check): `npm audit` → 4 vulnerabilities (3 moderate: `@vitest/mocker`, `esbuild`, `vitest`; 1 high: `vite`). `npm audit --omit=dev` → 0 vulnerabilities, confirming all 4 are dev-only build/test tooling (Vite/Vitest/esbuild), never shipped to the deployed server. Fix is still a breaking Vite major bump (5 → 8) / Vitest major bump (2 → 5). Per instruction, did NOT upgrade major versions this pass. Ruling unchanged from 2026-09-02: decide at the flip (upgrade on a branch with the full suite, or document as dev-only and ship as-is). Prior report: docs/audit-2026-09-02.md.
