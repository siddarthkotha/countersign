import { describe, it, expect } from 'vitest';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { CorpusFile, EngineInput } from '@countersign/engine';
import { deriveScreenState } from '../src/screen/state.js';
import scenarioBJson from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };
import scenarioAJson from '../../engine/corpus/scenario-a-dana-legitimate.json' with { type: 'json' };
import judgeOutOfScopeJson from '../../engine/corpus/judge-out-of-scope-no-request.json' with { type: 'json' };
import singleWrongAnswerEscalatesJson from '../../engine/corpus/single-wrong-answer-escalates.json' with { type: 'json' };

// `with { type: 'json' }` gives each import site its own structurally-inferred (and
// therefore mutually "unrelated" per TS) literal type; casting once through the engine's
// own CorpusFile contract is what makes the two importing test files agree.
const scenarioB = scenarioBJson as unknown as CorpusFile;
const scenarioA = scenarioAJson as unknown as CorpusFile;
const judgeOutOfScope = judgeOutOfScopeJson as unknown as CorpusFile;
const singleWrongAnswerEscalates = singleWrongAnswerEscalatesJson as unknown as CorpusFile;

function inputFor(corpus: CorpusFile): EngineInput {
  return {
    conversation: corpus.conversation,
    tools: corpus.tools,
    actions: corpus.actions,
    call: corpus.call,
    seed: MERIDIAN,
  };
}

describe('deriveScreenState — Scenario B end state (FREEZE)', () => {
  const engineInput = inputFor(scenarioB);
  const output = evaluate(engineInput);

  it('maps gates from ev-context/ev-oob/ev-consistency-*', () => {
    const state = deriveScreenState({
      session_id: 'sess-b',
      t_ms: 52000,
      engineInput,
      output,
      speaking: false,
      export_hash: null,
      recomputed: false,
      link: 'live',
    });

    expect(state.gates.context).toBe('FAIL'); // no scheduled payment matches
    expect(state.gates.device).toBe('FAIL'); // out-of-band: no_response
    expect(state.gates.consistency).toBe('FAIL'); // the $1.8M -> $2.1M contradiction
  });

  it('sets agent_status to VERDICT once the verdict is terminal', () => {
    const state = deriveScreenState({
      session_id: 'sess-b',
      t_ms: 52000,
      engineInput,
      output,
      speaking: true, // even mid-reply, a terminal verdict wins
      export_hash: null,
      recomputed: false,
      link: 'live',
    });
    expect(state.agent_status).toBe('VERDICT');
  });

  it('produces a FREEZE banner with plain-words reasons and highlights the contradicted utterances', () => {
    const state = deriveScreenState({
      session_id: 'sess-b',
      t_ms: 52000,
      engineInput,
      output,
      speaking: false,
      export_hash: 'abc123def456',
      recomputed: true,
      link: 'live',
    });

    expect(state.banner).not.toBeNull();
    expect(state.banner?.headline).toBe('WIRE FROZEN');
    expect(state.banner?.reasons).toContain('identity unverified');
    expect(state.banner?.reasons).toContain('story inconsistency');
    expect(state.banner?.reasons.every((r) => r === r.toLowerCase())).toBe(true);
    expect(state.banner?.subline).toContain('export abc123def4');

    const c3 = state.transcript.find((u) => u.id === 'c3');
    const c2 = state.transcript.find((u) => u.id === 'c2'); // "Whitmore & Bass" -- the wrong counsel
    expect(c3?.highlighted).toBe(true);
    expect(c2?.highlighted).toBe(true);

    expect(state.forensic.countersign).toEqual({ server_verdict: 'FREEZE', recomputed: true });
    expect(state.forensic.export_hash).toBe('abc123def456');
    expect(state.simulated).toBe(true);
    expect(state.link).toBe('live');
    expect(state.request.claimed_identity).toBe('Robert Miller');
    expect(state.request.amount_usd).toBe(2_100_000);
  });
});

describe('deriveScreenState — Scenario A end state (STAGE)', () => {
  const engineInput = inputFor(scenarioA);
  const output = evaluate(engineInput);

  it('all gates PASS, banner names the second approver, agent_status is VERDICT', () => {
    const state = deriveScreenState({
      session_id: 'sess-a',
      t_ms: 4500,
      engineInput,
      output,
      speaking: false,
      export_hash: null,
      recomputed: true,
      link: 'live',
    });

    expect(state.gates).toEqual({ context: 'PASS', device: 'PASS', consistency: 'PASS' });
    expect(state.agent_status).toBe('VERDICT');
    expect(state.banner?.headline).toBe('STAGED FOR SECOND APPROVAL');
    expect(state.banner?.subline).toContain('second approval: Marcus Obi');
    expect(state.request.claimed_identity).toBe('Dana Whitfield');
    // Claim.value is normalized/lower-cased by the ledger (types.ts: "names lower-cased,
    // trimmed") -- ScreenState surfaces the raw claim value, not a display-cased copy.
    expect(state.request.beneficiary).toBe('meridian supply');
    expect(state.transcript.some((u) => u.highlighted)).toBe(false); // nothing failed or flagged
  });
});

describe('deriveScreenState — judge out-of-scope end state (NO_ACTION)', () => {
  // Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md, fix 1): a judge who opens
  // with "I'm not the CEO, I'm testing this" ends the call on NO_ACTION -- before this fix,
  // that verdict had no banner at all (STAGE/FREEZE had one, NO_ACTION did not).
  const engineInput = inputFor(judgeOutOfScope);
  const output = evaluate(engineInput);

  it('produces a NO_ACTION banner with a neutral glyph and a plain-English description', () => {
    const state = deriveScreenState({
      session_id: 'sess-judge-1',
      t_ms: 1000,
      engineInput,
      output,
      speaking: false,
      export_hash: null,
      recomputed: false,
      link: 'live',
    });

    expect(output.verdict).toBe('NO_ACTION');
    expect(state.banner).not.toBeNull();
    expect(state.banner?.headline).toBe('NO ACTION TAKEN');
    expect(state.banner?.glyph).toBe('○');
    expect(state.banner?.description).toBe(
      'Nothing was at stake on this call. No request was staged, nothing was frozen, and the evidence record is complete.',
    );
    expect(state.banner?.reasons).toContain('out of scope');
  });
});

describe('deriveScreenState — single wrong answer end state (ESCALATE)', () => {
  const engineInput = inputFor(singleWrongAnswerEscalates);
  const output = evaluate(engineInput);

  it('already had a banner before this fix -- headline present, no NO_ACTION-only fields', () => {
    const state = deriveScreenState({
      session_id: 'sess-5',
      t_ms: 15000,
      engineInput,
      output,
      speaking: false,
      export_hash: 'deadbeef00',
      recomputed: true,
      link: 'live',
    });

    expect(output.verdict).toBe('ESCALATE');
    expect(state.banner).not.toBeNull();
    expect(state.banner?.headline).toBe('ESCALATED TO A HUMAN');
    // ESCALATE already carries plenty in its subline (incident id, export hash) -- it does
    // not get the NO_ACTION-only description/glyph fields.
    expect(state.banner?.description).toBeUndefined();
    expect(state.banner?.glyph).toBeUndefined();
  });
});

describe('deriveScreenState — replay-path parity', () => {
  it('produces an identical ScreenState (besides link) whether called for a live or a replay session_id/t_ms', () => {
    const engineInput = inputFor(scenarioA);
    const output = evaluate(engineInput);
    const base = { engineInput, output, speaking: false, export_hash: null, recomputed: false };

    const live = deriveScreenState({ ...base, session_id: 'sess-a', t_ms: 4500, link: 'live' });
    const replay = deriveScreenState({ ...base, session_id: 'sess-a', t_ms: 4500, link: 'replay' });

    expect({ ...live, link: undefined }).toEqual({ ...replay, link: undefined });
    expect(replay.link).toBe('replay');
  });
});
