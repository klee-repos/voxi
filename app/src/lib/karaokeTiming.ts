/**
 * Karaoke timing — a PURE, client-side read-along estimate (there is NO server word/line timing; the Deep Dive
 * transcript is `{speaker,text}[]` with no timestamps, so we approximate). Each WORD is given a `[start,end)`
 * slice of the real audio duration, proportional to its character weight over the whole transcript. The player
 * highlights the word whose interval contains the current playhead — Spotify-podcast style (spoken words bright,
 * current word boxed, upcoming words dimmed).
 *
 * It is intentionally approximate: without real per-word timestamps a ±1-word drift is expected, and reads as a
 * natural read-along rather than an error (large type + a highlight box absorb the slop). If real per-turn timing
 * ever ships from the worker, swap `computeWordTimings` for the exact map — the `activeWordIndex` consumer is
 * unchanged.
 */

/** One word's place + spoken interval. `line`/`wordInLine` map back to the rendered transcript for highlighting. */
export interface WordTiming {
  line: number // transcript line index
  wordInLine: number // word index within that line
  start: number // seconds
  end: number // seconds
}

/** Split a transcript line into display words (whitespace-separated, empties dropped). Pure + shared with the UI so
 *  the rendered words and the timing map can never disagree on tokenization. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0)
}

/** A word's time WEIGHT: char length + 1 for the inter-word gap, plus a small pause for trailing punctuation (TTS
 *  breathes at sentence/clause ends), so a one-letter word still claims a slice and pauses aren't under-counted. */
function weightOf(word: string): number {
  let w = word.length + 1
  if (/[.!?]["')\]]?$/.test(word)) w += 3 // sentence-final pause
  else if (/[,;:—]["')\]]?$/.test(word)) w += 1 // clause pause
  return w
}

/**
 * Per-word `[start,end)` intervals. Contiguous + monotonic (word i ends where i+1 begins) so `activeWordIndex` is a
 * clean "last word whose start ≤ pos".
 *
 * Two sources, best first:
 *  1. **Real per-clause timing** — when EVERY clause carries a finite `endSec` (the worker's real byte-derived
 *     cumulative end times), sync to it: each clause's real span is subdivided across ITS words by char weight, so
 *     drift can't accumulate across the episode. The clause ends are SCALED to the player's actual `durationSec`
 *     (absorbing any muxer offset/stretch) — much more accurate than a whole-episode estimate.
 *  2. **Estimate** — no server timing (an older episode): whole-transcript cumulative char-weight over the real
 *     duration (the original behaviour).
 * Invalid duration (≤0 / NaN / ∞) with no real timing → every interval collapses to `[0,0)` so nothing highlights
 * until a real duration arrives (audio metadata loads after mount).
 */
export function computeWordTimings(transcript: { speaker: string; text: string; endSec?: number }[], durationSec: number): WordTiming[] {
  const perLine = transcript.map((l) => splitWords(l.text).map((w) => ({ w, weight: weightOf(w) })))
  const validDur = Number.isFinite(durationSec) && durationSec > 0
  const timings: WordTiming[] = []

  // (1) Real per-clause timing available for the whole transcript?
  const realEnds = transcript.length > 0 && transcript.every((l) => Number.isFinite(l.endSec) && (l.endSec as number) >= 0)
  if (realEnds) {
    const rawEnds = transcript.map((l) => l.endSec as number)
    const lastEnd = rawEnds[rawEnds.length - 1] ?? 0
    const scale = validDur && lastEnd > 0 ? durationSec / lastEnd : 1
    let clauseStart = 0
    perLine.forEach((words, line) => {
      const clauseEnd = Math.max(clauseStart, (rawEnds[line] ?? clauseStart) * scale)
      const total = words.reduce((s, x) => s + x.weight, 0) || 1
      let acc = 0
      words.forEach((x, wordInLine) => {
        const start = clauseStart + ((clauseEnd - clauseStart) * acc) / total
        acc += x.weight
        const end = clauseStart + ((clauseEnd - clauseStart) * acc) / total
        timings.push({ line, wordInLine, start, end })
      })
      clauseStart = clauseEnd
    })
    return timings
  }

  // (2) Estimate — whole-transcript cumulative char weight over the real duration.
  const flat = perLine.flatMap((words, line) => words.map((x, wordInLine) => ({ line, wordInLine, weight: x.weight })))
  if (flat.length === 0) return []
  const total = flat.reduce((s, w) => s + w.weight, 0)
  let acc = 0
  for (const w of flat) {
    const start = validDur ? (acc / total) * durationSec : 0
    acc += w.weight
    const end = validDur ? (acc / total) * durationSec : 0
    timings.push({ line: w.line, wordInLine: w.wordInLine, start, end })
  }
  return timings
}

/**
 * The global index of the currently-spoken word (the last word whose `start ≤ positionSec`), or `-1` when there is
 * nothing to highlight (empty transcript, or an invalid/zero-span timing map from an unloaded duration). Monotonic
 * non-decreasing in `positionSec`, so the E2E can assert the active index STRICTLY ADVANCES as the playhead moves
 * (the no-fake-green coupling proof). Past the end it stays on the last word (a clean finish, no flicker to -1).
 */
export function activeWordIndex(positionSec: number, timings: WordTiming[]): number {
  if (timings.length === 0) return -1
  const span = timings[timings.length - 1]!.end
  if (!(span > 0)) return -1 // invalid/zero duration → nothing spoken yet
  if (!(positionSec >= 0)) return -1
  // Contiguous intervals → the active word is the last one that has started. Linear scan (transcripts are short).
  let idx = 0
  for (let i = 0; i < timings.length; i++) {
    if (timings[i]!.start <= positionSec) idx = i
    else break
  }
  return idx
}
