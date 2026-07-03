/**
 * LiveVisionProvider — the production VisionProvider for identify_object (PLAN §5), backed by real Vertex
 * Gemini (Stage 1) + Cloud Vision web detection (Stage 2), authed via the gcloud CLI. It returns STAGE
 * candidates only; the tool's shared arbitration decides the confidence band (the over-confident VLM is never
 * the source of truth). Catalog (Stage 3) is the "moat": when a real Vertex multimodal embedding of the image
 * matches a prior scan below a distance threshold, it is injected as the `catalog` candidate BEFORE arbitration.
 *
 * The catalog wiring is fully ADDITIVE and GUARDED: it only runs when a Catalog + EmbeddingProvider are injected
 * AND the image carries a userId (the ACL key). ANY embedding/catalog error is swallowed and analyze() proceeds
 * vlm+web-only — byte-identical to the no-catalog path. With an EMPTY catalog no `catalog` stage is ever added,
 * so the arbitrated result is unchanged from today.
 */
import type { VisionProvider, VisionStages, ImageRef, IdEvidence, IdentifyResult } from '../tools/identify_object'
import type { Candidate } from '../../../../packages/shared/src/arbitration'
import { loadImageBytes, geminiIdentify, visionWebDetect, type WebDetect } from '../lib/gcp-vision'
import { OBSERVED_SOURCE_PREFIX } from '../../../../packages/shared/src/confidence'
import type { EmbeddingProvider } from '../lib/embedding'
import type { Catalog } from '../../../../packages/db/catalog'

const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
/** Alphanumeric-only fold so "SUB POP" ≡ "Sub Pop" ≡ "SubPop" match as substrings (brand corroboration). */
const foldAlnum = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Filler / non-answer words a clean human title must never carry (the VLM sometimes prefixes a hedge). */
const TITLE_FILLER =
  /\b(unspecified|unidentified|unknown|generic|assorted|various|miscellaneous|misc|n\/?a|possibly|probably|likely|maybe|unbranded|no[- ]?name|unnamed|undetermined)\b/gi

/**
 * Sanitize the VLM's `display_title` into a clean, confident human name: strip filler/non-answer qualifiers
 * ("Unspecified Parliament Blue" → "Parliament Blue"), collapse whitespace, and trim stray separators. Returns
 * undefined when nothing usable survives (the caller then falls back to the arbitrated label). This is the
 * deterministic backstop to the prompt rule — a hedge word never reaches the reveal title.
 */
export function cleanDisplayTitle(s?: string): string | undefined {
  if (!s) return undefined
  const cleaned = s
    .replace(TITLE_FILLER, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,–—-]+|[\s,–—-]+$/g, '')
    .trim()
  return cleaned.length >= 2 ? cleaned : undefined
}

/**
 * Clean an identity FIELD (make/model): return undefined ONLY when the value WHOLLY reduces to a non-answer
 * ("unbranded"/"unspecified"/"N/A"), otherwise return the ORIGINAL unchanged (§13.3, adversarial #9). Unlike
 * cleanDisplayTitle this must NEVER strip a filler token EMBEDDED in a real name — "Unknown Mortal Orchestra",
 * "No Name" (the grocery brand), "Various Artists" are real identities, not hedges. Fixes D-6 (filler leaking into
 * make/model → label/subject/catalog-id) without mangling brand-primary names.
 */
export function cleanField(s?: string): string | undefined {
  if (!s) return undefined
  const stripped = s.replace(TITLE_FILLER, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,–—-]+|[\s,–—-]+$/g, '').trim()
  return stripped.length > 0 ? s.trim() : undefined // anything real survives → keep original; wholly-filler → absent
}

/**
 * Clean a raw VLM make/model FIELD of the junk shape the VLM smuggles in: a trailing " or <alternative>"
 * ("Xbox Wireless Controller or wood" → "Xbox Wireless Controller"). Trailing-alternation ONLY, whole-word "or",
 * applied to the make/model FIELDS (never the display title, never mid-string), so a real name that legitimately
 * contains " or " earlier, or parentheses (an edition), survives. Runs AFTER cleanField (wholly-filler). Conservative
 * because arbitration + `deriveMaker` key on these fields — never blank a field (fall back to the original).
 */
export function cleanIdentityField(s?: string): string | undefined {
  if (!s) return undefined
  const cleaned = s.replace(/\s+\bor\b\s+.*$/i, '').replace(/\s{2,}/g, ' ').trim()
  return cleaned.length >= 2 ? cleaned : s.trim()
}

/**
 * Photo GENRE / medium / technique labels a reverse-image search returns INSTEAD of the object ("still life
 * photography" for an Xbox controller on a table). Matched WHOLE-LABEL (case-insensitive), never as a substring —
 * so a legit object called a "portrait lens" or a "Polaroid" is untouched. Such a label must never become a
 * surfaced candidate nor a `contradicts` source (it dragged a good VLM identity to a bogus PROBABLE).
 */
const WEB_GENRE_LABELS: ReadonlySet<string> = new Set([
  'still life', 'still-life', 'still life photography', 'photograph', 'photography', 'photo', 'photo shoot',
  'product photography', 'stock photography', 'stock photo', 'close-up', 'closeup', 'macro photography', 'macro',
  'portrait', 'portrait photography', 'illustration', 'drawing', 'image', 'images', 'picture', 'art',
])
export function isGenreLabel(label: string | undefined): boolean {
  const t = (label ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return t.length > 0 && WEB_GENRE_LABELS.has(t)
}

/** Sensitive / non-brand strings that must NEVER become citable observed evidence (PII/junk — §13.3, adversarial
 *  #8): emails, digit runs (phone/card/ID/DOB/serial), and punctuation/mark-only spans (©/®/™). */
function looksSensitiveOrJunk(s: string): boolean {
  const t = (s ?? '').trim()
  if (t.length < 2) return true
  if (/@/.test(t)) return true
  if (/\d{3,}/.test(t)) return true
  if (!/[a-z0-9]/i.test(t)) return true
  return false
}

/** Corporate / label FORM suffixes the VLM often APPENDS to a make that are NOT physically on the object ("Sub Pop
 *  Records" for a wordmark that reads only "SUB POP"). A trailing run of these is stripped so the corroboration can
 *  match the brand AS BORNE by the object (§13.3, the Sub Pop-logo regression). WHOLE trailing tokens only. */
const ENTITY_SUFFIXES: ReadonlySet<string> = new Set([
  'records', 'recordings', 'inc', 'incorporated', 'ltd', 'limited', 'llc', 'plc', 'corp', 'corporation',
  'company', 'gmbh',
])

/** Drop a trailing run of corporate/label-form suffix tokens ("Sub Pop Records" → "Sub Pop"). Never strips to empty
 *  (keeps ≥1 token) and returns the brand UNCHANGED when it bears no such suffix — so it only ever shortens a
 *  clearly-corporate name, never a plain one. */
export function stripEntitySuffix(brand: string): string {
  const toks = brand.trim().split(/\s+/).filter(Boolean)
  let end = toks.length
  while (end > 1 && ENTITY_SUFFIXES.has(foldAlnum(toks[end - 1]!))) end--
  return toks.slice(0, end).join(' ')
}

/**
 * The distilled OBSERVED BRAND (§13.3, adversarial #8/#17/#19/#22). Derived from the CLEAN structured `make` — NOT
 * reconstructed from a raw OCR array (the real Sub Pop capture is ['S','U','B','P','O','P'], whose naive join is
 * garbage). It becomes observed evidence ONLY when (a) it survives the PII/junk guard and (b) it is corroborated in
 * what was actually READ/seen on the CHOSEN object (`readOff` = its OCR + distinguishing-features + display title),
 * which binds it to the primary object so a background logo never becomes "observed". `distinguishing_features` are
 * used only for corroboration here, never emitted as citable evidence (they carry VLM inference, not a literal read).
 */
export function observedBrandFrom(make: string | undefined, readOff: string): string | undefined {
  const brand = cleanField(make)
  if (!brand || looksSensitiveOrJunk(brand)) return undefined
  const hay = foldAlnum(readOff)
  if (hay.includes(foldAlnum(brand))) return brand
  // The VLM may append a corporate/label suffix the object does NOT bear ("Sub Pop Records" for a "SUB POP"
  // wordmark) — defeating the full-string corroboration. Corroborate the suffix-stripped CORE and return THAT (what
  // the object actually reads), so a logo whose make carries an inferred "…Records" still surfaces its brand and the
  // maker lane fires instead of falling to a generic class ("Logo") reveal (§13.3, the Sub Pop-logo regression).
  const core = stripEntitySuffix(brand)
  if (core !== brand && !looksSensitiveOrJunk(core) && hay.includes(foldAlnum(core))) return core
  return undefined
}

/**
 * Catalog-match acceptance threshold (cosine DISTANCE, 0 = identical). A hit nearer than this is trustworthy
 * enough to inject as a Stage-3 candidate. 0.15 is intentionally tight: multimodalembedding@001 puts the SAME
 * object at very small distances, so this admits the "moat" (a prior scan of this exact thing) while rejecting
 * merely-similar objects. Arbitration then still requires model agreement to short-circuit — the injected
 * candidate never alone forces a CONFIDENT reveal.
 */
export const CATALOG_MATCH_MAX_DIST = 0.15

/** Injected catalog dependencies. When ABSENT, LiveVisionProvider behaves exactly as the vlm+web-only original. */
export interface CatalogDeps {
  catalog: Catalog
  embedder: EmbeddingProvider
}

/**
 * Assert a concrete year ONLY from a single unambiguous year token. A RANGE ("1998-2004", the schema's
 * `year_or_range`) or a multi-year string returns undefined so the year is left UNSUPPORTED and never asserted
 * as a specific make_model_year (the reveal must not claim a precise year it does not have).
 */
export function parseYear(s: string): number | undefined {
  const all = (s ?? '').match(/\b(1[89]\d\d|20\d\d)\b/g)
  return all && all.length === 1 ? Number(all[0]) : undefined
}

/**
 * Web verified_confidence (0..1) = how well the headline bestGuess is BACKED by the ranked webEntities, NOT the
 * raw (unbounded) entity relevance score. A bestGuess the entities do not actually name is NOT "verified" — this
 * stops a strong reverse-image match to a GENERIC/wrong label from clearing the webVerified bar on score alone.
 */
export function webConfidence(web: WebDetect): number {
  const entityHay = new Set(norm(web.entities.map((e) => e.description).join(' ')).split(' ').filter(Boolean))
  const bgToks = norm(web.bestGuess ?? '').split(' ').filter((t) => t.length > 2)
  const agree = bgToks.length ? bgToks.filter((t) => entityHay.has(t)).length / bgToks.length : 0
  const topScore = Math.min(1, web.entities[0]?.score ?? 0) // relevance weights are unbounded → cap before use
  return Math.min(1, 0.6 * agree + 0.4 * topScore)
}

/** Split a "make model" title into best-effort make/model for a derived catalog id + Candidate fields. */
function idFrom(make?: string, model?: string): string {
  return norm([make, model].filter(Boolean).join(' ')).replace(/ /g, '_') || 'unknown'
}

export class LiveVisionProvider implements VisionProvider {
  /**
   * Per-image embedding cache: analyze() computes the Vertex embedding ONCE; the host's post-ID upsert reuses it
   * (keyed by the b64 image) so we never pay for a second embed. Bounded so a long-lived provider can't grow
   * unbounded. Absent deps → this stays empty and unused.
   */
  private embedCache = new Map<string, number[]>()

  /**
   * Per-image VLM identity cache: the structured make/model analyze() derived, keyed by the b64 image. The
   * `confidence_band` stream event only carries display strings, so the host's post-ID upsert reads make/model
   * from HERE to derive a stable catalog id. Bounded alongside embedCache.
   */
  private vlmCache = new Map<string, { make?: string; model?: string }>()

  constructor(private catalogDeps?: CatalogDeps) {}

  /**
   * Compute (and cache) the image embedding. Returns undefined — swallowing the error — if no embedder is wired
   * or the Vertex call fails, so every caller degrades to the vlm+web-only path.
   */
  private async embedOnce(b64: string): Promise<number[] | undefined> {
    if (!this.catalogDeps) return undefined
    const cached = this.embedCache.get(b64)
    if (cached) return cached
    try {
      const emb = await this.catalogDeps.embedder.embedImage(b64)
      if (this.embedCache.size > 32) this.embedCache.clear() // simple bound; a scan uses one entry
      this.embedCache.set(b64, emb)
      return emb
    } catch {
      return undefined // GUARD: any embedding failure → no catalog stage, cascade proceeds vlm+web-only.
    }
  }

  async analyze(image: ImageRef): Promise<VisionStages> {
    const { b64, mime } = image.bytes ?? (await loadImageBytes(image.uri))
    const [vlm, web] = await Promise.all([geminiIdentify(b64, mime), visionWebDetect(b64)])

    // Strip non-answer filler from the identity fields (D-6) so "unbranded"/"unspecified"/"N/A" never pollute the
    // name/label/subject/catalog-id — but only when the field is WHOLLY filler (cleanField keeps real names) — then
    // strip a trailing " or <alt>" the VLM smuggled into a field ("Xbox Wireless Controller or wood").
    const make = cleanIdentityField(cleanField(vlm.make))
    const model = cleanIdentityField(cleanField(vlm.model))
    // A CONCRETE year only for the candidate name (parseYear → undefined for a range), never the verbose
    // "2020-present (Shock Blue color released 2021)" string that garbled the surfaced candidate.
    const yearNum = parseYear(vlm.year_or_range)
    // The brand READ off the object (distilled from the clean make, corroborated by the on-object text) — a grounded
    // observation that unblocks the brand-primary class without asserting an unconfirmed make/model (§13.1/§13.3).
    const readOff = [...(vlm.ocr_text ?? []), ...(vlm.distinguishing_features ?? []), vlm.display_title].filter(Boolean).join(' ')
    const observedBrand = observedBrandFrom(vlm.make, readOff)

    const vlmCandidate: Candidate = {
      name: [yearNum, make, model].filter(Boolean).join(' ').trim(),
      make,
      model,
      year: yearNum,
      source: 'vlm',
      confidence: vlm.fine_confidence ?? 0.5,
      category: vlm.category || undefined, // coarse class label — feeds PROBABLE class-level reveal enrichment
      displayTitle: cleanDisplayTitle(vlm.display_title), // clean human title (filler stripped) — display only
      observedBrand, // a read-off-the-object brand → routes brand research + citable as an `observation`
    }

    const stages: VisionStages = { vlm: vlmCandidate }
    const evidence: IdEvidence[] = []
    // The observed brand becomes ONE closed evidence row the narrator may cite as an `observation` — its claim is the
    // clean brand string, its "source" the observed sentinel (never a URL; the honesty gate lets it ground ONLY a
    // restatement of the mark, never a provenance/date claim). Exactly one row, PII-scrubbed (§13.1/§13.3).
    if (observedBrand) evidence.push({ ref: 'obs1', sourceUrl: OBSERVED_SOURCE_PREFIX, claim: observedBrand })

    // Remember the structured VLM identity for this image so the post-ID upsert can key on make/model (only
    // relevant when a catalog is wired; harmless otherwise).
    if (this.catalogDeps) {
      if (this.vlmCache.size > 32) this.vlmCache.clear()
      this.vlmCache.set(b64, { make: vlmCandidate.make, model: vlmCandidate.model })
    }

    // Neutralise a photo GENRE/medium bestGuess ("still life photography") — it must never become a surfaced
    // candidate nor a `contradicts` source (it dragged a good VLM identity to a bogus PROBABLE — the Xbox bug). But
    // KEEP the real reverse-image ENTITIES (they carry the true make/model), so `corroborates(web, vlm)` — which
    // ignores web.confidence — still promotes a genuine CONFIDENT reveal (adversarial #9). Drop the web stage only
    // when NOTHING usable survives (bestGuess junk/absent AND no non-genre entity).
    const bestGuessJunk = isGenreLabel(web.bestGuess)
    const usableEntities = web.entities.filter((e) => !isGenreLabel(e.description))
    if (web.bestGuess && (!bestGuessJunk || usableEntities.length > 0)) {
      stages.web = {
        // Blank the name for a junk bestGuess so a genre string never surfaces or contradicts; keep it otherwise.
        name: bestGuessJunk ? '' : web.bestGuess,
        source: 'web',
        // A junk bestGuess carries zero verified_confidence (never clears webVerified); real corroboration then
        // comes ONLY from the surviving entities via `corroborates`. Otherwise the usual bestGuess↔entity agreement.
        confidence: bestGuessJunk ? 0 : webConfidence(web),
        // The ranked reverse-image entities (genre labels stripped) — the real grounding the arbiter corroborates
        // the VLM against; the headline bestGuess is often a generic/foreign/genre label.
        aka: usableEntities.map((e) => e.description),
      }
      // Grounded evidence = the matching pages Vision found (the closed array the honesty gate later checks). Skip a
      // titleless page when the bestGuess is junk (never seed a genre string as a citable claim).
      web.pages.forEach((p, i) => {
        const claim = p.title || (bestGuessJunk ? '' : web.bestGuess!)
        if (claim) evidence.push({ ref: `web${i + 1}`, sourceUrl: p.url, claim })
      })
    }
    if (evidence.length) stages.evidence = evidence

    // ── Stage 3 (the moat): a prior-scan vector hit, injected BEFORE arbitration. Fully guarded — only runs with
    //    a catalog + embedder + a userId (the ACL key); ANY failure leaves `stages` exactly as vlm+web above. ──
    if (this.catalogDeps && image.userId) {
      try {
        const emb = await this.embedOnce(b64)
        if (emb) {
          const hits = await this.catalogDeps.catalog.searchPartitioned(emb, image.userId, 3)
          const best = hits[0]
          if (best && best.dist < CATALOG_MATCH_MAX_DIST) {
            // Inject the prior scan as a catalog Candidate. cosine SIMILARITY = 1 - dist (arbitration reads
            // `cosine`, matching catalog_search's contract). make/model are recovered from the stored id so the
            // arbiter can check model agreement; if they can't be split we still supply the name for step-6 fallback.
            const [mk, ...rest] = best.id.split('_')
            stages.catalog = {
              name: best.name,
              make: mk ? mk.replace(/_/g, ' ') : undefined,
              model: rest.length ? rest.join(' ') : undefined,
              source: 'catalog',
              confidence: Math.max(0, Math.min(1, 1 - best.dist)),
              cosine: Math.max(0, Math.min(1, 1 - best.dist)),
            }
          }
        }
      } catch {
        // GUARD: catalog/embedding error → drop Stage 3 silently; arbitration runs on vlm+web exactly as today.
      }
    }

    return stages
  }

  /**
   * Post-identification upsert of an ACCEPTED id as a PRIVATE catalog item (the moat GROWS with each scan). Called
   * by the host AFTER a CONFIDENT/PROBABLE reveal. Reuses the embedding cached in analyze() (no second embed).
   * Fully guarded: no deps, no userId, no cached embedding, or any DB error → a no-op. UNKNOWN is never upserted.
   */
  async upsertAccepted(userId: string, b64: string, result: Pick<IdentifyResult, 'label' | 'confidence_band'>): Promise<void> {
    if (!this.catalogDeps || !userId) return
    if (result.confidence_band !== 'CONFIDENT' && result.confidence_band !== 'PROBABLE') return
    try {
      const emb = await this.embedOnce(b64) // cached from analyze; recomputed only if evicted
      if (!emb) return
      // id is derived from make+model (the stable identity, dedupes the same object across scans) recovered from
      // the VLM identity analyze() cached for this image; fall back to the normalized label if that's absent.
      const vlm = this.vlmCache.get(b64)
      const id = vlm?.make || vlm?.model ? idFrom(vlm.make, vlm.model) : norm(result.label).replace(/ /g, '_')
      if (id === 'unknown' || !id) return // nothing concrete to key on → don't pollute the catalog
      await this.catalogDeps.catalog.upsert({
        id,
        name: result.label,
        ownerUserId: userId,
        visibility: 'private',
        embedding: emb,
      })
    } catch {
      // GUARD: upsert failure is non-fatal — the reveal already stood; the moat simply doesn't grow this scan.
    }
  }
}
