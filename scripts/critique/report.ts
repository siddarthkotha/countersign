// scripts/critique/report.ts
// Writes one .json + .md report per (model, persona) call, and rolls every result's
// findings up into one ROLLUP.md: dedupe by normalized claim text, count how many distinct
// critics (model+persona pairs) raised each, rank by severity then count, list the
// suggested tests. Plain English, no em-dashes (CLAUDE.md style rule).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CriticResult, RollupRow, Severity } from './types.js';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, important: 1, minor: 2 };

export function safeFileToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function callFileBase(result: CriticResult): string {
  return `${safeFileToken(result.model)}__${safeFileToken(result.persona)}`;
}

function renderCallMarkdown(r: CriticResult): string {
  const lines: string[] = [];
  lines.push(`# Critique: ${r.model_label} x ${r.persona_label}`);
  lines.push('');
  lines.push(`- Provider: ${r.provider}`);
  lines.push(`- Model id: \`${r.model}\``);
  lines.push(`- Persona: ${r.persona}`);
  lines.push(`- Requested at: ${r.requested_at_iso}`);
  lines.push(`- Latency: ${r.latency_ms}ms`);
  lines.push(`- Prompt size: ${r.prompt_char_estimate} chars, ESTIMATE ${r.token_estimate} tokens (method: chars/4)`);
  lines.push(`- Call ok: ${r.ok ? 'yes' : 'no'}`);
  if (r.error) lines.push(`- Error: ${r.error}`);
  if (r.parse_error) lines.push(`- Parse warning: ${r.parse_error} (raw text kept below and in the .json file)`);
  lines.push('');
  if (r.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('| severity | area | claim | suggested test |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of r.findings) {
      lines.push(`| ${f.severity} | ${f.area.replace(/\|/g, '\\|')} | ${f.claim.replace(/\|/g, '\\|')} | ${f.suggested_test.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push('_none returned_');
    lines.push('');
  }
  if (r.prose_verdict) {
    lines.push('## Prose verdict');
    lines.push('');
    lines.push(r.prose_verdict);
    lines.push('');
  }
  if (r.raw_text) {
    lines.push('## Raw response');
    lines.push('');
    lines.push('```');
    lines.push(r.raw_text);
    lines.push('```');
  }
  return lines.join('\n');
}

export async function writeCallReport(dir: string, result: CriticResult): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(dir, { recursive: true });
  const base = callFileBase(result);
  const jsonPath = join(dir, `${base}.json`);
  const mdPath = join(dir, `${base}.md`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
  await writeFile(mdPath, renderCallMarkdown(result), 'utf-8');
  return { jsonPath, mdPath };
}

/** Normalizes a claim for dedupe: lowercase, collapse whitespace, strip trailing
 *  punctuation. Deliberately coarse -- two critics rarely word a claim identically, so this
 *  catches near-duplicates (case, trailing period, extra spaces) without attempting fuzzy
 *  semantic matching, which would need another model call to do honestly. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');
}

export function buildRollup(results: CriticResult[]): RollupRow[] {
  const byClaim = new Map<string, RollupRow>();
  for (const r of results) {
    const raisedById = `${r.model}__${r.persona}`;
    for (const f of r.findings) {
      const key = normalizeClaim(f.claim);
      if (key.length === 0) continue;
      const existing = byClaim.get(key);
      if (!existing) {
        byClaim.set(key, {
          normalized_claim: key,
          severity: f.severity,
          area: f.area,
          claim: f.claim,
          evidence_quote: f.evidence_quote,
          suggested_test: f.suggested_test,
          raised_by: [raisedById],
          count: 1,
        });
      } else {
        if (!existing.raised_by.includes(raisedById)) {
          existing.raised_by.push(raisedById);
          existing.count += 1;
        }
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
          existing.severity = f.severity;
        }
      }
    }
  }
  const rows = [...byClaim.values()];
  rows.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.count - a.count;
  });
  return rows;
}

export function renderRollup(rows: RollupRow[], results: CriticResult[], packetNote: string): string {
  const lines: string[] = [];
  lines.push('# Critique roll-up');
  lines.push('');
  lines.push(`Calls attempted: ${results.length}. Calls that succeeded: ${results.filter((r) => r.ok).length}.`);
  lines.push(`Distinct findings after dedupe: ${rows.length}.`);
  lines.push('');
  lines.push('## Packet');
  lines.push('');
  lines.push(packetNote);
  lines.push('');
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push('## Calls that did not complete');
    lines.push('');
    for (const f of failed) lines.push(`- ${f.model} x ${f.persona}: ${f.error ?? 'unknown error'}`);
    lines.push('');
  }
  lines.push('## Findings, ranked by severity then how many critics raised it');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_no findings returned_');
  } else {
    lines.push('| severity | count | raised by | area | claim | suggested test |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${row.severity} | ${row.count} | ${row.raised_by.join(', ')} | ${row.area.replace(/\|/g, '\\|')} | ${row.claim.replace(/\|/g, '\\|')} | ${row.suggested_test.replace(/\|/g, '\\|')} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeRollup(dir: string, rows: RollupRow[], results: CriticResult[], packetNote: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'ROLLUP.md');
  await writeFile(path, renderRollup(rows, results, packetNote), 'utf-8');
  return path;
}
