// scripts/critique/parseOutput.ts
// Parses a critic model's raw text response into the required shape: a JSON array of
// findings, then a 5-line prose verdict. Models routinely wrap JSON in markdown code
// fences or add a sentence before it, so this scans for the array by bracket-matching
// (string-aware, so a finding's own text can safely contain "[" or "]") rather than
// assuming the response starts exactly with "[".
import type { Finding, Severity } from './types.js';

const VALID_SEVERITIES: Severity[] = ['critical', 'important', 'minor'];

/** Finds the first top-level JSON array in `text` by scanning for balanced brackets,
 *  skipping over the contents of quoted strings so a finding's own text can contain "[" or
 *  "]" without breaking the scan. Returns null if no balanced array is found. */
export function extractJsonArray(text: string): { json: string; endIndex: number } | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), endIndex: i + 1 };
    }
  }
  return null;
}

function isFindingLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/** Coerces a parsed array element into a Finding, defaulting anything missing or malformed
 *  rather than throwing -- a critic model that gets 4 of 5 fields right should not lose the
 *  whole finding. severity defaults to "minor" (the safe default: never let a malformed
 *  severity silently look more urgent than it is or, in the rollup, than it was said to be). */
function coerceFinding(raw: unknown): Finding {
  const r = isFindingLike(raw) ? raw : {};
  const severity = VALID_SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : 'minor';
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    severity,
    area: str(r.area) || 'unspecified',
    claim: str(r.claim) || str(r.finding) || '(no claim text provided)',
    evidence_quote: str(r.evidence_quote),
    suggested_test: str(r.suggested_test),
  };
}

export interface ParsedOutput {
  findings: Finding[];
  prose_verdict?: string;
  parse_error?: string;
}

function withProse(base: Omit<ParsedOutput, 'prose_verdict'>, prose: string): ParsedOutput {
  return prose.length > 0 ? { ...base, prose_verdict: prose } : base;
}

export function parseCriticOutput(raw: string): ParsedOutput {
  // Strip markdown code fences (```json ... ``` or ``` ... ```) -- models add them often
  // even when explicitly told not to.
  const dejsonfenced = raw.replace(/```(?:json)?/gi, '');
  const fallbackProse = dejsonfenced.trim().slice(0, 2000);
  const found = extractJsonArray(dejsonfenced);
  if (!found) {
    return withProse({ findings: [], parse_error: 'no JSON array found in the response' }, fallbackProse);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(found.json);
  } catch (err) {
    return withProse(
      { findings: [], parse_error: `JSON.parse failed on the extracted array: ${err instanceof Error ? err.message : String(err)}` },
      fallbackProse,
    );
  }
  if (!Array.isArray(parsed)) {
    return withProse({ findings: [], parse_error: 'extracted JSON was not an array' }, fallbackProse);
  }
  const findings = parsed.map(coerceFinding);
  const prose = dejsonfenced.slice(found.endIndex).trim();
  return withProse({ findings }, prose);
}
