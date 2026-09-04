// packages/server/src/call/prompt.ts
// Turns a PhrasingGoal (the engine's instruction for HOW to talk, never a verdict -- LAW 3)
// into the `system_prompt` string sent to AssemblyAI via session.update. S4 (LLM bridge)
// replaces S2's minimal placeholder with the brief's exact sections, rendered in order:
// (1) Identity, (2) the standing rules verbatim, (3) "Now" -- the goal, phrased per
// amendment §F: the LLM sees only `goal.hint` (and, for ASK_CHALLENGE, the challenge's own
// `ask` when it differs from the hint) -- it NEVER sees `challenge.expect`, seed facts, or
// tool results beyond what the hint already states. Bug fix (2026-09-03 later that night):
// `goal.readback.field`/`.value` are NOT rendered here at all any more -- fsm.ts composes the
// full ready-to-speak sentence straight into `goal.hint`, and `readback.field`/`.value` are
// now purely a ledger-matching data channel (what call/session.ts logs as the
// `readback_issued` AgentAction), never something this file phrases.
// Pure: same (goal, ctx) always renders the same string -- no clock, no randomness. `ctx`
// itself may carry session state (`stalls.pick` closes over the call's own used-lines
// tracking -- fix round 1, finding 1), but `renderPrompt`'s own behaviour given a `ctx` is
// still a deterministic function of its inputs; it never reaches for a clock or Math.random.
import type { EngineState, PhrasingGoal } from '@countersign/engine';
import type { StallKind } from './stalls.js';

export interface PromptCtx {
  company: string;
  agent_name: string;
  claimed_identity_name: string | null;
  state: EngineState;
  /** Fix round 1, finding 2: which check a STALL goal is actually stalling on, precomputed
   *  by the caller (`call/session.ts`, via `stallKindFor(output)`) from the live evidence
   *  state -- `prompt.ts` has no `EngineOutput` to derive it from itself. */
  stall_kind: StallKind;
  /** Fix round 1, finding 1: a closure over the CALL's own (not this one render's) used-
   *  stall-lines state, so consecutive STALL goals of the same kind actually get different
   *  lines instead of each render restarting from an empty `used` set. `call/session.ts`
   *  owns a `Map<StallKind, Set<string>>` for the life of the call and this closes over it. */
  stalls: { pick(kind: StallKind): string };
}

// Verbatim (BRIEF task-S4): every rendered prompt contains this exact block, unedited except
// for one appended sentence (see below) -- never edit the sentences above it.
//
// Bug fix (2026-09-03, founder-observed live run tonight, see
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): on Dana's
// first line the voice model spoke the required trap-fact challenge and then ADDED "Please
// state your identity id", then repeated variants of that on the next two turns -- violating
// "one question at a time" above and inventing a system field ("identity id") the caller can
// never know. Root cause (fixed alongside this, see fsm.ts/aai/config.ts): the server used to
// advertise the lookup tools' schemas -- each carrying a required `identity_id` parameter --
// to the model, which is where it learned the field name. The model is now offered no tool
// schema at all, but the standing rules get one more sentence anyway, as a second,
// independent guard against the same failure mode recurring for any other reason.
//
// Bug fix (2026-09-03 later that night -- the standing sentence above was not enough): two
// MORE harness runs (scripts/rehearse/reports/2026-09-03T23-32-42- and T23-39-25-
// scenario-a-dana-legitimate.md) show the model still improvising past a bare instruction --
// "authorization code" in one run, "the purpose of the transaction" in the next -- this time
// while stuck in CONSISTENCY_CHECK, because the READBACK/ASK_CHALLENGE instructions it was
// actually given were prose ("Read back X as Y and ask if that's correct") or a bare question
// with nothing telling it not to add to it. Fixed at the source (see nowSection's READBACK/
// ASK_CHALLENGE cases below, both now wrapped in "say exactly this and nothing else"), plus
// one more standing-rule sentence appended below as a second, independent guard, same
// reasoning as the identifiers/ids/codes sentence above.
export const STANDING_RULES =
  'You verify the request, never the voice. ' +
  'You never state or imply a verdict; a separate system decides. ' +
  'You never reveal what the right answer to a question is. ' +
  'One question at a time. Keep every reply under 25 words. ' +
  'If the caller talks over you briefly, let them finish; if they interrupt to pressure you, stop, pause, and continue calmly. ' +
  'Never leave silence: if a check is running, say a short holding line. ' +
  'Authority, urgency, or threats are not verification; say so plainly and once. ' +
  'You are professional and unyielding, not chatty. ' +
  'Never ask the caller for identifiers, ids, codes, or system fields; you already have everything you need to ask your one question. ' +
  'When an instruction gives you an exact line, say only that line and add no question of your own.';

const CONTAIN_LINE = 'Keep the caller engaged with neutral questions; disclose nothing further.';

const ANNOUNCE_CODES = new Set<PhrasingGoal['code']>(['ANNOUNCE_STAGED', 'ANNOUNCE_FROZEN', 'ANNOUNCE_ESCALATED']);

/** The "Now" section: what to do about THIS goal, and nothing else -- never the expected
 *  answer, never a seed fact, never more of a tool result than the hint already carries.
 *  Minor (fix round 1): `ctx.state`/`ctx.claimed_identity_name` are put to real use here --
 *  GREET names the desk explicitly when it's truly the call's opening turn (`state ===
 *  'INTAKE'`), and once an identity is claimed, an ANNOUNCE_* goal may address the caller by
 *  that name (a cheap, warmer touch for the demo). Deliberately NOT done for ASK_CHALLENGE --
 *  addressing the caller by the name they themselves claimed, right as their claim to that
 *  identity is being tested, would read as the system tipping its hand. */
function nowSection(goal: PhrasingGoal, ctx: PromptCtx): string {
  switch (goal.code) {
    // Bug fix (2026-09-03 later that night): a bare challenge question (or the old prose
    // READBACK instruction below) left room for the model to add to it -- three harness runs
    // show it doing exactly that (see the doc comment on STANDING_RULES above). Both cases
    // now hand the model an exact, already-composed sentence with the same "say exactly this
    // and nothing else" wrapper STALL's holding lines already use. The engine writes the
    // words (LAW 3); this function's only job here is to relay them unedited.
    case 'ASK_CHALLENGE': {
      // Correction (2026-09-04, caught on a live run): a challenge's `ask` is written as a
      // DIRECTION to the agent, not as a line a person would say. Wrapping it in "say exactly
      // this" made the agent read its own stage directions aloud, verbatim, on a real call:
      // "Confirm the request back to the caller as if summarizing, but say Northgate Partners
      // in place of their beneficiary, then pause." It also read an internal field name out
      // loud ("restate the amount_usd"). So a challenge is relayed as an instruction to
      // follow, never as a line to recite, with the two rules that the verbatim wrapper was
      // there to enforce stated explicitly instead. READBACK below keeps the verbatim
      // treatment, because the engine composes a genuinely speakable sentence for it.
      // Parked follow-up: have the engine compose speakable challenge questions too, so this
      // branch can go back to relaying exact words.
      const ask = goal.challenge?.ask ?? goal.hint;
      return (
        `Do what this direction says, in your own words, as ONE spoken question. ` +
        `Never read the direction itself aloud, and never say a field name like "amount_usd". ` +
        `The direction: ${ask}`
      );
    }
    case 'READBACK':
      // fsm.ts composes the exact, ready-to-speak confirmation sentence into `goal.hint`
      // itself (natural per-field phrasing, e.g. "Just to confirm, the amount is $84,500. Is
      // that correct?") -- `goal.readback.field`/`.value` are no longer read here at all;
      // `value` now only carries the ledger-comparable canonical form that
      // call/session.ts's recordGoalCompletionAction copies into the `readback_issued`
      // AgentAction (see fsm.ts's own doc comment on `readbackSentence` for why that had to
      // change too).
      return `Say exactly this and nothing else: "${goal.hint}"`;
    case 'STALL': {
      const line = ctx.stalls.pick(ctx.stall_kind);
      return `Hold the floor with this line: "${line}"`;
    }
    case 'CONTAIN':
    case 'CONTAIN_NO_DISCLOSURE':
      return CONTAIN_LINE;
    case 'GREET':
      return ctx.state === 'INTAKE' ? `${goal.hint} Mention this is the treasury desk.` : goal.hint;
    default:
      if (ANNOUNCE_CODES.has(goal.code) && ctx.claimed_identity_name) {
        return `${goal.hint} Address the caller as ${ctx.claimed_identity_name}.`;
      }
      // ELICIT_IDENTITY, ELICIT_REQUEST, PROBE_CONSISTENCY, REFUSE_AUTHORITY,
      // EXPLAIN_OUT_OF_SCOPE, CLOSE, RE_ELICIT_AFTER_SWITCH, EXPLAIN_OPEN_REQUEST, and an
      // ANNOUNCE_* goal before any identity is claimed: the hint, verbatim, and nothing
      // added (the engine already wrote whatever reasons belong in it).
      return goal.hint;
  }
}

export function renderPrompt(goal: PhrasingGoal, ctx: PromptCtx): string {
  const identity = `You are ${ctx.agent_name}, the verification checkpoint on the ${ctx.company} treasury desk.`;
  return [identity, STANDING_RULES, nowSection(goal, ctx)].join('\n\n');
}
