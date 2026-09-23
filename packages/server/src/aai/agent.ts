// packages/server/src/aai/agent.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §4, Lane D).
// Idempotent stored-agent bootstrap: ONE AssemblyAI stored agent for the whole server
// process, created once at boot (index.ts) when COUNTERSIGN_BRAIN=endpoint, reused across
// restarts by name -- `GET /v1/agents` (list) is PROVEN to exist and return lightweight
// records ({id, name, created_at, updated_at, deleted_at}, searchable by name), per this
// lane's own live docs re-check (2026-09-22, https://www.assemblyai.com/docs/voice-agents/
// voice-agent-api/manage-agents, and the update/delete endpoints confirmed at
// .../api-spec/update-agent and .../api-spec/delete-agent). Never throws: every path below
// is caught and returns `null` so `index.ts` can log and fall back to legacy mode for every
// call rather than crash the server (plan §4: "Failure to create the agent at boot must NOT
// crash the server").
//
// Voice and greeting move onto the stored agent's OWN creation/update payload (plan §4) --
// PROVEN required because binding via `agent_id` is mutually exclusive with inline session
// fields (docs/PANEL-2026-09-22-LIVE-RELIABILITY.md, "Stored agents" citation) -- reusing
// whatever DEFAULT_VOICE/DEFAULT_GREETING (or their env overrides) `index.ts` already passes
// the legacy path's `buildInitialSessionUpdate`, so the caller hears the identical voice and
// greeting in either mode.
import { resolveVoice } from './config.js';

const AGENTS_BASE = 'https://agents.assemblyai.com/v1';

/** Fixed name this process looks for/creates on every boot -- never derived from anything
 *  request-scoped (session id, timestamp), so a restart always finds the SAME agent rather
 *  than accumulating duplicates on AssemblyAI's side. */
export const BRAIN_AGENT_NAME = 'countersign-brain';

/** The model string this process's stored agent's `llm[0].model` is created/updated with --
 *  never a real model id. Our own `/api/brain/chat/completions` endpoint (brain/endpoint.ts)
 *  ignores it entirely and renders the WS server's own already-computed goal (LAW 3); this
 *  constant only satisfies the REST API's own required field. Exported so a test can assert
 *  against the same constant rather than a hand-copied string. */
export const BRAIN_LLM_MODEL = 'countersign-engine';

export interface EnsureBrainAgentOpts {
  assemblyai_api_key: string;
  /** COUNTERSIGN_PUBLIC_URL -- this process's own externally-reachable base URL (e.g.
   *  `https://countersign.onrender.com`), trailing slash optional. The stored agent's
   *  `llm[0].base_url` is built from this as `${publicUrl}/api/brain` -- AssemblyAI appends
   *  `/chat/completions` itself (PROVEN shape: `scripts/spike/run.ts`'s own `createAgent`
   *  call passed the bare tunnel root as `llm_base_url`, and `scripts/spike/endpoint.ts`'s
   *  own route lives at `/chat/completions` off that root -- so this file must never append
   *  `/chat/completions` itself, only `/api/brain`, matching http.ts's real mounted route
   *  `POST /api/brain/chat/completions`). */
  publicUrl: string;
  /** COUNTERSIGN_BRAIN_API_KEY -- the static bearer token `/api/brain/chat/completions`
   *  checks (http.ts/brain/endpoint.ts). Sent to AssemblyAI as `llm[0].api_key` so its own
   *  outbound request to our endpoint carries it (an OpenAI-compatible LLM config's
   *  `api_key` field becomes that request's `Authorization: Bearer <key>`, per the spike's
   *  own proven shape). */
  brainApiKey: string;
  voice: string;
  greeting: string;
  fetchImpl: typeof fetch;
}

export interface BrainAgent {
  id: string;
}

interface AgentListItem {
  id: string;
  name: string;
}

function buildLlmBaseUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/brain`;
}

/** GET /v1/agents -- PROVEN to exist (this lane's live docs re-check, 2026-09-22, see the
 *  module doc comment above): returns a JSON array of lightweight records, newest first,
 *  searchable by `name`. Never throws -- a network/parse/non-2xx failure returns `[]` so the
 *  caller falls through to "create fresh" rather than treating a transient list failure as
 *  proof no agent exists (which would otherwise leak a duplicate agent into AssemblyAI's
 *  account on every flaky boot). */
async function listAgents(opts: EnsureBrainAgentOpts): Promise<AgentListItem[]> {
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents`, {
      method: 'GET',
      headers: { Authorization: opts.assemblyai_api_key },
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return body.filter(
      (e): e is AgentListItem =>
        typeof e === 'object' && e !== null && typeof (e as AgentListItem).id === 'string' && typeof (e as AgentListItem).name === 'string'
    );
  } catch {
    return [];
  }
}

/** The exact stored-agent payload this process wants live, at creation (POST) or on every
 *  reconciling update (PUT) -- `voice`/`greeting`/`llm[0].base_url`/`llm[0].model` are the
 *  four fields plan §4 names as needing to converge on every boot; `system_prompt` is a
 *  fixed placeholder because endpoint mode's real per-call `system_prompt` is ALWAYS the
 *  post-bind `session.update` (aai/config.ts's `buildPostBindSessionUpdate`, aai/session.ts's
 *  `connectAaiEndpoint`), never this REST field -- it exists only to satisfy the API's
 *  required shape. */
function desiredAgentPayload(opts: EnsureBrainAgentOpts, voice: string): Record<string, unknown> {
  return {
    name: BRAIN_AGENT_NAME,
    system_prompt:
      'Countersign verification line. Per-call configuration loads at connect time; this placeholder is never spoken.',
    greeting: opts.greeting,
    voice: { voice_id: voice },
    llm: [{ base_url: buildLlmBaseUrl(opts.publicUrl), model: BRAIN_LLM_MODEL, api_key: opts.brainApiKey }],
  };
}

async function createAgent(opts: EnsureBrainAgentOpts, voice: string): Promise<BrainAgent | null> {
  const res = await opts.fetchImpl(`${AGENTS_BASE}/agents`, {
    method: 'POST',
    headers: { Authorization: opts.assemblyai_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(desiredAgentPayload(opts, voice)),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id?: string; agent_id?: string };
  const id = body.id ?? body.agent_id;
  return id ? { id } : null;
}

/** PUT /v1/agents/{id} -- PROVEN to exist (this lane's live docs re-check). Sends the full
 *  `desiredAgentPayload` every time (never a diff/patch) so this process's boot always
 *  converges the live agent onto exactly what it expects, without needing an unverified
 *  single-agent GET to compare against first. */
async function updateAgent(opts: EnsureBrainAgentOpts, id: string, voice: string): Promise<boolean> {
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents/${id}`, {
      method: 'PUT',
      headers: { Authorization: opts.assemblyai_api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(desiredAgentPayload(opts, voice)),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Idempotent at boot: finds an existing agent named `countersign-brain` (GET /v1/agents,
 *  filtered by name) and reconciles it (PUT) onto today's desired voice/greeting/base_url,
 *  reusing its `id`; creates one fresh (POST) if none is found, OR if reconciling an existing
 *  one fails (recreate rather than run a live call against a possibly-stale agent). Never
 *  throws: every internal failure is caught and logged here, and this function returns
 *  `null` -- `index.ts` treats `null` as "fall back to legacy for every call" (plan §4),
 *  never a crash. */
export async function ensureBrainAgent(opts: EnsureBrainAgentOpts): Promise<BrainAgent | null> {
  const voice = resolveVoice(opts.voice);
  try {
    const list = await listAgents(opts);
    const existing = list.find((a) => a.name === BRAIN_AGENT_NAME);
    if (existing) {
      const updated = await updateAgent(opts, existing.id, voice);
      if (updated) return { id: existing.id };
      console.warn(
        `countersign: brain agent "${BRAIN_AGENT_NAME}" (${existing.id}) reconcile (PUT) failed -- recreating.`
      );
      // Fall through to create a fresh one below rather than run the call against a
      // possibly-stale existing agent.
    }
    const created = await createAgent(opts, voice);
    if (created) return created;
    console.error('countersign: ensureBrainAgent create (POST /v1/agents) failed -- falling back to legacy for every call.');
    return null;
  } catch (err) {
    console.error(
      'countersign: ensureBrainAgent threw -- falling back to legacy for every call:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
