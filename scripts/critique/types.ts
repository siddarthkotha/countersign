// scripts/critique/types.ts
// Shared types for the critique loop. This is a TEST/REVIEW HARNESS (BRIEF LAW 5 scope
// fence): it never ships in packages/, never claims voice/deepfake detection (LAW 1), and
// makes no network call unless the caller explicitly runs it without --dry-run and with a
// real API key present.

export type Severity = 'critical' | 'important' | 'minor';

/** One finding a critic model returned, in the fixed shape every persona is instructed to
 *  emit (see personas/OUTPUT_SHAPE in personaLoader.ts). */
export interface Finding {
  severity: Severity;
  area: string;
  claim: string;
  evidence_quote: string;
  suggested_test: string;
}

export interface PacketSection {
  id: string;
  label: string;
  content: string;
}

export interface Packet {
  /** The full assembled packet text, secret-redacted, ready to paste after a persona prompt. */
  text: string;
  /** Section ids included in full. */
  included: string[];
  /** Section ids that were truncated (partially included) or cut entirely (0 chars). */
  truncated: string[];
  /** Human-readable note describing exactly what was cut and why -- always present, even
   *  when nothing was cut ("nothing cut; N of CAP chars used"). */
  cut_note: string;
  char_count: number;
  cap: number;
}

export interface Persona {
  id: string;
  label: string;
  /** The full prompt text: the persona's own file content plus the shared output-shape
   *  suffix (see personaLoader.ts). */
  prompt: string;
}

export interface ModelConfig {
  /** The id passed to the provider. An OpenRouter id looks like "openai/gpt-4o" (routed to
   *  OpenRouter as-is); a direct-Gemini id is prefixed "gemini/", e.g.
   *  "gemini/gemini-1.5-pro" (the prefix is stripped before calling Gemini's API). */
  id: string;
  label: string;
}

export interface CritiqueConfig {
  packet_cap_chars: number;
  max_calls: number;
  request_timeout_ms: number;
  models: ModelConfig[];
}

export interface CriticResult {
  provider: 'openrouter' | 'gemini' | 'skipped';
  model: string;
  model_label: string;
  persona: string;
  persona_label: string;
  ok: boolean;
  error?: string;
  raw_text?: string;
  findings: Finding[];
  prose_verdict?: string;
  /** Set when the provider call succeeded (ok: true) but this critic's output could not be
   *  parsed into the required shape -- raw_text is always kept so nothing is silently lost. */
  parse_error?: string;
  requested_at_iso: string;
  latency_ms: number;
  /** ESTIMATE (method: characters / 4) -- never read from a provider's own token count. */
  prompt_char_estimate: number;
  token_estimate: number;
}

export interface RollupRow {
  normalized_claim: string;
  severity: Severity;
  area: string;
  claim: string;
  evidence_quote: string;
  suggested_test: string;
  raised_by: string[]; // "model__persona" ids that raised this claim
  count: number;
}
