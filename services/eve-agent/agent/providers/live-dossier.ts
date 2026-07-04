/**
 * LiveDossierProvider — the async deep-research step that produces the durable, fully-cited dossier and STREAMS
 * each verified fact as it clears the honesty gate (PROMPT-QUALITY §3.B/§3.C). It runs OFF the reveal path, so it
 * never blocks the instant reveal; the cascade yields its facts as late `fact` events on the same open stream.
 *
 * ONE draft source behind a seam: FirecrawlGeminiDraft — the shared Firecrawl→OpenAI `groundedFacts` primitive
 * (lib/grounded-research). Firecrawl crawls the subject to real page MARKDOWN; OpenAI EXTRACTS facts each with a
 * VERBATIM quote copied from that markdown. `buildDossier` then verifies every quote is a real substring of the
 * fetched page, is about the subject (REAL titles now — the synthetic-title native-grounding fallback is gone, which
 * TIGHTENS sourceMatchesSubject), and entails the fact. Needs FIRECRAWL_API_KEY + OPENAI_API_KEY.
 *
 * Best-effort throughout; any failure ends the research with no facts and the reveal stands exactly as it was.
 */
import { buildDossier, type ProposedDossier, type DossierInput } from '../subagents/researcher'
import type { ResearchDossier, DossierFact } from '../../../../packages/shared/src/dossier'
import type { EntailmentJudge } from '../../../../packages/shared/src/confidence'
import { groundedFacts } from '../lib/grounded-research'
import { OPENAI_CALL_TIMEOUT_MS } from '../lib/openai'
import { firecrawlFromEnv, type WebResearchProvider } from '../tools/web_research'

/** A streamed research event: a verified fact (surfaced immediately), then the terminal dossier (or null). */
export type ResearchEvent =
  | { type: 'fact'; fact: DossierFact }
  | { type: 'done'; dossier: ResearchDossier | null }

export interface DossierProvider {
  research(input: DossierInput): AsyncGenerator<ResearchEvent>
}

/** Produces an UNVERIFIED draft (facts + fetched sources) the gate then verifies. */
export interface DossierDraftSource {
  draft(input: DossierInput): Promise<ProposedDossier>
}

/** DEEP path: Firecrawl markdown → OpenAI extracts facts with verbatim quotes copied from that markdown. A WIDE
 *  net across the whole web (manufacturer, reviews, references — NOT Wikipedia-dependent): one Firecrawl search+scrape
 *  call returns `maxDocs` diverse sources, and a generous `docChars` gives the extractor real body PROSE (which
 *  quotes cleanly) instead of only a page's reformatting-prone spec table. More sources ⇒ more chances at ≥3 facts.
 *  Thin wrapper over the shared `groundedFacts` primitive (lib/grounded-research) — the ONE Firecrawl→OpenAI grounding
 *  path used by the dossier, the live researcher, and the podcast worker alike.
 *
 *  RETRY + TIMEOUT mirror the podcast worker's `GroundedResearchProvider` (providers.ts:144-153): a transient OpenAI
 *  throw OR an empty-facts extract is retried up to `maxAttempts`, and the OpenAI call itself is bounded by `timeoutMs`
 *  (default `OPENAI_CALL_TIMEOUT_MS`) so a hung call throws instead of hanging the reveal. After `maxAttempts` it
 *  THROWS (not "return empty") — `LiveDossierProvider.buildFrom` catches → done:null, so the reveal stands as-is. */
export class FirecrawlGeminiDraft implements DossierDraftSource {
  constructor(
    private web: WebResearchProvider,
    private docChars = 9000,
    private maxDocs = 6,
    private timeoutMs: number = OPENAI_CALL_TIMEOUT_MS,
    private maxAttempts: number = 3,
  ) {}

  async draft(input: DossierInput): Promise<ProposedDossier> {
    // Brand lane LEADS with the entity's identity + history (see brandLaneQuery) — leading with the object type pulled
    // the storefront and starved the maker bucket (§13.2/§13.5). Retriever ranking follows order.
    let lastErr = 'dossier draft failed'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const r = await groundedFacts({
          web: this.web,
          subject: input.subject,
          query: brandLaneQuery(input),
          item: input.scope === 'item',
          brandLane: !!input.brandLane,
          docChars: this.docChars,
          maxDocs: this.maxDocs,
          timeoutMs: this.timeoutMs,
        })
        if (!r.facts.length) { lastErr = 'dossier draft: no facts extracted'; continue }
        return r
      } catch (e) {
        lastErr = 'dossier draft: ' + (e as Error).message
      }
    }
    throw new Error(`${lastErr} (after ${this.maxAttempts} attempts)`)
  }
}

/**
 * The DEEP-path (Firecrawl) search query for a brand/maker lane — LEADS with the entity's identity + history (who
 * they are, when founded, what they are known for), trailing the object type only as context. Leading with the
 * object type / "merchandise" pulled the storefront and STARVED the maker (§13.2/§13.5 — a measured regression).
 * The noun is generalized from "brand or record label" → "company, brand, maker or label" so it fits a hardware
 * MAKER (Xbox/Microsoft) as well as a record label (Sub Pop). Non-brand-lane → the plain subject. Pure + exported
 * so a unit test pins the history-first lead (the only artifact that catches a wording regression at `bun test`).
 */
export function brandLaneQuery(input: DossierInput): string {
  if (input.brandLane)
    return `${input.subject} — company, brand, maker or label: history, founding, what they are best known for, and its ${input.objectType ?? 'merchandise'}`
  // Item (make+model) lane: LEAD with the subject (retrieval stays centered on it), then append a WHEN-IT-WAS-MADE
  // angle + the corroborated year hint so the crawl reaches the model's production-date page (fills the `made`
  // bucket). Class scope stays the bare subject — a category has no specimen production date to seek.
  if (input.scope === 'item')
    return `${input.subject}${input.year ? ` ${input.year}` : ''} — history and key facts, including when it was made: its production years, model years, or release date`
  return input.subject
}

/** The grounding-path (Gemini Search) subject phrasing — same entity-first framing, same generalized noun. */
export function groundingSubject(input: DossierInput): string {
  return input.brandLane
    ? `the maker "${input.subject}" — the company, brand, maker or label behind this ${input.objectType ?? 'object'} (who they are, their history, what they are best known for, and why they make things like this)`
    : input.scope === 'item'
      ? `the ${input.subject}${input.year ? ` (${input.year})` : ''}, including when it was made — its production years or release date`
      : `the category of object: ${input.subject}`
}

export class LiveDossierProvider implements DossierProvider {
  constructor(
    private primary: DossierDraftSource,
    private fallback?: DossierDraftSource,
    private judge?: EntailmentJudge,
  ) {}

  private async buildFrom(source: DossierDraftSource, input: DossierInput): Promise<ResearchDossier | null> {
    try {
      const proposed = await source.draft(input)
      const r = buildDossier(input, proposed, { judge: this.judge })
      return r.ok ? r.dossier : null
    } catch {
      return null
    }
  }

  async *research(input: DossierInput): AsyncGenerator<ResearchEvent> {
    let dossier = await this.buildFrom(this.primary, input)
    if ((!dossier || dossier.facts.length === 0) && this.fallback) {
      const fb = await this.buildFrom(this.fallback, input)
      if (fb && fb.facts.length) dossier = fb
    }
    if (!dossier) {
      yield { type: 'done', dossier: null }
      return
    }
    // Surface each verified fact progressively (the cascade assigns the stream `index`).
    for (const fact of dossier.facts) yield { type: 'fact', fact }
    yield { type: 'done', dossier }
  }
}

/**
 * Wire the dossier provider from the environment. The ONE path is Firecrawl→OpenAI (groundedFacts); a missing
 * FIRECRAWL_API_KEY degrades to an empty dossier — the reveal stands as-is, never a fake success. (Prod asserts the
 * key at boot via assertProdKeys, so this no-op branch is dev-only.) Never throws.
 */
export function dossierProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  judge?: EntailmentJudge,
): DossierProvider {
  const web = firecrawlFromEnv(env)
  if (!web) return { async *research() { yield { type: 'done', dossier: null } } }
  return new LiveDossierProvider(new FirecrawlGeminiDraft(web), undefined, judge)
}
