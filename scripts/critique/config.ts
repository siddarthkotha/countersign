// scripts/critique/config.ts
// Loads scripts/critique/critique.config.json -- the founder-editable file naming which
// models to fan out to, the packet size cap, the per-run spend guard, and the request
// timeout. Model ids are UNKNOWN to be current (providers rename/retire models often); this
// file is where the founder corrects them without touching code. See docs/CRITIQUE-LOOP.md.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CritiqueConfig, ModelConfig } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = join(HERE, 'critique.config.json');

export const HARD_DEFAULT_CONFIG: CritiqueConfig = {
  packet_cap_chars: 60_000,
  max_calls: 20,
  request_timeout_ms: 30_000,
  models: [
    { id: 'openai/gpt-4o', label: 'ChatGPT (gpt-4o via OpenRouter)' },
    { id: 'x-ai/grok-2', label: 'Grok 2 (via OpenRouter)' },
    { id: 'perplexity/sonar-pro', label: 'Perplexity Sonar Pro (via OpenRouter)' },
    { id: 'google/gemini-pro', label: 'Gemini Pro (via OpenRouter)' },
  ],
};

function isModelConfig(v: unknown): v is ModelConfig {
  return !!v && typeof v === 'object' && typeof (v as ModelConfig).id === 'string' && typeof (v as ModelConfig).label === 'string';
}

/** Loads the JSON config file if present, falling back field-by-field to
 *  HARD_DEFAULT_CONFIG for anything missing or malformed -- a founder editing one field
 *  (say, swapping a stale model id) should never have to restate the whole file correctly
 *  or risk the loop refusing to run. */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): CritiqueConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { ...HARD_DEFAULT_CONFIG, models: [...HARD_DEFAULT_CONFIG.models] };
  }
  const r = (raw ?? {}) as Partial<CritiqueConfig>;
  const packet_cap_chars = typeof r.packet_cap_chars === 'number' && r.packet_cap_chars > 0 ? r.packet_cap_chars : HARD_DEFAULT_CONFIG.packet_cap_chars;
  const max_calls = typeof r.max_calls === 'number' && r.max_calls > 0 ? r.max_calls : HARD_DEFAULT_CONFIG.max_calls;
  const request_timeout_ms = typeof r.request_timeout_ms === 'number' && r.request_timeout_ms > 0 ? r.request_timeout_ms : HARD_DEFAULT_CONFIG.request_timeout_ms;
  const models = Array.isArray(r.models) && r.models.every(isModelConfig) && r.models.length > 0 ? r.models : HARD_DEFAULT_CONFIG.models;
  return { packet_cap_chars, max_calls, request_timeout_ms, models: [...models] };
}

/** Parses a CLI-supplied comma list ("openai/gpt-4o,gemini/gemini-1.5-pro") into
 *  ModelConfig entries, using the id itself as the label (a CLI override has no config-file
 *  label to draw from). */
export function parseModelsArg(arg: string): ModelConfig[] {
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((id) => ({ id, label: id }));
}
