// scripts/rehearse/llmCaller.ts
// The LLM-DRIVEN caller: instead of a fixed scenario turn list, an external model plays the
// caller live, reading the scenario's `persona` and the transcript so far, and generating its
// next spoken line (plus an optional barge-in flag) turn by turn. This is a TEST HARNESS file
// (BRIEF LAW 5 scope fence) -- the model is playing a synthetic caller for testing, never
// claiming to detect a real one (LAW 1), and this is never imported by product code under
// packages/.
//
// Two providers, chosen by the `--model` flag's shape (see resolveLlmConfig):
//  - `--model gemini/<id>` -> Google's Gemini generateContent endpoint
//    (https://ai.google.dev/api/generate-content), key from GEMINI_API_KEY.
//  - any other `--model <id>` -> OpenRouter's OpenAI-compatible chat completions endpoint
//    (https://openrouter.ai/docs/api-reference/chat-completion), key from
//    OPENROUTER_API_KEY, `<id>` passed straight through as OpenRouter's own model id (e.g.
//    "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku").
//
// Both keys are read from `process.env` only -- the same convention run.ts's own
// ASSEMBLYAI_API_KEY dependency already uses (docs/REHEARSAL-HARNESS.md: "npm run dev:server
// does not read .env by itself"; export the key into the shell first, e.g.
// `set -a; source .env; set +a`). Neither key is ever logged, printed, or included in a
// thrown error message here -- errors report an HTTP status or a shape mismatch, never the
// request itself.
//
// The actual HTTP call is injected via the `HttpClient` interface (types.ts) so every
// function in this file is testable with a mocked fetch and never touches the network in
// `npm run rehearse:test` (BRIEF: "the tests must not need the network").
import type { HttpClient, LlmCallerTurnResult, LlmProvider, LlmTurnHistoryEntry } from './types.js';

export function resolveLlmConfig(modelArg: string): { provider: LlmProvider; model: string } {
  if (modelArg.startsWith('gemini/')) {
    return { provider: 'gemini', model: modelArg.slice('gemini/'.length) };
  }
  return { provider: 'openrouter', model: modelArg };
}

export function apiKeyEnvVarFor(provider: LlmProvider): string {
  return provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY';
}

/** Reads the provider's key straight from `process.env` -- never parsed from `.env` itself
 *  (see file header). Returns undefined, never throws, so the caller can print a plain
 *  "exit 2" message instead of an exception. */
export function getApiKey(provider: LlmProvider): string | undefined {
  return process.env[apiKeyEnvVarFor(provider)];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildSystemPrompt(persona: string, maxWords: number): string {
  return [
    'You are role-playing ONE SIDE of a live phone call for a security-testing rehearsal.',
    `Persona: ${persona}`,
    'Stay in character. Speak only what this caller would actually say out loud, one line at a time -- never narrate, never break character, never mention you are an AI or that this is a test.',
    `Keep each line to at most ${maxWords} words.`,
    'Reply with STRICT JSON ONLY, no markdown, no code fences, no extra text -- exactly this shape:',
    '{"text": "<the single line this caller says next>", "barge_in": false}',
    'Set "barge_in" to true only if, in character, this caller would talk over/interrupt the other side right now instead of waiting for them to finish (anger, urgency, being challenged) -- otherwise false.',
  ].join('\n');
}

/** Turns the running (agent, caller) history into a chat-style message list, folding a
 *  "speak now" instruction into (or after) the last message rather than appending a second
 *  consecutive user turn -- keeps this valid for providers (Gemini included) that expect
 *  strict role alternation. */
export function buildMessages(persona: string, history: LlmTurnHistoryEntry[], maxWords: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(persona, maxWords) }];
  const OPEN_TRIGGER = 'The call has just connected and no one has spoken yet. Speak your opening line now, in character, as JSON.';
  const CONTINUE_TRIGGER = 'Respond with your next line now, in character, as JSON.';

  if (history.length === 0) {
    messages.push({ role: 'user', content: OPEN_TRIGGER });
    return messages;
  }

  history.forEach((h, i) => {
    const role: ChatMessage['role'] = h.speaker === 'agent' ? 'user' : 'assistant';
    const isLast = i === history.length - 1;
    const content = isLast && role === 'user' ? `${h.text}\n\n(${CONTINUE_TRIGGER})` : h.text;
    messages.push({ role, content });
  });

  if (history[history.length - 1]!.speaker !== 'agent') {
    messages.push({ role: 'user', content: CONTINUE_TRIGGER });
  }

  return messages;
}

async function readErrorSnippet(res: { text(): Promise<string> }): Promise<string> {
  try {
    const body = await res.text();
    return body.slice(0, 200);
  } catch {
    return '(no body)';
  }
}

export async function callOpenRouter(http: HttpClient, apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
  const res = await http.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: 200, temperature: 0.8 }),
  });
  if (!res.ok) throw new Error(`OpenRouter request failed: HTTP ${res.status}: ${await readErrorSnippet(res)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('OpenRouter response missing choices[0].message.content');
  }
  return content;
}

interface GeminiContentPart {
  role: 'user' | 'model';
  parts: { text: string }[];
}

function toGeminiRequest(messages: ChatMessage[]): { systemInstruction?: { parts: { text: string }[] }; contents: GeminiContentPart[] } {
  const system = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model', parts: [{ text: m.content }] }));
  return system ? { systemInstruction: { parts: [{ text: system.content }] }, contents } : { contents };
}

export async function callGemini(http: HttpClient, apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
  const { systemInstruction, contents } = toGeminiRequest(messages);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, ...(systemInstruction ? { systemInstruction } : {}), generationConfig: { temperature: 0.8, maxOutputTokens: 200 } }),
  });
  // Never include `url` in a thrown message -- it carries the API key as a query param.
  if (!res.ok) throw new Error(`Gemini request failed: HTTP ${res.status}: ${await readErrorSnippet(res)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Gemini response missing candidates[0].content.parts[0].text');
  }
  return text;
}

/** Best-effort JSON parse of the model's reply: takes the first `{...}` span found (models
 *  occasionally wrap JSON in a code fence or a stray sentence despite instructions), falls
 *  back to treating the whole raw reply as the spoken line (barge_in: false) if nothing
 *  parses -- an LLM caller turn should never hard-fail a whole run over a formatting slip. */
export function parseCallerReply(raw: string): LlmCallerTurnResult {
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  try {
    const parsed = JSON.parse(candidate) as { text?: unknown; barge_in?: unknown };
    const text = typeof parsed.text === 'string' && parsed.text.trim().length > 0 ? parsed.text.trim() : raw.trim();
    return { text, barge_in: parsed.barge_in === true };
  } catch {
    return { text: raw.trim(), barge_in: false };
  }
}

/** One full round-trip: build the messages, call the right provider, parse the reply. */
export async function requestNextCallerLine(
  http: HttpClient,
  provider: LlmProvider,
  model: string,
  apiKey: string,
  persona: string,
  history: LlmTurnHistoryEntry[],
  maxWords: number,
): Promise<LlmCallerTurnResult> {
  const messages = buildMessages(persona, history, maxWords);
  const raw = provider === 'gemini' ? await callGemini(http, apiKey, model, messages) : await callOpenRouter(http, apiKey, model, messages);
  return parseCallerReply(raw);
}

/** The real HTTP client used outside tests -- a thin wrapper over the global `fetch` (Node
 *  22+, no dependency needed) matching the injectable `HttpClient` shape. */
export const nodeFetchHttpClient: HttpClient = {
  fetch: (url, init) => fetch(url, init),
};
