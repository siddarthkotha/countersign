// packages/server/src/call/validate.ts
// CLAUDE.md law: "typed tool payloads validated/repaired in code." A `tool.call` from AAI
// carries `arguments: Record<string, unknown>` with no compile-time guarantee it matches
// the schema we advertised -- S2 built this against a scripted fake that always sends
// well-formed args, but S3's real adapter is the first place a genuinely LLM-generated
// payload flows through, and an LLM can omit a required field, send a stringified number,
// or invent an extra property. This is a small, dependency-free JSON-Schema-subset checker
// for our nine flat tool schemas: it never calls the mock backend itself -- `call/session.ts`
// decides what to do with the result (call the mock, or log an `invalid_arguments` error and
// let the LLM retry).
//
// Deliberately NOT a general JSON-Schema validator: only object/string/number/integer/
// boolean, only top-level (non-nested) properties, only `required` and `enum`. Every one of
// our tool schemas fits that shape; nothing here needs to grow past it.

export interface FlatToolProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  enum?: string[];
}

// Named `ParamsSchema` (fix round 1, finding 4) -- NOT the same shape as `allowlist.ts`'s
// `FlatToolSchema` (the whole outer tool schema: type/name/description/parameters/
// execution_mode/timeout_seconds). This is just the `parameters` JSON-Schema-subset object
// nested inside one of those -- two different things had been exported under the same name.
export interface ParamsSchema {
  type: 'object';
  properties: Record<string, FlatToolProperty>;
  required?: string[];
}

export interface ValidateResult {
  ok: boolean;
  /** Sanitized args: unknown properties dropped, known ones coerced where safe. Always
   *  returned (even when `ok` is false) so a caller can still log what was actually there. */
  args: Record<string, unknown>;
  /** Property names that were kept but changed shape (a dropped unknown property, OR a
   *  coerced scalar) -- judge-legible provenance for "the server repaired this," never
   *  silent. */
  repaired: string[];
  /** Property names missing (and required) or present but uncoercible/enum-mismatched.
   *  Non-empty ⇒ `ok: false`. */
  rejected: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerces `value` to `type` when it can be done without guessing at the caller's intent:
 *  a number already of the right shape, or the two conversions the fix explicitly calls
 *  for (a numeric string -> number/integer, "true"/"false" -> boolean). Anything else is
 *  left uncoerced -- `null` signals "could not make this fit," not "made it fit with `null`." */
function coerceScalar(value: unknown, type: FlatToolProperty['type']): { value: unknown; changed: boolean } | null {
  if (type === 'string') {
    return typeof value === 'string' ? { value, changed: false } : null;
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return { value, changed: false };
    if (value === 'true') return { value: true, changed: true };
    if (value === 'false') return { value: false, changed: true };
    return null;
  }

  // 'number' | 'integer'
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (type === 'integer' && !Number.isInteger(value)) return null;
    return { value, changed: false };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      if (type === 'integer' && !Number.isInteger(n)) return null;
      return { value: n, changed: true };
    }
  }
  return null;
}

/** Validates (and repairs where safe) `args` against `schema`. `name` is accepted for
 *  parity with every other per-tool function on the call path (mock, argsForTerminalTool)
 *  and for a caller building its own error/log messages -- the checker itself is generic
 *  over `schema` and never branches on it. */
export function validateToolArgs(name: string, args: unknown, schema: ParamsSchema): ValidateResult {
  void name;
  const repaired: string[] = [];
  const rejected: string[] = [];
  const input = isPlainObject(args) ? args : {};

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!(key in schema.properties)) {
      repaired.push(key); // unknown property: dropped, not passed to the mock
      continue;
    }
    out[key] = input[key];
  }

  const required = new Set(schema.required ?? []);
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in out)) {
      if (required.has(key)) rejected.push(key);
      continue;
    }
    const coerced = coerceScalar(out[key], propSchema.type);
    if (coerced === null) {
      rejected.push(key);
      delete out[key];
      continue;
    }
    if (propSchema.enum && !propSchema.enum.includes(String(coerced.value))) {
      rejected.push(key);
      delete out[key];
      continue;
    }
    if (coerced.changed) repaired.push(key);
    out[key] = coerced.value;
  }

  return { ok: rejected.length === 0, args: out, repaired, rejected };
}
