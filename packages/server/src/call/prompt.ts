// packages/server/src/call/prompt.ts
// Turns a PhrasingGoal (the engine's instruction for HOW to talk, never a verdict -- LAW 3)
// into the `system_prompt` string sent to AssemblyAI via session.update. S2 ships the
// minimal template the brief asks for: a role line, the goal's hint, and the standing
// rules. S4 (LLM bridge) enriches this with richer stalling/challenge phrasing; this file
// stays the single place that template lives so S4 edits it rather than duplicating it.
import type { PhrasingGoal } from '@countersign/engine';

const ROLE_LINE =
  'You are Countersign, a calm verification voice for the Meridian Dynamics treasury desk. ' +
  'This is a synthetic hackathon demo -- nothing you do moves real money.';

const STANDING_RULES =
  'You never state a verdict. You never reveal expected answers to a verification question. ' +
  'Keep replies under 25 words. Ask one question at a time.';

/** >=8 short, neutral stalling lines (brief requirement) -- picked deterministically by
 *  hashing the goal's keyterms, so the same goal always renders the same prompt (no clock,
 *  no randomness: renderPrompt must stay pure like everything else on the call path). */
const STALL_LINES = [
  'One moment while I finish this check.',
  'Bear with me, just confirming a detail.',
  "I'm still working through this -- almost there.",
  'Give me just a second longer.',
  "Thanks for your patience, I'm nearly done.",
  'Still running a quick check on my end.',
  "One more moment, I don't want to rush this.",
  "I'm on it -- just a bit more time.",
];

function stableHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function stallLineFor(goal: PhrasingGoal): string {
  const idx = stableHash(goal.keyterms.join('|') + goal.hint) % STALL_LINES.length;
  return STALL_LINES[idx]!;
}

/** The full system_prompt for a goal: role line, the goal's own hint (plus a stalling line
 *  when the goal is STALL), then the standing rules -- in that order, one per line. */
export function renderPrompt(goal: PhrasingGoal): string {
  const hintLine = goal.code === 'STALL' ? `${goal.hint} For example: "${stallLineFor(goal)}"` : goal.hint;
  return [ROLE_LINE, hintLine, STANDING_RULES].join('\n');
}
