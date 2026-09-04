// Exercises the reactive caller's rule engine (scripted `respond.rules` + the generic
// `truth`-driven fallback) with plain strings -- no network, no server, no CallClient. This
// is the fix for the failure recorded in scripts/rehearse/reports/
// 2026-09-03T23-04-42-scenario-a-dana-legitimate.md: a scripted caller confirmed a planted
// trap value instead of correcting it.
import { describe, expect, it } from 'vitest';
import { matchRespondRules, genericTruthReply, extractAmountsFromText, resolveTurnText } from '../truthEngine.js';
import type { ScenarioTruth, ScenarioTurn } from '../types.js';

describe('matchRespondRules', () => {
  it('returns the first matching rule\'s "say" (case-insensitive substring)', () => {
    const rules = [
      { if_agent_says_any: ['Northgate'], say: "No, that's wrong, it's Meridian Supply." },
      { if_agent_says_any: ['identity id'], say: "I don't have an identity id." },
    ];
    expect(matchRespondRules(rules, 'You are requesting a wire to Northgate Partners.')).toBe("No, that's wrong, it's Meridian Supply.");
    expect(matchRespondRules(rules, 'Please state your IDENTITY ID.')).toBe("I don't have an identity id.");
  });

  it('returns null when nothing matches, or there is no agent line yet', () => {
    const rules = [{ if_agent_says_any: ['Northgate'], say: 'x' }];
    expect(matchRespondRules(rules, 'Everything checks out.')).toBeNull();
    expect(matchRespondRules(rules, null)).toBeNull();
  });
});

const DANA_TRUTH: ScenarioTruth = {
  identity: 'Dana Whitfield',
  beneficiary: 'Meridian Supply',
  amount_usd: 84500,
  account_last4: '4471',
  counsel: null,
  escrow_institution: null,
  approver: null,
  deadline: null,
};

describe('genericTruthReply -- the actual bug this task fixes', () => {
  it('CORRECTS a planted trap value instead of confirming it (the real failed-run scenario)', () => {
    const reply = genericTruthReply(
      'You are requesting to wire eighty four thousand five hundred dollars to Northgate Partners, account ending four four seven one.',
      DANA_TRUTH,
    );
    expect(reply).toBe("No, that's wrong, it's Meridian Supply.");
  });

  it('CONFIRMS a true readback', () => {
    const reply = genericTruthReply('To confirm: $84,500 to Meridian Supply, account ending 4471. Is that right?', DANA_TRUTH);
    expect(reply).toBe("Yes, that's right.");
  });

  it('corrects a wrong spoken-word amount', () => {
    const reply = genericTruthReply('Confirming eighty four thousand six hundred dollars to Meridian Supply.', DANA_TRUTH);
    expect(reply).toBe('No, that\'s wrong, it\'s $84,500.');
  });

  it('confirms a true spoken-word amount', () => {
    const reply = genericTruthReply('Confirming eighty four thousand five hundred dollars to Meridian Supply.', DANA_TRUTH);
    expect(reply).toBe("Yes, that's right.");
  });

  it('corrects a wrong account number spoken as digit words', () => {
    const reply = genericTruthReply('And the account ending four four seven two, is that correct?', DANA_TRUTH);
    expect(reply).toBe("No, that's wrong, it's account ending 4471.");
  });

  it('declines an unanswerable id/code ask and repeats the caller\'s name', () => {
    const reply = genericTruthReply('Please state your identity id.', DANA_TRUTH);
    expect(reply).toBe("I don't have that. This is Dana Whitfield.");
  });

  it('declines an "authorization code" ask too (PROVEN gap from the second real run, scripts/rehearse/reports/2026-09-03T23-32-42-scenario-a-dana-legitimate.md)', () => {
    const reply = genericTruthReply('Please state the authorization code for this transaction.', DANA_TRUTH);
    expect(reply).toBe("I don't have that. This is Dana Whitfield.");
  });

  it('answers a known-fact knowledge question from truth', () => {
    const truth: ScenarioTruth = { ...DANA_TRUTH, counsel: 'Calder & Finch' };
    const reply = genericTruthReply('Who is our counsel of record on this deal?', truth);
    expect(reply).toBe("It's Calder & Finch.");
  });

  it('declines an unknown-fact knowledge question and repeats the name', () => {
    const reply = genericTruthReply('Which institution holds the escrow?', DANA_TRUTH);
    expect(reply).toBe("I don't have that. This is Dana Whitfield.");
  });

  it('restates a true value on an open "restate" ask with no value quoted', () => {
    const reply = genericTruthReply('Please restate the amount you gave earlier.', DANA_TRUTH);
    expect(reply).toBe('It\'s $84500.');
  });

  it('never corrects or confirms a field the caller does not track (truth value null)', () => {
    // Miller-shaped: everything but identity is null, so a quoted decoy for a field he
    // doesn't track should fall through to null (the turn's own text/else_say takes over).
    const millerTruth: ScenarioTruth = { identity: 'Robert Miller' };
    expect(genericTruthReply('Confirming Whitmore and Bass as counsel.', millerTruth)).toBeNull();
  });

  it('returns null when nothing recognizable is in the text', () => {
    expect(genericTruthReply('One moment please.', DANA_TRUTH)).toBeNull();
  });
});

describe('extractAmountsFromText', () => {
  it('parses a numeral amount with a dollar sign', () => {
    expect(extractAmountsFromText('$84,500 to the vendor')).toContain(84500);
  });

  it('parses a numeral amount followed by "dollars"', () => {
    expect(extractAmountsFromText('84,500 dollars total')).toContain(84500);
  });

  it('parses a fully spelled-out whole number amount', () => {
    expect(extractAmountsFromText('eighty four thousand five hundred dollars')).toContain(84500);
  });

  it('parses a "point" decimal million amount, both directions of the contradiction', () => {
    expect(extractAmountsFromText('one point eight million dollars')).toContain(1_800_000);
    expect(extractAmountsFromText('two point one million')).toContain(2_100_000);
  });

  it('does not treat an unrelated digit run as a dollar amount', () => {
    expect(extractAmountsFromText('account ending four four seven one')).toEqual([]);
  });
});

describe('resolveTurnText', () => {
  const truth = DANA_TRUTH;

  it('a turn with no respond block always speaks its fixed text', () => {
    const turn: ScenarioTurn = { id: 'c1', text: 'This is Dana Whitfield.' };
    expect(resolveTurnText(turn, truth, 'anything the agent said').source).toBe('fixed');
    expect(resolveTurnText(turn, truth, 'anything the agent said').text).toBe('This is Dana Whitfield.');
  });

  it('an explicit rule wins over the generic engine', () => {
    const turn: ScenarioTurn = {
      id: 'c2',
      text: 'Yes, that\'s right.',
      respond: { rules: [{ if_agent_says_any: ['Northgate'], say: 'Custom rule wins.' }] },
    };
    const resolved = resolveTurnText(turn, truth, 'wire to Northgate Partners');
    expect(resolved).toEqual({ text: 'Custom rule wins.', source: 'rule' });
  });

  it('falls through rule -> else_say when no rule matches', () => {
    const turn: ScenarioTurn = {
      id: 'c2',
      text: 'fallback text',
      respond: { rules: [{ if_agent_says_any: ['Northgate'], say: 'x' }], else_say: 'else say line' },
    };
    const resolved = resolveTurnText(turn, truth, 'nothing relevant here');
    expect(resolved).toEqual({ text: 'else say line', source: 'else_say' });
  });

  it('falls through to the generic engine when no rule matches and no else_say is given', () => {
    const turn: ScenarioTurn = { id: 'c2', text: 'fallback text', respond: { rules: [] } };
    const resolved = resolveTurnText(turn, truth, 'Confirming Meridian Supply, is that right?');
    expect(resolved).toEqual({ text: "Yes, that's right.", source: 'generic' });
  });

  it('falls all the way back to fixed text when nothing else produces a line', () => {
    const turn: ScenarioTurn = { id: 'c2', text: 'fallback text', respond: { rules: [] } };
    const resolved = resolveTurnText(turn, truth, 'One moment please.');
    expect(resolved).toEqual({ text: 'fallback text', source: 'fallback' });
  });

  it('falls back to fixed text when there is no agent line yet and no truth block', () => {
    const turn: ScenarioTurn = { id: 'c1', text: 'fallback text', respond: { rules: [] } };
    expect(resolveTurnText(turn, undefined, null)).toEqual({ text: 'fallback text', source: 'fallback' });
  });
});
