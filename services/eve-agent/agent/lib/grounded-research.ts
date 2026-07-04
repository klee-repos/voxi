/**
 * grounded-research — the shared Firecrawl→GLM-5.2 grounding primitive. Firecrawl /v2/search returns real page
 * MARKDOWN (real URLs + real titles); GLM-5.2 then EXTRACTS claim-structured facts each with a VERBATIM quote copied
 * from that markdown. This is the ONE grounding path post-migration (native Google-Search grounding is gone): every
 * fact carries a real `sourceUrl` + a `quote` that is an exact substring of the fetched page, so the honesty gate's
 * `verifyQuote` + `sourceMatchesSubject` hold. Best-effort: empty docs / a throw → empty facts (callers degrade
 * honestly; never a fake success).
 */
import type { WebResearchProvider } from '../tools/web_research'
import { glmJSON } from './glm'
import { renderPrompt } from '../prompts'
import type { ProposedFact, FetchedSource } from '../subagents/researcher'

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

export interface GroundedFactsInput {
  web: WebResearchProvider
  /** the subject, rendered into the extract prompt. */
  subject: string
  /** the Firecrawl search query (caller-computed: the dossier brand-lane query, the researcher subject, etc.). */
  query: string
  /** scope flags forwarded to the extract prompt (item vs class; brand lane). */
  item: boolean
  brandLane?: boolean
  docChars?: number
  maxDocs?: number
}

/**
 * Firecrawl search→scrape → GLM-5.2 verbatim-quote extraction → `{facts, sources}`. Each fact's `sourceUrl` is the
 * real Firecrawl doc its quote was lifted from (no round-robin: per-fact attribution is the honesty property).
 */
export async function groundedFacts(input: GroundedFactsInput): Promise<{ facts: ProposedFact[]; sources: FetchedSource[] }> {
  const docs = await input.web.search(input.query, { limit: input.maxDocs ?? 6 })
  if (!docs.length) return { facts: [], sources: [] }
  const context = docs
    .map((d) => `SOURCE ${d.url} (${d.title}):\n${d.markdown.slice(0, input.docChars ?? 9000)}`)
    .join('\n\n---\n\n')
  const system = renderPrompt('research-extract.system.md', { item: input.item, brandLane: !!input.brandLane })
  const user = `Subject: ${input.subject}.\n\nSOURCES:\n${context}`
  const out = await glmJSON<{ facts?: ProposedFact[] }>(system, user, EXTRACT_SCHEMA, 0.2)
  const sources: FetchedSource[] = docs.map((d) => ({ url: d.url, title: d.title, text: d.markdown }))
  return { facts: out.facts ?? [], sources }
}
