/**
 * Redaction for structured-log fields AND outbound error-monitoring events. The BFF handles auth tokens and
 * multi-megabyte photo data-URIs; none of that may ever land in a log line or reach Sentry (a repo rule:
 * "bodies are never logged"). This strips sensitive keys and neutralises secrets by VALUE — the latter matters
 * because an error's message or a captured source line can embed a credential no key-name guards.
 */

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|__session|__client|x-worker-secret|password|passwd|secret|token|api[-_]?key|apikey|jwt|bearer|clerk[-_]?secret|signing[-_]?key|continuation[-_]?token)$/i

const MAX_STRING = 2048

function redactValue(input: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return '[deep]'
  if (typeof input === 'string') return redactString(input)
  if (Array.isArray(input)) return input.map((v) => redactValue(v, depth + 1, maxDepth))
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1, maxDepth)
    }
    return out
  }
  return input
}

/**
 * Neutralise secrets embedded ANYWHERE in a string. Key-name checks miss the highest-risk vectors — a thrown
 * Error whose message interpolates the Postgres DSN, or a captured stack-frame source line — so we mask by value:
 * data-URIs, URL userinfo credentials (the live DATABASE_URL password), vendor keys, Bearer tokens, JWTs.
 */
function redactString(s: string): string {
  if (s.startsWith('data:')) return `[data-uri ${s.length}b]`
  s = s
    // embedded data-URI (mid-string, e.g. inside an error message)
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,][^\s"'>)\]]+/gi, '[data-uri]')
    // URL userinfo credentials — scheme://user:password@host (postgres/redis/etc connection strings)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[redacted]@')
    // vendor secret keys (stripe/clerk shaped), OAuth, Bearer, JWT
    .replace(/\b[rspk]k_(?:live|test)_[A-Za-z0-9]{6,}/g, '[redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, '[jwt]')
  // A signed capability URL (the /media photo route) carries its HMAC in the query string, and the access log
  // records `pathname + search`. Neutralise sig/exp/u so a logged path can't be replayed within its TTL (A13).
  if (s.includes('sig=')) s = s.replace(/([?&](?:sig|exp|u)=)[^&\s]*/gi, '$1[redacted]')
  if (s.length > MAX_STRING) return `${s.slice(0, 256)}…[+${s.length - 256}b]`
  return s
}

/** Redact a flat fields object destined for a log line (shallow by design). */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0, 6) as Record<string, unknown>
}

/**
 * Deep value-aware scrub of an arbitrarily-nested object — for a whole Sentry event, whose secrets hide in
 * exception stack frames (context_line / vars / abs_path) far deeper than a log field. No shallow depth cap.
 * Returns a redacted copy of plain JSON-shaped data.
 */
export function redactDeep<T>(value: T, maxDepth = 64): T {
  return redactValue(value, 0, maxDepth) as T
}

/** Mask secrets embedded in a single string (exported for callers scrubbing one field at a time). */
export { redactString }
