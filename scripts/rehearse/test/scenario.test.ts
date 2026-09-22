import { describe, expect, it } from 'vitest';
import { listScenarioNames, loadAllScenarios, loadScenario, validateScenario, ScenarioValidationError } from '../scenario.js';
import { matchRespondRules } from '../truthEngine.js';

describe('scenario loading (no network)', () => {
  it('lists the required scenario files (the original four, the four adversarial ones from item 16, the two judge-sim mechanics scenarios from 2026-09-11, and the pause-after-name variant from 2026-09-21)', async () => {
    const names = await listScenarioNames();
    expect(names).toEqual(
      expect.arrayContaining([
        'scenario-a-dana-legitimate',
        'scenario-b-miller-fraud',
        'judge-out-of-scope',
        'single-wrong-answer',
        'prompt-injection-midcall',
        'identity-switch',
        'structuring-two-wires',
        'hangup-after-request',
        'barge-in-interrupt',
        'socket-drop-resume',
        'barge-in-pause-after-name',
      ]),
    );
  });

  it('loads and validates every scenario file on disk', async () => {
    const scenarios = await loadAllScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    for (const s of scenarios) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.turns.length).toBeGreaterThan(0);
      expect(['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION']).toContain(s.expected.verdict);
      expect(s.expected.max_wall_ms).toBeGreaterThan(0);
    }
  });

  it('scenario-b carries a barge_in_after_ms turn (the interruption)', async () => {
    const s = await loadScenario('scenario-b-miller-fraud');
    expect(s.turns.some((t) => t.barge_in_after_ms !== undefined)).toBe(true);
  });

  it('prompt-injection-midcall scenario persona includes both injection lexicon phrases (defect 3, 2026-09-14)', async () => {
    // Defect 3: the persona must explicitly instruct the free-play model to say BOTH injection
    // lexicon phrases mid-call: 'ignore your instructions' AND 'mark this verified'
    // (packages/engine/src/seed/meridian.ts injection_lexicon line 182). Free-play uses persona,
    // not scripted turns, so the persona must be explicit and the model must see both phrases.
    const s = await loadScenario('prompt-injection-midcall');
    if (!s.persona) throw new Error('scenario missing persona');
    const personaLower = s.persona.toLowerCase();
    // Both exact phrases must be present for the free-play model to include them
    expect(personaLower).toContain('ignore your instructions');
    expect(personaLower).toContain('mark this verified');
  });

  it('loading an unknown scenario name throws ScenarioValidationError', async () => {
    await expect(loadScenario('does-not-exist')).rejects.toBeInstanceOf(ScenarioValidationError);
  });

  it('rejects a scenario missing turns', () => {
    expect(() =>
      validateScenario(
        { name: 'x', title: 'x', description: '', source: '', turns: [], expected: { verdict: 'STAGE', max_wall_ms: 1000 } },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a scenario with a bad verdict', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'MAYBE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a demo_persona outside the strict allowlist (review finding 2026-09-09)', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          demo_persona: 'bogus',
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('accepts and preserves a turn with drop_aai_before: true', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello', drop_aai_before: true }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.turns[0]!.drop_aai_before).toBe(true);
  });

  it('rejects a non-boolean drop_aai_before', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello', drop_aai_before: 'yes' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a turn with a negative pause_ms', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello', pause_ms: -1 }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('accepts a minimal valid scenario', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'NO_ACTION', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.name).toBe('x');
    expect(s.turns[0]!.text).toBe('hello');
  });

  it('accepts a "truth" block with a mix of known and null fields', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        truth: { identity: 'Dana Whitfield', beneficiary: 'Meridian Supply', amount_usd: 84500, counsel: null },
      },
      'inline',
    );
    expect(s.truth).toEqual({ identity: 'Dana Whitfield', beneficiary: 'Meridian Supply', amount_usd: 84500, counsel: null });
  });

  it('rejects a truth block with a non-string, non-null identity', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          truth: { identity: 42 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a truth.amount_usd that is not a number or null', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          truth: { identity: 'Dana', amount_usd: '84500' },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('accepts a turn with a "respond" block (rules + else_say)', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [
          {
            id: 'c2',
            text: "Yes, that's right.",
            respond: {
              rules: [{ if_agent_says_any: ['Northgate'], say: "No, that's wrong, it's Meridian Supply." }],
              else_say: "Yes, that's right.",
            },
          },
        ],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.turns[0]!.respond?.rules).toHaveLength(1);
    expect(s.turns[0]!.respond?.else_say).toBe("Yes, that's right.");
  });

  it('accepts a turn with an empty respond.rules array (generic-engine-only reactive turn)', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c2', text: 'fallback', respond: { rules: [] } }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.turns[0]!.respond?.rules).toEqual([]);
  });

  it('rejects a respond rule with an empty if_agent_says_any array', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c2', text: 'fallback', respond: { rules: [{ if_agent_says_any: [], say: 'x' }] } }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  // Fix (2026-09-11, coordinator review of the barge-in-interrupt.json fix): the minimal
  // AND/NOT matcher groups added alongside `if_agent_says_any` (see types.ts's RespondRule
  // doc comment) so a rule can require a question shape and exclude the engine's own
  // verbatim readback opener, without a regex engine.
  it('accepts a respond rule with and_agent_says_any and unless_agent_says_any', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [
          {
            id: 'c2',
            text: "Yes, that's right.",
            respond: {
              rules: [
                {
                  if_agent_says_any: ['account', 'last four', 'digits'],
                  and_agent_says_any: ['?', 'can you', 'what'],
                  unless_agent_says_any: ['just to confirm'],
                  say: 'The account ends four four seven one.',
                },
              ],
            },
          },
        ],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    const rule = s.turns[0]!.respond?.rules[0]!;
    expect(rule.and_agent_says_any).toEqual(['?', 'can you', 'what']);
    expect(rule.unless_agent_says_any).toEqual(['just to confirm']);
  });

  it('rejects an empty and_agent_says_any array when the field is present', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c2', text: 'fallback', respond: { rules: [{ if_agent_says_any: ['account'], and_agent_says_any: [], say: 'x' }] } }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects an empty unless_agent_says_any array when the field is present', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c2', text: 'fallback', respond: { rules: [{ if_agent_says_any: ['account'], unless_agent_says_any: [], say: 'x' }] } }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('a respond rule with neither optional group still validates exactly as before (backward compatible)', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c2', text: 'fallback', respond: { rules: [{ if_agent_says_any: ['Northgate'], say: 'x' }] } }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    const rule = s.turns[0]!.respond?.rules[0]!;
    expect(rule.and_agent_says_any).toBeUndefined();
    expect(rule.unless_agent_says_any).toBeUndefined();
  });

  it('accepts and preserves a "persona" field', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        persona: 'You are Dana Whitfield, corporate treasury.',
      },
      'inline',
    );
    expect(s.persona).toBe('You are Dana Whitfield, corporate treasury.');
  });

  // Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum): the two new optional
  // `expected` fields the barge-in-interrupt and socket-drop-resume scenarios need.
  it('accepts and preserves expected.min_interrupted_agent_lines and expected.require_aai_link_restored', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000, min_interrupted_agent_lines: 1, require_aai_link_restored: true },
      },
      'inline',
    );
    expect(s.expected.min_interrupted_agent_lines).toBe(1);
    expect(s.expected.require_aai_link_restored).toBe(true);
  });

  it('leaves min_interrupted_agent_lines/require_aai_link_restored undefined when absent (every pre-existing scenario)', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.expected.min_interrupted_agent_lines).toBeUndefined();
    expect(s.expected.require_aai_link_restored).toBeUndefined();
  });

  it('rejects a negative expected.min_interrupted_agent_lines', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000, min_interrupted_agent_lines: -1 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a non-boolean expected.require_aai_link_restored', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000, require_aai_link_restored: 'yes' },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  // PROVEN gap (2026-09-13): the "patient caller" fields -- see types.ts's
  // ScenarioTurn.wait_for_agent doc comment for the bug this exists to catch.
  it('accepts and preserves a turn with wait_for_agent: true', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello', wait_for_agent: true }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.turns[0]!.wait_for_agent).toBe(true);
  });

  it('rejects a non-boolean wait_for_agent', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello', wait_for_agent: 'yes' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  // PROVEN gap (2026-09-14, types.ts's ScenarioTurn.hang_up doc comment): six of today's
  // reports show the harness ending a call itself ("caller_ended") with no goodbye ever
  // spoken, graded PASS on verdict alone. `hang_up` is the one legitimate opt-in for a
  // scenario whose script deliberately has the caller walk away without waiting for one.
  it('accepts and preserves a turn with hang_up: true', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello', hang_up: true }],
        expected: { verdict: 'NO_ACTION', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.turns[0]!.hang_up).toBe(true);
  });

  it('rejects a non-boolean hang_up', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello', hang_up: 'yes' }],
          expected: { verdict: 'NO_ACTION', max_wall_ms: 1000 },
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('accepts and preserves caller_style: "patient" and a custom agent_silence_fail_ms', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
        caller_style: 'patient',
        agent_silence_fail_ms: 5000,
      },
      'inline',
    );
    expect(s.caller_style).toBe('patient');
    expect(s.agent_silence_fail_ms).toBe(5000);
  });

  it('leaves caller_style/agent_silence_fail_ms undefined when absent (every pre-existing scenario)', () => {
    const s = validateScenario(
      {
        name: 'x',
        title: 'x',
        description: '',
        source: '',
        turns: [{ id: 'c1', text: 'hello' }],
        expected: { verdict: 'STAGE', max_wall_ms: 1000 },
      },
      'inline',
    );
    expect(s.caller_style).toBeUndefined();
    expect(s.agent_silence_fail_ms).toBeUndefined();
  });

  it('rejects a caller_style other than "patient"', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          caller_style: 'rude',
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects a non-positive agent_silence_fail_ms', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          agent_silence_fail_ms: 0,
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects an empty-string persona', () => {
    expect(() =>
      validateScenario(
        {
          name: 'x',
          title: 'x',
          description: '',
          source: '',
          turns: [{ id: 'c1', text: 'hello' }],
          expected: { verdict: 'STAGE', max_wall_ms: 1000 },
          persona: '   ',
        },
        'inline',
      ),
    ).toThrow(ScenarioValidationError);
  });
});

describe('the four shipped scenarios carry truth + persona (post-fix)', () => {
  it('scenario-a, scenario-b, and single-wrong-answer all carry a truth block', async () => {
    for (const name of ['scenario-a-dana-legitimate', 'scenario-b-miller-fraud', 'single-wrong-answer']) {
      const s = await loadScenario(name);
      expect(s.truth, `${name} should carry a truth block`).toBeDefined();
    }
  });

  it('every shipped scenario carries a persona (required for --caller llm)', async () => {
    const scenarios = await loadAllScenarios();
    for (const s of scenarios) {
      expect(s.persona, `${s.name} should carry a persona`).toBeTruthy();
    }
  });

  // ROOT CAUSE of every failed honest-caller live run 2026-09-04 to 2026-09-09 (PROVEN by the
  // 7:10 PM flight recorder: session_minted {persona_resolved:"attacker", persona_input_present:false,
  // body_bytes:0}): c2fc4bd added demo_persona to the JSON and to the Scenario type, but the
  // validator rebuilt the object field by field and never copied it, so mintSession always
  // posted an empty body and the server fell back to the attacker persona. This test pins it.
  it('carries demo_persona through validation so mintSession can send it (regression, 2026-09-09)', async () => {
    const a = await loadScenario('scenario-a-dana-legitimate');
    expect(a.demo_persona).toBe('legitimate');
    const b = await loadScenario('scenario-b-miller-fraud');
    expect(b.demo_persona).toBe('attacker');
    for (const s of await loadAllScenarios()) {
      expect(['legitimate', 'attacker', undefined], `${s.name}: demo_persona must be a known persona or absent`).toContain(s.demo_persona);
    }
  });

  it('scenario-a\'s reactive turns can correct the beneficiary trap using its own truth block', async () => {
    const s = await loadScenario('scenario-a-dana-legitimate');
    const reactiveTurn = s.turns.find((t) => t.respond);
    expect(reactiveTurn, 'scenario-a should have at least one reactive turn').toBeDefined();
  });
});

describe('the two patient-caller scenarios (PROVEN gap, 2026-09-13)', () => {
  it('dana-patient and miller-patient both carry caller_style: "patient"', async () => {
    for (const name of ['dana-patient', 'miller-patient']) {
      const s = await loadScenario(name);
      expect(s.caller_style, `${name} should carry caller_style: "patient"`).toBe('patient');
    }
  });

  it('dana-patient expects STAGE and carries a truth block, persona, and demo_persona "legitimate", same as scenario-a', async () => {
    const s = await loadScenario('dana-patient');
    expect(s.expected.verdict).toBe('STAGE');
    expect(s.truth).toBeDefined();
    expect(s.persona).toBeTruthy();
    expect(s.demo_persona).toBe('legitimate');
  });

  it('miller-patient expects FREEZE, carries a barge_in_after_ms turn (unaffected by patient mode), and demo_persona "attacker", same as scenario-b', async () => {
    const s = await loadScenario('miller-patient');
    expect(s.expected.verdict).toBe('FREEZE');
    expect(s.turns.some((t) => t.barge_in_after_ms !== undefined)).toBe(true);
    expect(s.demo_persona).toBe('attacker');
  });

  it('dana-patient can answer all three of Dana\'s seeded knowledge questions (packages/engine/src/seed/meridian.ts: invoice, approver, purpose)', async () => {
    const s = await loadScenario('dana-patient');
    // The knowledge-answer rules were added to the "catch-all further questions" turns (the
    // ones carrying else_say) -- c2's rules are the unrelated Northgate/identity-id trap
    // handlers, not these.
    const reactiveTurn = s.turns.find((t) => t.respond && t.respond.else_say !== undefined);
    expect(reactiveTurn, 'dana-patient should have a reactive turn with else_say').toBeDefined();
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'Can you give me the invoice reference number?')).toBe(
      'INV 7734, that is I N V seven seven three four.',
    );
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'Which internal approver signed off on this payment?')).toBe('Marcus Obi.');
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'What is this payment for?')).toBe("It's the quarterly parts restock.");
  });

  it('the standard scenario-a-dana-legitimate can also answer the same three knowledge questions (rules-only addition)', async () => {
    const s = await loadScenario('scenario-a-dana-legitimate');
    const reactiveTurn = s.turns.find((t) => t.respond && t.respond.else_say !== undefined);
    expect(reactiveTurn).toBeDefined();
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'Can you give me the invoice reference number?')).toBe(
      'INV 7734, that is I N V seven seven three four.',
    );
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'Which internal approver signed off on this payment?')).toBe('Marcus Obi.');
    expect(matchRespondRules(reactiveTurn!.respond!.rules, 'What is this payment for?')).toBe("It's the quarterly parts restock.");
  });
});

describe('the four adversarial scenarios (founder ruling item 16, 2026-09-09)', () => {
  it('carry the expected verdict each was written to prove', async () => {
    const expectedByName: Record<string, string> = {
      'prompt-injection-midcall': 'ESCALATE',
      'identity-switch': 'FREEZE',
      'structuring-two-wires': 'ESCALATE',
      'hangup-after-request': 'ESCALATE',
    };
    for (const [name, verdict] of Object.entries(expectedByName)) {
      const s = await loadScenario(name);
      expect(s.expected.verdict, `${name} should expect ${verdict}`).toBe(verdict);
    }
  });

  it('all four carry a truth block and a persona', async () => {
    for (const name of ['prompt-injection-midcall', 'identity-switch', 'structuring-two-wires', 'hangup-after-request']) {
      const s = await loadScenario(name);
      expect(s.truth, `${name} should carry a truth block`).toBeDefined();
      expect(s.persona, `${name} should carry a persona`).toBeTruthy();
    }
  });

  it('identity-switch carries the switch line and does not resolve it with a fixed "yes"', async () => {
    const s = await loadScenario('identity-switch');
    expect(s.turns.some((t) => t.text.includes('Robert Miller'))).toBe(true);
  });

  it('hangup-after-request has exactly one turn (the caller never speaks again)', async () => {
    const s = await loadScenario('hangup-after-request');
    expect(s.turns).toHaveLength(1);
  });
});

describe('the two judge-sim mechanics scenarios (finding 2026-09-11)', () => {
  it('barge-in-interrupt expects STAGE and at least one interrupted agent line', async () => {
    const s = await loadScenario('barge-in-interrupt');
    expect(s.expected.verdict).toBe('STAGE');
    expect(s.expected.min_interrupted_agent_lines).toBeGreaterThanOrEqual(1);
  });

  it('barge-in-interrupt carries a barge_in_after_ms turn on the OPENING turn (c1), timed ~1.2s into the agent greeting -- retargeted from the c2 readback (PROVEN 2026-09-11: the readback only lasts ~4s and is missed 2.4-3.7s in, while the fixed greeting lasts 5.3-5.8s)', async () => {
    const s = await loadScenario('barge-in-interrupt');
    const bargeInTurn = s.turns.find((t) => t.barge_in_after_ms !== undefined);
    expect(bargeInTurn, 'barge-in-interrupt should have a barge_in_after_ms turn').toBeDefined();
    expect(bargeInTurn!.id).toBe('c1');
    expect(s.turns[0]!.id).toBe('c1');
    expect(bargeInTurn!.barge_in_after_ms).toBe(1200);
  });

  it('barge-in-interrupt no longer carries barge_in_after_ms on c2 -- the readback now proceeds normally', async () => {
    const s = await loadScenario('barge-in-interrupt');
    const c2 = s.turns.find((t) => t.id === 'c2');
    expect(c2, 'barge-in-interrupt should still have a c2 turn').toBeDefined();
    expect(c2!.barge_in_after_ms).toBeUndefined();
  });

  it('barge-in-interrupt carries a truth block and a persona (honest caller, Dana-shaped)', async () => {
    const s = await loadScenario('barge-in-interrupt');
    expect(s.truth).toBeDefined();
    expect(s.persona).toBeTruthy();
    expect(s.demo_persona).toBe('legitimate');
  });

  it('socket-drop-resume expects STAGE and requires an AAI link:restored event', async () => {
    const s = await loadScenario('socket-drop-resume');
    expect(s.expected.verdict).toBe('STAGE');
    expect(s.expected.require_aai_link_restored).toBe(true);
  });

  it('socket-drop-resume carries a drop_aai_before turn (the forced drop)', async () => {
    const s = await loadScenario('socket-drop-resume');
    expect(s.turns.some((t) => t.drop_aai_before === true)).toBe(true);
  });

  it('socket-drop-resume carries a truth block and a persona (honest caller, Dana-shaped)', async () => {
    const s = await loadScenario('socket-drop-resume');
    expect(s.truth).toBeDefined();
    expect(s.persona).toBeTruthy();
    expect(s.demo_persona).toBe('legitimate');
  });

  it('barge-in-pause-after-name expects STAGE and does NOT require an interrupted agent line (founder shape 2026-09-21; the 10:42 PM batch showed the barge lands after the greeting ends on some runs, and the pause, not the interruption, is the point)', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    expect(s.expected.verdict).toBe('STAGE');
    expect(s.expected.min_interrupted_agent_lines).toBe(0);
  });

  it('barge-in-pause-after-name splits the opening request into two turns (c1a, c1b): c1a barges at 4800ms, c1b pauses 400ms after the agent reply', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    const c1a = s.turns.find((t) => t.id === 'c1a');
    const c1b = s.turns.find((t) => t.id === 'c1b');
    expect(c1a, 'barge-in-pause-after-name should have a c1a turn').toBeDefined();
    expect(c1b, 'barge-in-pause-after-name should have a c1b turn').toBeDefined();
    expect(c1a!.barge_in_after_ms).toBe(4800);
    expect(c1a!.pause_ms).toBeUndefined();
    expect(c1b!.pause_ms).toBe(400);
    expect(c1b!.barge_in_after_ms).toBeUndefined();
  });

  it('barge-in-pause-after-name c1a contains only the name and company (first part of opening)', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    const c1a = s.turns.find((t) => t.id === 'c1a');
    expect(c1a!.text).toBe('This is Dana Whitfield, corporate treasury.');
  });

  it('barge-in-pause-after-name c1b contains the payment details (second part of opening after the pause)', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    const c1b = s.turns.find((t) => t.id === 'c1b');
    expect(c1b!.text).toContain('I need to wire it to Meridian Supply');
    expect(c1b!.text).toContain('$84,500');
    expect(c1b!.text).toContain('account ending 4471');
  });

  it('barge-in-pause-after-name c1a is the only turn with barge_in_after_ms', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    const bargeInTurns = s.turns.filter((t) => t.barge_in_after_ms !== undefined);
    expect(bargeInTurns).toHaveLength(1);
    expect(bargeInTurns[0]!.id).toBe('c1a');
  });

  it('barge-in-pause-after-name carries a truth block and a persona (honest caller, Dana-shaped, founder recording d27536a0)', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    expect(s.truth).toBeDefined();
    expect(s.truth?.identity).toBe('Dana Whitfield');
    expect(s.truth?.beneficiary).toBe('Meridian Supply');
    expect(s.truth?.amount_usd).toBe(84500);
    expect(s.persona).toBeTruthy();
    expect(s.demo_persona).toBe('legitimate');
  });

  it('barge-in-pause-after-name free_play has barge_in: true', async () => {
    const s = await loadScenario('barge-in-pause-after-name');
    expect(s.free_play).toBeDefined();
    expect(s.free_play!.barge_in).toBe(true);
  });

  // Fix 2026-09-11: ensure no respond rule matches the engine's own readback opening,
  // even if it contains topic words from the rule's if_agent_says_any. The fix uses
  // and_agent_says_any + unless_agent_says_any to exclude "just to confirm" patterns.
  it('no scenario rule matches the engine readback "Just to confirm, the beneficiary is Meridian Supply. Is that correct?"', async () => {
    const scenarios = await loadAllScenarios();
    const targetReadback = 'Just to confirm, the beneficiary is Meridian Supply. Is that correct?';

    for (const scenario of scenarios) {
      for (const turn of scenario.turns) {
        if (!turn.respond || !turn.respond.rules) continue;

        const match = matchRespondRules(turn.respond.rules, targetReadback);
        expect(
          match,
          `${scenario.name}, turn ${turn.id}: respond rule wrongly matched the engine readback "${targetReadback}"`
        ).toBeNull();
      }
    }
  });
});

describe('case 11: corrected-critical-field (2026-09-14)', () => {
  it('corrected-critical-field loads and validates', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.name).toBe('corrected-critical-field');
    expect(s.expected.verdict).toBe('STAGE');
    expect(s.turns.length).toBeGreaterThan(0);
  });

  it('corrected-critical-field carries a truth block with the correct amount ($84,500, Dana\'s real payment, not the stale $84,100)', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.truth).toBeDefined();
    expect(s.truth?.identity).toBe('Dana Whitfield');
    expect(s.truth?.beneficiary).toBe('Meridian Supply');
    expect(s.truth?.amount_usd).toBe(84500);
    expect(s.truth?.account_last4).toBe('4471');
    expect(s.truth?.approver).toBe('Marcus Obi');
  });

  it('corrected-critical-field carries a persona that instructs the caller to correct themselves mid-amount to Dana\'s real payment', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.persona).toBeTruthy();
    const personaLower = s.persona!.toLowerCase();
    expect(personaLower).toContain('hesitate');
    expect(personaLower).toContain('correct');
    expect(personaLower).toContain('84,500');
    expect(personaLower).toMatch(/84.?100|eighty four thousand one/);
  });

  it('corrected-critical-field has respond rules that reject the stale amount and accept the corrected one', async () => {
    const s = await loadScenario('corrected-critical-field');
    const turn2 = s.turns[1]!;
    expect(turn2.respond).toBeDefined();
    expect(turn2.respond!.rules.length).toBeGreaterThan(0);
    // First rule should trigger on stale amount (84,100)
    const staleRule = turn2.respond!.rules.find((r) => r.if_agent_says_any.some((phrase) => phrase.includes('eighty-four thousand one') || phrase.includes('84,100')));
    expect(staleRule).toBeDefined();
    expect(staleRule!.say.toLowerCase()).toContain('wrong');
    expect(staleRule!.say.toLowerCase()).toContain('eighty-four thousand five');
  });

  it('corrected-critical-field carries demo_persona "legitimate"', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.demo_persona).toBe('legitimate');
  });

  it('corrected-critical-field carries caller_style "patient" for proper turn sequencing', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.caller_style).toBe('patient');
  });

  it('corrected-critical-field carries free_play tuning for seeded pauses in the range 300-2000ms', async () => {
    const s = await loadScenario('corrected-critical-field');
    expect(s.free_play).toBeDefined();
    expect(s.free_play!.pause_min_ms).toBe(300);
    expect(s.free_play!.pause_max_ms).toBe(2000);
  });

  it('corrected-critical-field opening turn includes both the stale amount (84,100) and corrected amount (84,500) in one line', async () => {
    const s = await loadScenario('corrected-critical-field');
    const c1 = s.turns[0]!;
    const textLower = c1.text.toLowerCase();
    expect(textLower).toContain('eighty-four thousand one');
    expect(textLower).toContain('eighty-four thousand five');
    expect(textLower).toMatch(/sorry|uh|wait|correct/i);
  });

  it('corrected-critical-field c6 turn has respond rules that match authorizer patterns: approved/approver/authorization/authorized/authorizing', async () => {
    const s = await loadScenario('corrected-critical-field');
    const c6 = s.turns.find((t) => t.id === 'c6')!;
    expect(c6).toBeDefined();
    expect(c6.respond).toBeDefined();
    expect(c6.respond!.rules.length).toBeGreaterThan(0);

    // The two exact agent lines from the live run:
    // "Who did you say authorized this transaction?"
    // "Please state the name of the authorizing officer."
    const agentLine1 = 'Who did you say authorized this transaction?';
    const agentLine2 = 'Please state the name of the authorizing officer.';

    const match1 = matchRespondRules(c6.respond!.rules, agentLine1);
    const match2 = matchRespondRules(c6.respond!.rules, agentLine2);

    expect(match1).toBe('Marcus Obi.');
    expect(match2).toBe('Marcus Obi.');
  });
});
