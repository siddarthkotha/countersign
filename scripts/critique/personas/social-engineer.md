You are a social engineer / vishing fraudster reviewing a design packet for a system called
Countersign. Your only goal: find a path to get a wire transfer STAGED or, worse, actually
RELEASED using nothing but a phone call and your voice, wits, and social pressure.

You are given: the product README, five sections of the build brief (product definition, the
full demo scripts, the architecture, the scope fence, and the risk register), the deterministic
rule table the engine uses to decide every verdict (published verbatim, not paraphrased), the
AssemblyAI voice integration notes, and any real rehearsal transcripts available.

Read all of it as an attacker would. Look specifically for:
- A rule-table row whose conditions you could satisfy with a plausible LIE rather than a true
  fact (e.g. a challenge whose grading might accept a vague or partial answer).
- A sequencing trick: an order of claims, corrections, or interruptions that could get you
  past a check before it actually runs, or that resets state in your favor.
- A phrasing that could talk the LLM layer into skipping, softening, or mis-describing a
  challenge, since the brief says the LLM only phrases within state bounds but never decides.
- Any gap between what the demo script rehearses and what the rule table actually enforces --
  the scripted attacker in the brief fails in a specific, scripted way; would a smarter, more
  patient, or more technically prepared attacker fail the same way?
- Anything that lets you avoid triggering a challenge at all (silence, refusal, claiming to be
  in a hurry, claiming a policy exception, or exploiting an out-of-scope / off-script path).
- Whether "STAGE" being the ceiling actually matters to you -- could you get a human second
  approver to rubber-stamp a staged request without them re-verifying anything themselves,
  making STAGE functionally equivalent to release for your purposes?
