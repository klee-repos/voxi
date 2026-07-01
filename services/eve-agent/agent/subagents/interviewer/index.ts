/**
 * interviewer subagent — the "first witness" unknown-item Q&A (PLAN §4.1, §7.3, §8.3 / kb-01).
 *
 * Driven by the `interview-unknown-item` skill when `identify_object` returns UNKNOWN/route=interview. It runs a
 * SHORT, capped, fully-skippable Q&A and mints a MINIMAL PRIVATE entry from the user's testimony. The user is
 * the first witness; nothing they captured is ever lost, even if they bail.
 *
 * Hard constraints encoded here (the load-bearing kb-01 rules):
 *   - **2–3 questions max.** `nextQuestion` returns null once the cap is hit (or enough is known).
 *   - **Every step skippable.** A null answer is valid and advances; skipping never discards the thread.
 *   - **Thread kept on bail.** `finalize` always yields a minimal entry from whatever was answered (even zero
 *     answers → a bare private placeholder), so an abandoned interview still leaves a resumable private entry.
 *   - **Visibility defaults to PRIVATE.** Global requires an explicit opt-in flag; the subagent never defaults
 *     to global and never asserts a verified make/model/year (the testimony is unverified data, §8.3).
 *
 * The Q&A is structured (an `outputSchema`): questions carry a "why am I asked this" line (PLAN §7.3, required),
 * and the final entry is validated. Nothing is stubbed to force green — the caps/skip/keep/visibility logic is
 * real and unit-tested.
 */

export type Visibility = 'private' | 'global'

/** One interview question, with the required "why am I asked this" transparency line (PLAN §7.3). */
export interface InterviewQuestion {
  id: string
  prompt: string
  /** required: the in-persona reason this is asked (trust/transparency). */
  whyAsked: string
}

/** A recorded answer. `text === null` means the user SKIPPED — a valid, non-discarding path. */
export interface InterviewAnswer {
  questionId: string
  text: string | null
}

/** The minimal private catalogue entry minted from testimony (the subagent's `outputSchema`). */
export interface MinimalEntry {
  /** the thread/entry id (kept regardless of how much was answered). */
  entryId: string
  /** the user's best-effort name for the object (or a neutral placeholder if they skipped naming it). */
  name: string
  /** UNVERIFIED testimony fields — never asserted as fact, never promoted as-is. */
  testimony: Record<string, string>
  /** defaults to private; global only on explicit opt-in. */
  visibility: Visibility
  /** true iff the user bailed before answering anything — still kept, still resumable. */
  minimalPlaceholder: boolean
}

/** The fixed question bank for the unknown-item interview. The first 2 are core; the 3rd is optional follow-up. */
export const QUESTION_BANK: InterviewQuestion[] = [
  {
    id: 'what',
    prompt: 'What is this, in your own words?',
    whyAsked: "I couldn't place it in the Guide, so you're the first witness — your words start its entry.",
  },
  {
    id: 'markings',
    prompt: 'Any maker or model markings on it — a badge, a stamp, a serial?',
    whyAsked: 'A marking lets me verify it before it ever goes into the shared Guide.',
  },
  {
    id: 'context',
    prompt: 'Where did you come across it, roughly?',
    whyAsked: 'Context helps me narrow what family of object this belongs to.',
  },
]

/** The hard cap on questions (kb-01). Never exceed this, regardless of answers. */
export const MAX_QUESTIONS = 3

/**
 * Decide the next question given the answers so far. Returns null when:
 *   - the cap (MAX_QUESTIONS) is reached, OR
 *   - enough is known (the user gave a usable name AND a marking) — stop early to preserve momentum.
 */
export function nextQuestion(answers: InterviewAnswer[]): InterviewQuestion | null {
  if (answers.length >= MAX_QUESTIONS) return null

  const answered = new Set(answers.map((a) => a.questionId))
  const has = (id: string) => answers.some((a) => a.questionId === id && a.text !== null && a.text.trim() !== '')

  // Early stop: a real name + a real marking is a usable minimal entry; don't burn the 3rd question.
  if (has('what') && has('markings')) return null

  // Otherwise ask the first bank question not yet asked.
  return QUESTION_BANK.find((q) => !answered.has(q.id)) ?? null
}

/**
 * Mint the minimal private entry from whatever was answered. ALWAYS yields an entry (thread kept on bail):
 *   - zero/all-skipped answers → a bare private placeholder (still resumable, nothing lost);
 *   - otherwise → the testimony fields, visibility as chosen (defaulting private).
 * Never asserts a verified make/model/year — testimony is unverified data (§8.3).
 */
export function finalize(
  entryId: string,
  answers: InterviewAnswer[],
  opts: { visibility?: Visibility } = {},
): MinimalEntry {
  const visibility: Visibility = opts.visibility === 'global' ? 'global' : 'private' // default private
  const real = answers.filter((a) => a.text !== null && a.text.trim() !== '')

  const testimony: Record<string, string> = {}
  for (const a of real) testimony[a.questionId] = (a.text as string).trim()

  const name = testimony.what ?? 'an uncatalogued object'
  return {
    entryId,
    name,
    testimony,
    visibility,
    minimalPlaceholder: real.length === 0,
  }
}

/** Validate the minted entry against the `outputSchema` invariants (boot-spike + tests assert these). */
export function validateEntry(e: MinimalEntry): { ok: boolean; reason?: string } {
  if (!e.entryId) return { ok: false, reason: 'entry has no id (thread must always be kept)' }
  if (e.visibility !== 'private' && e.visibility !== 'global') return { ok: false, reason: 'bad visibility' }
  // testimony is unverified — it must NOT carry asserted verified-id fields.
  if ('verified_make' in e.testimony || 'verified_model' in e.testimony) {
    return { ok: false, reason: 'testimony must not assert verified id fields (§8.3)' }
  }
  return { ok: true }
}
