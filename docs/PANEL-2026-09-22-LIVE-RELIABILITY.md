# External panel, 2026-09-22 evening: live-call reliability and the submit decision

Six seats. The founder carried one identical adversarial prompt (the test plan P1 to P7 and the
submit options i, ii, iii) to his own AI accounts at about 7:15 PM CDT and pasted six answers
back at 7:20 PM. Each answer is one seat; voices are not merged. Seat order is paste order.

## What triggered it

The founder's three calls at 6:52 to 6:58 PM on 93f714e: case 6 twice (STAGE; the play sheet
told him to contradict an approver question the agent never asks), case 1 once (ESCALATE after
a missed name-first payee, a split STT fragment dropped into a 33 s stall, the purpose asked
twice, and the goodbye spoken four times; record a7a58fd7). The harness 3-run check just before
had passed all verdicts with three talk-over flags.

## Convergence (all six seats agree)

1. The two-speaker design (the provider's automatic reply plus our server-instructed replies)
   is the root cause of the repeated question and repeated goodbye classes, and a large part of
   why per-defect patching has not converged. Patching symptoms around two writers will not end.
2. Pick option (ii): the no-mic replay as the primary judge path, live calling as a clearly
   labeled experimental bonus, cut to three cases (one STAGED, one FROZEN, one ESCALATED; NO
   ACTION optional). No seat picked (i) or (iii).
3. 9 of 10 on about 10 calls is not evidence. Seats quote the exact binomial interval for 9/10
   at roughly 55 to 99.7 percent; 30/30 bounds at about 88 percent, about 59 clean calls are
   needed to bound failure under 5 percent with zero observed.
4. Offline event replay (P2) cannot reproduce live timing races; salvage it only as a
   server-state regression suite, never as end-to-end proof.
5. A TTS harness is structurally blind to human pauses, restarts and fragments; testing needs
   real audio and people other than the founder.

## Disagreements (named, not averaged)

- How to get to one speaker.
  - Seats 3 and 5 (seat 2 agrees in part): point the Voice Agent API at our own
    OpenAI-compatible streaming /chat/completions endpoint that returns the deterministic
    engine's next line instead of calling an LLM. One reply per caller turn by construction.
    Time-box a spike to about two hours; revert if it fails.
  - Seat 4: a dummy endpoint that returns nothing, with the server still instructing lines.
  - Seat 6: claims the client protocol has only four events and no reply.create, so proposes a
    playback lock that mutes the provider's audio while our line plays, plus a prompt that
    neuters the managed LLM. (The client event list claim contradicts our own code, which sends
    reply.create; being verified.)
  - Seat 1: drop to raw streaming STT and own the TTS. Every other seat calls that too big.
- Turn detection. Seats 3 and 6 cite the provider docs as saying that setting min_silence or
  max_silence disables adaptive, entity-aware waiting, and recommend defaults. Our history cuts
  the other way on one data point: case 6 was cut at a pause on the adaptive default, and the
  1500 ms explicit setting carried his pause as one line tonight. Being verified.
- Extraction. Seats 1, 2, 4, 5: constrained LLM extraction to JSON feeding the deterministic
  engine (allowed under LAW 3 if the extractor never decides; LAW 4 means it must return exact
  transcript spans). Seat 3: question-aware extraction first (at the payee question, the short
  answer is the payee). Seat 6: cheap pattern additions from the real transcripts first.
- Seat 6 alone: a "done speaking" button, a headphones nudge, one call at a time (we already
  cap concurrency), and keyterms. Our server sends `keyterms: []` today (index.ts:242), so
  registering Meridian Supply, Northgate Partners, Marcus Obi and the other seed names is free.
- Seats 3 and 6: the provider's Bluejay simulation page offers audio simulations with accents
  and interruptions. Being verified.

## Existing assets that change the cost of option (ii)

- Replay already exists and runs the real engine (packages/server/src/replay.ts,
  packages/web/src/screens/Replay.tsx, "Watch a recorded attack"), shown first when live calls
  are unavailable. It carries no audio today.

## Citation check (fetched live from assemblyai.com/docs at about 7:23 PM CDT; copies in the session scratchpad aai-docs/)

- Own LLM endpoint: VERIFIED. "set the `llm` field on the agent to your own OpenAI-compatible
  chat-completions endpoint. AssemblyAI calls that endpoint at runtime to generate every reply."
  Streaming is required. Config is an `llm` list with one entry {base_url, model, api_key}.
  UNKNOWN: the request body beyond "the OpenAI schema", whether any session id reaches the
  endpoint, whether reply.create routes through it, and what an empty completion does.
- Silence thresholds: VERIFIED, and it goes against my Day 13 change. "Setting `min_silence` or
  `max_silence` turns off the adaptive pacing and entity-aware waiting described above for the
  rest of the session. Prefer leaving them unset." and "Tune the raw thresholds only as a last
  resort." The patient alternative is `input.transcription_mode` = `max_accuracy` ("waits
  longest to confirm the end of a turn"). Entity-aware waiting is driven by tool parameter
  descriptions, not keyterms.
- Client events: seat 6 CONTRADICTED. Seven exist: input.audio, session.update,
  session.resume, session.end, tool.result, reply.create, conversation.message. reply.create
  generates through the LLM "using the provided instructions on top of the existing system
  prompt"; no client event speaks an exact string (only the `greeting` config does).
- Suppressing the automatic reply: NOT FOUND in events reference, session configuration, or
  tools overview. The own-endpoint route is the only documented single-speaker path.
- Keyterms: VERIFIED. `session.input.keyterms`, up to 100 strings, mutable. We send none.
- Bluejay audio simulations (interruptions, accents): page exists; pricing not stated there.

## Status of this record

Seat 6's playback-lock plan rests on a false premise (no reply.create) and is set aside. The
own-endpoint design goes to a second panel round before any code. No code has changed since
the panel.

## Round 2 (pasted 7:40 PM CDT): critique of "the rules engine as the only brain"

Six seats again, same prompt.

Convergence:
- The design is the right direction, but it is a spike to prove, not a plan to assume. Log the
  full request body on the first call before designing correlation or history handling.
- When the engine wants silence (a fragment such as "Meridian."), four of six say return a
  valid streamed completion with no spoken content; two cite AssemblyAI's own BYO demo and blog
  for this "say nothing" answer (being verified). Seat 1 says a filler; seat 4 says empty will
  crash. The spike tests empty, whitespace, and a short line, ten times each.
- Never answer with an HTTP error; never stream slowly; send the whole line fast.
- Keep a per-call record of what was actually heard (reply.done, interrupted replies). The
  request history may carry a trap line the caller never heard; never score a missing
  correction without proof the wrong detail was delivered.
- Speak the verdict and goodbye as one line, then session.end after its reply.done.
- The replay must carry audio, clearly labeled as a recorded call, driven by the real engine;
  AssemblyAI keeps a per-session recording and timeline (being verified).

Disagreements:
- Silent-caller nudge: seats 1, 4, 5, 6 keep reply.create as a trigger only, with the words
  coming from the same endpoint, IF the spike proves reply.create routes through it. Seats 2
  and 3 say no audible nudge at all; show "Listening" on screen and end the call cleanly.
- Correlation: per-call api_key (seats 1, 2, 5), a call id in the base_url path (seats 4, 5),
  or no call identity at all by making the endpoint a pure function of (messages, scenario),
  with the scenario named in `model` (seat 6).

Checked locally against the saved docs: seat 6 is right that `llm` lives on a stored agent
(POST /v1/agents, PUT /v1/agents/{id}), not in session configuration. Our server today
connects with an inline session.update and no stored agent, so the first spike question is
whether a stored agent with `llm` can be used on our WebSocket connection at all.

Keyterm caution (seat 6): register proper nouns and domain words only, and seed trap pairs
symmetrically or not at all; never bias recognition toward the answer being verified.

## Round 2 citation check (7:47 PM CDT; copies in the session scratchpad aai-docs/round2/)

- AssemblyAI's own BYO demo: VERIFIED. github.com/dan-ince-aai/voice-agent-byo-llm-demo, owner
  lists company @AssemblyAI, repo homepage is the connect-your-own-llm doc. server.mjs has
  `{ label: 'say nothing', text: '' }`; README: "say nothing — an empty completion, which is a
  real answer on a call". Framing: role-only first delta, content chunks, finish_reason stop,
  [DONE]; a 2 s heartbeat of empty deltas while waiting. Reads the latest user and assistant
  messages; no session id in the request. README also says about one session in four never
  answered session.update and the page retries after 4.5 s.
- AssemblyAI blog (https://www.assemblyai.com/blog/thinker-responder-voice-agent): VERIFIED
  "Decide the right move is silence, and close the stream having said nothing at all.",
  "Keep your own conversation state. The Responder isn't remembering anything for you.",
  "Treat your endpoint as public the moment it's live." A different, older-looking post
  (whats-actually-inside-the-voice-agent-api) says "You cannot point it at your own LLM
  endpoint"; the docs and demo contradict it; the spike settles it.
- Stored agents: VERIFIED that agent_id "is mutually exclusive with inline session fields";
  binding and also sending system_prompt, greeting, tools, input, or output is rejected. A
  later separate session.update after binding: UNKNOWN (spike G0).
- Recordings: VERIFIED "Every connection to a voice agent is recorded as a session"; stereo,
  user left, agent right; GET /v1/sessions/{id} artifacts. PROVEN by probe at 7:50 PM: our
  account lists sessions back to 2026-09-19 including tonight's three founder calls (23:52,
  23:54, 23:56 UTC) and this morning's (14:24:19 and 14:25:47 UTC). Retention: NOT FOUND.
