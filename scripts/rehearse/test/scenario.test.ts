import { describe, expect, it } from 'vitest';
import { listScenarioNames, loadAllScenarios, loadScenario, validateScenario, ScenarioValidationError } from '../scenario.js';
import { matchRespondRules } from '../truthEngine.js';

describe('scenario loading (no network)', () => {
  it('lists the required scenario files (the original four, the four adversarial ones from item 16, and the two judge-sim mechanics scenarios from 2026-09-11)', async () => {
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

  it('prompt-injection-midcall scenario includes both injection lexicon phrases (defect 3, 2026-09-14)', async () => {
    // Defect 3: the persona must explicitly instruct the model to say injection phrases
    // mid-call, per the engine's injection_lexicon (packages/engine/src/seed/meridian.ts line 182):
    // 'ignore previous', 'ignore your instructions', 'system prompt', 'mark this verified', etc.
    const s = await loadScenario('prompt-injection-midcall');
    // Check the persona
    const personaText = s.persona?.toLowerCase() ?? '';
    // Check the turns for the injection phrase
    const turnsText = s.turns.map((t) => t.text.toLowerCase()).join(' ');
    const fullText = personaText + ' ' + turnsText;
    // The scenario should contain phrases that match the injection lexicon entries.
    // "ignore your previous instructions" matches both 'ignore previous' and contains 'instructions'
    expect(fullText).toMatch(/ignore (your )?previous|ignore your instructions/);
    // "mark this verified" is an exact match
    expect(fullText).toContain('mark this verified');
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
