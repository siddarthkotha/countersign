// packages/engine/src/counterfactual.ts
// Powers the UI's "why?" panel: for each evidence card, what if this one card had come
// out differently? Pure -- every counterfactual re-runs the real `evaluate` with one
// card's status flipped via the override map; nothing here mutates the input or reads
// external state.
import { evaluate } from './evaluate';
import type { EngineInput, EvidenceStatus, Verdict } from './types';

function flipped(status: EvidenceStatus): EvidenceStatus | null {
  if (status === 'FAIL') return 'PASS';
  if (status === 'PASS') return 'FAIL';
  if (status === 'FLAG') return 'INFO';
  return null; // PENDING/INFO cards aren't meaningful single-card flips
}

export function counterfactuals(input: EngineInput): { flip: string; verdict: Verdict }[] {
  const base = evaluate(input);
  const out: { flip: string; verdict: Verdict }[] = [];

  for (const e of base.evidence) {
    const to = flipped(e.status);
    if (to === null) continue;
    const result = evaluate(input, { [e.id]: to });
    if (result.verdict !== base.verdict) {
      out.push({ flip: `${e.label}: ${e.status} -> ${to}`, verdict: result.verdict });
    }
  }

  return out;
}
