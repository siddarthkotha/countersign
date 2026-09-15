// packages/engine/src/extract/personQuestion.ts
// Identifies caller utterances that are answers to person-shaped challenges or readbacks.
// Used by identity.ts and compose.ts to skip false identity claims when a bare name
// is answering a question about a person field (approver, counsel, beneficiary, escrow_institution).

import type { AgentAction, Claim, ClaimField, ChallengeSpec, SeedConfig, Utterance } from '../types.js';
import { isAnswerShapedFor, seedFieldForEntry } from '../challenges.js';

const PERSON_SHAPED_FIELDS = new Set<ClaimField>(['approver', 'counsel', 'beneficiary', 'escrow_institution']);

/** Map a fact_id to its corresponding claim field, using the same logic as selectSeedFact.
 *  This handles cases where a challenge_issued action may have a fact_id but no explicit field. */
function fieldForFactId(fact_id: string): ClaimField | null {
  return seedFieldForEntry(fact_id);
}

/** Returns the set of caller utterance ids that are answers to person-shaped challenges
 *  or readbacks. Extends the exemption from identity-switch checking to every caller
 *  utterance from a person-shaped challenge_issued (or readback_issued) action up to and
 *  including the first caller utterance that is answer-shaped for that field, or up to
 *  the next agent action of a different kind, whichever comes first.
 *
 *  A repeat challenge_issued with the same challenge_id (a re-ask) keeps the window open.
 *
 *  Explicit-cue rules (e.g. "this is Marcus Obi") still apply within the window.
 *
 *  FIX (2026-09-15): Previously only the FIRST caller utterance after the action got
 *  the exemption. If the caller said "um" (not answer-shaped), the next utterance would
 *  revert to normal rules even if it answered the question. With the new semantics,
 *  a sequence like "um, let me think" / "Marcus Obi." is now correctly handled: both
 *  utterances fall within the exemption window. */
export function answersToPersonQuestion(
  conversation: Utterance[] | undefined,
  actions: AgentAction[] | undefined,
  seed?: SeedConfig,
  claims?: Claim[],
  issued?: ChallengeSpec[],
): Set<string> {
  const answers = new Set<string>();

  if (!conversation || !actions || conversation.length === 0 || actions.length === 0) {
    return answers;
  }

  // Filter to challenge_issued and readback_issued actions, sorted by time
  const boundaryActions = actions
    .filter((a) => a.kind === 'challenge_issued' || a.kind === 'readback_issued')
    .sort((a, b) => a.t_ms - b.t_ms);

  if (boundaryActions.length === 0) {
    return answers;
  }

  const callerUtterances = conversation.filter((u) => u.speaker === 'caller').sort((a, b) => a.t_ms - b.t_ms);

  for (const action of boundaryActions) {
    // Determine which field and spec this action is asking about
    let field: ClaimField | null = null;
    let spec: ChallengeSpec | undefined = undefined;

    if (action.kind === 'readback_issued') {
      field = action.field ?? null;
    } else if (action.kind === 'challenge_issued') {
      // For challenge_issued, use action.spec if present, otherwise look it up in issued
      spec = action.spec;
      if (!spec && issued) {
        // Try to find the corresponding spec in the issued array (match by challenge_id or approximate position)
        spec = issued.find((s) => s.challenge_id === action.challenge_id);
      }

      if (spec?.field) {
        field = spec.field;
      } else if (spec?.fact_id) {
        field = fieldForFactId(spec.fact_id);
      }
    }

    // Skip if not a person-shaped field
    if (!field || !PERSON_SHAPED_FIELDS.has(field)) {
      continue;
    }

    // If seed, claims, AND spec are all available for a challenge_issued, use the new extended-window behavior.
    // Otherwise, fall back to the old behavior (first caller utterance only).
    if (seed && claims && action.kind === 'challenge_issued' && spec) {
      // New behavior: extend exemption to all utterances until first answer-shaped one
      const nextAgentActionT = actions
        .filter(
          (a) =>
            a.t_ms > action.t_ms &&
            ((a.kind === 'challenge_issued' && a.challenge_id !== action.challenge_id) || a.kind === 'readback_issued'),
        )
        .reduce<number | undefined>((min, a) => (min === undefined || a.t_ms < min ? a.t_ms : min), undefined);

      const windowUtterances = callerUtterances.filter(
        (u) => u.t_ms > action.t_ms && (nextAgentActionT === undefined || u.t_ms < nextAgentActionT),
      );

      for (const utterance of windowUtterances) {
        answers.add(utterance.id);
        if (isAnswerShapedFor(spec, utterance.text, seed, claims)) {
          // Window closes after this answer-shaped utterance
          break;
        }
      }
    } else {
      // Old behavior: add only the first caller utterance after the action
      const firstCallerAfter = callerUtterances.find((u) => u.t_ms > action.t_ms);
      if (firstCallerAfter) {
        answers.add(firstCallerAfter.id);
      }
    }
  }

  return answers;
}
