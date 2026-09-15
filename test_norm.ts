import { normalizeText } from './packages/engine/src/normalize.js';

const tests = [
  "yes",
  "that's right",
  "okay",
  "yes, right",
  "yes that is right",
  "hmm",
  "why do you need that",
  "Alright, that's fine"
];

for (const t of tests) {
  const norm = normalizeText(t);
  console.log(`"${t}" -> length: ${norm.length}, normalized: "${norm}"`);
}
