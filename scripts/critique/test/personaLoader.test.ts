// scripts/critique/test/personaLoader.test.ts
import { describe, it, expect } from 'vitest';
import { loadAllPersonas, listPersonaIds, loadPersona, OUTPUT_SHAPE_SUFFIX } from '../personaLoader.js';

const EXPECTED_PERSONAS = ['accessibility-reviewer', 'hackathon-judge', 'security-architect', 'social-engineer', 'treasury-operator'];

describe('listPersonaIds / loadAllPersonas', () => {
  it('finds exactly the five required personas', () => {
    expect(listPersonaIds().sort()).toEqual([...EXPECTED_PERSONAS].sort());
  });

  it('every persona loads with a unique id and non-empty prompt', () => {
    const personas = loadAllPersonas();
    expect(personas).toHaveLength(5);
    const ids = new Set(personas.map((p) => p.id));
    expect(ids.size).toBe(5);
    for (const p of personas) {
      expect(p.prompt.length).toBeGreaterThan(100);
    }
  });
});

describe('output-shape suffix', () => {
  it('every loaded persona prompt ends with the shared output-shape suffix', () => {
    for (const id of listPersonaIds()) {
      const persona = loadPersona(id);
      expect(persona.prompt.endsWith(OUTPUT_SHAPE_SUFFIX)).toBe(true);
    }
  });

  it('the suffix names the required JSON finding fields', () => {
    for (const field of ['severity', 'area', 'claim', 'evidence_quote', 'suggested_test']) {
      expect(OUTPUT_SHAPE_SUFFIX).toContain(field);
    }
    expect(OUTPUT_SHAPE_SUFFIX).toMatch(/critical/);
    expect(OUTPUT_SHAPE_SUFFIX).toMatch(/important/);
    expect(OUTPUT_SHAPE_SUFFIX).toMatch(/minor/);
    expect(OUTPUT_SHAPE_SUFFIX).toMatch(/5-line prose verdict|five lines/i);
  });

  it('the suffix tells every critic that voice/deepfake detection is out of scope by design (LAW 1)', () => {
    expect(OUTPUT_SHAPE_SUFFIX.toLowerCase()).toContain('deepfake');
    expect(OUTPUT_SHAPE_SUFFIX.toLowerCase()).toContain('out of scope');
    expect(OUTPUT_SHAPE_SUFFIX.toLowerCase()).toContain('behavioral verification');
  });

  it('no persona file itself claims or asks the critic to test voice/deepfake detection', () => {
    for (const id of listPersonaIds()) {
      const persona = loadPersona(id);
      const bodyOnly = persona.prompt.slice(0, persona.prompt.length - OUTPUT_SHAPE_SUFFIX.length).toLowerCase();
      expect(bodyOnly).not.toContain('detect a deepfake');
      expect(bodyOnly).not.toContain('detect synthetic voice');
      expect(bodyOnly).not.toContain('voice biometric');
    }
  });
});
