// scripts/spike/lib.ts
// SPIKE-ONLY (2.5h time-boxed, see docs/PANEL-2026-09-22-LIVE-RELIABILITY.md). Standalone,
// dependency-free helpers for talking to AssemblyAI's REST agent-management API and minting
// WS tokens. Deliberately NOT imported from packages/server -- this script tree must stand
// alone per the task's HARD RULES (write only under scripts/spike/, never edit packages/**).
// Mirrors the already-proven shape in packages/server/src/token.ts (Bearer-prefixed token
// mint) and the AssemblyAI docs' own curl examples for /v1/agents (raw key, no Bearer).
import { mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = join(HERE, 'logs');
export const OUT_DIR = join(HERE, 'out');

const AGENTS_BASE = 'https://agents.assemblyai.com/v1';

export function nowIso(): string {
  return new Date().toISOString();
}

/** Redacts a secret so logs never carry it -- shows only that a value was present. */
export function redact(v: string | undefined | null): string {
  if (!v) return '(absent)';
  return `(redacted, len=${v.length})`;
}

export function redactHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'cookie') {
      out[k] = redact(Array.isArray(v) ? v[0] : v);
    } else {
      out[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
  }
  return out;
}

let logFile = '';
export function setLogFile(name: string): string {
  logFile = join(LOG_DIR, name);
  return logFile;
}
export async function log(event: Record<string, unknown>): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: nowIso(), ...event }) + '\n';
  if (!logFile) setLogFile(`spike-${Date.now()}.jsonl`);
  await appendFile(logFile, line, 'utf8');
}

export interface MintedToken {
  token: string;
  expires_in_seconds: number;
}

/** Same shape as packages/server/src/token.ts's mintToken -- Bearer-prefixed Authorization,
 *  GET https://agents.assemblyai.com/v1/token. PROVEN pattern (that file is live in prod);
 *  reimplemented standalone here rather than imported, per the spike's file-isolation rule. */
export async function mintToken(apiKey: string, sessionCapSeconds: number): Promise<MintedToken> {
  const url = new URL(`${AGENTS_BASE}/token`);
  url.searchParams.set('expires_in_seconds', '60');
  url.searchParams.set('max_session_duration_seconds', String(sessionCapSeconds));
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mintToken failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as MintedToken;
}

export interface CreateAgentOpts {
  apiKey: string;
  name: string;
  system_prompt: string;
  greeting?: string;
  voice_id: string;
  llm_base_url: string;
  llm_model: string;
  llm_api_key: string;
  keyterms: string[];
  transcription_mode: 'balanced' | 'min_latency' | 'max_accuracy';
}

/** POST /v1/agents -- per docs/round2/connect-your-own-llm.md and manage-agents.txt, the REST
 *  agent-management endpoints take the RAW api key in Authorization (no "Bearer " prefix),
 *  unlike the token-mint endpoint above. Both forms are quoted verbatim in this spike's
 *  report. */
export async function createAgent(opts: CreateAgentOpts): Promise<{ id: string; raw: unknown }> {
  const body = {
    name: opts.name,
    system_prompt: opts.system_prompt,
    ...(opts.greeting ? { greeting: opts.greeting } : {}),
    voice: { voice_id: opts.voice_id },
    llm: [{ base_url: opts.llm_base_url, model: opts.llm_model, api_key: opts.llm_api_key }],
    input: {
      transcription_mode: opts.transcription_mode,
      keyterms: opts.keyterms,
    },
  };
  await log({ kind: 'rest_request', method: 'POST', url: `${AGENTS_BASE}/agents`, body });
  const res = await fetch(`${AGENTS_BASE}/agents`, {
    method: 'POST',
    headers: { Authorization: opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  await log({ kind: 'rest_response', status: res.status, body: text.slice(0, 4000) });
  if (!res.ok) {
    throw new Error(`createAgent failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as { id?: string; agent_id?: string };
  const id = json.id ?? json.agent_id;
  if (!id) throw new Error(`createAgent: no id in response: ${text.slice(0, 300)}`);
  return { id, raw: json };
}

/** PUT /v1/agents/{id} -- used to test whether a live re-publish of the SAME agent (new llm
 *  base_url / keyterms) is picked up by an already-bound session (G0's second question is
 *  about a second session.update on the WS, not this REST update; this helper exists in case
 *  the spike needs to rotate the tunnel URL without deleting/recreating the agent). */
export async function updateAgent(apiKey: string, id: string, patch: Record<string, unknown>): Promise<void> {
  await log({ kind: 'rest_request', method: 'PUT', url: `${AGENTS_BASE}/agents/${id}`, body: patch });
  const res = await fetch(`${AGENTS_BASE}/agents/${id}`, {
    method: 'PUT',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  await log({ kind: 'rest_response', status: res.status, body: text.slice(0, 2000) });
  if (!res.ok) throw new Error(`updateAgent failed: ${res.status} ${text.slice(0, 500)}`);
}

/** DELETE /v1/agents/{id} -- MUST be called for every agent this spike creates before the
 *  spike finishes (HARD RULES). Never throws on 404 (already gone) so cleanup in a finally
 *  block can't itself crash the process. */
export async function deleteAgent(apiKey: string, id: string): Promise<{ status: number }> {
  const res = await fetch(`${AGENTS_BASE}/agents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey },
  });
  await log({ kind: 'rest_response', method: 'DELETE', url: `${AGENTS_BASE}/agents/${id}`, status: res.status });
  return { status: res.status };
}

export function randomKey(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export async function ensureDirs(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
