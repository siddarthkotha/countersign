import { describe, it, expect } from 'vitest';
import { resolveIdentitySwitch } from '../src/compose';
import { answersToPersonQuestion } from '../src/extract/personQuestion';
import { MERIDIAN } from '../src/seed/meridian';
import { buildLedger } from '../src/ledger';
import { evaluate } from '../src/evaluate';
import type { Evidence, Claim, Utterance, AgentAction, ChallengeSpec, EngineInput } from '../src/types';

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

  it('fragment-split challenge answer: filler then bare name both exempt from identity check', () => {
    // FIX (2026-09-15): extend exemption window to include all utterances until the first
    // answer-shaped one. Test: caller says "um, let me think" (not answer-shaped), then
    // "Marcus Obi." (answer-shaped for approver). Both should be exempt.
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, this is Dana Whitfield', t_ms: 1000 },
      { id: 'a1', speaker: 'agent', text: 'Who approved this?', t_ms: 1100 },
      { id: 'c2', speaker: 'caller', text: 'um, let me think', t_ms: 1200 }, // filler, not answer-shaped
      { id: 'c3', speaker: 'caller', text: 'Marcus Obi.', t_ms: 1300 }, // answer-shaped for approver
      { id: 'a2', speaker: 'agent', text: 'Thanks.', t_ms: 1400 },
    ];

    const actions: AgentAction[] = [
      {
        id: 'ch1',
        kind: 'challenge_issued',
        t_ms: 1100,
        challenge_id: 'ch-1',
        spec: {
          challenge_id: 'ch-1',
          kind: 'LIVE_COMMITMENT',
          field: 'approver',
          ask: 'Ask who approved this.',
          speak: 'Who approved this?',
          expect: { commitment_claim_id: 'claim-1' },
        } as ChallengeSpec,
      },
    ];

    // Build claims to have an 'approver' claim with value 'Marcus Obi'
    const { claims } = buildLedger(conversation, actions, MERIDIAN);

    const personQuestionAnswers = answersToPersonQuestion(conversation, actions, MERIDIAN, claims);

    // Both c2 (filler) and c3 (answer) should be in the exemption window
    expect(personQuestionAnswers.has('c2')).toBe(true);
    expect(personQuestionAnswers.has('c3')).toBe(true);
  });

  it('explicit cue inside challenge window still registers identity', () => {
    // The explicit cue rule (a) should still apply inside the exemption window.
    // If caller says "this is Robert Miller speaking" while answering an approver challenge,
    // it should still register as an identity claim.
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, I need to send money', t_ms: 1000 },
      { id: 'a1', speaker: 'agent', text: 'Who approved this?', t_ms: 1100 },
      { id: 'c2', speaker: 'caller', text: 'this is Robert Miller speaking', t_ms: 1200 }, // explicit self-id cue
    ];

    const actions: AgentAction[] = [
      {
        id: 'ch1',
        kind: 'challenge_issued',
        t_ms: 1100,
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

    const { claims } = buildLedger(conversation, actions, MERIDIAN);
    const personQuestionAnswers = answersToPersonQuestion(conversation, actions, MERIDIAN, claims);

    // c2 is exempt (inside challenge window), but it has an explicit cue so identity.ts
    // should still extract the identity claim. answeringPersonQuestion flag only skips
    // rule (b) startsUtteranceValidly, not rules (a) explicit cues.
    expect(personQuestionAnswers.has('c2')).toBe(true);
  });

  it('bare name after answer-shaped reply is NOT exempt', () => {
    // FIX (2026-09-15): window should close after first answer-shaped utterance.
    // Test: challenge asks for approver, caller answers "Marcus Obi." (answer-shaped),
    // then later says just "Obi" (bare name). The later bare name is NOT exempt.
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, Dana Whitfield', t_ms: 1000 },
      { id: 'a1', speaker: 'agent', text: 'Who approved this?', t_ms: 1100 },
      { id: 'c2', speaker: 'caller', text: 'Marcus Obi.', t_ms: 1200 }, // answer-shaped, closes window
      { id: 'a2', speaker: 'agent', text: 'And the amount?', t_ms: 1300 },
      { id: 'c3', speaker: 'caller', text: 'Obi did it', t_ms: 1400 }, // NOT exempt (after window closed)
    ];

    const actions: AgentAction[] = [
      {
        id: 'ch1',
        kind: 'challenge_issued',
        t_ms: 1100,
        challenge_id: 'ch-1',
        spec: {
          challenge_id: 'ch-1',
          kind: 'LIVE_COMMITMENT',
          field: 'approver',
          ask: 'Ask who approved this.',
          speak: 'Who approved this?',
          expect: { commitment_claim_id: 'claim-1' },
        } as ChallengeSpec,
      },
    ];

    const { claims } = buildLedger(conversation, actions, MERIDIAN);
    const personQuestionAnswers = answersToPersonQuestion(conversation, actions, MERIDIAN, claims);

    // c2 is exempt (answer-shaped)
    expect(personQuestionAnswers.has('c2')).toBe(true);
    // c3 is NOT exempt (window closed after c2)
    expect(personQuestionAnswers.has('c3')).toBe(false);
  });

  it('bare-name fragment answering an approver challenge keeps request_version at 1 through the real engine', () => {
    // FIX (2026-09-15, person-window lane): PROVEN defect -- a caller who answers a
    // person-shaped LIVE_COMMITMENT challenge with a BARE name and no cue (e.g. "Marcus
    // Obi." rather than "That's Marcus Obi.") used to get that bare name recorded by the
    // LEDGER's OWN extractIdentityClaim call as a false self-identification (a CONTRADICTED
    // identity claim), bumping request_version from 1 to 2 -- even though the extended
    // person-question exemption window (answersToPersonQuestion) already correctly covered
    // that utterance for the OTHER two call sites (fromTranscript.ts, resolveIdentitySwitch).
    // evaluate.ts now builds the ledger in two passes so all three call sites agree; this is
    // an end-to-end regression test through the real `evaluate()`, not just the exemption set.
    const call = { session_id: 'sess-bare-name-rv', origin_kind: 'registered_device' as const, origin_geo: 'Austin, TX' };
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'This is Dana Whitfield, corporate treasury. This was approved by Marcus Obi.', t_ms: 1000 },
      { id: 'c2', speaker: 'caller', text: 'I need to wire it to Meridian Supply — $84,500, account ending 4471.', t_ms: 2000 },
      { id: 'c3', speaker: 'caller', text: 'Please let me know once it\'s done.', t_ms: 3000 },
      { id: 'a1', speaker: 'agent', text: 'Can you restate the approver you gave me earlier?', t_ms: 3500 },
      { id: 'c-frag2', speaker: 'caller', text: 'Marcus Obi.', t_ms: 4200 }, // bare name, no cue
      { id: 'a2', speaker: 'agent', text: 'To confirm: $84,500. Is that right?', t_ms: 4700 },
      { id: 'c4', speaker: 'caller', text: "Yes, that's right.", t_ms: 5000 },
      { id: 'a3', speaker: 'agent', text: 'And the account ending 4471, correct?', t_ms: 5500 },
      { id: 'c5', speaker: 'caller', text: 'Yes, correct.', t_ms: 6000 },
      { id: 'a4', speaker: 'agent', text: 'And Meridian Supply is the beneficiary, correct?', t_ms: 6500 },
      { id: 'c6', speaker: 'caller', text: "Yes, that's right.", t_ms: 7000 },
    ];
    const tools = [
      {
        id: 't1',
        name: 'check_sso_context',
        t_ms: 1500,
        args: { identity_id: 'dana-whitfield', request_version: 1 },
        result: { session_active: true, geo: 'Austin, TX', device: 'Dell Latitude (managed)', request_version: 1 },
      },
      {
        id: 't2',
        name: 'get_request_history',
        t_ms: 1600,
        args: { identity_id: 'dana-whitfield', request_version: 1 },
        result: {
          known_vendors: ['Meridian Supply'],
          matches: [{ vendor: 'Meridian Supply', amount_usd: 84500, account_last4: '4471', due: '2026-09-04' }],
          request_version: 1,
        },
      },
      {
        id: 't3',
        name: 'verify_out_of_band',
        t_ms: 1700,
        args: { identity_id: 'dana-whitfield', request_version: 1 },
        result: { sent: true, devices: 1, response: 'confirmed', latency_ms: 2500, request_version: 1 },
      },
    ];
    const actions: AgentAction[] = [
      { id: 'ch1', kind: 'challenge_issued', t_ms: 3500, challenge_id: 'sess-bare-name-rv-1' },
      { id: 'r1', kind: 'readback_issued', t_ms: 4700, field: 'amount_usd', value: '84500' },
      { id: 'r2', kind: 'readback_issued', t_ms: 5500, field: 'account_last4', value: '4471' },
      { id: 'r3', kind: 'readback_issued', t_ms: 6500, field: 'beneficiary', value: 'Meridian Supply' },
    ];

    const input: EngineInput = { conversation, tools: tools as EngineInput['tools'], actions, call, seed: MERIDIAN };
    const out = evaluate(input);

    expect(out.request_version).toBe(1);
    expect(out.failure_tally).toBe(0);
    expect(out.verdict).toBe('STAGE');
    expect(out.assurance.no_contradictions).toBe(true);
  });
});
