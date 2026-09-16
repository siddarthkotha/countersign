#!/usr/bin/env -S npx tsx
// scripts/rehearse/creditsLedger.ts
// `npm run credits:ledger` -- reads EVERY *.diagnostics.json bundle under
// scripts/rehearse/reports/ (gitignored; not part of this repo's tracked history, see
// docs/REHEARSAL-HARNESS.md's "what is not committed"), sums billed seconds per calendar day
// in America/Chicago timezone (falling back to wall clock when billed_seconds is absent,
// labeled as ESTIMATE), and prints a table showing: day, calls, billed minutes, cost at $4.50/h,
// method (PROVEN vs ESTIMATE). Also reads docs/CREDITS.md for founder dashboard readings
// (parsed as America/Chicago time, handling CDT/CST timezone) and prints a reconciliation line
// with bundle count and UTC bounds.
//
// This is read-only against the reports directory (never writes a report, never touches a
// server, never calls the live API -- BRIEF LAW 5 scope fence) and pure math otherwise.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, 'reports');
const CREDITS_PATH = join(HERE, '..', '..', 'docs', 'CREDITS.md');

const RATE_PER_HOUR = 4.50;
const CHICAGO_TZ = 'America/Chicago';

interface DiagnosticBundle {
  started_at: number;
  ended_at: number | null;
  billed_seconds?: number;
}

interface DailyRecord {
  day: string;
  calls: number;
  billedSeconds: number;
  provenSeconds: number;
  estimateSeconds: number;
}

interface FounderReading {
  timestamp: string;
  timestampMs: number; // UTC milliseconds
  hoursUsed: number;
  dollarsRemaining: number;
}

/** Parse a Chicago-time timestamp like "2026-09-14 5:34 PM CDT" to UTC milliseconds.
 *  Handles CDT (UTC-5) and CST (UTC-6) suffixes. */
function parseChicagoTimestamp(str: string): number | null {
  // Pattern: YYYY-MM-DD H:MM AM/PM CDT/CST
  const match = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+(CDT|CST)/.exec(str);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minStr, ampm, tzSuffix] = match;
  let hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);

  // Convert to 24-hour format
  if (ampm === 'AM' && hour === 12) hour = 0;
  if (ampm === 'PM' && hour !== 12) hour += 12;

  // Create a date in UTC, but interpret it as if it's Chicago time first
  // Then apply the offset correction
  const utcDate = new Date(Date.UTC(
    parseInt(yearStr, 10),
    parseInt(monthStr, 10) - 1,
    parseInt(dayStr, 10),
    hour,
    min,
    0
  ));

  // CDT is UTC-5, CST is UTC-6, so we need to ADD those hours to convert Chicago->UTC
  const offsetHours = tzSuffix === 'CDT' ? 5 : 6;
  const utcMs = utcDate.getTime() + offsetHours * 60 * 60 * 1000;

  return utcMs;
}

/** Format UTC timestamp as local Chicago time string (for display) */
function formatChicagoTime(utcMs: number): string {
  const date = new Date(utcMs);
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: CHICAGO_TZ,
    hour12: false,
  }).format(date);
}

/** Get the Chicago calendar day for a UTC timestamp (e.g., "2026-09-14") */
function getChicagoDayKey(utcMs: number): string {
  const date = new Date(utcMs);
  // Swedish locale (sv) produces YYYY-MM-DD format directly
  const formatted = new Intl.DateTimeFormat('sv', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: CHICAGO_TZ,
  }).format(date);

  return formatted;
}

async function parseCreditsFile(): Promise<FounderReading[]> {
  try {
    const content = await readFile(CREDITS_PATH, 'utf-8');
    const lines = content.split('\n');
    const readings: FounderReading[] = [];

    // Parse founder dashboard readings from the table
    // Expected format: | 2026-09-14 5:34 PM CDT | 2.9 | $86.92 |
    for (const line of lines) {
      // Skip header and separator lines
      if (line.includes('Timestamp') || line.includes('---') || !line.includes('|')) continue;

      // Split by pipe and extract fields (trim spaces from each)
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length >= 4) {
        // Format: [ '', timestamp, hours, dollars, '' ]
        const timestamp = parts[1];
        const hoursNum = parseFloat(parts[2]!);
        const dollarStr = parts[3]!.replace('$', '');
        const dollarsNum = parseFloat(dollarStr);

        const timestampMs = parseChicagoTimestamp(timestamp || '');
        if (timestamp && !isNaN(hoursNum) && !isNaN(dollarsNum) && timestampMs !== null) {
          readings.push({
            timestamp,
            timestampMs,
            hoursUsed: hoursNum,
            dollarsRemaining: dollarsNum,
          });
        }
      }
    }

    return readings;
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  // Parse command-line arguments
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');

  // Read all diagnostics bundles
  let files: string[] = [];
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    // Reports directory doesn't exist or can't be read
    console.log('No reports directory found. Run rehearsals first to generate diagnostics bundles.\n');
    return;
  }
  const diagnosticsFiles = files.filter((f) => f.endsWith('.diagnostics.json'));

  const dailyMap = new Map<string, DailyRecord>();
  let totalProvenSeconds = 0;
  let totalEstimateSeconds = 0;

  // Cache all parsed bundles to avoid re-reading from disk
  const bundlesCache: DiagnosticBundle[] = [];

  for (const file of diagnosticsFiles) {
    try {
      const content = await readFile(join(REPORTS_DIR, file), 'utf-8');
      const bundle: DiagnosticBundle = JSON.parse(content);

      if (!bundle.started_at || !bundle.ended_at) continue;

      // Store in cache for later window analysis
      bundlesCache.push(bundle);

      // Extract day using Chicago timezone
      const dayKey = getChicagoDayKey(bundle.started_at);

      // Get or create daily record
      let record = dailyMap.get(dayKey);
      if (!record) {
        record = { day: dayKey, calls: 0, billedSeconds: 0, provenSeconds: 0, estimateSeconds: 0 };
        dailyMap.set(dayKey, record);
      }

      record.calls += 1;

      // Use billed_seconds if available, otherwise estimate from wall clock
      if (bundle.billed_seconds !== undefined && typeof bundle.billed_seconds === 'number') {
        record.billedSeconds += bundle.billed_seconds;
        record.provenSeconds += bundle.billed_seconds;
        totalProvenSeconds += bundle.billed_seconds;
      } else {
        const estimatedSeconds = (bundle.ended_at - bundle.started_at) / 1000;
        record.billedSeconds += estimatedSeconds;
        record.estimateSeconds += estimatedSeconds;
        totalEstimateSeconds += estimatedSeconds;
      }
    } catch {
      // Silently skip malformed bundles
    }
  }

  // Sort by day
  const sortedDays = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // Print table
  console.log('\nCredit Ledger (America/Chicago timezone)\n');
  console.log('| Day        | Calls | Billed Minutes | Cost ($) | Method          |');
  console.log('|:-----------|------:|---------------:|---------:|:----------------|');

  let runningTotalMinutes = 0;
  let runningTotalCost = 0;

  for (const record of sortedDays) {
    const minutes = record.billedSeconds / 60;
    const cost = (record.billedSeconds / 3600) * RATE_PER_HOUR;
    const method =
      record.estimateSeconds > 0
        ? record.provenSeconds > 0
          ? `MIXED (${record.provenSeconds}s proven + ${record.estimateSeconds}s estimated)`
          : 'ESTIMATE (wall clock)'
        : 'PROVEN (termination event)';

    console.log(`| ${record.day} | ${record.calls} | ${minutes.toFixed(1)} | $${cost.toFixed(2)} | ${method} |`);

    runningTotalMinutes += minutes;
    runningTotalCost += cost;
  }

  console.log('|:-----------|------:|---------------:|---------:|:----------------|');
  console.log(
    `| **TOTAL** | **${Array.from(dailyMap.values()).reduce((sum, r) => sum + r.calls, 0)}** | **${runningTotalMinutes.toFixed(1)}** | **$${runningTotalCost.toFixed(2)}** | |`
  );
  console.log('');

  // Read founder dashboard readings
  const readings = await parseCreditsFile();
  if (readings.length >= 2) {
    const first = readings[0]!;
    const last = readings[readings.length - 1]!;

    // Collect bundles that started within the reading window using cached bundles
    const bundlesInWindow: DiagnosticBundle[] = [];
    for (const bundle of bundlesCache) {
      // Bundle's start time must be between first and last reading (in UTC)
      if (bundle.started_at >= first.timestampMs && bundle.started_at <= last.timestampMs) {
        bundlesInWindow.push(bundle);
      }
    }

    // Calculate seconds for ONLY the bundles in the window
    let windowProvenSeconds = 0;
    let windowEstimateSeconds = 0;
    for (const bundle of bundlesInWindow) {
      if (bundle.billed_seconds !== undefined && typeof bundle.billed_seconds === 'number') {
        windowProvenSeconds += bundle.billed_seconds;
      } else {
        const estimatedSeconds = (bundle.ended_at! - bundle.started_at) / 1000;
        windowEstimateSeconds += estimatedSeconds;
      }
    }

    if (verbose) {
      console.log('\nIn-window bundles:');
      for (const bundle of bundlesInWindow) {
        const duration = bundle.billed_seconds ?? (bundle.ended_at! - bundle.started_at) / 1000;
        const minutes = (duration / 60).toFixed(1);
        const method = bundle.billed_seconds !== undefined ? 'PROVEN' : 'ESTIMATE';
        console.log(`  ${bundle.session_id}: ${minutes}m (${method})`);
      }
      console.log('');
    }

    const dashboardHoursDiff = last.hoursUsed - first.hoursUsed;
    const dashboardDollarsDiff = first.dollarsRemaining - last.dollarsRemaining;
    const impliedDollarPerHour = dashboardHoursDiff > 0 ? dashboardDollarsDiff / dashboardHoursDiff : 0;

    const windowStartChicago = formatChicagoTime(first.timestampMs);
    const windowEndChicago = formatChicagoTime(last.timestampMs);

    console.log('Reconciliation with Founder Dashboard\n');
    console.log(`First reading:  ${first.timestamp} (${first.hoursUsed}h used, $${first.dollarsRemaining} remaining)`);
    console.log(`Last reading:   ${last.timestamp} (${last.hoursUsed}h used, $${last.dollarsRemaining} remaining)`);
    console.log('');
    console.log(`Window (UTC):   ${first.timestampMs} to ${last.timestampMs} (${bundlesInWindow.length} bundles in window)`);
    console.log(`Window (Chicago): ${windowStartChicago} to ${windowEndChicago}`);
    console.log('');
    console.log(`Dashboard moved: ${dashboardHoursDiff.toFixed(2)}h (avg $${impliedDollarPerHour.toFixed(2)}/h)`);
    console.log(`Ledger billed:   ${(windowProvenSeconds / 3600).toFixed(2)}h PROVEN`);
    if (windowEstimateSeconds > 0) {
      console.log(`                 ${(windowEstimateSeconds / 3600).toFixed(2)}h ESTIMATE (wall clock)`);
      console.log(`                 ${((windowProvenSeconds + windowEstimateSeconds) / 3600).toFixed(2)}h total`);
    }
    console.log('');
  } else {
    console.log('No founder dashboard readings found in docs/CREDITS.md\n');
  }

  console.log(
    'PROVEN rows appear once deploys after 2026-09-14 record the session.ended event; every row before that is wall clock.'
  );
  console.log('');
}

main().catch((err) => {
  console.error('creditsLedger error:', err);
  process.exit(1);
});
