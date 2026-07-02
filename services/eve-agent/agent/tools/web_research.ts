/**
 * web_research — the eve agent's web tools (PROMPT-QUALITY §3.B1). A `WebResearchProvider` seam with a live
 * Firecrawl implementation; used by the researcher (to gather sources for the dossier) AND by the root agent live
 * in conversation ("tell me more" → a fresh grounded lookup). Firecrawl gives real page MARKDOWN, so the
 * researcher can lift a VERBATIM quote for the provenance loop (quote ⊆ source), which reverse-image page titles
 * never could. Best-effort + timeout-bounded; a `FIRECRAWL_API_KEY`-absent construction returns null so callers
 * degrade to the Gemini-grounding fallback (see providers/live-dossier.ts), never a fake success.
 */

/** A fetched web document — the URL, its page title, and the main-content markdown (the quote must be found here). */
export interface WebDoc {
  url: string
  title: string
  markdown: string
}

export interface WebResearchProvider {
  /** Search the web for `query` and return the top results already scraped to markdown (search+scrape in one). */
  search(query: string, opts?: { limit?: number }): Promise<WebDoc[]>
  /** Scrape a single known URL to markdown (used for a live conversation follow-up on a specific page). */
  scrape(url: string): Promise<WebDoc | null>
}

const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev'

/** Live Firecrawl (v2 /search + /scrape). Returns null from the factory when no key is configured (loud-degrade). */
export class LiveFirecrawl implements WebResearchProvider {
  constructor(
    private apiKey: string,
    // Search+scrape of several full, large pages (a Wikipedia article can be 100k+ chars) routinely takes 30–60s;
    // deep research runs ASYNC off the reveal path (the reveal is already shown), so a generous budget just means
    // MORE facts, never a slower reveal. Too tight and the deep path times out and silently degrades to the thin
    // grounding fallback (the 2-facts-instead-of-7 failure we saw on Game Boy's 129k-char page).
    private timeoutMs = 60000,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${FIRECRAWL_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs), // best-effort: a hung crawl can never stall the async research
    })
    const j = (await r.json()) as T
    if (!r.ok) throw new Error(`firecrawl ${path}: ${JSON.stringify(j).slice(0, 200)}`)
    return j
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<WebDoc[]> {
    // v2 /search with scrapeOptions returns each result already scraped to markdown (main content only). In v2,
    // `data` is an OBJECT keyed by source ({web, news, images}); older shapes returned `data` as a flat array — so
    // accept both.
    type Row = { url?: string; title?: string; markdown?: string; metadata?: { title?: string } }
    const j = await this.post<{ data?: Row[] | { web?: Row[] } }>(
      '/v2/search',
      { query, limit: opts.limit ?? 4, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } },
    )
    const rows: Row[] = Array.isArray(j.data) ? j.data : (j.data?.web ?? [])
    return rows
      .filter((d) => d.url && d.markdown)
      .map((d) => ({ url: d.url!, title: d.title || d.metadata?.title || '', markdown: d.markdown! }))
  }

  async scrape(url: string): Promise<WebDoc | null> {
    const j = await this.post<{ data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } } }>(
      '/v2/scrape',
      { url, formats: ['markdown'], onlyMainContent: true },
    )
    const d = j.data
    if (!d?.markdown) return null
    return { url: d.metadata?.sourceURL ?? url, title: d.metadata?.title ?? '', markdown: d.markdown }
  }
}

/** Factory: a LiveFirecrawl when `FIRECRAWL_API_KEY` is set, else null so the caller uses the grounding fallback. */
export function firecrawlFromEnv(env: Record<string, string | undefined> = process.env): WebResearchProvider | null {
  const key = env.FIRECRAWL_API_KEY
  return key ? new LiveFirecrawl(key) : null
}
