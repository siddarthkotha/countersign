# The critique loop

Plain-English explanation of `scripts/critique/`, the tool that stress-tests Countersign's
design by putting it in front of several outside AI models and asking each one to break it.
Nothing in this tool ships in the product; it never touches `packages/`.

## What it does

1. It builds a "packet": README.md, five sections of the build brief (product definition,
   demo scripts, architecture, scope fence, risk register), the engine's own deterministic
   rule table (imported from the real code, never retyped by hand), the AssemblyAI
   integration notes, the newest rehearsal-harness transcripts if any exist, and the latest
   rehearsal report. It caps this packet at a size limit (60,000 characters by default) so
   it fits in one message to a model, and it always says exactly what got left out if
   anything did.
2. It hands that packet to five different "critic personas" — a social engineer trying to
   talk the checkpoint into staging or releasing a wire, a security architect looking for
   ways the AI layer could sneak influence into the verdict, a hackathon judge scoring the
   real rubric, a skeptical bank treasury operator asking what breaks in production, and an
   accessibility reviewer checking colour and plain-language clarity.
3. It sends each persona to each configured outside model (ChatGPT, Grok, Perplexity, and
   Gemini by default) and asks for a list of findings plus a short verdict.
4. It writes every answer to a file, then rolls all the answers up into one file
   (`ROLLUP.md`) that groups the same complaint raised by more than one critic, ranks
   everything by how serious it is and how many critics raised it, and lists a concrete test
   for each one.

## The exact commands

Everything runs with `npx tsx`, the same way this repo already runs `scripts/rehearse/`.
Nothing here is wired into `npm test` or `package.json` — running it is always an explicit,
separate step.

**Tonight, before any API keys exist** — build the packet and every prompt, write them to
disk, make no network call, and prove the tool works:

```
npx tsx scripts/critique/run.ts --dry-run
```

This writes a timestamped folder under `scripts/critique/reports/` containing `PACKET.txt`
(the assembled packet) and one `<model>__<persona>.prompt.txt` file per combination — the
exact text that would be sent, so you can read it yourself before it ever goes anywhere.

**Once `OPENROUTER_API_KEY` and/or `GEMINI_API_KEY` are in `.env`** — run the real thing:

```
npx tsx scripts/critique/run.ts
```

Useful flags (all optional):

- `--models "openai/gpt-4o,x-ai/grok-2"` — run only these models instead of the config
  file's default list. A `gemini/...` id (e.g. `gemini/gemini-1.5-pro`) always goes straight
  to Google's API with `GEMINI_API_KEY`; every other id goes to OpenRouter with
  `OPENROUTER_API_KEY`.
- `--personas "social-engineer,security-architect"` — run only these personas instead of all
  five.
- `--cap 40000` — a smaller or larger packet size limit for this run.
- `--max-calls 8` — the spend guard (see below); stop after this many provider calls.
- `--timeout-ms 20000` — how long to wait for one model's answer before giving up.
- `--config path/to/other.json` — use a different config file than the default.
- `--help` — prints all of this from the command line.

Run its own tests (no network, everything mocked):

```
npx vitest run --root scripts/critique
```

## The key names

- `OPENROUTER_API_KEY` — one key, used for ChatGPT, Grok, Perplexity, and any other model
  routed through OpenRouter. Put it in `.env` (never commit it).
- `GEMINI_API_KEY` — used only for model ids that start with `gemini/`, calling Google's API
  directly instead of going through OpenRouter.

As of writing this, PROVEN (the founder's own words): neither key exists on this machine
yet. `.env` holds only the AssemblyAI key and a session cap. The tool is built and tested
entirely with `--dry-run`, which needs neither key. When a key is missing, the tool does not
crash — it marks that call "skipped: OPENROUTER_API_KEY is not set" (or the Gemini
equivalent) in the report and keeps going with whatever calls it can make.

## Which models, exactly

The exact model ids to use are UNKNOWN to be current — providers rename and retire models
often, and the ones here were the best names available in September 2026. They live in
`scripts/critique/critique.config.json`, a small file meant to be hand-edited. If a run
comes back with every call for one model failing, the model id is the first thing to check.
Current defaults (all routed through OpenRouter):

- `openai/gpt-4o` (ChatGPT)
- `x-ai/grok-2` (Grok)
- `perplexity/sonar-pro` (Perplexity)
- `google/gemini-pro` (Gemini, via OpenRouter — use a `gemini/...` id instead to call
  Google directly)

## The cost guard

Every provider call costs real money and, for OpenRouter/Gemini, is unrelated to the
AssemblyAI credits used elsewhere in this repo. Two protections:

- `--max-calls` (default 20): the tool refuses to make more than this many provider calls in
  one run. With 5 personas and 4 models, a full run is 20 calls — right at the default, so
  raising the model or persona list means either raising `--max-calls` on purpose or
  narrowing `--models`/`--personas` for that run.
- A token estimate is printed before every single call: `token_estimate(ESTIMATE,
  chars/4)=...`. This is always labeled ESTIMATE and is never a real token count from the
  provider — it is just the prompt's character count divided by 4, a rough rule of thumb.

## The loop the orchestrator follows

1. Run the critics (`npx tsx scripts/critique/run.ts`).
2. Read `ROLLUP.md`. Triage every finding into one of three buckets:
   - **Fix now** — a real gap, cheap to fix, fix it before the next rehearsal.
   - **Write a test** — a real gap, needs code or a corpus transcript to prove it stays
     fixed; add that to `packages/engine/test/` or `packages/engine/corpus/` (this tool's
     own lane never edits those).
   - **Park with reason** — not a real gap (e.g. it's already a disclosed limitation), or
     out of scope (LAW 5), or a duplicate of something already tracked. Write down why, so
     the next round doesn't re-litigate it.
3. Fix what's in "fix now" and "write a test".
4. Re-run the rehearsal harness (`scripts/rehearse/`) to confirm nothing broke.
5. Re-run the critics on the newly-changed packet.
6. Stop when two consecutive rounds add no new critical or important finding. Minor findings
   can stay open as known limitations.

## What never happens here (LAW 1)

Every persona prompt is told, in the same words every time: Countersign makes no claim to
detect synthetic, cloned, or deepfake voices; its mechanism is behavioral verification only,
and that is a deliberate, disclosed design choice. A critic finding of the shape "you can't
actually detect a cloned voice" is explicitly out of scope and the personas are told not to
raise it. This is enforced in one shared place (`scripts/critique/personaLoader.ts`), not
copy-pasted into each persona file, so it can never drift.

## .gitignore entries this tool needs (not made by this lane; flagging for whoever owns .gitignore)

Every real run writes timestamped folders under `scripts/critique/reports/` (packets,
prompts, per-call JSON/markdown, and `ROLLUP.md`) — the same pattern
`scripts/rehearse/reports/` already uses. That folder should be ignored the same way:

```
scripts/critique/reports/
```

No other new paths need ignoring; there is no cache directory here (unlike
`scripts/rehearse/.cache/`, since this tool calls providers directly with no local audio
render step to cache).
