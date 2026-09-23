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
// LIVE-RUN FIX (2026-09-23): the first live run left TWO stored agents both named
// "countersign-brain" after two server restarts -- a reconcile (PUT) that failed transiently
// used to fall through to create (POST), leaking a duplicate every time. `ensureBrainAgent`
// now cleans up duplicates (keeps the newest, deletes the rest, never by any name but its
// own) and retries a failed PUT once before reusing the existing agent as-is -- POST is only
// ever reached when nothing named `countersign-brain` exists at all. See that function's own
// doc comment for the full reasoning.
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
  /** Timeout for AssemblyAI REST calls in milliseconds. Default 10000 ms. */
  fetchTimeoutMs?: number;
}

export interface BrainAgent {
  id: string;
}

interface AgentListItem {
  id: string;
  name: string;
  /** ISO timestamp, when the API includes one (this module's header doc comment: the list
   *  endpoint's records are `{id, name, created_at, updated_at, deleted_at}`) -- used only to
   *  pick the newest of several same-named agents during cleanup (see `pickNewest` below).
   *  Optional: a record missing or with an unparseable one falls back to the list's own
   *  documented "newest first" order instead of ever throwing or mis-picking. */
  created_at?: string;
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
  const controller = new AbortController();
  const timeoutMs = opts.fetchTimeoutMs ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents`, {
      method: 'GET',
      headers: { Authorization: opts.assemblyai_api_key },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    const items: AgentListItem[] = [];
    for (const e of body) {
      if (typeof e !== 'object' || e === null) continue;
      const rec = e as { id?: unknown; name?: unknown; created_at?: unknown };
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string') continue;
      items.push({ id: rec.id, name: rec.name, ...(typeof rec.created_at === 'string' ? { created_at: rec.created_at } : {}) });
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
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
  const controller = new AbortController();
  const timeoutMs = opts.fetchTimeoutMs ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents`, {
      method: 'POST',
      headers: { Authorization: opts.assemblyai_api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(desiredAgentPayload(opts, voice)),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; agent_id?: string };
    const id = body.id ?? body.agent_id;
    return id ? { id } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** PUT /v1/agents/{id} -- PROVEN to exist (this lane's live docs re-check). Sends the full
 *  `desiredAgentPayload` every time (never a diff/patch) so this process's boot always
 *  converges the live agent onto exactly what it expects, without needing an unverified
 *  single-agent GET to compare against first. */
async function updateAgent(opts: EnsureBrainAgentOpts, id: string, voice: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = opts.fetchTimeoutMs ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents/${id}`, {
      method: 'PUT',
      headers: { Authorization: opts.assemblyai_api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(desiredAgentPayload(opts, voice)),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** DELETE /v1/agents/{id} -- PROVEN to exist (this module's header doc comment,
 *  ".../api-spec/delete-agent"). Only ever called on ids already filtered to
 *  `name === BRAIN_AGENT_NAME` exactly (see `ensureBrainAgent`'s cleanup step below) -- this
 *  function itself does not re-check the name, so it must never be called with an id from
 *  outside that filtered set. Best-effort: a failure is reported to the caller (`false`), not
 *  thrown, so a stale duplicate that fails to delete is left in place for the next boot to
 *  retry rather than aborting the whole bootstrap over a cleanup step. */
async function deleteAgent(opts: EnsureBrainAgentOpts, id: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = opts.fetchTimeoutMs ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await opts.fetchImpl(`${AGENTS_BASE}/agents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: opts.assemblyai_api_key },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** `true` when `a` is provably newer than `b` by `created_at`; `false` whenever either side is
 *  missing a parseable timestamp -- callers then fall back to the list's own order (the API's
 *  documented "newest first", per this module's header doc comment), never guess. */
function isNewer(a: AgentListItem, b: AgentListItem): boolean {
  if (!a.created_at || !b.created_at) return false;
  const at = Date.parse(a.created_at);
  const bt = Date.parse(b.created_at);
  if (Number.isNaN(at) || Number.isNaN(bt)) return false;
  return at > bt;
}

/** Picks the newest of one or more same-named agent records. With no usable `created_at` on
 *  either side of a comparison, `isNewer` always reads `false`, so this naturally falls back
 *  to `items[0]` -- the list's own documented newest-first order -- without any separate
 *  fallback branch. */
function pickNewest(items: AgentListItem[]): AgentListItem {
  let newest = items[0]!;
  for (const item of items.slice(1)) {
    if (isNewer(item, newest)) newest = item;
  }
  return newest;
}

/** Idempotent at boot: finds every agent named `countersign-brain` (GET /v1/agents, filtered
 *  by name -- never any other name). Zero found -> create one fresh (POST). One or more found
 *  -> DUPLICATE CLEANUP (live finding, 2026-09-23: two server restarts left two stored agents
 *  both named "countersign-brain" -- `scripts/spike/live-run/proxy-brain.log`/live boot logs,
 *  PROVEN): keep the newest (`pickNewest`) and `DELETE` every other match, then reconcile
 *  (PUT) the survivor onto today's desired voice/greeting/base_url, reusing its `id`.
 *
 *  PUT-FAILURE-CREATES-DUPLICATE fix: the previous version fell through to POST whenever the
 *  reconcile (PUT) failed -- on AssemblyAI's side that created a SECOND agent with the same
 *  name every time a PUT happened to fail transiently, which is exactly how the live duplicate
 *  got there in the first place. Now: retry the PUT once: if that also fails, REUSE the
 *  existing agent's id as-is (its live config may be stale until a future successful boot)
 *  rather than ever creating a duplicate. `createAgent` (POST) is reached ONLY when nothing
 *  named `countersign-brain` existed at all.
 *
 *  Never throws: every internal failure (list/reconcile/cleanup/create) is caught and logged
 *  here, and this function returns `null` only when there is truly no usable agent id at all
 *  (no existing agent AND create failed) -- `index.ts` treats `null` as "fall back to legacy
 *  for every call" (plan §4), never a crash. */
export async function ensureBrainAgent(opts: EnsureBrainAgentOpts): Promise<BrainAgent | null> {
  const voice = resolveVoice(opts.voice);
  try {
    const list = await listAgents(opts);
    const matches = list.filter((a) => a.name === BRAIN_AGENT_NAME);

    if (matches.length > 0) {
      const survivor = pickNewest(matches);
      const stale = matches.filter((a) => a.id !== survivor.id);
      for (const dup of stale) {
        const deleted = await deleteAgent(opts, dup.id);
        if (!deleted) {
          console.warn(
            `countersign: duplicate brain agent "${BRAIN_AGENT_NAME}" (${dup.id}) cleanup (DELETE) failed -- left in place, will retry next boot.`
          );
        }
      }

      let updated = await updateAgent(opts, survivor.id, voice);
      if (!updated) updated = await updateAgent(opts, survivor.id, voice); // one retry
      if (!updated) {
        console.warn(
          `countersign: brain agent "${BRAIN_AGENT_NAME}" (${survivor.id}) reconcile (PUT) failed twice -- reusing it as-is rather than creating a duplicate (voice/greeting/endpoint config may be stale until the next successful boot).`
        );
      }
      return { id: survivor.id };
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
