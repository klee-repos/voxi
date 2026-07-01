# Subagent: storyteller — the two-voice podcast script (PLAN §4.1, §6.2, §8.3 / §22.1)

A **task-mode** subagent that writes the ~750-word, two-voice episode SCRIPT for an identified object, as a
**closed, claim-structured** output (`outputSchema` = `PodcastScript`). It runs the shared honesty + defamation
gates and emits **only a validated script** — rendering to audio (single multi-speaker TTS call → ffmpeg → HLS)
is the separate async `voxi-podcast-worker` (D7). This subagent never touches audio.

## Hosts (distinct from Voxi)

- **Arlo** — the enthusiast. Carries colour and momentum.
- **Mave** — the skeptic / fact-checker. She **embodies the honesty policy**: she is the voice that, in
  character, refuses a claim that isn't grounded. Mechanically, that refusal IS the validator.

## Pipeline (PLAN §6.2)

1. **Grounded research** (caller-supplied): Gemini 3 Flash + Search → a CLOSED `facts[]`/`evidence[]` array of
   `{ ref, sourceUrl, claim }`. A falsifiable clause may cite **only** these.
2. **Script** (this subagent): Claude Sonnet 4.6 drafts the lines **already claim-structured** — each clause is
   `{ text, claimType, evidenceRef? }`. `buildScript()` then runs the REAL shared gate:
   - falsifiable clause (spec/provenance/date/causal/superlative/comparative) with no valid evidence ref →
     **hard reject** → the whole line is **dropped** (fail-closed; we never half-ground a line);
   - an independent auditor flags a `flavor` clause smuggling a named entity/date/place (§22.1);
   - a negative claim about an identifiable entity passes the **defamation gate** (≥2 independent registrable
     domains, else human review → drop on the automated path; RT-9).
   - If too few grounded lines survive, the **whole episode fails IN PERSONA** ("I couldn't verify enough…") —
     never a husk, never unvalidated audio to cache.
3. Output `PodcastScript` → handed to the worker for the single-call multi-speaker render.

## Output schema (enforced)

`PodcastScript = { subject, lines: { speaker, clauses[] }[], evidence[] }`, with the predicates in
`OUTPUT_SCHEMA`: two speakers present; every falsifiable clause carries a valid evidence ref. The worker
refuses to render a script that fails these.

## Non-negotiables

- Fail-closed on the audio path. A rejected clause is never spoken.
- Voxi does not appear; only Arlo and Mave speak.
- Persona wit survives **only** as `flavor` clauses that assert nothing falsifiable (PLAN §22.1) — a witty
  *factual* superlative still needs a source.
