export const ENGINE_VERSION = '0.0.1';

export * from './types';
export { MERIDIAN } from './seed/meridian';
export * from './export/hashChain';
export { decide, RULES_DOC } from './rules';
export type { DecideResult, RuleContext, RuleMutant } from './rules';
export { evaluate } from './evaluate';
export { counterfactuals } from './counterfactual';
export { mockToolResult } from './mock/backend';
export type { MockCtx } from './mock/backend';
