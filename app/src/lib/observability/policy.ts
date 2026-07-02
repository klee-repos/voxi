/**
 * The capture policy — a single pure predicate so "is this error worth a Sentry event?" lives in ONE place and
 * is unit-testable without a browser or the SDK. Mirrors the backend's shouldCaptureServer.
 *
 * Skip EXPECTED business outcomes (they're product states, not anomalies, and would burn the 5k/mo free quota +
 * cause alert fatigue). Capture genuine anomalies: uncaught JS, render errors, 5xx, transport failures.
 *   - 402 payment_required — the paywall, expected.
 *   - safety_refusal — a moderated identification, expected.
 *   - hard_failure — the Guide lost the thread; has first-class retry UI AND is already captured server-side
 *     (the cascade runs in-process in the BFF), so a client capture would double-report.
 */
const EXPECTED = new Set(['payment_required', 'safety_refusal', 'hard_failure'])

/** `kind` is an HTTP status (number), a stream/error code (string), or undefined (an uncaught throw → capture). */
export function shouldCapture(kind: string | number | undefined): boolean {
  if (kind === undefined) return true
  if (typeof kind === 'number') return kind >= 500
  return !EXPECTED.has(kind)
}
