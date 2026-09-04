// packages/engine/test/fsm.test.ts
// Bug fix (2026-09-03, founder-observed live run tonight, see
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): the voice
// model was offered the three EVIDENCE/CONSISTENCY_CHECK lookup tools' schemas (each
// carrying a required `identity_id: string` parameter), learned that field name, and started
// asking the caller for their "identity id" -- violating the standing rule (one question at
// a time) and inventing a system field the caller can never know. Since commit 422d750 the
// server runs get_request_history/check_sso_context/verify_out_of_band itself
// (`runLookupsIfNeeded`, call/session.ts) the instant EVIDENCE/CONSISTENCY_CHECK is reached,
// so the model never needed to be OFFERED these tools at all. This test proves
// `allowedTools` returns [] for every EngineState -- the voice model is offered NO tools,
// ever, ceiling zero, not just for the states that used to already return [].
import { describe, it, expect } from 'vitest';
import { allowedTools } from '../src/fsm';
import type { EngineState, Verdict } from '../src/types';

const ALL_STATES: EngineState[] = [
  'INTAKE',
  'CLAIM',
  'CHALLENGE',
  'EVIDENCE',
  'CONSISTENCY_CHECK',
  'DECISION',
  'ACTION',
  'SEALED',
  'OUT_OF_SCOPE',
];

const SOME_VERDICTS: Verdict[] = ['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION'];

describe('allowedTools -- the voice model is offered no tools, ever', () => {
  for (const state of ALL_STATES) {
    for (const verdict of SOME_VERDICTS) {
      it(`returns [] for state=${state}, verdict=${verdict}`, () => {
        expect(allowedTools(state, verdict)).toEqual([]);
      });
    }
  }

  it('covers every EngineState member (fails loudly if a new state is ever added here without a test)', () => {
    expect(ALL_STATES).toHaveLength(9);
  });
});
