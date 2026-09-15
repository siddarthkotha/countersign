import { describe, it, expect } from 'vitest';
import { resolveIdentitySwitch } from '../src/compose';
import { answersToPersonQuestion } from '../src/extract/personQuestion';
import { MERIDIAN } from '../src/seed/meridian';
import type { Evidence, Claim, Utterance, AgentAction } from '../src/types';

describe('resolveIdentitySwitch with person question context', () => {
  /**
   * Scenario: A genuine identity switch is flagged, then the caller answers an
   * approver challenge with a bare "Marcus Obi." and later gives an explicit
   * self-id "this is Robert Miller". Only the explicit self-id should count as
   * a reclaim; the bare-name challenge answer should not trigger resolution.
   */
  it('bare-name challenge answer does not count as reclaim after switch', () => {
    // Setup: conversation where someone switches from Robert Miller to Marcus Obi,
    // then answers an approver challenge with bare "Marcus Obi.", then explicitly
    // re-states "I'm Robert Miller speaking" (reclaiming the original identity).
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, this is Robert Miller', t_ms: 1000 },
      { id: 'a1', speaker: 'agent', text: 'What vendor?', t_ms: 1100 },
      { id: 'c2', speaker: 'caller', text: 'This is Marcus Obi actually', t_ms: 1200 },
      { id: 'a2', speaker: 'agent', text: 'Who approved this?', t_ms: 1300 },
      { id: 'c3', speaker: 'caller', text: 'Marcus Obi.', t_ms: 1400 }, // bare name, answering approver challenge
      { id: 'a3', speaker: 'agent', text: 'To confirm...', t_ms: 1500 },
      { id: 'c4', speaker: 'caller', text: 'I am Robert Miller speaking.', t_ms: 1600 }, // explicit self-id, reclaiming
    ];

    const actions: AgentAction[] = [
      {
        id: 'ch1',
        kind: 'challenge_issued',
        t_ms: 1300,
        challenge_id: 'ch-1',
        spec: {
          challenge_id: 'ch-1',
          kind: 'SEED_FACT',
          field: 'approver',
          ask: 'Ask who approved this.',
          speak: 'Who approved this?',
          expect: { accept_tokens: ['marcus', 'obi'] },
          fact_id: 'dana_internal_approver',
        },
      },
    ];

    const personQuestionAnswers = answersToPersonQuestion(conversation, actions);

    // c3 (bare "Marcus Obi.") should be in personQuestionAnswers because it's the
    // first caller utterance after the approver challenge
    expect(personQuestionAnswers.has('c3')).toBe(true);
    // c4 is NOT after a person challenge, so it's not in the set
    expect(personQuestionAnswers.has('c4')).toBe(false);

    // Create evidence with an identity switch
    const transcriptEv: Evidence[] = [
      {
        id: 'ev-identity-switch',
        kind: 'identity_switch',
        t_ms: 1200,
        label: 'Identity switch',
        status: 'FLAG',
        detail: 'Caller first claimed Robert Miller, then claimed Marcus Obi.',
        facts: { first_id: 'robert-miller', later_id: 'marcus-obi' },
        quotes: [
          { utterance_id: 'c1', text: 'Robert Miller' },
          { utterance_id: 'c2', text: 'Marcus Obi' },
        ],
        source: 'transcript',
        provenance: 'CALLER_SAID',
        request_version: 1,
      },
    ];

    // No claims yet (simplified test)
    const claims: Claim[] = [];

    // Resolve with personQuestionAnswers context
    const result = resolveIdentitySwitch(transcriptEv, conversation, claims, MERIDIAN, personQuestionAnswers);

    // The switch should NOT be resolved (demoted to INFO) because c3 (the only
    // later mention of Marcus Obi) is a bare name answering a challenge, not a
    // genuine reclaim. The later c4 "I am Robert Miller speaking" is not checking
    // for marcus-obi, it's a different identity, so the switch stays FLAG.
    const switchEv = result.find((e) => e.kind === 'identity_switch');
    expect(switchEv?.status).toBe('FLAG');
  });

  it('explicit self-id after switch does count as reclaim', () => {
    // Similar scenario but now the caller reclaims Marcus Obi with explicit self-id
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, this is Robert Miller', t_ms: 1000 },
      { id: 'a1', speaker: 'agent', text: 'What vendor?', t_ms: 1100 },
      { id: 'c2', speaker: 'caller', text: 'This is Marcus Obi actually', t_ms: 1200 },
      { id: 'a2', speaker: 'agent', text: 'To confirm...', t_ms: 1300 },
      { id: 'c3', speaker: 'caller', text: 'I am Marcus Obi speaking.', t_ms: 1400 }, // explicit self-id with cue
    ];

    const actions: AgentAction[] = [];

    const personQuestionAnswers = answersToPersonQuestion(conversation, actions);

    // No challenge actions, so no person question answers
    expect(personQuestionAnswers.size).toBe(0);

    // Create evidence with an identity switch
    const transcriptEv: Evidence[] = [
      {
        id: 'ev-identity-switch',
        kind: 'identity_switch',
        t_ms: 1200,
        label: 'Identity switch',
        status: 'FLAG',
        detail: 'Caller first claimed Robert Miller, then claimed Marcus Obi.',
        facts: { first_id: 'robert-miller', later_id: 'marcus-obi' },
        quotes: [
          { utterance_id: 'c1', text: 'Robert Miller' },
          { utterance_id: 'c2', text: 'Marcus Obi' },
        ],
        source: 'transcript',
        provenance: 'CALLER_SAID',
        request_version: 1,
      },
    ];

    const claims: Claim[] = [];

    // Resolve without personQuestionAnswers (none available)
    const result = resolveIdentitySwitch(transcriptEv, conversation, claims, MERIDIAN);

    // The switch SHOULD be resolved (demoted to INFO) because c3 has the explicit
    // "I am Marcus Obi speaking" self-id cue, matching the later_id
    const switchEv = result.find((e) => e.kind === 'identity_switch');
    expect(switchEv?.status).toBe('INFO');
    expect(switchEv?.detail).toContain('re-stated this identity');
  });
});
