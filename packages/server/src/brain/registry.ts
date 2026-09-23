// packages/server/src/brain/registry.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§5, Lane
// B). AssemblyAI's own automatic reply calls OUR `/api/brain` HTTP endpoint (Lane C, not this
// file) as its LLM -- that request carries no `session_id`/`call_id` at all (PROVEN, the
// plan's own G5 citation: "no session_id/call_id in any header or body"). This registry is
// the in-process bridge: an unguessable per-call token, generated once when a `CallSession`
// starts and embedded in the FIRST (system) message of that call's stored-agent conversation
// history, is how a later `/api/brain` request finds its way back to the live `CallSession`
// that owns the real, server-authoritative conversation/tools/actions logs (LAW 2/LAW 3: this
// registry only ever LOOKS UP a session for the endpoint to read from -- it never itself
// drives a verdict, sends anything over the AAI socket, or writes evidence).
//
// The token is never logged (not by this file, and callers must not log it either -- treat it
// like a bearer credential: whoever holds it can drive that one call's `nextSpokenLine()`/
// `awaitCallerUtterance()`, though neither of those can ever release the wire on its own).
import { randomBytes } from 'node:crypto';
import type { CallSession } from '../call/session.js';

/** 32 random bytes (256 bits) as 64 lowercase hex characters -- generated fresh per call,
 *  never derived from anything guessable (session id, timestamp, caller-supplied data). Sized
 *  the same as a typical bearer-token/API-key convention; there is no per-call rate limit on
 *  guessing it to defend against (the caps.ts concurrency limit of 1-2 already bounds how many
 *  tokens are ever live at once), but 256 bits of entropy makes brute-forcing one moot. */
export function generateCallToken(): string {
  return randomBytes(32).toString('hex');
}

/** The fixed marker format a call's token is embedded in, inside the system message
 *  `CallSessionOpts`'s endpoint-mode wiring (Lane D, not this file) places first in the
 *  stored agent's own conversation history -- e.g. `system_prompt` at connect time, or
 *  whatever fixed system-role framing text AssemblyAI prepends to every `/api/brain` request
 *  it sends. Deliberately a distinctive bracketed marker (never a bare hex string) so it can
 *  never be confused with the surrounding prose, and deliberately embeddable ANYWHERE inside
 *  that message's content (see `extractCallToken` below) rather than requiring an exact
 *  position, since Lane D/Lane C do not yet know exactly what else that message will contain. */
export function formatCallTokenMarker(token: string): string {
  return `[countersign-call:${token}]`;
}

const CALL_TOKEN_HEX_LENGTH = 64; // 32 bytes, matches generateCallToken() above
const CALL_TOKEN_PATTERN = new RegExp(`\\[countersign-call:([0-9a-f]{${CALL_TOKEN_HEX_LENGTH}})\\]`);

/** The minimal shape this file needs from an OpenAI-style chat message -- `/api/brain`'s own
 *  request body (Lane C) will have a richer type; this file only ever reads `role`/`content`,
 *  so it takes the narrowest shape that works, importable from anywhere without a dependency
 *  on Lane C's own request-body type. */
export interface BrainChatMessage {
  role: string;
  content: string;
}

/** Extracts this call's token from an OpenAI-style `messages` array, per the marker format
 *  `formatCallTokenMarker` defines above. Per this plan's own §1 reconstruction algorithm,
 *  the token-carrying system message is always `messages[0]` (the provider's leading system
 *  boilerplate + our persona/marker line) -- a non-`system` `messages[0]`, or no match inside
 *  it, both return `null` rather than searching the rest of the array, so a token can never be
 *  found in caller- or assistant-authored content (LAW 4 adjacent: the token is server-side
 *  plumbing, never something a transcript substring should ever be able to forge). */
export function extractCallToken(messages: readonly BrainChatMessage[]): string | null {
  const first = messages[0];
  if (!first || first.role !== 'system' || typeof first.content !== 'string') return null;
  const match = CALL_TOKEN_PATTERN.exec(first.content);
  return match ? match[1]! : null;
}

/** In-process registry mapping an unguessable per-call token to the live `CallSession` it was
 *  minted for. One instance is meant to live for the whole server process (constructed once in
 *  `index.ts`, Lane D -- not this file), the same "one process, one map" shape `caps.ts`'s own
 *  concurrency tracking already uses. Never persisted, never serialized, never logged: a
 *  process restart drops every live call's token along with the call itself, which is correct
 *  -- there is nothing to resume (a fresh AssemblyAI connection mints a fresh token). */
export class BrainCallRegistry {
  private readonly sessions = new Map<string, CallSession>();

  /** Called once, when a `CallSession` starts in endpoint mode -- `token` must already be
   *  `generateCallToken()`'s own output (this method does not generate one itself, since the
   *  caller needs the token BEFORE the session exists, to embed it in the system message the
   *  stored agent bind sends). Overwrites silently if `token` is somehow already registered
   *  (should never happen -- 256 bits of entropy -- but a silent overwrite is safer than a
   *  thrown error on a call's own start path). */
  register(token: string, session: CallSession): void {
    this.sessions.set(token, session);
  }

  /** Called once, when a `CallSession` ends -- a no-op if `token` is not (or no longer)
   *  registered, so it is always safe to call from an `end()`-adjacent cleanup path without
   *  first checking whether registration ever happened (e.g. a legacy-mode call, which never
   *  registers a token at all). */
  unregister(token: string): void {
    this.sessions.delete(token);
  }

  /** The live `CallSession` for `token`, or `undefined` for an unknown/expired/never-issued
   *  one -- Lane C's `/api/brain` handler must treat `undefined` as "reject this request" (no
   *  session to read from means no engine state to compute a reply from), never as "start a
   *  fresh one" (a token this registry does not recognize proves nothing about which real call,
   *  if any, is asking). */
  get(token: string): CallSession | undefined {
    return this.sessions.get(token);
  }

  /** Number of calls currently registered -- diagnostics/test convenience only (e.g. asserting
   *  `unregister` actually removed an entry); never read by any verdict- or evidence-bearing
   *  code path. */
  get size(): number {
    return this.sessions.size;
  }
}
