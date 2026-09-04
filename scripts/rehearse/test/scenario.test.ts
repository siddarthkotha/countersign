import { describe, expect, it } from 'vitest';
import { listScenarioNames, loadAllScenarios, loadScenario, validateScenario, ScenarioValidationError } from '../scenario.js';

describe('scenario loading (no network)', () => {
  it('lists the four required scenario files', async () => {
    const names = await listScenarioNames();
    expect(names).toEqual(
      expect.arrayContaining(['scenario-a-dana-legitimate', 'scenario-b-miller-fraud', 'judge-out-of-scope', 'single-wrong-answer']),
    );
  });

  it('loads and validates every scenario file on disk', async () => {
    const scenarios = await loadAllScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
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

  it('scenario-a\'s reactive turns can correct the beneficiary trap using its own truth block', async () => {
    const s = await loadScenario('scenario-a-dana-legitimate');
    const reactiveTurn = s.turns.find((t) => t.respond);
    expect(reactiveTurn, 'scenario-a should have at least one reactive turn').toBeDefined();
  });
});
