/**
 * Display helpers for a source CITATION on the reveal BucketCard (the "Sources" list).
 *
 * Native-safety: this ships to RN (Hermes) with NO `react-native-url-polyfill`, where `new URL().hostname` is
 * unreliable — so the hostname is extracted with a small regex, never `new URL()`. (The server-side
 * `registrableDomain` in `packages/shared/src/moderation.ts` uses `new URL()` and stays server-only.)
 *
 * Honesty: the creds-free default deployment grounds facts via Vertex, whose source URLs are opaque
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/…` proxies — NOT a real publisher. We never render a
 * proxy host (it would read as "vertexaisearch…" / Title-cased "Google"); such rows are suppressed entirely.
 */

/** The minimal source shape these helpers consume — a structural subset of `RevealFact`/`RevealSection`. */
export interface RevealSource {
  sourceUrl: string
  sourceTitle?: string
}

/** Extract the bare, lower-cased hostname from a URL WITHOUT `new URL()` (Hermes-safe). '' when not derivable. */
function hostnameOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)
  if (!m || !m[1]) return ''
  let host = m[1]
  const at = host.lastIndexOf('@')
  if (at !== -1) host = host.slice(at + 1) // strip userinfo
  host = host.replace(/:\d+$/, '') // strip :port
  return host.toLowerCase()
}

const looksLikeUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim())

/**
 * True for an opaque Vertex grounding-redirect URL whose host is a proxy, not a real publisher — never displayable.
 */
export function isRedirectHost(url: string): boolean {
  if (/grounding-api-redirect/i.test(url)) return true
  const h = hostnameOf(url)
  return h === 'vertexaisearch.cloud.google.com' || h.endsWith('.vertexaisearch.cloud.google.com')
}

/** The muted "which site" line: hostname minus a leading `www.`; '' when not derivable or a suppressed proxy. */
export function sourceHost(url: string): string {
  if (!url || isRedirectHost(url)) return ''
  return hostnameOf(url).replace(/^www\./, '')
}

/** Title-case the registrable-domain SLD into a display name: en.wikipedia.org → "Wikipedia", canon.com → "Canon". */
function siteName(host: string): string {
  const labels = host.replace(/^www\./, '').split('.').filter(Boolean)
  if (labels.length === 0) return ''
  // registrable SLD = second-to-last label (naive; fine for a *display* name — no public-suffix list needed).
  const sld = labels.length >= 2 ? labels[labels.length - 2] : labels[0]
  if (!sld) return ''
  return sld.charAt(0).toUpperCase() + sld.slice(1)
}

/**
 * The source's display label: prefer a real page title; else a prettified site name from the hostname; else ''.
 * Returns '' for a redirect-proxy URL with no real title — the row is then dropped by `dedupeSources`.
 */
export function sourceLabel(url: string, title?: string): string {
  const t = (title ?? '').trim()
  if (t && !looksLikeUrl(t)) return t // a real, non-URL title always wins
  if (isRedirectHost(url)) return '' // opaque proxy + no real title → non-displayable
  const host = hostnameOf(url)
  return host ? siteName(host) : ''
}

/**
 * Collapse sources to one row per unique URL (order-preserving), dropping any whose URL is falsy, a `voxi:` sentinel,
 * or a grounding-redirect proxy — so the citation list never renders a dead, duplicate, or proxy row. The verbatim
 * quote is NOT carried here: it stays on the fact/prose row it grounds (per-fact proof, §3.3).
 */
export function dedupeSources<T extends RevealSource>(sources: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const s of sources) {
    const url = s.sourceUrl
    // Truthy check FIRST so `undefined.startsWith` is unreachable (What yields `sourceUrl: undefined`).
    if (!url || url.startsWith('voxi:') || isRedirectHost(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(s)
  }
  return out
}
