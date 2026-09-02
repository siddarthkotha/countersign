// packages/server/src/call/prompt.ts
// Turns a PhrasingGoal (the engine's instruction for HOW to talk, never a verdict -- LAW 3)
// into the `system_prompt` string sent to AssemblyAI via session.update. S4 (LLM bridge)
// replaces S2's minimal placeholder with the brief's exact sections, rendered in order:
// (1) Identity, (2) the standing rules verbatim, (3) "Now" -- the goal, phrased per
// amendment §F: the LLM sees only `goal.hint` (and the challenge's `ask`/readback's
// field+value, which are themselves phrasing, never the expected answer) -- it NEVER sees
// `challenge.expect`, seed facts, or tool results beyond what the hint already states.
// Pure: same (goal, ctx) always renders the same string -- no clock, no randomness.
import type { ChallengeSpec, ClaimField, EngineState, PhrasingGoal } from '@countersign/engine';
import { kindFromHint, stallLineFor } from './stalls.js';

export interface PromptCtx {
  company: string;
  agent_name: string;
  claimed_identity_name: string | null;
  state: EngineState;
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

function fieldLabel(field: ClaimField): string {
  return field.replace(/_/g, ' ');
}

function askTextFor(hint: string, challenge: ChallengeSpec | undefined): string {
  const ask = challenge?.ask ?? hint;
  return ask === hint ? hint : `${hint} ${ask}`;
}

/** The "Now" section: what to do about THIS goal, and nothing else -- never the expected
 *  answer, never a seed fact, never more of a tool result than the hint already carries. */
function nowSection(goal: PhrasingGoal): string {
  switch (goal.code) {
    case 'ASK_CHALLENGE':
      return askTextFor(goal.hint, goal.challenge);
    case 'READBACK':
      return goal.readback
        ? `Read back ${fieldLabel(goal.readback.field)} as '${goal.readback.value}' and ask if that is correct.`
        : goal.hint;
    case 'STALL': {
      const line = stallLineFor(kindFromHint(goal.hint), new Set());
      return `Hold the floor with this line: "${line}"`;
    }
    case 'CONTAIN':
    case 'CONTAIN_NO_DISCLOSURE':
      return CONTAIN_LINE;
    default:
      // GREET, ELICIT_IDENTITY, ELICIT_REQUEST, PROBE_CONSISTENCY, REFUSE_AUTHORITY,
      // ANNOUNCE_STAGED/FROZEN/ESCALATED, EXPLAIN_OUT_OF_SCOPE, CLOSE,
      // RE_ELICIT_AFTER_SWITCH, EXPLAIN_OPEN_REQUEST: the hint, verbatim, and nothing added
      // (the engine already wrote whatever reasons belong in it).
      return goal.hint;
  }
}

export function renderPrompt(goal: PhrasingGoal, ctx: PromptCtx): string {
  const identity = `You are ${ctx.agent_name}, the verification checkpoint on the ${ctx.company} treasury desk.`;
  return [identity, STANDING_RULES, nowSection(goal)].join('\n\n');
}
