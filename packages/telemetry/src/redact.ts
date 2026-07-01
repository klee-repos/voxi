/**
 * Redaction for structured-log fields. The BFF handles auth tokens and multi-megabyte photo data-URIs; none
 * of that may ever land in a log line (a repo rule: "bodies are never logged"). This strips sensitive keys
 * and neutralises data-URIs / oversized strings before anything is written or shipped.
 */

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|x-worker-secret|password|passwd|secret|token|api[-_]?key|apikey|jwt|bearer|clerk[-_]?secret|signing[-_]?key|continuation[-_]?token)$/i

const MAX_STRING = 2048

function redactValue(input: unknown, depth: number): unknown {
  if (depth > 6) return '[deep]'
  if (typeof input === 'string') return redactString(input)
  if (Array.isArray(input)) return input.map((v) => redactValue(v, depth + 1))
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1)
    }
    return out
  }
  return input
}

function redactString(s: string): string {
  if (s.startsWith('data:')) return `[data-uri ${s.length}b]`
  // A signed capability URL (the /media photo route) carries its HMAC in the query string, and the access log
  // records `pathname + search`. Neutralise sig/exp/u so a logged path can't be replayed within its TTL (A13) —
  // the route shape stays visible for debugging, the secret does not.
  if (s.includes('sig=')) s = s.replace(/([?&](?:sig|exp|u)=)[^&\s]*/gi, '$1[redacted]')
  if (s.length > MAX_STRING) return `${s.slice(0, 256)}…[+${s.length - 256}b]`
  return s
}

/** Redact a flat fields object destined for a log line. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0) as Record<string, unknown>
}
