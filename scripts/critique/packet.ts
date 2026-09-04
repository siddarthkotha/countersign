// scripts/critique/packet.ts
// Assembles the critique packet from the repo, read-only: README.md, BRIEF.md sections 3,
// 4, 6, 9, 12, the engine's own RULES_DOC (imported, never hand-copied), the AssemblyAI
// integration notes, the newest rehearsal-harness transcripts (if any), and the latest
// rehearsal report. Deterministic priority order; capped at a configurable size with a note
// of exactly what got cut. Never reads .env, node_modules, or anything outside this fixed
// whitelist of repo files -- a critic model only ever sees what this file explicitly opens.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_DOC } from '@countersign/engine';
import type { Packet, PacketSection } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function readRepoFile(relPath: string): string | null {
  const p = join(REPO_ROOT, relPath);
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Extracts one or more numbered "## N. HEADING" sections from BRIEF.md, from each heading
 *  up to (not including) the next "## <digit>." heading at the same level. Order follows
 *  `wantedNumbers`, not the order headings appear in the file, so a caller can name the
 *  priority explicitly. Missing numbers are skipped, not errored -- the brief's numbering
 *  can grow; this packet only ever asks for the sections it names. */
export function extractBriefSections(briefText: string, wantedNumbers: number[]): Map<number, string> {
  const headingRe = /^## (\d+)\.\s.*$/gm;
  const matches: { num: number; start: number; headingLine: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(briefText)) !== null) {
    matches.push({ num: Number(m[1]), start: m.index, headingLine: m[0] });
  }
  const out = new Map<number, string>();
  for (const want of wantedNumbers) {
    const idx = matches.findIndex((x) => x.num === want);
    if (idx === -1) continue;
    const start = matches[idx]!.start;
    const end = idx + 1 < matches.length ? matches[idx + 1]!.start : briefText.length;
    out.set(want, briefText.slice(start, end).trim());
  }
  return out;
}

/** Names the newest N files (by filename, which is a leading ISO-ish timestamp, so
 *  lexicographic order == chronological order -- same convention as
 *  scripts/rehearse/report.ts's reportFileName) under scripts/rehearse/reports/. Returns
 *  [] if the directory doesn't exist or holds nothing yet -- rehearsals are optional
 *  context, not a hard dependency. */
export function newestRehearsalReports(n = 2): { name: string; content: string }[] {
  const dir = join(REPO_ROOT, 'scripts', 'rehearse', 'reports');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, n);
  return files.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf-8') }));
}

/** Defense in depth: the packet only ever reads a fixed whitelist of repo files (never
 *  .env, never node_modules), but this redacts common secret shapes anyway in case a
 *  rehearsal transcript or doc ever quotes one back (e.g. a pasted curl command). Keeps the
 *  key/variable NAME visible (useful context for a critic) and blanks only the value. */
export function redactSecrets(text: string): string {
  let out = text;
  // KEY=value / TOKEN=value / SECRET=value style env lines -- keep the name, drop the value.
  out = out.replace(/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*=\s*)(\S+)/gm, '$1[REDACTED]');
  // Authorization: Bearer <token> headers, in any casing.
  out = out.replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, '$1[REDACTED]');
  // Common vendor key prefixes, wherever they appear (not just after KEY=).
  out = out.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  return out;
}

export interface BuildPacketOptions {
  cap?: number;
  rehearsalReportsToInclude?: number;
}

function section(id: string, label: string, content: string | null, missingNote: string): PacketSection {
  return { id, label, content: content ?? missingNote };
}

/** Builds every candidate section, in the fixed priority order the packet is assembled in.
 *  Exported separately from `buildPacket` so tests can exercise ordering/truncation without
 *  needing real network or a live rehearsal report to exist. */
export function buildSections(opts: BuildPacketOptions = {}): PacketSection[] {
  const sections: PacketSection[] = [];

  const readme = readRepoFile('README.md');
  sections.push(section('readme', 'README.md', readme, '_README.md not found_'));

  const brief = readRepoFile('docs/BRIEF.md');
  if (brief) {
    const wanted = extractBriefSections(brief, [3, 4, 6, 9, 12]);
    for (const num of [3, 4, 6, 9, 12]) {
      const content = wanted.get(num);
      sections.push(section(`brief-${num}`, `docs/BRIEF.md section ${num}`, content ?? null, `_docs/BRIEF.md section ${num} not found (heading may have been renumbered)_`));
    }
  } else {
    sections.push(section('brief-missing', 'docs/BRIEF.md', null, '_docs/BRIEF.md not found_'));
  }

  sections.push(section('rules-doc', "packages/engine/src/rules.ts RULES_DOC (imported, verbatim)", RULES_DOC, '_RULES_DOC import failed_'));

  const aai = readRepoFile('docs/ASSEMBLYAI_INTEGRATION.md');
  sections.push(section('aai-integration', 'docs/ASSEMBLYAI_INTEGRATION.md', aai, '_docs/ASSEMBLYAI_INTEGRATION.md not found_'));

  const reports = newestRehearsalReports(opts.rehearsalReportsToInclude ?? 2);
  if (reports.length === 0) {
    sections.push(section('rehearsal-transcripts', 'scripts/rehearse/reports/ (newest transcripts)', null, '_no rehearsal transcripts found yet under scripts/rehearse/reports/_'));
  } else {
    for (const r of reports) {
      sections.push(section(`rehearsal-${r.name}`, `scripts/rehearse/reports/${r.name}`, r.content, '_unreadable_'));
    }
  }

  const rehearsalReport = readRepoFile('docs/REHEARSAL-REPORT-2026-09-03.md');
  sections.push(section('rehearsal-report-2026-09-03', 'docs/REHEARSAL-REPORT-2026-09-03.md', rehearsalReport, '_docs/REHEARSAL-REPORT-2026-09-03.md not found_'));

  return sections;
}

const SECTION_HEADER = (s: PacketSection) => `\n\n===== ${s.label} [${s.id}] =====\n`;

/** Assembles sections into one capped, redacted packet. First match wins on the character
 *  budget: sections are added in priority order until the cap is reached; the section that
 *  crosses the cap is truncated to fit its remaining budget (not skipped), and everything
 *  after it is cut entirely. The returned `cut_note` always says what happened, even when
 *  nothing was cut, so a reader never has to infer completeness from the byte count alone.
 *  `cap` bounds the section content budget exactly; the inline "...[TRUNCATED: N chars]"
 *  marker on a truncated section and the trailing "PACKET NOTE" summary are metadata added
 *  on top of that budget, not counted against it, so the final `char_count` can run a few
 *  hundred characters past `cap` -- that overhead is bounded (one marker per truncated
 *  section, one summary), never unbounded. */
export function assemblePacket(sections: PacketSection[], cap: number): Packet {
  let used = 0;
  const parts: string[] = [];
  const included: string[] = [];
  const truncatedOrCut: string[] = [];

  for (const s of sections) {
    const header = SECTION_HEADER(s);
    if (used + header.length >= cap) {
      truncatedOrCut.push(s.id);
      continue;
    }
    const budget = cap - used - header.length;
    if (s.content.length <= budget) {
      parts.push(header + s.content);
      used += header.length + s.content.length;
      included.push(s.id);
    } else {
      const kept = s.content.slice(0, budget);
      const cutChars = s.content.length - budget;
      parts.push(`${header}${kept}\n...[TRUNCATED: ${cutChars} more characters of ${s.label} cut to fit the ${cap}-char packet cap]`);
      used = cap;
      truncatedOrCut.push(s.id);
    }
  }

  const cutNote =
    truncatedOrCut.length === 0
      ? `Nothing cut. ${used} of ${cap} chars used across ${included.length} section(s).`
      : `Cap reached: ${used} of ${cap} chars used. Truncated or cut entirely, in this order: ${truncatedOrCut.join(', ')}. Full, uncut: ${included.join(', ') || '(none)'}.`;

  const body = redactSecrets(parts.join(''));
  const text = `${body}\n\n===== PACKET NOTE =====\n${cutNote}\n`;

  return { text, included, truncated: truncatedOrCut, cut_note: cutNote, char_count: text.length, cap };
}

export function buildPacket(opts: BuildPacketOptions = {}): Packet {
  const cap = opts.cap ?? 60_000;
  return assemblePacket(buildSections(opts), cap);
}
