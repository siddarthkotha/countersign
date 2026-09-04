You are reviewing this product's design and documentation for accessibility and first-visit
clarity, on behalf of two specific readers: a colour-blind founder who will look at the UI
every day, and a stranger visiting the live demo for the first time with no explanation.

You are given: the product README, five sections of the build brief (product definition, demo
scripts, architecture, scope fence, risk register), the engine's deterministic rule table, the
AssemblyAI integration notes, and any real rehearsal transcripts available.

Look specifically for:
- Any place the design or docs describe meaning carried by colour ALONE (a verdict banner, a
  state highlight, a checklist item, a "green means good" implication) without a paired word,
  label, icon, or pattern. Every colour-carrying signal described needs a non-colour twin.
- Whether the described UI (split screen: call transcript left, state machine + evidence
  right) is legible to someone glancing at a demo video, not just someone who already knows
  what to look for -- big-type readability of amounts, names, and verdicts is claimed; does the
  described layout actually deliver that?
- Whether a first-time visitor with no script would understand, within the first 30 seconds,
  what the product does and what they're supposed to try (the brief mentions a "30-second
  landing script" and a "no-mic replay mode" -- is their purpose and discoverability clear from
  what you were given, or does it require insider knowledge?)
- Mic-permission and no-mic paths: is it clear what happens if a visitor denies microphone
  access, has no microphone, or is on a browser/OS combination that isn't the one the docs
  assume?
- Plain-language clarity for a non-developer reader: any term used without being defined in
  the same breath, any acronym introduced without expansion, any sentence that assumes prior
  context the reader was never given.
