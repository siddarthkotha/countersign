// packages/engine/src/extract/personQuestion.ts
// Identifies caller utterances that are answers to person-shaped challenges or readbacks.
// Used by identity.ts and compose.ts to skip false identity claims when a bare name
// is answering a question about a person field (approver, counsel, beneficiary, escrow_institution).

import type { AgentAction, ClaimField, Utterance } from '../types.js';
import { seedFieldForEntry } from '../challenges.js';

const PERSON_SHAPED_FIELDS = new Set<ClaimField>(['approver', 'counsel', 'beneficiary', 'escrow_institution']);

/** Map a fact_id to its corresponding claim field, using the same logic as selectSeedFact.
 *  This handles cases where a challenge_issued action may have a fact_id but no explicit field. */
function fieldForFactId(fact_id: string): ClaimField | null {
  return seedFieldForEntry(fact_id);
}

/** Returns the set of caller utterance ids that are the first caller utterance after
 *  a challenge_issued or readback_issued action for a person-shaped field, with no other
 *  caller utterance in between. Used to detect when a bare name is answering a person
 *  question and should not be treated as a self-identification. */
export function answersToPersonQuestion(
  conversation: Utterance[] | undefined,
  actions: AgentAction[] | undefined,
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
    // Determine which field this action is asking about
    let field: ClaimField | null = null;

    if (action.kind === 'readback_issued') {
      field = action.field ?? null;
    } else if (action.kind === 'challenge_issued') {
      // For challenge_issued, check spec.field first, then spec.fact_id
      if (action.spec?.field) {
        field = action.spec.field;
      } else if (action.spec?.fact_id) {
        field = fieldForFactId(action.spec.fact_id);
      }
    }

    // Skip if not a person-shaped field
    if (!field || !PERSON_SHAPED_FIELDS.has(field)) {
      continue;
    }

    // Find the first caller utterance strictly after this action's t_ms
    const firstCallerAfter = callerUtterances.find((u) => u.t_ms > action.t_ms);
    if (firstCallerAfter) {
      answers.add(firstCallerAfter.id);
    }
  }

  return answers;
}
