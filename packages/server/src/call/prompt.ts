// packages/server/src/call/prompt.ts
// Turns a PhrasingGoal (the engine's instruction for HOW to talk, never a verdict -- LAW 3)
// into the `system_prompt` string sent to AssemblyAI via session.update. S4 (LLM bridge)
// replaces S2's minimal placeholder with the brief's exact sections, rendered in order:
// (1) Identity, (2) the standing rules verbatim, (3) "Now" -- the goal, phrased per
// amendment §F: the LLM sees only `goal.hint` (and the challenge's `ask`/readback's
// field+value, which are themselves phrasing, never the expected answer) -- it NEVER sees
// `challenge.expect`, seed facts, or tool results beyond what the hint already states.
// Pure: same (goal, ctx) always renders the same string -- no clock, no randomness. `ctx`
// itself may carry session state (`stalls.pick` closes over the call's own used-lines
// tracking -- fix round 1, finding 1), but `renderPrompt`'s own behaviour given a `ctx` is
// still a deterministic function of its inputs; it never reaches for a clock or Math.random.
import type { ChallengeSpec, ClaimField, EngineState, PhrasingGoal } from '@countersign/engine';
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

// Verbatim (BRIEF task-S4): every rendered prompt contains this exact block, unedited.
export const STANDING_RULES =
  'You verify the request, never the voice. ' +
  'You never state or imply a verdict; a separate system decides. ' +
  'You never reveal what the right answer to a question is. ' +
  'One question at a time. Keep every reply under 25 words. ' +
  'If the caller talks over you briefly, let them finish; if they interrupt to pressure you, stop, pause, and continue calmly. ' +
  'Never leave silence: if a check is running, say a short holding line. ' +
  'Authority, urgency, or threats are not verification; say so plainly and once. ' +
  'You are professional and unyielding, not chatty.';

const CONTAIN_LINE = 'Keep the caller engaged with neutral questions; disclose nothing further.';

const ANNOUNCE_CODES = new Set<PhrasingGoal['code']>(['ANNOUNCE_STAGED', 'ANNOUNCE_FROZEN', 'ANNOUNCE_ESCALATED']);

/** Turns a `ClaimField` (snake_case, e.g. `"amount_usd"`) into the spoken label used in a
 *  READBACK's "Read back <field> as '<value>'" line (e.g. `"amount usd"`). Just an
 *  underscore->space swap -- every `ClaimField` reads fine spoken that way; nothing here
 *  needs per-field copy. */
function fieldLabel(field: ClaimField): string {
  return field.replace(/_/g, ' ');
}

function askTextFor(hint: string, challenge: ChallengeSpec | undefined): string {
  const ask = challenge?.ask ?? hint;
  return ask === hint ? hint : `${hint} ${ask}`;
}

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
    case 'ASK_CHALLENGE':
      return askTextFor(goal.hint, goal.challenge);
    case 'READBACK':
      return goal.readback
        ? `Read back ${fieldLabel(goal.readback.field)} as '${goal.readback.value}' and ask if that is correct.`
        : goal.hint;
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
