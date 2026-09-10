// scripts/rehearse/scenario.ts
// Loads and validates a scenario JSON file under scripts/rehearse/scenarios/. Deliberately
// hand-rolled validation (no schema library) -- this is a small, fixed shape and a test
// harness, not product code (BRIEF LAW 5 scope fence).
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario, ScenarioRespond, ScenarioTruth, ScenarioTurn } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = join(HERE, 'scenarios');

const VALID_VERDICTS = new Set(['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION']);

export class ScenarioValidationError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ScenarioValidationError(msg);
}

function validateRespondRule(raw: unknown, turnLabel: string, index: number): { if_agent_says_any: string[]; say: string } {
  assert(raw && typeof raw === 'object', `${turnLabel}.respond.rules[${index}] must be an object`);
  const r = raw as Record<string, unknown>;
  assert(
    Array.isArray(r.if_agent_says_any) && r.if_agent_says_any.length > 0 && r.if_agent_says_any.every((s) => typeof s === 'string' && s.length > 0),
    `${turnLabel}.respond.rules[${index}].if_agent_says_any must be a non-empty array of non-empty strings`,
  );
  assert(typeof r.say === 'string' && r.say.trim().length > 0, `${turnLabel}.respond.rules[${index}].say must be a non-empty string`);
  return { if_agent_says_any: r.if_agent_says_any as string[], say: r.say as string };
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
  const turn: ScenarioTurn = { id: t.id as string, text: t.text as string };
  if (typeof t.pause_ms === 'number') turn.pause_ms = t.pause_ms;
  if (typeof t.barge_in_after_ms === 'number') turn.barge_in_after_ms = t.barge_in_after_ms;
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

  const scenario: Scenario = {
    name: s.name as string,
    title: s.title as string,
    description: s.description as string,
    source: s.source as string,
    turns,
    expected: {
      verdict: expected.verdict as Scenario['expected']['verdict'],
      max_wall_ms: expected.max_wall_ms as number,
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
