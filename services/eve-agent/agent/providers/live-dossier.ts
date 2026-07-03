/**
 * LiveDossierProvider — the async deep-research step that produces the durable, fully-cited dossier and STREAMS
 * each verified fact as it clears the honesty gate (PROMPT-QUALITY §3.B/§3.C). It runs OFF the reveal path, so it
 * never blocks the instant reveal; the cascade yields its facts as late `fact` events on the same open stream.
 *
 * Two draft sources behind a seam (the honesty-critical `buildDossier` verification is identical for both):
 *   - FirecrawlGeminiDraft — the DEEP path: Firecrawl crawls the subject to real page MARKDOWN, then Vertex Gemini
 *     EXTRACTS 3–6 facts each with a VERBATIM quote copied from that markdown. `buildDossier` then verifies every
 *     quote is a real substring of the fetched page, is about the subject, and entails the fact. Needs FIRECRAWL_API_KEY
 *     (+ gcloud). This is the "encyclopedia-depth, provable" tier.
 *   - GeminiGroundingDraft — the creds-free FALLBACK: Vertex Gemini Google-Search grounding (gcloud only). Each
 *     grounded segment becomes a fact whose quote IS the grounded claim, paired with the source URL that grounds it.
 *
 * The provider tries the deep path first (when configured) and falls back to grounding if it yields nothing —
 * best-effort throughout; any failure ends the research with no facts and the reveal stands exactly as it was.
 */
import {
  buildDossier,
  type ProposedDossier,
  type ProposedFact,
  type FetchedSource,
  type DossierInput,
} from '../subagents/researcher'
import type { ResearchDossier, DossierFact } from '../../../../packages/shared/src/dossier'
import type { EntailmentJudge } from '../../../../packages/shared/src/confidence'
import { geminiJSON, geminiGrounded } from '../lib/gcp-vision'
import { factsFromGrounding } from './live-research'
import { renderPrompt } from '../prompts'
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

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          claimType: { type: 'string', enum: ['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative'] },
          quote: { type: 'string' },
          sourceUrl: { type: 'string' },
        },
        required: ['text', 'claimType', 'quote', 'sourceUrl'],
      },
    },
  },
  required: ['facts'],
}

/** DEEP path: Firecrawl markdown → Gemini extracts facts with verbatim quotes copied from that markdown. A WIDE
 *  net across the whole web (manufacturer, reviews, references — NOT Wikipedia-dependent): one Firecrawl search+scrape
 *  call returns `maxDocs` diverse sources, and a generous `docChars` gives the extractor real body PROSE (which
 *  quotes cleanly) instead of only a page's reformatting-prone spec table. More sources ⇒ more chances at ≥3 facts. */
export class FirecrawlGeminiDraft implements DossierDraftSource {
  constructor(private web: WebResearchProvider, private docChars = 9000, private maxDocs = 6) {}

  async draft(input: DossierInput): Promise<ProposedDossier> {
    // In the brand lane, ONE search LEADS with the brand ENTITY's identity + history (so the maker/facts ground on
    // the label's STORY — who they are, when founded, notable works — not a merch-store listing) and names the object
    // type only as trailing context for purpose. Leading with "merchandise"/the object type pulled the storefront and
    // starved the maker bucket (§13.2/§13.5 — a measured before/after regression). Retriever ranking follows order.
    const query = brandLaneQuery(input)
    const docs = await this.web.search(query, { limit: this.maxDocs })
    if (!docs.length) return { facts: [], sources: [] }
    const context = docs
      .map((d) => `SOURCE ${d.url} (${d.title}):\n${d.markdown.slice(0, this.docChars)}`)
      .join('\n\n---\n\n')
    const system = renderPrompt('research-extract.system.md', { item: input.scope === 'item', brandLane: !!input.brandLane })
    const user = `Subject: ${input.subject}.\n\nSOURCES:\n${context}`
    const out = await geminiJSON<{ facts?: ProposedFact[] }>(system, user, EXTRACT_SCHEMA, 0.2)
    const sources: FetchedSource[] = docs.map((d) => ({ url: d.url, title: d.title, text: d.markdown }))
    return { facts: out.facts ?? [], sources }
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

const guessType = (claim: string): ProposedFact['claimType'] =>
  /\b(1[89]\d\d|20\d\d)\b/.test(claim) ? 'date' : 'spec'

/** FALLBACK path: Vertex Gemini Google-Search grounding (gcloud only). The grounded segment IS the fact + quote. */
export class GeminiGroundingDraft implements DossierDraftSource {
  constructor(private timeoutMs = 8000) {}

  async draft(input: DossierInput): Promise<ProposedDossier> {
    const subject = groundingSubject(input)
    // Pass brandLane so research.system.md adds the entity-facts / never-assert-this-edition guard on the
    // creds-free grounding path (the Firecrawl extract prompt already has it; the grounding path lacked it — the
    // only edition guard on the prod path where there is no judge). The sync class researcher never sets brandLane,
    // so its rendered prompt is byte-unchanged (the golden holds).
    const system = renderPrompt('research.system.md', { item: input.scope === 'item', brandLane: !!input.brandLane })
    const user = renderPrompt('research.user.md', { subject })
    const { grounding } = await geminiGrounded(system, user, { timeoutMs: this.timeoutMs, temperature: 0.2 })
    const grounded = factsFromGrounding(grounding)
    // The grounding pipeline established subject-relevance by construction, so the source title carries the subject
    // (so `sourceMatchesSubject` reflects that the segment WAS retrieved for this subject).
    const sources: FetchedSource[] = grounded.map((g) => ({ url: g.sourceUrl, title: input.subject, text: g.claim }))
    const facts: ProposedFact[] = grounded.map((g) => ({
      text: g.claim,
      claimType: guessType(g.claim),
      sourceUrl: g.sourceUrl,
      sourceTitle: input.subject,
      quote: g.claim,
    }))
    return { facts, sources }
  }
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
 * Wire the dossier provider from the environment. FIRECRAWL_API_KEY present → the DEEP Firecrawl+Gemini path with a
 * Gemini-grounding fallback; absent → the grounding path alone (still real, on gcloud). Never throws — a missing
 * key just degrades the depth, never the reveal.
 */
export function dossierProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  judge?: EntailmentJudge,
): DossierProvider {
  const web = firecrawlFromEnv(env)
  const grounding = new GeminiGroundingDraft()
  return web
    ? new LiveDossierProvider(new FirecrawlGeminiDraft(web), grounding, judge)
    : new LiveDossierProvider(grounding, undefined, judge)
}
