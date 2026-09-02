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
