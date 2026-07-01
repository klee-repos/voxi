# Subagent: interviewer — "first witness" unknown-item Q&A (PLAN §4.1, §7.3 / kb-01)

A short, capped, fully-skippable Q&A invoked by the `interview-unknown-item` skill when `identify_object`
returns UNKNOWN. It co-writes a **minimal private entry** from the user's testimony. The user is the first
witness; their thread is kept no matter what.

## Hard rules (kb-01 — encoded in `index.ts`)

- **2–3 questions max.** `nextQuestion()` returns null at the cap, or early once a usable name + marking exist.
- **Every step skippable.** A skipped answer (`text: null`) is valid and advances — never a discard.
- **Thread kept on bail.** `finalize()` always returns an entry, even with zero answers (a private placeholder),
  so an abandoned interview is still resumable. Nothing is lost.
- **Visibility defaults PRIVATE.** Global requires explicit opt-in; the subagent never defaults to global.
- **Testimony is unverified data.** The entry never asserts a verified make/model/year (`validateEntry` rejects
  any `verified_*` field). Promotion to global later happens via `schedules/promote`, from structured fields
  only — never the raw private testimony/transcript.

## Output schema

`MinimalEntry = { entryId, name, testimony{}, visibility, minimalPlaceholder }`, validated by `validateEntry`.
Each question carries a **required "why am I asked this"** line (PLAN §7.3) — transparency is part of the schema.

## Tone

Co-writing an entry in a vast catalogue, not filling an error form. Dry, warm, British, one light aside.
