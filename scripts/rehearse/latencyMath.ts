// scripts/rehearse/latencyMath.ts
// Pure computation over one rehearsal run's flight-recorder bundle (the exact
// RehearseDiagnosticBundle shape written by artifacts.ts next to every *.md report -- see
// types.ts's own doc comment for where that shape comes from). No filesystem access here on
// purpose: latencyTable.ts (the CLI) does all the reading; this module only computes, so it
// can be unit-tested against small synthetic bundles with no disk/network at all.
//
// Every number this module returns is either a real subtraction between two events the live
// stack actually emitted (PROVEN, once wired to a real bundle) or `null` (UNKNOWN -- the event
// this column needs is absent from this bundle, e.g. an older run that predates a given event
// kind). Nothing here ever guesses. CLAUDE.md: never write "sub-second"; every number labeled.
import type { RehearseDiagnosticBundle, RehearseDiagnosticEvent } from './types.js';

export type TargetKind = 'local' | 'deployed' | 'unknown';

/** Local = the harness's own default (http://localhost:8787) or any other loopback address;
 *  everything else named on --url is "deployed" (matches run.ts's own local/non-local test,
 *  see run.ts:336). `unknown` only when the url string itself could not be parsed at all. */
export function classifyTarget(url: string | null): TargetKind {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'local';
  return 'deployed';
}

function sortedByTime(events: RehearseDiagnosticEvent[]): RehearseDiagnosticEvent[] {
  return events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t_ms - b.e.t_ms || a.i - b.i).map((x) => x.e);
}

function firstOfKind(events: RehearseDiagnosticEvent[], kind: string): RehearseDiagnosticEvent | null {
  for (const e of events) if (e.kind === kind) return e;
  return null;
}

function detailNumber(detail: unknown, field: string): number | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const v = (detail as Record<string, unknown>)[field];
  return typeof v === 'number' ? v : null;
}

function detailString(detail: unknown, field: string): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const v = (detail as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : null;
}

export interface RunLatencyMetrics {
  /** Column 1: socket connect (`aai_connect_start`) to AssemblyAI ready (`aai_ready`).
   *  Prefers the `aai_ready` event's own `ms_since_connect_start` detail (server's own
   *  measurement) when present; falls back to the two events' t_ms difference. `null` when
   *  either event is absent (an older bundle that predates one of them). */
  connect_to_ready_ms: number | null;
  /** Column 2: ready to the first agent audio (`reply.audio.first` after `aai_ready`). The
   *  row this feeds is labeled "greeting" when `greeting` below is `true`. */
  ready_to_first_audio_ms: number | null;
  /** From `aai_ready`'s own `greeting_configured` detail (founder ruling 2026-09-11, same
   *  field diagnosticsSummary.ts already extracts). `null` on a bundle that predates it. */
  greeting: boolean | null;
  /** Column 3, one entry per caller turn that got a reply: the gap from the LAST
   *  `input.speech.stopped` event before a `reply.audio.first` (falling back to the last
   *  `transcript` event with `detail.role === "user"` when this bundle has no
   *  `input.speech.stopped` events at all) to that `reply.audio.first`. This is the
   *  "response latency" a judge feels turn to turn -- NOT the same number as
   *  ready_to_first_audio_ms, which is the opening greeting/first line only. A caller turn
   *  with no reply before the call ended (or before the next caller turn) contributes
   *  nothing here, same as a rehearsal report's own "no reply audio observed after this
   *  turn" note. */
  turn_response_gaps_ms: number[];
  /** Which signal turn_response_gaps_ms was actually built from, for the report's own "how
   *  was this computed" line. */
  caller_end_source: 'input.speech.stopped' | 'transcript.user' | 'none';
  /** Column 4: connect (`aai_connect_start`, t=0 baseline) to the first `terminal_action`
   *  event (the moment the server actually acted on a verdict) -- `null` when this run never
   *  reached a terminal action (a FAIL run, or a bundle from before this event existed). */
  connect_to_verdict_ms: number | null;
  /** Column 5: that same `terminal_action` to `session_ended`. `null` when either is
   *  missing. */
  verdict_to_end_ms: number | null;
}

/** Builds turn_response_gaps_ms plus which source it used. Exported separately so a test can
 *  exercise the fallback path (a bundle with zero `input.speech.stopped` events) without
 *  having to also fake connect/ready/terminal events. */
export function computeTurnResponseGaps(events: RehearseDiagnosticEvent[]): { gaps_ms: number[]; source: RunLatencyMetrics['caller_end_source'] } {
  const sorted = sortedByTime(events);
  const hasSpeechStopped = sorted.some((e) => e.kind === 'input.speech.stopped');
  const source: RunLatencyMetrics['caller_end_source'] = hasSpeechStopped
    ? 'input.speech.stopped'
    : sorted.some((e) => e.kind === 'transcript' && detailString(e.detail, 'role') === 'user')
      ? 'transcript.user'
      : 'none';
  if (source === 'none') return { gaps_ms: [], source };

  const gaps: number[] = [];
  let pendingStopMs: number | null = null;
  for (const e of sorted) {
    const isCallerEndSignal = source === 'input.speech.stopped' ? e.kind === 'input.speech.stopped' : e.kind === 'transcript' && detailString(e.detail, 'role') === 'user';
    if (isCallerEndSignal) {
      // Always take the LAST caller-end signal seen before the next reply -- when the caller
      // speaks twice in a row before the agent answers (a real pattern in the rehearsal
      // corpus: two consecutive "No, that's wrong" turns), the felt latency is measured from
      // the last thing said, not the first.
      pendingStopMs = e.t_ms;
    } else if (e.kind === 'reply.audio.first') {
      if (pendingStopMs !== null) {
        gaps.push(e.t_ms - pendingStopMs);
        pendingStopMs = null;
      }
      // else: a reply with no pending caller turn (the opening greeting) -- not a turn gap.
    }
  }
  return { gaps_ms: gaps, source };
}

export function computeRunLatencyMetrics(bundle: RehearseDiagnosticBundle): RunLatencyMetrics {
  const events = sortedByTime(bundle.server_events);

  const connectEvent = firstOfKind(events, 'aai_connect_start');
  const readyEvent = firstOfKind(events, 'aai_ready');
  const connectMs = connectEvent?.t_ms ?? null;
  const readyMs = readyEvent?.t_ms ?? null;

  let connectToReadyMs: number | null = null;
  if (readyEvent) {
    const fromDetail = detailNumber(readyEvent.detail, 'ms_since_connect_start');
    if (fromDetail !== null) connectToReadyMs = fromDetail;
    else if (connectMs !== null) connectToReadyMs = readyMs! - connectMs;
  }

  const greeting = readyEvent ? detailBool(readyEvent.detail, 'greeting_configured') : null;

  let readyToFirstAudioMs: number | null = null;
  if (readyMs !== null) {
    const firstReply = events.find((e) => e.kind === 'reply.audio.first' && e.t_ms >= readyMs);
    if (firstReply) readyToFirstAudioMs = firstReply.t_ms - readyMs;
  }

  const { gaps_ms, source } = computeTurnResponseGaps(events);

  const terminalEvent = firstOfKind(events, 'terminal_action');
  let connectToVerdictMs: number | null = null;
  if (terminalEvent && connectMs !== null) connectToVerdictMs = terminalEvent.t_ms - connectMs;

  const endedEvent = firstOfKind(events, 'session_ended');
  let verdictToEndMs: number | null = null;
  if (terminalEvent && endedEvent) verdictToEndMs = endedEvent.t_ms - terminalEvent.t_ms;

  return {
    connect_to_ready_ms: connectToReadyMs,
    ready_to_first_audio_ms: readyToFirstAudioMs,
    greeting,
    turn_response_gaps_ms: gaps_ms,
    caller_end_source: source,
    connect_to_verdict_ms: connectToVerdictMs,
    verdict_to_end_ms: verdictToEndMs,
  };
}

function detailBool(detail: unknown, field: string): boolean | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const v = (detail as Record<string, unknown>)[field];
  return typeof v === 'boolean' ? v : null;
}

export interface ParsedPerTurnGaps {
  /** One entry per turn whose gap was a real number (not "n/a"), in table order. */
  gaps_ms: number[];
  /** How many turns in the table had gap "n/a" (the call ended, or the next turn started,
   *  before any reply audio was observed) -- excluded from `gaps_ms` but counted here, per
   *  the review finding: a turn that never got a reply must not silently vanish from `n`. */
  na_count: number;
  /** gaps_ms.length + na_count -- every turn row this parser recognized in the table. */
  total_turns: number;
}

const MD_MS_OR_NA = /^(?:([\d.]+)ms|n\/a)$/;

/** Parses the "Per-turn gaps (caller line end -> next agent audio)" table report.ts's own
 *  `renderTurnGaps` writes into every run's markdown report (`| turn | caller ended | first
 *  reply audio | gap | note |`). This is the harness's OWN wall-clock measurement -- the
 *  moment the synthetic caller finished streaming a line's audio, to the moment the agent's
 *  first reply audio frame arrived, both timestamped on the SAME client-side clock
 *  (turnController.ts/wsClient.ts, relative to the WebSocket handshake).
 *
 *  Review finding (2026-09-11, fixing 278d82b): this is NOT the same number as
 *  `computeTurnResponseGaps`'s `input.speech.stopped -> reply.audio.first` gap over the
 *  server's diagnostics event stream. Checked directly against
 *  2026-09-11T17-44-51-scenario-a-dana-legitimate's raw bundle: for turn c4, the server's own
 *  `reply.started` (t=54569ms) fires BEFORE `input.speech.stopped` (t=54572ms) -- proof that
 *  `input.speech.stopped` carries AssemblyAI's own end-of-turn detection lag and can even
 *  race with the reply already starting, making it a server/relay artifact, not the gap a
 *  judge actually perceives. This table's "caller ended" timestamp is the harness's own
 *  authoritative "the caller stopped talking" instant (when it stopped streaming audio into
 *  the socket), which is the honest number.
 *
 *  Deliberately structural rather than heading-anchored: matches any markdown table row shaped
 *  like `| <turn id> | <ms|n/a> | <ms|n/a> | <ms|n/a> | ... |`, which only this table produces
 *  in a rehearsal report (the transcript table has 3 columns of non-ms text, the caller-line-
 *  decisions table has 4 columns of text, the state-history table has state/verdict text) --
 *  so it does not depend on the exact heading text or table position, only the table's shape.
 *  A malformed/missing table (or no `.md` at all) returns all-zero, never throws. */
export function parsePerTurnGapsFromMd(mdText: string): ParsedPerTurnGaps {
  const gaps_ms: number[] = [];
  let na_count = 0;

  for (const rawLine of mdText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 4) continue;

    const [turnId, callerEnded, firstReplyAudio, gap] = cells;
    if (!turnId || turnId === 'turn' || /^-+$/.test(turnId)) continue; // header or separator row
    if (!callerEnded || !MD_MS_OR_NA.test(callerEnded)) continue;
    if (!firstReplyAudio || !MD_MS_OR_NA.test(firstReplyAudio)) continue;
    if (!gap || !MD_MS_OR_NA.test(gap)) continue;

    if (gap === 'n/a') {
      na_count += 1;
      continue;
    }
    const match = MD_MS_OR_NA.exec(gap);
    gaps_ms.push(Number(match![1]));
  }

  return { gaps_ms, na_count, total_turns: gaps_ms.length + na_count };
}

/** Linear-interpolation percentile (the numpy/R-7 default) over a sample of numbers.
 *  `null` on an empty sample -- callers must show "n=0, UNKNOWN" rather than a fabricated
 *  number. `p` is 0..1 (0.5 for p50, 0.95 for p95). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}
