# Panel 2026-09-14: the speech-path test plan (circulated by the founder, two external seats)

Question circulated: is a recorded-behaviour AssemblyAI simulator plus a no-credit server mode
overkill, and what is the simplest test strategy that meets the definition of done (a judge in
their own words, any pauses, any pronunciation, every case) within about 19 hours of credit.

## Seat 1 (founder's external AI, pasted 6:04 PM CDT)
- Kill the simulator: static bundles cannot model a race whose timing depends on what our
  server sends; a fake of a fake. Underbuilt against the definition of done.
- The ant: steering via session.update mid-turn is an anti-pattern; the standard is TOOL
  CALLING: the model calls a tool, the server returns the exact text as the tool result, the
  agent reads it. Prefers 8D (live only; 19 h of credit is 38 ten-case batches) and, if the
  architecture stays, 8B (every line verbatim).
- Strategy: nothing offline but engine unit tests; a 10-case improvising batch (~30 min) on
  every merged logic change; pass = 10/10 verdicts, verbatim goodbye transcribed, no dead air
  over 3 s; judge evidence = unedited audio of the improvising caller plus server logs.
- Missing case: the split-utterance stall (thinking out loud, a 4 s pause mid-number; the
  turn detector ends the turn and the engine consumes a partial account number).

## Seat 2 (founder's external AI with web search, pasted 6:04 PM CDT)
- Kill the simulator, keep the recordings as TRACE FIXTURES (8C): replay their exact event
  sequences into the server adapter and assert invariants (never advance evidence on speech
  not observed, never two transitions for one answer, never a verdict change from timing);
  add synthetic mutations (missing reply.done, empty replies, transcript before done,
  overlapping replies, interruption). Do not model how AssemblyAI would respond.
- Two hours of live testing is far too little; plans 4 h 45 min: a 30 min protocol spike,
  45 min confirmation batch, 60 min judge simulation (a human who does not know the script),
  60 min founder recording, 90 min final adversarial batch (30/30 verdicts, 30/30 audible
  closes, zero unanswered required questions).
- Its E: make the automatic post-caller reply a deliberate short holding acknowledgement
  (stable in the session prompt); compute the decision while it speaks; after its transcript
  arrives, send exactly ONE reply.create with reply-scoped instructions for the real line.
  Race (b) becomes the design; fact (e) stops being a bug. Cost: a 0.5 to 2 s beat per turn,
  acceptable for a checkpoint. Do one 30 min live spike first; if explicit replies still
  come back empty or overlapping, abandon E rather than build another retry protocol.
- Says 8B is not truly deterministic (still passes through the model) and 8A is ugly.
- Grading: drop the question-mark / imperative oracle; grade whether the caller was asked for
  the required field before the engine consumed an answer; dead air gate = no unexplained
  silence over 4 s; latency tracked, not gated.
- Judge evidence live-first: an unedited shuffled human run, an expected/actual matrix, one
  evidence trail, one timeline showing voice only reaches STAGE.
- Missing case: a critical value misheard or committed during hesitation or self-correction
  ("fifteen, uh, sorry, fifty thousand"); invariant: no security-relevant evidence becomes
  final until an unambiguous complete answer or a confirmed readback. Eleventh case:
  "corrected critical field", with real human voices.
- Citations: AssemblyAI session-configuration (system_prompt applies on the next turn),
  events-reference (reply.create instructions; transcript.agent after audio delivered; no
  correlation key), turn-detection page, tools overview, $4.50/hour price, TTS-only-in-pipeline
  FAQ; LiveKit session.say, Pipecat TTSSpeakFrame, Vapi say.exact, Retell custom-LLM
  response_id, OpenAI Realtime response.create. Fetch-verification lane running.

## Convergence (the trust signal)
1. The simulator is dead. Both seats, independently.
2. Spend far more live credit than two hours; live is the only ground truth for speech.
3. The current mechanism (global prompt change, then verify the transcript) is the wrong
   primitive; the fix is architectural, not another retry.
4. Add a hesitation / corrected-value case; both name it as the likeliest judge failure.
5. Judge evidence must be live and unedited, never "our simulator passed".

## Disagreement (not averaged)
- Seat 1: tool calling (hold-mode tool result read by the agent) is the standard fix.
  Seat 2: an explicit single reply.create with instructions after a deliberate holding reply.
  Both are documented AssemblyAI primitives; both replace "beat the auto reply by 4 ms".
- Seat 1 would go live-only (8D); Seat 2 keeps cheap trace fixtures (8C) plus live.

## Orchestrator synthesis
- Kill RECORDED-BEHAVIOUR-SIMULATOR and NO-CREDIT-SERVER-MODE. Keep the bundles as trace
  fixtures with mutations (small, Haiku-sized after the spike).
- One decision for the founder: run the 30 min live A/B spike tomorrow between (E) holding
  auto-reply + one instructed reply.create and (T) hold-mode tool call whose result is the
  engine's line, on the three known races; adopt whichever is clean; if neither, keep the
  current server and spend credit on live batches (8D).
- Live budget: about 5 h of the remaining 19 h, milestones as Seat 2's table.
- Add case 11 (corrected critical field) and replace the question-mark oracle with the
  required-field check in the grader.

## Citation fetch-verification (Haiku errand, 6:05 PM CDT)
PROVEN from AssemblyAI docs: a session.update system_prompt applies "on the next turn";
reply.create carries a one-shot instruction; transcript.agent arrives "after all audio for
the response has been delivered"; every reply carries a reply_id; no client correlation key
exists for reply.create (UNVERIFIED as absent: the docs do not mention one); turn detection
is semantic and adaptive and "you never signal end-of-turn yourself"; the agent waits for a
whole value when a tool parameter expects a number, date or entity; tool HOLD MODE "keeps the
agent silent while the tool runs. The user can't trigger replies during this period ... This
suits ... sensitive workflows like payment authentication. When you send the tool result, it
automatically triggers the agent's next response"; TTS exists only inside the Voice Agent
pipeline. Price $4.50/hour: not on the docs page, but PROVEN by the founder's dashboard
(2.9 h used, $13.08 spent).

## Docs answer to "is there a documented way?" (Haiku errand, 6:22 PM CDT, all PROVEN from assemblyai.com/docs)
- There is NO client event or field that makes the agent say an exact sentence at an exact
  moment. The events reference: "There is no event that makes the agent speak text
  verbatim; the agent always generates responses based on its system prompt and
  conversation context."
- tool.result is paraphrased by the model, has no speak/say field, and a tool call cannot be
  forced on every turn. Hold mode mutes the agent while the tool runs and auto-speaks
  (paraphrased) when the result arrives.
- conversation.message injects a user or system message into context without speech;
  reply.create speaks now, with a one-shot instruction, "any time you want the agent to
  speak without a user utterance triggering it".
- system_prompt applies on the next turn; greeting is immutable after session.ready.
- "Connect your own LLM" is mentioned but its page returns 404; no application-driven
  dialogue guide exists.
Consequence: the model always phrases; the server can only order the moments and verify the
transcript. Sequencing without a race (seat 2's E) is the doc-consistent design; the hold-mode
tool is a documented alternative that removes the automatic reply but depends on the model
choosing to call the tool each turn, which the docs say cannot be forced.
