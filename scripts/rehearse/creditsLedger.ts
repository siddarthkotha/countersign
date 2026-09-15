#!/usr/bin/env -S npx tsx
// scripts/rehearse/creditsLedger.ts
// `npm run credits:ledger` -- reads EVERY *.diagnostics.json bundle under
// scripts/rehearse/reports/ (gitignored; not part of this repo's tracked history, see
// docs/REHEARSAL-HARNESS.md's "what is not committed"), sums billed seconds per calendar day
// (falling back to wall clock when billed_seconds is absent, labeled as ESTIMATE), and prints
// a table showing: day, calls, billed minutes, cost at $4.50/h, method (PROVEN vs ESTIMATE).
// Also reads docs/CREDITS.md for founder dashboard readings and prints a reconciliation line.
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
  hoursUsed: number;
  dollarsRemaining: number;
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

        if (timestamp && !isNaN(hoursNum) && !isNaN(dollarsNum)) {
          readings.push({
            timestamp,
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
  // Read all diagnostics bundles
  const files = await readdir(REPORTS_DIR);
  const diagnosticsFiles = files.filter((f) => f.endsWith('.diagnostics.json'));

  const dailyMap = new Map<string, DailyRecord>();
  let totalProvenSeconds = 0;
  let totalEstimateSeconds = 0;

  for (const file of diagnosticsFiles) {
    try {
      const content = await readFile(join(REPORTS_DIR, file), 'utf-8');
      const bundle: DiagnosticBundle = JSON.parse(content);

      if (!bundle.started_at || !bundle.ended_at) continue;

      // Extract day from started_at (epoch ms)
      const date = new Date(bundle.started_at);
      const dayKey = date.toISOString().split('T')[0]!;

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
  console.log('\nCredit Ledger\n');
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

    const dashboardHoursDiff = last.hoursUsed - first.hoursUsed;
    const dashboardDollarsDiff = first.dollarsRemaining - last.dollarsRemaining;
    const impliedDollarPerHour = dashboardHoursDiff > 0 ? dashboardDollarsDiff / dashboardHoursDiff : 0;

    console.log('Reconciliation with Founder Dashboard\n');
    console.log(`First reading:  ${first.timestamp} (${first.hoursUsed}h used, $${first.dollarsRemaining} remaining)`);
    console.log(`Last reading:   ${last.timestamp} (${last.hoursUsed}h used, $${last.dollarsRemaining} remaining)`);
    console.log('');
    console.log(`Dashboard moved: ${dashboardHoursDiff.toFixed(2)}h (avg $${impliedDollarPerHour.toFixed(2)}/h)`);
    console.log(`Ledger billed:   ${(totalProvenSeconds / 3600).toFixed(2)}h PROVEN`);
    if (totalEstimateSeconds > 0) {
      console.log(`                 ${(totalEstimateSeconds / 3600).toFixed(2)}h ESTIMATE (wall clock)`);
      console.log(`                 ${((totalProvenSeconds + totalEstimateSeconds) / 3600).toFixed(2)}h total`);
    }
    console.log('');
  } else {
    console.log('No founder dashboard readings found in docs/CREDITS.md\n');
  }
}

main().catch((err) => {
  console.error('creditsLedger error:', err);
  process.exit(1);
});
