// scripts/rehearse/scenario.ts
// Loads and validates a scenario JSON file under scripts/rehearse/scenarios/. Deliberately
// hand-rolled validation (no schema library) -- this is a small, fixed shape and a test
// harness, not product code (BRIEF LAW 5 scope fence).
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RespondRule, Scenario, ScenarioFreePlay, ScenarioRespond, ScenarioTruth, ScenarioTurn } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = join(HERE, 'scenarios');

const VALID_VERDICTS = new Set(['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION']);

export class ScenarioValidationError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ScenarioValidationError(msg);
}

/** Validates one optional OR-group field (`and_agent_says_any`/`unless_agent_says_any`):
 *  when present, must be a non-empty array of non-empty strings, same shape as
 *  `if_agent_says_any` -- both are optional AND-onto-groups (see types.ts's RespondRule
 *  doc comment), absent entirely on a rule that doesn't need them. */
function validateOptionalPhraseGroup(r: Record<string, unknown>, field: 'and_agent_says_any' | 'unless_agent_says_any', turnLabel: string, index: number): string[] | undefined {
  if (r[field] === undefined) return undefined;
  assert(
    Array.isArray(r[field]) && (r[field] as unknown[]).length > 0 && (r[field] as unknown[]).every((s) => typeof s === 'string' && s.length > 0),
    `${turnLabel}.respond.rules[${index}].${field} must be a non-empty array of non-empty strings when present`,
  );
  return r[field] as string[];
}

function validateRespondRule(raw: unknown, turnLabel: string, index: number): RespondRule {
  assert(raw && typeof raw === 'object', `${turnLabel}.respond.rules[${index}] must be an object`);
  const r = raw as Record<string, unknown>;
  assert(
    Array.isArray(r.if_agent_says_any) && r.if_agent_says_any.length > 0 && r.if_agent_says_any.every((s) => typeof s === 'string' && s.length > 0),
    `${turnLabel}.respond.rules[${index}].if_agent_says_any must be a non-empty array of non-empty strings`,
  );
  assert(typeof r.say === 'string' && r.say.trim().length > 0, `${turnLabel}.respond.rules[${index}].say must be a non-empty string`);
  const rule: RespondRule = { if_agent_says_any: r.if_agent_says_any as string[], say: r.say as string };
  const andGroup = validateOptionalPhraseGroup(r, 'and_agent_says_any', turnLabel, index);
  if (andGroup) rule.and_agent_says_any = andGroup;
  const unlessGroup = validateOptionalPhraseGroup(r, 'unless_agent_says_any', turnLabel, index);
  if (unlessGroup) rule.unless_agent_says_any = unlessGroup;
  return rule;
}

function validateRespond(raw: unknown, turnLabel: string): ScenarioRespond {
  assert(raw && typeof raw === 'object', `${turnLabel}.respond must be an object`);
  const r = raw as Record<string, unknown>;
  assert(Array.isArray(r.rules), `${turnLabel}.respond.rules must be an array (may be empty)`);
  const rules = (r.rules as unknown[]).map((rule, i) => validateRespondRule(rule, turnLabel, i));
  const respond: ScenarioRespond = { rules };
  if (r.else_say !== undefined) {
    assert(typeof r.else_say === 'string' && r.else_say.trim().length > 0, `${turnLabel}.respond.else_say must be a non-empty string when present`);
    respond.else_say = r.else_say as string;
  }
  return respond;
}

function validateTurn(raw: unknown, index: number): ScenarioTurn {
  assert(raw && typeof raw === 'object', `turn[${index}] must be an object`);
  const t = raw as Record<string, unknown>;
  assert(typeof t.id === 'string' && t.id.length > 0, `turn[${index}].id must be a non-empty string`);
  assert(typeof t.text === 'string' && t.text.trim().length > 0, `turn[${index}] (${String(t.id)}).text must be a non-empty string`);
  if (t.pause_ms !== undefined) {
    assert(typeof t.pause_ms === 'number' && t.pause_ms >= 0, `turn[${index}] (${String(t.id)}).pause_ms must be a non-negative number`);
  }
  if (t.barge_in_after_ms !== undefined) {
    assert(
      typeof t.barge_in_after_ms === 'number' && t.barge_in_after_ms >= 0,
      `turn[${index}] (${String(t.id)}).barge_in_after_ms must be a non-negative number`,
    );
  }
  if (t.drop_aai_before !== undefined) {
    assert(
      typeof t.drop_aai_before === 'boolean',
      `turn[${index}] (${String(t.id)}).drop_aai_before must be a boolean when present`,
    );
  }
  if (t.wait_for_agent !== undefined) {
    assert(
      typeof t.wait_for_agent === 'boolean',
      `turn[${index}] (${String(t.id)}).wait_for_agent must be a boolean when present`,
    );
  }
  if (t.hang_up !== undefined) {
    assert(
      typeof t.hang_up === 'boolean',
      `turn[${index}] (${String(t.id)}).hang_up must be a boolean when present`,
    );
  }
  const turn: ScenarioTurn = { id: t.id as string, text: t.text as string };
  if (typeof t.pause_ms === 'number') turn.pause_ms = t.pause_ms;
  if (typeof t.barge_in_after_ms === 'number') turn.barge_in_after_ms = t.barge_in_after_ms;
  if (typeof t.drop_aai_before === 'boolean') turn.drop_aai_before = t.drop_aai_before;
  if (typeof t.wait_for_agent === 'boolean') turn.wait_for_agent = t.wait_for_agent;
  if (typeof t.hang_up === 'boolean') turn.hang_up = t.hang_up;
  if (t.respond !== undefined) turn.respond = validateRespond(t.respond, `turn[${index}] (${String(t.id)})`);
  return turn;
}

const NULLABLE_STRING_TRUTH_FIELDS = ['beneficiary', 'amount_usd', 'account_last4', 'counsel', 'escrow_institution', 'approver', 'deadline'] as const;

function validateTruth(raw: unknown, sourcePath: string): ScenarioTruth {
  assert(raw && typeof raw === 'object', `${sourcePath}: "truth" must be an object`);
  const t = raw as Record<string, unknown>;
  assert(
    t.identity === null || typeof t.identity === 'string',
    `${sourcePath}: truth.identity must be a string or null`,
  );
  const truth: ScenarioTruth = { identity: (t.identity as string | null) ?? null };
  for (const field of NULLABLE_STRING_TRUTH_FIELDS) {
    if (t[field] === undefined) continue;
    const v = t[field];
    if (field === 'amount_usd') {
      assert(v === null || typeof v === 'number', `${sourcePath}: truth.amount_usd must be a number or null`);
    } else {
      assert(v === null || typeof v === 'string', `${sourcePath}: truth.${field} must be a string or null`);
    }
    (truth as unknown as Record<string, unknown>)[field] = v;
  }
  return truth;
}

export function validateScenario(raw: unknown, sourcePath: string): Scenario {
  assert(raw && typeof raw === 'object', `${sourcePath}: scenario must be a JSON object`);
  const s = raw as Record<string, unknown>;
  assert(typeof s.name === 'string' && s.name.length > 0, `${sourcePath}: "name" must be a non-empty string`);
  assert(typeof s.title === 'string' && s.title.length > 0, `${sourcePath}: "title" must be a non-empty string`);
  assert(typeof s.description === 'string', `${sourcePath}: "description" must be a string`);
  assert(typeof s.source === 'string', `${sourcePath}: "source" must be a string`);
  assert(Array.isArray(s.turns) && s.turns.length > 0, `${sourcePath}: "turns" must be a non-empty array`);
  const turns = (s.turns as unknown[]).map((t, i) => validateTurn(t, i));

  assert(s.expected && typeof s.expected === 'object', `${sourcePath}: "expected" must be an object`);
  const expected = s.expected as Record<string, unknown>;
  assert(
    typeof expected.verdict === 'string' && VALID_VERDICTS.has(expected.verdict),
    `${sourcePath}: expected.verdict must be one of ${[...VALID_VERDICTS].join(', ')}`,
  );
  assert(
    typeof expected.max_wall_ms === 'number' && expected.max_wall_ms > 0,
    `${sourcePath}: expected.max_wall_ms must be a positive number`,
  );
  if (expected.min_interrupted_agent_lines !== undefined) {
    assert(
      typeof expected.min_interrupted_agent_lines === 'number' && expected.min_interrupted_agent_lines >= 0,
      `${sourcePath}: expected.min_interrupted_agent_lines must be a non-negative number when present`,
    );
  }
  if (expected.require_aai_link_restored !== undefined) {
    assert(
      typeof expected.require_aai_link_restored === 'boolean',
      `${sourcePath}: expected.require_aai_link_restored must be a boolean when present`,
    );
  }
  // Free-play addition (2026-09-14): an improvising caller can legitimately land on more
  // than one acceptable terminal verdict -- see types.ts's ScenarioExpected.verdicts doc
  // comment. Optional; when present, must be a non-empty array of valid verdict strings.
  if (expected.verdicts !== undefined) {
    assert(
      Array.isArray(expected.verdicts) &&
        expected.verdicts.length > 0 &&
        expected.verdicts.every((v) => typeof v === 'string' && VALID_VERDICTS.has(v)),
      `${sourcePath}: expected.verdicts must be a non-empty array, each one of ${[...VALID_VERDICTS].join(', ')}, when present`,
    );
  }

  const scenario: Scenario = {
    name: s.name as string,
    title: s.title as string,
    description: s.description as string,
    source: s.source as string,
    turns,
    expected: {
      verdict: expected.verdict as Scenario['expected']['verdict'],
      max_wall_ms: expected.max_wall_ms as number,
      ...(typeof expected.min_interrupted_agent_lines === 'number'
        ? { min_interrupted_agent_lines: expected.min_interrupted_agent_lines }
        : {}),
      ...(typeof expected.require_aai_link_restored === 'boolean'
        ? { require_aai_link_restored: expected.require_aai_link_restored }
        : {}),
      ...(Array.isArray(expected.verdicts) ? { verdicts: expected.verdicts as Scenario['expected']['verdict'][] } : {}),
    },
  };
  if (s.truth !== undefined) scenario.truth = validateTruth(s.truth, sourcePath);
  if (s.persona !== undefined) {
    assert(typeof s.persona === 'string' && s.persona.trim().length > 0, `${sourcePath}: "persona" must be a non-empty string when present`);
    scenario.persona = s.persona as string;
  }
  // demo_persona is the ONLY thing the harness tells the server about who is calling (the
  // server maps it to simulated telemetry; see packages/server/src/personas.ts). It was added to
  // the JSON and the type on 2026-09-04 but never copied here, so every honest-caller live run
  // for five days was silently minted as the attacker. Strict allowlist, same as the server's.
  if (s.demo_persona !== undefined) {
    assert(
      s.demo_persona === 'legitimate' || s.demo_persona === 'attacker',
      `${sourcePath}: "demo_persona" must be exactly "legitimate" or "attacker" when present`,
    );
    scenario.demo_persona = s.demo_persona;
  }
  // PROVEN gap (2026-09-13, see types.ts's ScenarioTurn.wait_for_agent doc comment): the
  // "patient caller" fields. Both optional, both default to "no change from old behavior"
  // when absent -- same discipline as demo_persona's strict allowlist above.
  if (s.caller_style !== undefined) {
    assert(s.caller_style === 'patient', `${sourcePath}: "caller_style" must be exactly "patient" when present`);
    scenario.caller_style = s.caller_style;
  }
  if (s.agent_silence_fail_ms !== undefined) {
    assert(
      typeof s.agent_silence_fail_ms === 'number' && s.agent_silence_fail_ms > 0,
      `${sourcePath}: "agent_silence_fail_ms" must be a positive number when present`,
    );
    scenario.agent_silence_fail_ms = s.agent_silence_fail_ms;
  }
  // Free-play addition (2026-09-14): see types.ts's ScenarioFreePlay doc comment. All fields
  // optional, absent entirely preserves "use the harness-wide defaults" behavior.
  if (s.free_play !== undefined) {
    assert(s.free_play && typeof s.free_play === 'object', `${sourcePath}: "free_play" must be an object when present`);
    const fp = s.free_play as Record<string, unknown>;
    const freePlay: ScenarioFreePlay = {};
    if (fp.pause_min_ms !== undefined) {
      assert(typeof fp.pause_min_ms === 'number' && fp.pause_min_ms >= 0, `${sourcePath}: free_play.pause_min_ms must be a non-negative number when present`);
      freePlay.pause_min_ms = fp.pause_min_ms;
    }
    if (fp.pause_max_ms !== undefined) {
      assert(typeof fp.pause_max_ms === 'number' && fp.pause_max_ms >= 0, `${sourcePath}: free_play.pause_max_ms must be a non-negative number when present`);
      freePlay.pause_max_ms = fp.pause_max_ms;
    }
    if (freePlay.pause_min_ms !== undefined && freePlay.pause_max_ms !== undefined) {
      assert(freePlay.pause_min_ms <= freePlay.pause_max_ms, `${sourcePath}: free_play.pause_min_ms must be <= free_play.pause_max_ms`);
    }
    if (fp.barge_in !== undefined) {
      assert(typeof fp.barge_in === 'boolean', `${sourcePath}: free_play.barge_in must be a boolean when present`);
      freePlay.barge_in = fp.barge_in;
    }
    scenario.free_play = freePlay;
  }
  return scenario;
}

export async function loadScenario(name: string): Promise<Scenario> {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new ScenarioValidationError(`could not read scenario "${name}" at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ScenarioValidationError(`${path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateScenario(parsed, path);
}

export async function listScenarioNames(): Promise<string[]> {
  const entries = await readdir(SCENARIOS_DIR);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export async function loadAllScenarios(): Promise<Scenario[]> {
  const names = await listScenarioNames();
  return Promise.all(names.map((n) => loadScenario(n)));
}
