// packages/engine/src/extract/identity.ts
// Matches a spoken identity claim against the seed's known identities/aliases. This is a
// STATED-fact extractor only — it never implies anything about voice authenticity.
//
// RULING (controller, identity-cue fix): a bare name mention is NOT a self-identification.
// "no, it was approved by Elena Park" names an approver, not the caller. A hit requires
// either (a) a self-identification cue near the name ("this is X", "X here", ...) or (b)
// the name opening the utterance with no possessive/cued-name continuation ("X approved
// it", "X's account"). Names captured by a cued-name pattern elsewhere in claims.ts
// (approved by X, counsel is X, escrow ... X, ... to X) are excluded outright.
import type { SeedConfig } from '../types.js';
import { cuedNameSpans } from './claims.js';

export interface IdentityHit {
  identity_id: string;
  quote: string;
}

/** True when `candidate` (already lower-case) occurs in `lowerText` at `idx` with a word
 *  boundary on both sides (neither neighbor is a letter or digit). Works for multi-word
 *  phrases too -- only the outer edges are checked. */
function isWordBounded(lowerText: string, idx: number, len: number): boolean {
  const before = idx > 0 ? lowerText[idx - 1] : undefined;
  const after = idx + len < lowerText.length ? lowerText[idx + len] : undefined;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);
  return !isWordChar(before) && !isWordChar(after);
}

/** All word-bounded occurrences of `lowerCandidate` in `lowerText`, as [start, end) spans. */
function findAllOccurrences(lowerText: string, lowerCandidate: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= lowerText.length) {
    const idx = lowerText.indexOf(lowerCandidate, from);
    if (idx === -1) break;
    if (isWordBounded(lowerText, idx, lowerCandidate.length)) {
      spans.push({ start: idx, end: idx + lowerCandidate.length });
    }
    from = idx + 1;
  }
  return spans;
}

/** Number of whitespace-separated words strictly between two char offsets (0 when adjacent
 *  or separated only by punctuation/whitespace). */
function wordGap(text: string, fromIdx: number, toIdx: number): number {
  if (toIdx <= fromIdx) return 0;
  const between = text.slice(fromIdx, toIdx).trim();
  if (between.length === 0) return 0;
  return between.split(/\s+/).filter(Boolean).length;
}

// Self-identification cues that must PRECEDE the name (within 3 words).
const BEFORE_CUES = [
  'this is',
  "it's",
  'it is',
  "i'm",
  'i am',
  'my name is',
  "you're speaking with",
  'you are speaking with',
];

// Self-identification cues that may FOLLOW the name (within 2 words): "X here", "X
// speaking", "X calling".
const AFTER_CUES = ['speaking', 'calling', 'here'];

function hasPrecedingCue(text: string, lowerText: string, nameStart: number): boolean {
  for (const cue of BEFORE_CUES) {
    for (const span of findAllOccurrences(lowerText, cue)) {
      if (span.end <= nameStart && wordGap(text, span.end, nameStart) <= 3) return true;
    }
  }
  return false;
}

function hasFollowingCue(text: string, lowerText: string, nameEnd: number): boolean {
  for (const cue of AFTER_CUES) {
    for (const span of findAllOccurrences(lowerText, cue)) {
      if (span.start >= nameEnd && wordGap(text, nameEnd, span.start) <= 2) return true;
    }
  }
  return false;
}

// A name that opens the utterance is disqualified when what follows reads as a possessive
// ("Marcus Obi's account") or a cued-name pattern ("Marcus Obi approved it", "... is our
// counsel", "... handled the deal") -- those are statements ABOUT the named person, not a
// self-identification. Fix round 1 (review of 2a08920 + 7d16440), finding 2: an optional
// auxiliary/adverb run (has/have/had/was/were/is/are/will/already/just/also/then/
// previously, up to 3 words) may sit between the name and the disqualifying verb --
// "Marcus Obi has approved it", "Marcus Obi was our counsel", "Dana Whitfield will approve"
// must disqualify exactly like the bare-verb forms already did.
const AUX_RUN = '(?:\\s+(?:has|have|had|was|were|is|are|will|already|just|also|then|previously)){0,3}';
const DISQUALIFYING_VERB_PHRASE = 'approved|approves|approve|handled|signed|authorized|is our|was our|are our|counsel|represents';
const DISQUALIFYING_CONTINUATIONS = [
  /^\s*'s\b/i,
  new RegExp(`^${AUX_RUN}\\s*\\b(?:${DISQUALIFYING_VERB_PHRASE})\\b`, 'i'),
];

function startsUtteranceValidly(text: string, nameStart: number, nameEnd: number): boolean {
  const prefix = text.slice(0, nameStart);
  if (!/^[^A-Za-z0-9]*$/.test(prefix)) return false; // only leading punctuation/whitespace allowed
  const rest = text.slice(nameEnd);
  return !DISQUALIFYING_CONTINUATIONS.some((re) => re.test(rest));
}

function overlapsAnySpan(start: number, end: number, spans: { start: number; end: number }[]): boolean {
  return spans.some((s) => Math.max(start, s.start) < Math.min(end, s.end));
}

/** True when the name occurrence at [start, end) in `text` reads as the CALLER
 *  self-identifying, per the ruling above. */
function isSelfIdentification(text: string, lowerText: string, start: number, end: number): boolean {
  return (
    hasPrecedingCue(text, lowerText, start) ||
    hasFollowingCue(text, lowerText, end) ||
    startsUtteranceValidly(text, start, end)
  );
}

function firstValidHit(
  text: string,
  lowerText: string,
  excludedSpans: { start: number; end: number }[],
  candidates: { identity_id: string; value: string; fullName?: string }[],
): IdentityHit | null {
  for (const { identity_id, value, fullName } of candidates) {
    const lowerCandidate = value.toLowerCase();
    const lowerFullName = fullName?.toLowerCase();
    for (const span of findAllOccurrences(lowerText, lowerCandidate)) {
      if (overlapsAnySpan(span.start, span.end, excludedSpans)) continue;
      // An alias occurrence that's actually the start of this same identity's full name
      // ("Marcus" inside "Marcus Obi") was already decided by the full-name pass -- don't
      // let the shorter alias re-evaluate a truncated view of that same span and reach a
      // different (wrong) answer, e.g. "Marcus Obi approved it" (rejected as full name)
      // must not fall through to "Marcus" (alias) reading as a bare self-id.
      if (lowerFullName && lowerFullName !== lowerCandidate && lowerText.startsWith(lowerFullName, span.start)) continue;
      if (isSelfIdentification(text, lowerText, span.start, span.end)) {
        return { identity_id, quote: text.slice(span.start, span.end) };
      }
    }
  }
  return null;
}

/** Full names take priority over aliases: try every identity's `name` first, then every
 *  identity's aliases, both in seed order. Returns the first match found that reads as a
 *  self-identification (see the ruling in the file header) and is not itself the X of a
 *  cued-name pattern (approved by X, counsel is X, escrow ... X, ... to X). */
export function extractIdentityClaim(text: string, seed: SeedConfig): IdentityHit | null {
  const lowerText = text.toLowerCase();
  const excludedSpans = cuedNameSpans(text);

  const nameHit = firstValidHit(
    text,
    lowerText,
    excludedSpans,
    seed.identities.map((identity) => ({ identity_id: identity.id, value: identity.name })),
  );
  if (nameHit) return nameHit;

  const aliasCandidates: { identity_id: string; value: string; fullName: string }[] = [];
  for (const identity of seed.identities) {
    for (const alias of identity.aliases) aliasCandidates.push({ identity_id: identity.id, value: alias, fullName: identity.name });
  }
  return firstValidHit(text, lowerText, excludedSpans, aliasCandidates);
}
