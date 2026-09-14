// scripts/rehearse/freePlayPrompt.ts
// Free-play addition (2026-09-14, founder's definition of done: "a judge speaking in their
// own words, with any pauses and pronunciation, must be understood and get the right outcome
// in every case. A scripted pass is not done."). This builds the system prompt an improvising
// LLM caller plays from in `--free-play` mode -- persona AND truth, NEVER the scenario's
// scripted `turns` (those exist only for the reactive/scripted-turn-list callers) -- and adds
// explicit natural-variation instructions on top of llmCaller.ts's existing persona framing so
// the model doesn't read the same line twice in a row across repeated runs.
//
// This file never touches the network itself: `requestNextFreePlayLine` below is the only
// function that does, and it does so purely by delegating to llmCaller.ts's own
// `callOpenRouter`/`callGemini` (already network-injected via `HttpClient`, BRIEF: "the tests
// must not need the network") -- no new network code is written here.
import { callGemini, callOpenRouter } from './llmCaller.js';
import type { HttpClient, LlmProvider, LlmTurnHistoryEntry, ScenarioTruth } from './types.js';

/** Free play's own reply shape, extending llmCaller.ts's `{text, barge_in}` with `silent`
 *  (below) -- llmCaller.ts's own `parseCallerReply` cannot express this third state, so this
 *  file parses its own replies with `parseFreePlayCallerReply` instead of reusing that
 *  function; `callOpenRouter`/`callGemini` (the actual network calls) are still reused
 *  unmodified. */
export interface FreePlayCallerTurnResult {
  text: string;
  barge_in: boolean;
  /** PROVEN gap (2026-09-14): two of the ten judge cases (hangup-after-request,
   *  miller-silent-after-amount) require the caller to go PERMANENTLY silent at a defined
   *  point -- "say nothing further after the request / after the amount change". The ordinary
   *  `{text, barge_in}` contract has no way to say "I have nothing to say this turn, and
   *  never will again" -- an empty `text` would still get synthesized and streamed as a blank
   *  line, and the turn loop would keep asking for a NEXT line forever. `silent: true` is the
   *  model's own explicit signal that its persona has reached that point; freePlay.ts's
   *  `runFreePlayTurns` stops asking for further lines the moment it sees this, exactly the
   *  same way turnController.ts's scripted `hangup-after-request.json` (a one-turn scenario
   *  with nothing scripted after c1) already goes silent by simply running out of turns. */
  silent: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Renders `truth`'s non-null fields as a compact "field: value" list for the system prompt
 *  -- grounding facts the model must never contradict, distinct from the free-form `persona`
 *  text (a persona can, and often does, already spell these out in prose; this is a
 *  belt-and-suspenders structured copy so a value the persona's prose glossed over is still
 *  available). `identity` is included like any other field -- free play has no separate
 *  "declining an unknown id" special case the way the generic reactive engine does; the model
 *  is simply told what it knows and improvises the rest in character. Returns null when
 *  `truth` is absent or every field is null/undefined (nothing to ground). */
export function renderTruthForPrompt(truth: ScenarioTruth | undefined): string | null {
  if (!truth) return null;
  const lines: string[] = [];
  const push = (label: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined) return;
    lines.push(`- ${label}: ${value}`);
  };
  push('identity', truth.identity);
  push('beneficiary', truth.beneficiary);
  push('amount (USD)', truth.amount_usd);
  push('account, last 4 digits', truth.account_last4);
  push('counsel of record', truth.counsel);
  push('escrow institution', truth.escrow_institution);
  push('approver', truth.approver);
  push('deadline', truth.deadline);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** The natural-variation instructions themselves -- item (a) of the free-play spec: vary
 *  wording every run, sometimes restate a number differently, sometimes hesitate, never read
 *  a script. Split out as its own function (rather than inlined into
 *  `buildFreePlaySystemPrompt`) so a unit test can assert on its exact content without having
 *  to also thread a persona/truth through. */
export function freePlayVariationInstructions(): string {
  return [
    'This is a FREE-PLAY rehearsal: you have no fixed script. Improvise every line yourself, in character, from the persona and facts below -- never recite a memorized script, and never say the same sentence the same way twice across different calls.',
    'Vary your wording naturally from call to call: sometimes restate a number in digits ("84,500"), sometimes in words ("eighty-four five" or "eighty four thousand five hundred"); vary word order and phrasing; occasionally add a natural hesitation ("uh", "let me think", a short pause implied by "...") the way a real person on the phone does.',
    'Never break character to mention this is a test, a rehearsal, or that you are an AI.',
  ].join('\n');
}

/** The full free-play system prompt: persona, the natural-variation instructions, the
 *  grounding truth block (when present), and the same strict-JSON reply contract
 *  llmCaller.ts's scripted-LLM-caller prompt already uses (`{"text": ..., "barge_in": ...}`)
 *  so `parseCallerReply` (llmCaller.ts, reused unmodified) can parse either caller's reply the
 *  same way. */
export function buildFreePlaySystemPrompt(persona: string, truth: ScenarioTruth | undefined, maxWords: number): string {
  const truthBlock = renderTruthForPrompt(truth);
  const parts = [
    'You are role-playing ONE SIDE of a live phone call for a security-testing rehearsal.',
    `Persona: ${persona}`,
    freePlayVariationInstructions(),
    `Keep each line to at most ${maxWords} words.`,
  ];
  if (truthBlock) {
    parts.push('Facts you know for certain (never contradict these; the persona above may already restate some of them in your own words):', truthBlock);
  }
  parts.push(
    'Reply with STRICT JSON ONLY, no markdown, no code fences, no extra text -- exactly this shape:',
    '{"text": "<the single line this caller says next>", "barge_in": false, "silent": false}',
    'Set "barge_in" to true only if, in character, this caller would talk over/interrupt the other side right now instead of waiting for them to finish (anger, urgency, being challenged) -- otherwise false.',
    'Set "silent" to true ONLY if your persona explicitly instructs you to go silent / stop speaking at this exact point in the call -- when you do, leave "text" empty; you will not be asked for another line after that, exactly matching "gone from the call, permanently, from here on". If your persona gives no such instruction, always leave "silent" false and always say something in character.',
  );
  return parts.join('\n');
}

const OPEN_TRIGGER = 'The call has just connected and no one has spoken yet. Speak your opening line now, in character, as JSON.';
const CONTINUE_TRIGGER = 'Respond with your next line now, in character, as JSON.';

/** Same message-shape discipline as llmCaller.ts's own `buildMessages` (strict role
 *  alternation, the "speak now" trigger folded into/after the last message rather than
 *  appended as a second consecutive user turn) -- duplicated here, not imported, because the
 *  system prompt differs (this file's `buildFreePlaySystemPrompt`, not llmCaller.ts's
 *  persona-only one) and `buildMessages` builds its own system message internally with no way
 *  to inject a different one. */
export function buildFreePlayMessages(
  persona: string,
  truth: ScenarioTruth | undefined,
  history: LlmTurnHistoryEntry[],
  maxWords: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: buildFreePlaySystemPrompt(persona, truth, maxWords) }];

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

/** Best-effort JSON parse of the free-play model's reply -- same tolerant shape as
 *  llmCaller.ts's own `parseCallerReply` (first `{...}` span found, whole raw reply as a
 *  last-resort spoken line if nothing parses), extended with the `silent` field
 *  (`FreePlayCallerTurnResult`'s own doc comment has the full reasoning). A `silent: true`
 *  reply always wins over whatever (if anything) landed in `text` -- `text` is forced empty
 *  so a model that half-followed the instruction (set `silent: true` AND still wrote a line)
 *  never accidentally gets that line spoken. */
export function parseFreePlayCallerReply(raw: string): FreePlayCallerTurnResult {
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  try {
    const parsed = JSON.parse(candidate) as { text?: unknown; barge_in?: unknown; silent?: unknown };
    const silent = parsed.silent === true;
    if (silent) return { text: '', barge_in: false, silent: true };
    const text = typeof parsed.text === 'string' && parsed.text.trim().length > 0 ? parsed.text.trim() : raw.trim();
    return { text, barge_in: parsed.barge_in === true, silent: false };
  } catch {
    return { text: raw.trim(), barge_in: false, silent: false };
  }
}

/** Detects whether the caller is about to speak for the first time in this call: history has
 *  no entries with speaker === 'caller'. PROVEN gap (2026-09-14, defect 2): on the caller's
 *  opening line, the model must never be allowed to set `silent: true` -- every persona must
 *  state its opening request before going silent (hangup-after-request, miller-silent-after-
 *  amount). */
function isCallerFirstTurn(history: readonly LlmTurnHistoryEntry[]): boolean {
  return !history.some((entry) => entry.speaker === 'caller');
}

/** One full free-play round-trip: build the free-play messages, call the right provider
 *  (delegating to llmCaller.ts's own, already-tested `callOpenRouter`/`callGemini`), parse
 *  the reply with this file's own `parseFreePlayCallerReply` (not llmCaller.ts's
 *  `parseCallerReply` -- that shape has no room for `silent`). Enforces (2026-09-14, defect 2)
 *  that `silent: true` is never allowed on the caller's first turn. */
export async function requestNextFreePlayLine(
  http: HttpClient,
  provider: LlmProvider,
  model: string,
  apiKey: string,
  persona: string,
  truth: ScenarioTruth | undefined,
  history: LlmTurnHistoryEntry[],
  maxWords: number,
): Promise<FreePlayCallerTurnResult> {
  const messages = buildFreePlayMessages(persona, truth, history, maxWords);
  const raw = provider === 'gemini' ? await callGemini(http, apiKey, model, messages) : await callOpenRouter(http, apiKey, model, messages);
  let result = parseFreePlayCallerReply(raw);
  // Defect 2 (2026-09-14): a persona's FIRST spoken line must never be silent -- it must state
  // an opening request. If the model returned silent on the first turn, force it back to false
  // and ensure the text is non-empty (treated as the model's actual response).
  if (isCallerFirstTurn(history) && result.silent) {
    result = { text: result.text.trim().length > 0 ? result.text : raw.trim(), barge_in: false, silent: false };
  }
  return result;
}
