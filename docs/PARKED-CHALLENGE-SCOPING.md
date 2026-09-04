# Parked for the founder: who gets asked what, and what happens when there is nothing to ask

Written 2026-09-04, about 12:25 AM CDT, on autopilot. This is a decision, not a bug report.
The work is built and tested and is deliberately NOT committed. Two concrete options are at
the bottom. One word from the founder finishes it.

## The bug that started this

An adversarial review found that `selectSeedFact` in packages/engine/src/challenges.ts
filtered by nothing at all, and every seeded knowledge fact in
packages/engine/src/seed/meridian.ts belongs to Robert Miller's fictional Hartwell
acquisition: the counsel of record, the escrow institution, the target's chief executive, the
signing city, the escrow account digits, the board approval date.

So an honest caller with an unrelated payment could be handed a question about a deal she has
nothing to do with, fail it because nobody could answer it, and be pushed away from staging.
That is a false-positive machine, which is the failure mode that destroys trust in a real
security control. The finding was correct.

## The fix that was built, and why it is not committed

An agent scoped every Hartwell fact to Robert Miller's identity and made the selector refuse
anything out of scope, failing safe by returning nothing rather than reaching for someone
else's business. It was written test first, and on its own it is good work: 750 tests green,
all 18 recorded calls replay exactly, types clean.

Then the pre-commit gate went red on three server tests, and the reason matters.

I probed the real selector directly, with the fix applied, driving each caller's opening line
through the live code:

- Robert Miller, the fraudster, gets three challenges in priority order: counsel of record,
  then the escrow institution, then the escrow account digits. Correct and unchanged.
- Dana Whitfield, the honest caller, gets **nothing**. The selector returns null on the very
  first request.

She gets nothing because every seeded knowledge fact is now correctly out of her scope, and
the other two challenge kinds cannot help her either: the trap question only fires when the
caller has named a counsel or an escrow institution, and she names neither, and the live
commitment question needs earlier turns to build on.

The engine's rule rows decide whether a challenge is still owed by counting how many have
been issued, not by asking whether one can actually be produced. So with the fix in place, an
honest caller sits in the challenge state waiting for a question that can never be generated.

That trades one bug for a worse one. Before the fix she is asked something impossible and
fails it. After the fix she is asked nothing and the call cannot move at all.

## Why this needs the founder and not another agent

Both ways out are decisions, not repairs.

Giving the honest caller something to answer means inventing what she knows: facts about her
own vendor, her own approval, her own payment. That is new content in the synthetic world,
and the synthetic world is specified in the brief and shapes the demo's story.

Letting the engine move on when no challenge exists means a caller can reach staging having
passed no knowledge challenge at all. That is a weakening of the deterministic core, and it
is the same hole the adversarial review already flagged separately, where a caller who
recites an existing invoice is asked nothing and goes straight through. Making that easier
unattended, at half past midnight, is exactly the kind of change the founder's own rule says
to bring to him.

## The two options

**Option A, recommended. Give Dana her own facts.** Add two or three knowledge facts to the
seed scoped to Dana Whitfield and drawn from her own world: the vendor's own contact or
invoice reference, which internal approver signed off, the payment's stated purpose. Then keep
the scoping fix exactly as built. The honest path becomes genuinely verifiable: she is asked
something she really knows, she answers it, she stages. This is the version that makes the
demo tell the truth, because the whole claim is that an honest caller passes and a fraudster
does not. Cost: writing a few lines of synthetic seed data, then the existing tests and the
automated rehearsal confirm it. It changes no rule and no invariant.

**Option B. Let the engine proceed when the well is dry, and cap what that can reach.** Keep
the scoping fix, and change the rule row so a challenge that cannot be produced does not hold
the call, while ALSO ensuring that a caller who passed no knowledge challenge can never reach
staging and lands on escalate instead. Safe in direction, but it touches the rule table and
the assurance checklist, so it needs its own review pass and it makes the honest demo path end
in a human callback rather than a staged payment, which is a weaker story.

Doing neither is also a real choice, and it is the current state: the scoping bug stays, an
honest caller can still be asked an impossible question, and nothing regresses tonight.

## Where the work is

The finished, tested patch is saved outside the repository at
`scratchpad/fix8.patch` in this session's working directory, and the branch
`worktree-agent-a085d3014a160fb08` still holds it. Nothing was committed to main, and main is
green at 761 tests.

## The sibling bug found on the way, also parked

`selectRelational` asks for the last four digits of the account attached to whichever
beneficiary the caller named, but always grades the answer against the Hartwell escrow
account's digits regardless of who the caller is. So an honest caller naming her own real
vendor would fail even when telling the truth. It is currently unreachable, because the other
challenge kinds always win the available slots in every recorded scenario, but it is the same
family and the same decision covers it.
