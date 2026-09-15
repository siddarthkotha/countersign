// scripts/rehearse/truthEngine.ts
// The REACTIVE scripted caller's brain: decides what the synthetic caller says next by
// looking at the text of the real live agent's LAST reply, never a fixed script. This is a
// TEST HARNESS file (BRIEF LAW 5 scope fence) -- it never claims to detect synthetic voices
// (LAW 1) and is never imported by product code under packages/.
//
// Why this exists: the first real rehearsal run
// (scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md) failed
// because the OLD harness spoke a fixed line ("Yes, that's right.") no matter what the agent
// actually said -- including the moment the live engine deliberately planted a TRAP question
// (challenges.ts's TRAP_FACT: "confirm the request back... but say Northgate Partners in
// place of the beneficiary"). A scripted caller confirmed a false fact instead of correcting
// it, which is exactly what an honest caller must never do -- and the run FROZE instead of
// STAGING. This file is the fix: a small, deterministic rule engine that reads the agent's
// words and reacts the way the scenario's own `persona` would.
//
// Two layers, checked in order by `resolveTurnText` (turnController.ts calls this):
//   1. Scenario-authored `respond.rules` on the turn itself (explicit, highest priority) --
//      `{ if_agent_says_any: [...], say: "..." }`, first match wins.
//   2. This file's GENERIC engine, driven by the scenario's `truth` block -- no scenario-
//      specific wiring needed. It knows a small, fixed vocabulary of the proper-noun values
//      this demo's deterministic engine can plant or ask about (copied here as READ-ONLY
//      reference values, never imported, from packages/engine/src/challenges.ts:47-52 --
//      TRAP_DECOYS -- and packages/engine/src/seed/meridian.ts:42-50 -- the real
//      counsel/escrow knowledge entries). If the agent's text quotes one of those values for
//      a field the scenario's caller actually knows (`truth[field]` is set), the caller
//      confirms a match or corrects a mismatch; if the agent asks an open question about a
//      field with no quoted value, the caller restates or answers from `truth`; if the agent
//      asks for something the caller was never given (an id, a code, a PIN), the caller
//      declines and repeats their name -- never invents an answer.
// Both layers can also fall through to the turn's own fixed `text` -- every turn still
// carries one, so a scenario is never left with nothing to say.
import type { ScenarioTruth, ScenarioTurn, RespondRule } from './types.js';

// ---------- layer 1: scenario-authored rules ----------

/** True if ANY phrase in `group` is a case-insensitive substring of `lower` (already
 *  lower-cased). An undefined group is "no constraint" -- always true. */
function anyPhraseHits(group: string[] | undefined, lower: string): boolean {
  if (group === undefined) return true;
  return group.some((phrase) => lower.includes(phrase.toLowerCase()));
}

/** First rule that matches ALL of: at least one `if_agent_says_any` hit; at least one
 *  `and_agent_says_any` hit if that group is present; and NO `unless_agent_says_any` hit if
 *  that group is present -- wins. null if no rule matches (or there is no agent line yet).
 *  See types.ts's RespondRule doc comment (fix 2026-09-11) for why the two extra groups
 *  exist: a plain phrase list alone is not robust to the live model's paraphrase of
 *  ASK_CHALLENGE questions. */
export function matchRespondRules(rules: RespondRule[], lastAgentText: string | null): string | null {
  if (lastAgentText === null) return null;
  const lower = lastAgentText.toLowerCase();
  for (const rule of rules) {
    if (!anyPhraseHits(rule.if_agent_says_any, lower)) continue;
    if (!anyPhraseHits(rule.and_agent_says_any, lower)) continue;
    if (rule.unless_agent_says_any !== undefined && anyPhraseHits(rule.unless_agent_says_any, lower)) continue;
    return rule.say;
  }
  return null;
}

// ---------- layer 2: the generic truth engine ----------

type NameField = 'beneficiary' | 'counsel' | 'escrow_institution' | 'approver';
/** Same priority order challenges.ts's own TRAP_FIELD_ORDER uses (challenges.ts:45) -- not
 *  load-bearing here (this engine reacts to whatever value it finds, it does not select
 *  which field the live engine chooses to ask about), kept for readability only. */
const NAME_FIELD_ORDER: NameField[] = ['beneficiary', 'counsel', 'escrow_institution', 'approver'];

/** READ-ONLY copy of the fixed, small vocabulary of proper-noun values this demo's
 *  deterministic engine can plant (as a TRAP_FACT decoy) or ask about (as a SEED_FACT
 *  knowledge check) -- sourced from packages/engine/src/challenges.ts:47-52 and
 *  packages/engine/src/seed/meridian.ts:42-50/6/35. This is a fixed demo corpus, not a
 *  general NLP problem, so a hardcoded vocabulary is the right amount of machinery here
 *  (BRIEF LAW 5: this is a test harness, not product code). Each list includes both the real
 *  value and every decoy the engine is known to plant, so both "the agent said the truth"
 *  and "the agent said a decoy" are detectable. */
const FIELD_VOCAB: Record<NameField, string[]> = {
  beneficiary: ['Meridian Supply', 'Northgate Partners'],
  counsel: ['Calder & Finch', 'Calder and Finch', 'Whitmore & Bass', 'Whitmore and Bass'],
  escrow_institution: ['First Meridian Trust', 'Harbor Fidelity Trust', 'Sutter Cove Bank', 'Northgate Partners'],
  approver: ['Marcus Obi', 'Elena Park', 'Northgate Partners'],
};

const HUMAN_FIELD_NAME: Record<NameField | 'amount_usd' | 'account_last4' | 'deadline', string> = {
  beneficiary: 'beneficiary',
  counsel: 'counsel',
  escrow_institution: 'escrow institution',
  approver: 'approver',
  amount_usd: 'amount',
  account_last4: 'account number',
  deadline: 'deadline',
};

function confirmPhrase(): string {
  return "Yes, that's right.";
}

function correctPhrase(truthValue: string): string {
  return `No, that's wrong, it's ${truthValue}.`;
}

function restatePhrase(field: keyof typeof HUMAN_FIELD_NAME, value: string): string {
  if (field === 'amount_usd') return `It's $${value}.`;
  if (field === 'account_last4') return `It's account ending ${value}.`;
  return `It's ${value}.`;
}

function declineAndRepeatName(identity: string | null | undefined): string {
  const name = identity && identity.trim().length > 0 ? identity : 'the caller';
  return `I don't have that. This is ${name}.`;
}

// ---- number-word parsing (the live agent speaks amounts and digits as words, e.g. "eighty
// four thousand five hundred dollars", "account ending four four seven one" -- PROVEN from
// the failed run's own transcript, scripts/rehearse/reports/
// 2026-09-03T23-04-42-scenario-a-dana-legitimate.md) ----

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };
const DIGIT_WORD: Record<string, string> = { zero: '0', oh: '0', ...Object.fromEntries(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((w) => [w, String(ONES[w])])) };

/** Parses a run of number words ("eighty four thousand five hundred" -> 84500). Best-effort:
 *  stops at the first unrecognized token rather than throwing. Returns null if nothing in
 *  the run was a number word. */
function wordsToInteger(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let any = false;
  for (const tok of tokens) {
    if (tok === 'and') continue;
    if (tok in ONES) {
      current += ONES[tok]!;
      any = true;
    } else if (tok in TENS) {
      current += TENS[tok]!;
      any = true;
    } else if (tok === 'hundred') {
      current = (current || 1) * 100;
      any = true;
    } else if (tok === 'thousand' || tok === 'million' || tok === 'billion') {
      current = (current || 1) * SCALES[tok]!;
      total += current;
      current = 0;
      any = true;
    } else {
      break;
    }
  }
  return any ? total + current : null;
}

function extractNumeralAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(million|thousand)?\b/gi;
  for (const m of text.matchAll(re)) {
    const digits = m[1]!;
    const decimals = m[2];
    const scale = m[3]?.toLowerCase();
    const hasDollarSign = m[0].trim().startsWith('$');
    const hasScale = scale !== undefined;
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    const followedByDollars = /^\s*dollars?\b/i.test(after);
    if (!hasDollarSign && !hasScale && !followedByDollars) continue;
    let value = Number(digits.replace(/,/g, ''));
    if (decimals) value = Number(`${Math.trunc(value)}.${decimals}`);
    if (hasScale) value *= scale === 'million' ? 1_000_000 : 1000;
    out.push(Math.round(value));
  }
  return out;
}

/** "one point eight million" -> 1_800_000. Handles a single leading digit-word, "point",
 *  one or more trailing digit-words as the decimal, then a scale word. */
function extractSpokenPointAmounts(text: string): number[] {
  const out: number[] = [];
  const digitWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine)';
  const re = new RegExp(`\\b(${digitWord})\\s+point\\s+(${digitWord}(?:\\s+${digitWord})*)\\s+(thousand|million|billion)\\b`, 'gi');
  for (const m of text.matchAll(re)) {
    const intPart = ONES[m[1]!.toLowerCase()]!;
    const decDigits = m[2]!
      .toLowerCase()
      .split(/\s+/)
      .map((w) => ONES[w]!);
    const fraction = Number(`0.${decDigits.join('')}`);
    const scale = SCALES[m[3]!.toLowerCase()]!;
    out.push(Math.round((intPart + fraction) * scale));
  }
  return out;
}

/** Whole-number amounts spelled entirely as words, e.g. "eighty four thousand five hundred
 *  dollars" -- gated on either an explicit scale word inside the run itself, or the run being
 *  immediately followed by "dollars"/"dollar", so an unrelated number in the sentence (a
 *  count, a digit-by-digit account number) is never mistaken for a dollar amount. */
function extractSpokenWordAmounts(text: string): number[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const NUMBER_WORD = new Set([...Object.keys(ONES), ...Object.keys(TENS), 'hundred', 'thousand', 'million', 'billion', 'and']);
  const out: number[] = [];
  let i = 0;
  while (i < words.length) {
    if (!NUMBER_WORD.has(words[i]!)) {
      i++;
      continue;
    }
    if (i > 0 && words[i - 1] === 'point') {
      // Already covered (and consumed) by extractSpokenPointAmounts -- skip so it is never
      // double-counted as a second, unrelated whole-word amount.
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && NUMBER_WORD.has(words[j]!)) j++;
    const run = words.slice(i, j);
    const hasScaleInRun = run.some((w) => w === 'thousand' || w === 'million' || w === 'billion');
    const followedByDollars = words[j] === 'dollars' || words[j] === 'dollar';
    if (hasScaleInRun || followedByDollars) {
      const value = wordsToInteger(run);
      if (value !== null) out.push(value);
    }
    i = j;
  }
  return out;
}

/** Digit sequences spoken or written as separate tokens, e.g. "8 4 5 0 0" or "8-4-5-0-0",
 *  gated on being followed by "dollars"/"dollar" or appearing after "is" / "the amount is" /
 *  similar readback patterns, so a stray digit sequence elsewhere in the sentence is never
 *  mistaken for a dollar amount. */
function extractSpacedDigitAmounts(text: string): number[] {
  const out: number[] = [];
  // Look for patterns like "8 4 5 0 0 dollars" or "is 8 4 5 0 0" or "8-4-5-0-0 dollars"
  const lowerText = text.toLowerCase();

  // Replace dashes with spaces to normalize both forms
  const normalized = lowerText.replace(/-/g, ' ');

  // Look for sequences of digit words/numerals surrounded by spaces
  const tokens = normalized.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    // Check if this token is a digit word or numeral
    if (!(tokens[i] in DIGIT_WORD) && !/^\d$/.test(tokens[i]!)) continue;

    // Try to collect consecutive digit tokens
    let j = i;
    const digits: string[] = [];
    while (j < tokens.length && (tokens[j] in DIGIT_WORD || /^\d$/.test(tokens[j]!))) {
      digits.push(tokens[j]!);
      j++;
    }

    // Only process if we have at least 3 consecutive digits (minimum for amount like "4 4 7")
    if (digits.length < 3) {
      i = j - 1;
      continue;
    }

    // Check if followed by "dollars" or "dollar"
    const followedByDollars = j < tokens.length && (tokens[j] === 'dollars' || tokens[j] === 'dollar');

    // Also check if preceded by amount-related words (amount, is, costs, etc.)
    let precededByAmountWord = false;
    if (i > 0) {
      const prevToken = tokens[i - 1]!;
      precededByAmountWord = /^(amount|is|costs?|was|equals?|equals?)$/.test(prevToken);
    }

    // Process if it looks like an amount context
    if (followedByDollars || precededByAmountWord || (i > 0 && tokens[i - 1] === 'amount')) {
      // Convert digit words to numerals and join to form the amount
      const digitStrings = digits.map((d) => {
        if (d in DIGIT_WORD) return DIGIT_WORD[d];
        return d;
      });
      const numberStr = digitStrings.join('');
      const value = Number(numberStr);
      if (!isNaN(value)) out.push(value);
    }

    i = j - 1;
  }

  return out;
}

/** Every dollar-amount mention found in `text`, numeral and spoken forms merged. May contain
 *  duplicates or unrelated extra numbers from ambiguous phrasing -- callers only ever check
 *  "does the true amount appear anywhere in here", never treat this as a single value. */
export function extractAmountsFromText(text: string): number[] {
  return [...extractNumeralAmounts(text), ...extractSpokenPointAmounts(text), ...extractSpokenWordAmounts(text), ...extractSpacedDigitAmounts(text)];
}

/** Finds four consecutive single-digit tokens (numerals or spelled digit words) anywhere in
 *  `text`, e.g. "four four seven one" or "4471" -- only called when the text already looks
 *  like it is talking about an account number (see the `/ending|last four|account number|
 *  digits/i` gate at the call site), so this does not need its own topic gate. */
function extractLast4(text: string): string | null {
  const lower = text.toLowerCase();
  const bareNumeral = lower.match(/\b(\d{4})\b/);
  const tokens = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i + 4 <= tokens.length; i++) {
    const slice = tokens.slice(i, i + 4);
    if (slice.every((t) => t in DIGIT_WORD)) {
      return slice.map((t) => DIGIT_WORD[t]).join('');
    }
  }
  return bareNumeral ? bareNumeral[1]! : null;
}

/** The subset of ScenarioTruth fields the "restate"/"knowledge question" detectors can ever
 *  name -- deliberately excludes `identity` (that's handled separately, by the unknown-id/
 *  code decline path). */
type RestatableField = NameField | 'amount_usd' | 'account_last4' | 'deadline';

const RESTATE_RE = /\brestate|\brepeat (?:that|it|back)|what (?:was|did (?:i|you) say)/i;
const RESTATE_FIELD_KEYWORD: { re: RegExp; field: RestatableField }[] = [
  { re: /\bamount\b/i, field: 'amount_usd' },
  { re: /\bbeneficiary\b/i, field: 'beneficiary' },
  { re: /\baccount\b/i, field: 'account_last4' },
  { re: /\bapprover|\bapproved\b/i, field: 'approver' },
  { re: /\bcounsel\b/i, field: 'counsel' },
  { re: /\bescrow\b/i, field: 'escrow_institution' },
  { re: /\bdeadline\b/i, field: 'deadline' },
];

function detectRestateField(lower: string): RestatableField | null {
  if (!RESTATE_RE.test(lower)) return null;
  for (const { re, field } of RESTATE_FIELD_KEYWORD) {
    if (re.test(lower)) return field;
  }
  return null;
}

const KNOWLEDGE_FIELD_KEYWORD: { re: RegExp; field: RestatableField }[] = [
  { re: /counsel of record|which law firm|who is (?:our|the) counsel/i, field: 'counsel' },
  { re: /escrow institution|which institution|holds the .*escrow/i, field: 'escrow_institution' },
  { re: /last four digits/i, field: 'account_last4' },
  { re: /who approved|approved (?:this|it)/i, field: 'approver' },
];

function detectKnowledgeField(lower: string): RestatableField | null {
  for (const { re, field } of KNOWLEDGE_FIELD_KEYWORD) {
    if (re.test(lower)) return field;
  }
  return null;
}

// Broad on purpose: the live agent has been observed asking for several different
// unmodeled "prove it" tokens across runs -- "identity id" (PROVEN: the first real run,
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md) and
// "authorization code" (PROVEN: scripts/rehearse/reports/
// 2026-09-03T23-32-42-scenario-a-dana-legitimate.md, where a caller ignorant of this pattern
// looped with the agent until idle_timeout instead of ever declining). None of these are
// facts any scenario's `truth` block tracks, so the safe, generic response to ANY "state/
// give/provide ... code/id/pin/number" ask is always the same: decline and repeat the name.
const UNKNOWN_ID_RE =
  /identity id|identification (?:id|number|code)|verification code|security code|access code|authorization code|authorisation code|passcode|\bpin\b|\b(?:state|provide|give|enter)\b.{0,30}\b(?:code|id|pin|number)\b/i;

/** The generic, `truth`-driven fallback: given the live agent's last line and this
 *  scenario's `truth` block, decides what an honest (or, for a persona with everything set
 *  to null, deliberately non-corrective) caller says next. Returns null when nothing in the
 *  line is recognized -- the caller falls back further, to the turn's own fixed `text`. */
export function genericTruthReply(lastAgentText: string, truth: ScenarioTruth): string | null {
  const lower = lastAgentText.toLowerCase();
  // A single agent line can mention more than one field (e.g. "Meridian Supply" AND a wrong
  // amount in the same sentence) -- every recognized field is checked, and a MISMATCH on any
  // one of them wins outright (a caller who spots one wrong number corrects it, full stop);
  // only if nothing mismatched but at least one field was recognized does the caller confirm.
  let anyMatch = false;

  // 1) A known name-field value (real or decoy) quoted back to the caller.
  for (const field of NAME_FIELD_ORDER) {
    const truthValue = truth[field];
    if (truthValue === undefined || truthValue === null) continue;
    for (const candidate of FIELD_VOCAB[field]) {
      if (lower.includes(candidate.toLowerCase())) {
        if (normalizeLoose(candidate) === normalizeLoose(truthValue)) anyMatch = true;
        else return correctPhrase(truthValue);
        break;
      }
    }
  }

  // 2) A dollar amount quoted back to the caller.
  if (truth.amount_usd !== undefined && truth.amount_usd !== null) {
    const amounts = extractAmountsFromText(lastAgentText);
    if (amounts.length > 0) {
      if (amounts.includes(truth.amount_usd)) anyMatch = true;
      else return correctPhrase(`$${truth.amount_usd.toLocaleString()}`);
    }
  }

  // 3) An account number quoted back to the caller (gated on an account-shaped topic so a
  // random 4-digit run elsewhere in the sentence is never mistaken for this).
  if (
    truth.account_last4 !== undefined &&
    truth.account_last4 !== null &&
    /ending|last four|account number|account digits/i.test(lower)
  ) {
    const last4 = extractLast4(lastAgentText);
    if (last4 !== null) {
      if (last4 === truth.account_last4) anyMatch = true;
      else return correctPhrase(`account ending ${truth.account_last4}`);
    }
  }

  if (anyMatch) return confirmPhrase();

  // 4) An open "restate what you told me" ask with no value quoted.
  const restateField = detectRestateField(lower);
  if (restateField) {
    const value = truth[restateField];
    if (value !== undefined && value !== null) return restatePhrase(restateField, String(value));
  }

  // 5) A knowledge question (counsel of record, escrow institution, ...) with no value
  // quoted -- answer from truth if the caller knows it, decline (and repeat their name) if
  // not, same as an unknown id/code ask.
  const knowledgeField = detectKnowledgeField(lower);
  if (knowledgeField) {
    const value = truth[knowledgeField];
    if (value !== undefined && value !== null) return restatePhrase(knowledgeField, String(value));
    return declineAndRepeatName(truth.identity);
  }

  // 6) A request for something this caller was never given (an identity id, a PIN, a code)
  // -- never invented, always declined, with the caller repeating their name.
  if (UNKNOWN_ID_RE.test(lower)) {
    return declineAndRepeatName(truth.identity);
  }

  return null;
}

function normalizeLoose(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------- turn resolution ----------

export type ResolvedTurnSource = 'fixed' | 'rule' | 'else_say' | 'generic' | 'fallback';

export interface ResolvedTurn {
  text: string;
  source: ResolvedTurnSource;
}

/** Decides what a scripted-reactive turn actually says, given the live agent's last
 *  transcript line (null if the agent hasn't spoken yet -- the greeting-grace case). Order:
 *  a turn with no `respond` block always just speaks its fixed `text` (unchanged behavior
 *  for plain scripted lines, e.g. an opening statement or a scripted pressure escalation
 *  that should fire no matter what the agent said). A turn WITH `respond` tries, in order:
 *  its own rules, its `else_say`, the generic truth engine, and only then its fixed `text`
 *  as a last resort -- so a scenario is never left mute. */
export function resolveTurnText(turn: ScenarioTurn, truth: ScenarioTruth | undefined, lastAgentText: string | null): ResolvedTurn {
  if (!turn.respond) return { text: turn.text, source: 'fixed' };

  const ruleMatch = matchRespondRules(turn.respond.rules, lastAgentText);
  if (ruleMatch !== null) return { text: ruleMatch, source: 'rule' };

  if (turn.respond.else_say !== undefined) return { text: turn.respond.else_say, source: 'else_say' };

  if (lastAgentText !== null && truth) {
    const generic = genericTruthReply(lastAgentText, truth);
    if (generic !== null) return { text: generic, source: 'generic' };
  }

  return { text: turn.text, source: 'fallback' };
}
