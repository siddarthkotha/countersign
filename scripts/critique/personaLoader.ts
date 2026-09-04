// scripts/critique/personaLoader.ts
// Loads the persona prompt files under scripts/critique/personas/ and appends the shared
// output-shape suffix every persona must end with (LAW 1 boundary line, then the required
// JSON findings shape, then the 5-line prose verdict instruction). Keeping the suffix here
// instead of copy-pasted into every persona file means every persona is guaranteed to carry
// the LAW 1 line and the same output contract, and a change to the contract is one edit.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Persona } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PERSONAS_DIR = join(HERE, 'personas');

/** LAW 1 (project CLAUDE.md): Countersign never claims to detect synthetic/deepfake voices;
 *  the mechanism is behavioral verification only. Every critic gets told this explicitly so
 *  "you can't actually detect a cloned voice" comes back OUT OF SCOPE, not as a finding --
 *  that question was already decided and re-litigating it wastes a call and pollutes the
 *  rollup with a non-actionable item. */
const LAW1_LINE =
  "Design note you must respect: Countersign makes NO claim to detect synthetic, cloned, or deepfake voices acoustically. Its mechanism is behavioral verification only (what the caller knows, whether their story holds together, independent out-of-band checks) -- this is a deliberate, disclosed design choice, not an oversight. A finding of the shape \"you cannot detect a deepfake/cloned voice\" is OUT OF SCOPE by design; do not raise it.";

export const OUTPUT_SHAPE_SUFFIX = `
---
${LAW1_LINE}

Required output shape (produce exactly this, nothing before the JSON array):

1. A JSON array of findings. Each element:
   {
     "severity": "critical" | "important" | "minor",
     "area": "<short area name, e.g. 'rule table row 8' or 'README claims'>",
     "claim": "<one sentence: what is wrong or risky>",
     "evidence_quote": "<a short verbatim quote from the packet that supports this finding, or '' if none applies>",
     "suggested_test": "<one concrete, runnable or observable test/check that would catch this>"
   }
   Return [] if you find nothing beyond what's already disclosed as a known limitation.

2. After the JSON array, a 5-line prose verdict (exactly five lines, no more, no fewer):
   the single biggest risk you found, in your own words, and whether you would trust this
   system with a real high-value transfer today.
`;

function idFromFileName(fileName: string): string {
  return basename(fileName, '.md');
}

function labelFromId(id: string): string {
  return id
    .split('-')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

export function loadPersona(id: string, dir: string = PERSONAS_DIR): Persona {
  const filePath = join(dir, `${id}.md`);
  const body = readFileSync(filePath, 'utf-8').trim();
  return { id, label: labelFromId(id), prompt: `${body}\n${OUTPUT_SHAPE_SUFFIX}` };
}

export function listPersonaIds(dir: string = PERSONAS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map(idFromFileName)
    .sort();
}

export function loadAllPersonas(dir: string = PERSONAS_DIR): Persona[] {
  return listPersonaIds(dir).map((id) => loadPersona(id, dir));
}
