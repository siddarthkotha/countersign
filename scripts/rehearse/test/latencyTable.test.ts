import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateLatencyTable, loadRuns, renderLatencyDoc, type LoadedRun } from '../latencyTable.js';
import type { RehearseDiagnosticBundle } from '../types.js';

function bundle(events: RehearseDiagnosticBundle['server_events']): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-1',
    started_at: Date.parse('2026-09-11T00:00:00.000Z'),
    ended_at: Date.parse('2026-09-11T00:02:00.000Z'),
    end_reason: 'agent_closed',
    deployed_commit: 'abc123',
    server_events: events,
    client_events: [],
  };
}

describe('loadRuns', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'latency-table-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a diagnostics bundle and its paired .md for target/scenario', async () => {
    const base = '2026-09-11T12-00-00-scenario-a-dana-legitimate';
    await writeFile(
      join(dir, `${base}.diagnostics.json`),
      JSON.stringify(
        bundle([
          { t_ms: 0, kind: 'aai_connect_start', detail: {} },
          { t_ms: 100, kind: 'aai_ready', detail: { ms_since_connect_start: 100, greeting_configured: true } },
        ]),
      ),
      'utf-8',
    );
    await writeFile(join(dir, `${base}.md`), '# Rehearsal report\n\nScenario: `scenario-a-dana-legitimate`\nTarget: https://countersign-bf8q.onrender.com\n', 'utf-8');

    const runs = await loadRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scenario).toBe('scenario-a-dana-legitimate');
    expect(runs[0]!.target_url).toBe('https://countersign-bf8q.onrender.com');
    expect(runs[0]!.target_kind).toBe('deployed');
    expect(runs[0]!.metrics.connect_to_ready_ms).toBe(100);
  });

  it('falls back to parsing the scenario name from the filename when the .md is missing', async () => {
    const base = '2026-09-11T12-00-00-scenario-b-miller-fraud';
    await writeFile(join(dir, `${base}.diagnostics.json`), JSON.stringify(bundle([])), 'utf-8');

    const runs = await loadRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scenario).toBe('scenario-b-miller-fraud');
    expect(runs[0]!.target_url).toBeNull();
    expect(runs[0]!.target_kind).toBe('unknown');
  });

  it('returns an empty list for a directory with no diagnostics bundles', async () => {
    await writeFile(join(dir, 'not-a-bundle.md'), 'nothing here', 'utf-8');
    expect(await loadRuns(dir)).toEqual([]);
  });

  it('returns an empty list (not a throw) for a directory that does not exist', async () => {
    expect(await loadRuns(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('skips a corrupt diagnostics.json rather than failing the whole load', async () => {
    await writeFile(join(dir, '2026-09-11T12-00-00-broken.diagnostics.json'), '{not valid json', 'utf-8');
    expect(await loadRuns(dir)).toEqual([]);
  });

  it('parses the perceived per-turn gaps from the paired .md report', async () => {
    const base = '2026-09-11T12-00-00-scenario-a-dana-legitimate';
    await writeFile(join(dir, `${base}.diagnostics.json`), JSON.stringify(bundle([])), 'utf-8');
    await writeFile(
      join(dir, `${base}.md`),
      [
        'Scenario: `scenario-a-dana-legitimate`',
        'Target: http://localhost:8787',
        '',
        '| turn | caller ended | first reply audio | gap | note |',
        '| --- | --- | --- | --- | --- |',
        '| c1 | 1000ms | 1758ms | 758ms |  |',
        '| c2 | 2000ms | n/a | n/a | no reply audio observed after this turn |',
      ].join('\n'),
      'utf-8',
    );

    const runs = await loadRuns(dir);
    expect(runs[0]!.perceived.gaps_ms).toEqual([758]);
    expect(runs[0]!.perceived.na_count).toBe(1);
    expect(runs[0]!.perceived.total_turns).toBe(2);
  });

  it('defaults perceived to all-zero when the .md is missing entirely', async () => {
    const base = '2026-09-11T12-00-00-scenario-b-miller-fraud';
    await writeFile(join(dir, `${base}.diagnostics.json`), JSON.stringify(bundle([])), 'utf-8');

    const runs = await loadRuns(dir);
    expect(runs[0]!.perceived).toEqual({ gaps_ms: [], na_count: 0, total_turns: 0 });
  });
});

describe('generateLatencyTable', () => {
  let dir: string;
  let outPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'latency-table-out-'));
    outPath = join(dir, 'LATENCY.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes docs/LATENCY.md-shaped output even with zero bundles on disk', async () => {
    const { runs, outputPath } = await generateLatencyTable(dir, outPath);
    expect(runs).toEqual([]);
    expect(outputPath).toBe(outPath);
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(outPath, 'utf-8');
    expect(written).toContain('# Latency table');
    expect(written).toContain('No `*.diagnostics.json` bundles found');
  });
});

describe('renderLatencyDoc', () => {
  function run(overrides: Partial<LoadedRun>): LoadedRun {
    return {
      source_file: 'x.diagnostics.json',
      target_url: 'https://countersign-bf8q.onrender.com',
      target_kind: 'deployed',
      scenario: 'scenario-a-dana-legitimate',
      date_iso: '2026-09-11',
      metrics: {
        connect_to_ready_ms: 500,
        ready_to_first_audio_ms: 100,
        greeting: true,
        turn_response_gaps_ms: [200, 400],
        caller_end_source: 'input.speech.stopped',
        connect_to_verdict_ms: 9000,
        verdict_to_end_ms: 1500,
      },
      perceived: { gaps_ms: [700, 600], na_count: 1, total_turns: 3 },
      ...overrides,
    };
  }

  it('never writes the string "sub-second" anywhere', () => {
    const doc = renderLatencyDoc([run({})], 0);
    expect(doc.toLowerCase()).not.toContain('sub-second');
  });

  it('splits the ready-to-first-audio table by greeting label, never averaging greeting with non-greeting rows', () => {
    const doc = renderLatencyDoc(
      [
        run({ source_file: 'greet.diagnostics.json', metrics: { ...run({}).metrics, greeting: true, ready_to_first_audio_ms: 100 } }),
        run({ source_file: 'nogreet.diagnostics.json', metrics: { ...run({}).metrics, greeting: null, ready_to_first_audio_ms: 18000 } }),
      ],
      0,
    );
    // the same target/label combination never appears in a row averaging 100 and 18000
    expect(doc).toContain('deployed / greeting | 1 | 100ms | 100ms |');
    expect(doc).toMatch(/deployed \/ first reply.*\| 1 \| 18000ms \| 18000ms \|/);
  });

  it('reports n=0 and UNKNOWN when a run is missing an event a column needs', () => {
    const doc = renderLatencyDoc([run({ metrics: { ...run({}).metrics, connect_to_verdict_ms: null, verdict_to_end_ms: null } })], 0);
    expect(doc).toContain('| deployed / scenario-a-dana-legitimate | 0 | UNKNOWN | UNKNOWN |');
  });

  it('states n and the date range, and mentions skipped older .md-only runs', () => {
    const doc = renderLatencyDoc([run({})], 5);
    expect(doc).toContain('n=1, date range 2026-09-11 to 2026-09-11');
    expect(doc).toContain('5 additional');
  });

  it('handles the zero-bundle case without throwing', () => {
    const doc = renderLatencyDoc([], 0);
    expect(doc).toContain('No `*.diagnostics.json` bundles found');
  });

  it('the top headline line reports the PERCEIVED figure (from .md per-turn gaps), not the relay-gap figure', () => {
    const doc = renderLatencyDoc(
      [
        run({ metrics: { ...run({}).metrics, turn_response_gaps_ms: [1, 1] }, perceived: { gaps_ms: [700, 900], na_count: 1, total_turns: 3 } }),
      ],
      0,
    );
    const headlineLine = doc.split('\n').find((l) => l.startsWith('**Perceived response latency (headline'));
    expect(headlineLine).toBeDefined();
    expect(headlineLine).toContain('p50=800ms'); // median of [700,900], not the relay-gap [1,1]
    expect(headlineLine).toContain('n=2 turns');
    expect(headlineLine).toContain('1 turn(s) excluded as n/a');
  });

  it('labels section 3a as a relay gap (not perceived) and section 3b as the perceived/ESTIMATE figure', () => {
    const doc = renderLatencyDoc([run({})], 0);
    expect(doc).toContain('## 3a. Server relay gap after AssemblyAI\'s end-of-turn event (not perceived latency)');
    expect(doc).toContain('## 3b. Perceived response latency (the gap a judge feels) -- ESTIMATE');
    expect(doc).toContain('harness wall clock from the synthetic caller\'s last audio frame to the agent\'s first reply audio; includes AssemblyAI end-of-turn detection; ESTIMATE because the synthetic caller is not a human');
  });

  it('section 3a and 3b use independent samples -- a run\'s relay-gap turns never leak into the perceived table', () => {
    const doc = renderLatencyDoc(
      [run({ metrics: { ...run({}).metrics, turn_response_gaps_ms: [1, 2, 3] }, perceived: { gaps_ms: [700, 900], na_count: 0, total_turns: 2 } })],
      0,
    );
    const lines = doc.split('\n');
    const idx3a = lines.findIndex((l) => l.startsWith('## 3a.'));
    const idx3b = lines.findIndex((l) => l.startsWith('## 3b.'));
    const idx4 = lines.findIndex((l) => l.startsWith('## 4.'));
    const section3a = lines.slice(idx3a, idx3b).join('\n');
    const section3b = lines.slice(idx3b, idx4).join('\n');
    expect(section3a).toContain('| deployed / scenario-a-dana-legitimate | 3 |'); // n=3 relay-gap turns
    expect(section3b).toContain('| deployed / scenario-a-dana-legitimate | 2 |'); // n=2 perceived turns
  });

  it('never writes the string "sub-second" anywhere, even with the new perceived-latency sections', () => {
    const doc = renderLatencyDoc([run({})], 3);
    expect(doc.toLowerCase()).not.toContain('sub-second');
  });
});
