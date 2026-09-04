#!/usr/bin/env -S npx tsx
// scripts/critique/run.ts
// Entry point: `npx tsx scripts/critique/run.ts [--dry-run] [--models id1,id2,...]
//   [--personas id1,id2,...] [--cap N] [--max-calls N] [--timeout-ms N] [--config PATH]`
//
// Fans a critique packet (README, brief sections, the engine's own rule table, the
// AssemblyAI integration notes, real rehearsal transcripts) out to every persona x every
// configured model, via OpenRouter (OPENROUTER_API_KEY) or direct Gemini (GEMINI_API_KEY)
// for "gemini/..." ids. This is a TEST/REVIEW HARNESS (BRIEF LAW 5 scope fence): never
// imported by product code, never claims voice/deepfake detection (LAW 1 -- see
// personaLoader.ts's OUTPUT_SHAPE_SUFFIX). See docs/CRITIQUE-LOOP.md for the full loop.
//
// No API keys exist on this machine as of 2026-09-03 (PROVEN: .env holds only the
// AssemblyAI key). Use --dry-run to build the packet and every prompt, write them to the
// report dir, and exit 0 with no network call at all -- that is how this harness is
// verified tonight, before OPENROUTER_API_KEY / GEMINI_API_KEY exist.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPacket } from './packet.js';
import { loadAllPersonas, listPersonaIds, loadPersona } from './personaLoader.js';
import { loadConfig, parseModelsArg, DEFAULT_CONFIG_PATH } from './config.js';
import { providerFor, apiKeyEnvVar } from './providers/index.js';
import { SpendGuard, tokenEstimate } from './spendGuard.js';
import { parseCriticOutput } from './parseOutput.js';
import { writeCallReport, writeRollup, buildRollup } from './report.js';
import type { CriticResult, ModelConfig, Persona } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, 'reports');

interface CliArgs {
  dryRun: boolean;
  models?: string;
  personas?: string;
  cap?: number;
  maxCalls?: number;
  timeoutMs?: number;
  configPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, configPath: DEFAULT_CONFIG_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--models') {
      const v = argv[++i];
      if (v !== undefined) args.models = v;
    } else if (a === '--personas') {
      const v = argv[++i];
      if (v !== undefined) args.personas = v;
    }
    else if (a === '--cap') args.cap = Number(argv[++i]);
    else if (a === '--max-calls') args.maxCalls = Number(argv[++i]);
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--config') args.configPath = argv[++i] ?? args.configPath;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`critique: unrecognized argument "${a}" (--help for usage)`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      'Countersign critique loop -- fans out a design packet to external critic models.',
      '',
      'Usage: npx tsx scripts/critique/run.ts [--dry-run] [--models id1,id2] [--personas id1,id2]',
      '         [--cap N] [--max-calls N] [--timeout-ms N] [--config PATH]',
      '',
      '  --dry-run        build the packet and every prompt, write them to the report dir, make',
      '                   NO network call, exit 0. Use this until OPENROUTER_API_KEY / GEMINI_API_KEY exist.',
      '  --models         comma list of model ids, overriding critique.config.json for this run.',
      '                   "gemini/<name>" routes to the direct Gemini API; anything else routes to OpenRouter.',
      '  --personas       comma list of persona ids under scripts/critique/personas/ (default: all).',
      '  --cap N          packet size cap in characters (default from critique.config.json, 60000).',
      '  --max-calls N    spend guard: max provider calls this run will make (default 20).',
      '  --timeout-ms N   per-call request timeout (default from critique.config.json, 30000).',
      '  --config PATH    path to a critique.config.json to use instead of the default.',
      '',
      'Exit codes: 0 every attempted call completed (or --dry-run); 1 at least one call errored; 2 a setup error (bad args, unreadable packet).',
    ].join('\n'),
  );
}

function timestampDirName(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function callOne(model: ModelConfig, persona: Persona, userPrompt: string, timeoutMs: number): Promise<CriticResult> {
  const provider = providerFor(model.id);
  const envVar = apiKeyEnvVar(provider);
  const apiKey = process.env[envVar];
  const requestedAtIso = new Date().toISOString();
  const promptCharEstimate = userPrompt.length;
  const tokenEst = tokenEstimate(userPrompt);

  if (!apiKey) {
    return {
      provider: 'skipped',
      model: model.id,
      model_label: model.label,
      persona: persona.id,
      persona_label: persona.label,
      ok: false,
      error: `skipped: ${envVar} is not set`,
      findings: [],
      requested_at_iso: requestedAtIso,
      latency_ms: 0,
      prompt_char_estimate: promptCharEstimate,
      token_estimate: tokenEst,
    };
  }

  const started = performance.now();
  try {
    const res = await provider.call(
      { model: model.id, systemPrompt: 'You are a rigorous, adversarial reviewer. Follow the persona and output shape exactly.', userPrompt },
      { apiKey, timeoutMs },
    );
    const latency = Math.round(performance.now() - started);
    const parsed = parseCriticOutput(res.text);
    return {
      provider: provider.name,
      model: model.id,
      model_label: model.label,
      persona: persona.id,
      persona_label: persona.label,
      ok: true,
      raw_text: res.text,
      findings: parsed.findings,
      ...(parsed.prose_verdict !== undefined ? { prose_verdict: parsed.prose_verdict } : {}),
      ...(parsed.parse_error !== undefined ? { parse_error: parsed.parse_error } : {}),
      requested_at_iso: requestedAtIso,
      latency_ms: latency,
      prompt_char_estimate: promptCharEstimate,
      token_estimate: tokenEst,
    };
  } catch (err) {
    const latency = Math.round(performance.now() - started);
    return {
      provider: provider.name,
      model: model.id,
      model_label: model.label,
      persona: persona.id,
      persona_label: persona.label,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      findings: [],
      requested_at_iso: requestedAtIso,
      latency_ms: latency,
      prompt_char_estimate: promptCharEstimate,
      token_estimate: tokenEst,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);

  const cap = args.cap && args.cap > 0 ? args.cap : config.packet_cap_chars;
  const maxCalls = args.maxCalls && args.maxCalls > 0 ? args.maxCalls : config.max_calls;
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : config.request_timeout_ms;
  const models: ModelConfig[] = args.models ? parseModelsArg(args.models) : config.models;

  const personaIds = args.personas ? args.personas.split(',').map((s) => s.trim()).filter(Boolean) : listPersonaIds();
  let personas: Persona[];
  try {
    personas = args.personas ? personaIds.map((id) => loadPersona(id)) : loadAllPersonas();
  } catch (err) {
    console.error(`critique: could not load personas: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let packet;
  try {
    packet = buildPacket({ cap });
  } catch (err) {
    console.error(`critique: could not build the packet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  console.log(`critique: packet built. ${packet.char_count} chars (cap ${packet.cap}). ${packet.cut_note}`);
  console.log(`critique: ${personas.length} persona(s) x ${models.length} model(s) = ${personas.length * models.length} combo(s) planned. max-calls guard = ${maxCalls}.`);

  const runDir = join(REPORTS_DIR, timestampDirName());
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'PACKET.txt'), packet.text, 'utf-8');

  const combos: { model: ModelConfig; persona: Persona }[] = [];
  for (const persona of personas) for (const model of models) combos.push({ model, persona });

  if (args.dryRun) {
    for (const { model, persona } of combos) {
      const userPrompt = `${persona.prompt}\n\n===== DESIGN PACKET =====\n${packet.text}`;
      const base = `${model.id.replace(/[^a-zA-Z0-9_.-]+/g, '-')}__${persona.id}`;
      await writeFile(join(runDir, `${base}.prompt.txt`), userPrompt, 'utf-8');
      console.log(`[critique] dry-run wrote prompt for ${model.id} x ${persona.id} (${userPrompt.length} chars, ESTIMATE ${tokenEstimate(userPrompt)} tokens)`);
    }
    console.log(`critique: dry-run complete. No network call made. Prompts and packet written under ${runDir}`);
    process.exitCode = 0;
    return;
  }

  const guard = new SpendGuard(maxCalls);
  const results: CriticResult[] = [];

  for (const { model, persona } of combos) {
    const userPrompt = `${persona.prompt}\n\n===== DESIGN PACKET =====\n${packet.text}`;
    const label = `${model.id} x ${persona.id}`;
    if (!guard.canSpend()) {
      console.log(`[critique] skipped ${label}: max-calls guard (${maxCalls}) reached`);
      results.push({
        provider: 'skipped',
        model: model.id,
        model_label: model.label,
        persona: persona.id,
        persona_label: persona.label,
        ok: false,
        error: `skipped: max-calls guard (${maxCalls}) reached before this call`,
        findings: [],
        requested_at_iso: new Date().toISOString(),
        latency_ms: 0,
        prompt_char_estimate: userPrompt.length,
        token_estimate: tokenEstimate(userPrompt),
      });
      continue;
    }
    guard.spend(label, userPrompt);
    const result = await callOne(model, persona, userPrompt, timeoutMs);
    results.push(result);
    await writeCallReport(runDir, result);
    console.log(`[critique] ${result.ok ? 'ok' : 'FAIL'} ${label} latency=${result.latency_ms}ms findings=${result.findings.length}${result.error ? ` error=${result.error}` : ''}`);
  }

  const rows = buildRollup(results);
  const rollupPath = await writeRollup(runDir, rows, results, packet.cut_note);
  console.log(`critique: ${results.length} call(s) attempted, ${results.filter((r) => r.ok).length} ok. ${rows.length} distinct finding(s) after dedupe.`);
  console.log(`critique: roll-up written to ${rollupPath}`);

  const anyFailed = results.some((r) => !r.ok);
  process.exitCode = anyFailed ? 1 : 0;
}

void main();
