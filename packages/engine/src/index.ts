export const ENGINE_VERSION = '0.0.1';

export * from './types.js';
export { MERIDIAN } from './seed/meridian.js';
export * from './export/hashChain.js';
export { decide, RULES_DOC } from './rules.js';
export type { DecideResult, RuleContext, RuleMutant } from './rules.js';
export { evaluate } from './evaluate.js';
export { counterfactuals } from './counterfactual.js';
export { mockToolResult } from './mock/backend.js';
export type { MockCtx } from './mock/backend.js';
// 2026-09-18 continued (double-ask catch-up content-match lane): additive exports only, no
// behavior change -- lets call/session.ts (packages/server) reuse the SAME spoken-value
// normalizers the readback grader (ledger.ts) and challenge composer (challenges.ts) already
// use, rather than writing a third, server-side normalizer for the same job. See
// packages/server/src/call/questionMatch.ts's own `loadBearingValueFor`/
// `transcriptContainsLoadBearingValue` doc comments for how each is used.
export { normalizeText, normalizeSpokenDigits } from './normalize.js';
export { extractSpokenAmounts } from './extract/spokenNumbers.js';
export { spokenField } from './challenges.js';
