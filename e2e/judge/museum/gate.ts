/**
 * Pure, unit-testable gate logic for the museum identification eval (§F4, adversarial D3).
 *
 * The identification gate is ABSOLUTE per-fixture (mirroring e2e/judge/reveal-buckets.ts), NOT regression-only —
 * a coverage regression (a known object newly landing UNKNOWN) must register as a MISS, never silently drop out of
 * the denominator and inflate the rate. Three false-green traps this closes:
 *   1. generic-token match — a band-hedge that happens to contain "greek"/"egypt"/"unknown" is NOT an ID; only
 *      DISTINCTIVE curated tokens count (a stopword denylist strips the rest).
 *   2. honest-empty ≠ ID — a reveal whose maker admits it doesn't know ("unknown", "keeps their counsel") is a
 *      NON-match for accuracy even when the ground-truth maker string contains the same word.
 *   3. UNKNOWN self-selection — an expected-known item landing UNKNOWN is a MISS (band-sanity), not an exclusion.
 */

export type Band = 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN' | ''

export interface MuseumFixture {
  id: string
  file: string
  museum: string
  title: string
  maker: string
  year: string
  category: string
  medium: string
  expected_facts: string[]
  difficulty: string
  image_type: string
  source_url: string
  license: string
  sha1: string
  /** DISTINCTIVE lowercase substrings a correct reveal must ALL contain (never period/nationality/stopwords). */
  expected_id_tokens: string[]
  /** If set, the item MUST identify to at least this confidence — landing UNKNOWN is a band-sanity MISS. */
  expected_band: 'CONFIDENT' | 'PROBABLE' | null
  /** A safety suppression on THIS item is expected (e.g. a nude classical statue), not a wrong identification. */
  safety_expected?: boolean
  /** The fixture is a clean photo of the SAME design, not the exact accessioned unit — don't gate its facts. */
  same_design?: boolean
}

/** What the cascade produced for one fixture (captured from emitted events by the harness). */
export interface Captured {
  band: Band
  title: string
  what: string
  purpose: string
  maker: string
  facts: string[]
  /** A terminal suppression branch instead of a normal reveal (safety refusal / category-only). */
  suppressed: 'safety_refusal' | 'category_only' | null
}

// Generic tokens that must NEVER, on their own, count as an identification hit (period / nationality / role /
// corporate-form / stopwords). Curated `expected_id_tokens` should already exclude these; this is a guard.
export const ID_STOPWORDS = new Set<string>([
  'ancient', 'roman', 'greek', 'egypt', 'egyptian', 'attic', 'archaic', 'italian', 'milan', 'brescia',
  'south', 'north', 'netherlandish', 'mosan', 'coast', 'indigenous', 'haida', 'artists', 'artist',
  'corporation', 'company', 'international', 'british', 'american', 'french', 'dutch', 'studios', 'studio',
  'workshop', 'anonymous', 'unattributed', 'unknown', 'and', 'the', 'of', 'a', 'an', 'model', 'museum',
  'early', 'period', 'king', 'emperor', 'field', 'building', 'window', 'portable', 'personal', 'computer',
])

// Honest-empty maker phrasings — a reveal that admits it can't attribute (NOT a positive identification).
const HONEST_EMPTY = /^\s*$|nothing|keeps? (their|its) counsel|no maker|unbranded|unknown|not sure|n\/a|anonymous|unattributed|generic|couldn'?t|can'?t prove|no idea/i

export const isHonestEmpty = (maker: string): boolean => HONEST_EMPTY.test(maker)

/** A fabricated maker: a non-empty maker that is NOT an honest-empty admission. (Whether it's *wrong* is a
 *  separate, judge-scored question; this only detects a confident assertion vs an honest gap.) */
export const isFabricatedMaker = (maker: string): boolean => maker.trim().length > 0 && !isHonestEmpty(maker)

export type IdResult = 'hit' | 'miss' | 'suppressed'

/** Absolute per-fixture identification result. A HIT requires ALL distinctive tokens present in title+what+maker
 *  AND a non-honest-empty answer. Suppression (safety/category-only) is its own outcome, never a silent miss. */
export function identificationResult(cap: Captured, fx: MuseumFixture): IdResult {
  if (cap.suppressed) return 'suppressed'
  const tokens = fx.expected_id_tokens.map((t) => t.trim().toLowerCase()).filter((t) => t && !ID_STOPWORDS.has(t))
  if (tokens.length === 0) return 'miss' // no distinctive token to match on → cannot be a positive ID (curation guard)
  // Honest-empty maker can still HIT if the title/what names the object distinctively (e.g. "The Starry Night"
  // with no artist) — so match on the combined text, but a token that ONLY appears inside an honest-empty maker
  // phrase does not count (the maker text is excluded when it's honest-empty).
  const makerText = isHonestEmpty(cap.maker) ? '' : cap.maker
  const hay = `${cap.title} ${cap.what} ${makerText}`.toLowerCase()
  return tokens.every((t) => hay.includes(t)) ? 'hit' : 'miss'
}

/** Band-sanity failure (GATES): an item we expect to be identifiable landed UNKNOWN, or was suppressed when we
 *  did NOT expect a safety refusal. Absolute per-fixture — no baseline needed, works on run #1. */
export function bandSanityFail(cap: Captured, fx: MuseumFixture): boolean {
  if (!fx.expected_band) return false
  if (cap.suppressed) return !fx.safety_expected // an unexpected suppression on a should-identify item
  return cap.band === 'UNKNOWN' || cap.band === ''
}

/** Suppression-honesty failure (GATES): the pipeline safety-refused an item NOT flagged as expected — i.e. it
 *  wrongly refused a benign museum object. A safety_expected item being suppressed is fine (the kouros carve-out). */
export function unexpectedSuppression(cap: Captured, fx: MuseumFixture): boolean {
  return cap.suppressed === 'safety_refusal' && !fx.safety_expected
}
