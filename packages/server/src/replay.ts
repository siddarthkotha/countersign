// packages/server/src/replay.ts
// Turns a corpus file into a timed ServerEvent stream that looks exactly like a live call
// (BRIEF D4, replay-first): same `evaluate` call, same `deriveScreenState` call as
// `call/session.ts` uses, so a replay and a live run of the same scenario render
// identically save for `link: 'replay'`. No AAI socket, no audio -- ws/browser.ts's
// `/ws/replay/:file` route drives this directly against a corpus file on disk, whitelisted
// by directory listing so a path-traversal attempt can never escape the corpus directory.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { AgentAction, CorpusFile, EngineInput, ServerEvent, ToolLogEntry, Utterance } from '@countersign/engine';
import { deriveScreenState } from './screen/state.js';

/** packages/server/src/replay.ts -> packages/engine/corpus (siblings under packages/). */
export function defaultCorpusDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../engine/corpus');
}

/** The whitelist: only files that actually exist in the corpus directory can be served.
 *  A traversal attempt (`..`, an absolute path, a name AAI/URL-encoding tricks into
 *  something that isn't a plain filename) can never appear in this set, so it is rejected
 *  by the same lookup used for every legitimate request -- no separate "is this safe"
 *  check to forget. */
export function listCorpusFiles(corpusDir: string): Set<string> {
  return new Set(
    readdirSync(corpusDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length)),
  );
}

export function loadCorpusFile(corpusDir: string, name: string): CorpusFile | null {
  if (typeof name !== 'string' || name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return null;
  }
  const files = listCorpusFiles(corpusDir);
  if (!files.has(name)) return null;
  const raw = readFileSync(path.join(corpusDir, `${name}.json`), 'utf-8');
  return JSON.parse(raw) as CorpusFile;
}

type CallLogs = { conversation: Utterance[]; tools: ToolLogEntry[]; actions: AgentAction[] };

interface TimedLogEvent {
  t_ms: number;
  apply: (logs: CallLogs) => void;
}

function buildTimeline(corpus: CorpusFile): TimedLogEvent[] {
  const events: TimedLogEvent[] = [
    ...corpus.conversation.map((u) => ({ t_ms: u.t_ms, apply: (logs: CallLogs) => logs.conversation.push(u) })),
    ...corpus.tools.map((t) => ({ t_ms: t.t_ms, apply: (logs: CallLogs) => logs.tools.push(t) })),
    ...corpus.actions.map((a) => ({ t_ms: a.t_ms, apply: (logs: CallLogs) => logs.actions.push(a) })),
  ];
  events.sort((a, b) => a.t_ms - b.t_ms);
  return events;
}

export interface RunReplayOpts {
  session_id: string;
  speed: number;
  send: (e: ServerEvent) => void;
  sleep: (ms: number) => Promise<void>;
}

/** Replays `corpus`'s conversation/tools/actions in t_ms order, waiting `sleep` between
 *  events for real delays scaled by `speed` (2 = twice as fast), running `evaluate` and
 *  `deriveScreenState` after each -- exactly the sequence a live call produces, just fed
 *  from a file instead of an AAI socket. */
export async function runReplay(corpus: CorpusFile, opts: RunReplayOpts): Promise<void> {
  const logs: CallLogs = { conversation: [], tools: [], actions: [] };
  const timeline = buildTimeline(corpus);
  const safeSpeed = Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
  let lastT = 0;

  for (const evt of timeline) {
    const waitMs = Math.max(0, evt.t_ms - lastT) / safeSpeed;
    if (waitMs > 0) await opts.sleep(waitMs);
    lastT = evt.t_ms;
    evt.apply(logs);

    // Corpus files don't carry their own SeedConfig (there is only one synthetic world,
    // MERIDIAN); when a second seed ever exists this is the one place a replay needs to
    // learn which one a given corpus file was recorded against.
    const engineInput: EngineInput = {
      conversation: logs.conversation,
      tools: logs.tools,
      actions: logs.actions,
      call: corpus.call,
      seed: MERIDIAN,
    };
    const output = evaluate(engineInput);
    const state = deriveScreenState({
      session_id: opts.session_id,
      t_ms: evt.t_ms,
      engineInput,
      output,
      speaking: false,
      export_hash: null,
      recomputed: false,
      link: 'replay',
    });
    opts.send({ type: 'state', state });
  }
}
