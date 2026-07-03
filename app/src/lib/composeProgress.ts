/**
 * Compose-progress — an HONEST "how long" estimate for the Deep Dive composing wait. There is NO real progress
 * fraction (the worker reports composing/ready only, no percent), so we must NEVER claim a truthful percentage or
 * hit 100% before the worker actually returns `ready`. Instead: an eased curve that keeps moving (so it never
 * looks stuck) but asymptotes below 1.0, PLUS the literal elapsed clock and an honest "usually ~2 min" label.
 *
 *   τ = typicalMs / 3;  progress = min(0.92, 1 − exp(−elapsedMs / τ))
 *
 * e.g. typical ~2 min → τ ≈ 40s → ~63% @ 1 min, ~95%→capped 0.92 @ 3 min, never 1.0 until the real `ready`
 * flips the UI. Tunable in ONE place; the UI binds a flat ring to this value (no fake ceiling, no lie).
 */

/** The soft cap the eased estimate approaches but never reaches (real `ready` is the only thing that shows 100%). */
export const PROGRESS_CAP = 0.92

/** Eased, capped compose progress in [0, PROGRESS_CAP]. Monotonic in elapsed; 0 for non-positive/invalid input. */
export function estimateProgress(elapsedMs: number, typicalMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const tau = Math.max(1, (Number.isFinite(typicalMs) && typicalMs > 0 ? typicalMs : 120_000) / 3)
  return Math.min(PROGRESS_CAP, 1 - Math.exp(-elapsedMs / tau))
}

/** Elapsed as a clock string from milliseconds ("m:ss", or "h:mm:ss" past an hour). Negative/invalid → "0:00". */
export function formatElapsed(ms: number): string {
  return formatClock((Number.isFinite(ms) ? ms : 0) / 1000)
}

/**
 * Map a scrubber tap/drag x (px, relative to the track's left edge) to an ABSOLUTE seek target in seconds.
 * Pure + platform-agnostic — native and react-native-web both feed a responder-event `locationX`. Returns null
 * when not yet seekable (unknown duration or an unmeasured track width) so the caller no-ops instead of seeking
 * to NaN. Clamped to [0, durationSec]. This is the exact position math the on-device scrubber runs.
 */
export function seekTargetSeconds(localX: number, trackWidth: number, durationSec: number): number | null {
  if (!Number.isFinite(localX) || !Number.isFinite(trackWidth) || trackWidth <= 0) return null
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null
  return Math.min(durationSec, Math.max(0, (localX / trackWidth) * durationSec))
}

/**
 * A media clock string from SECONDS: "m:ss" under an hour, "h:mm:ss" at/over an hour (matches the Spotify scrubber
 * "1:02" / "-1:03:18"). Negative/NaN/∞ → "0:00" (so an unloaded duration renders cleanly, never "NaN:NaN").
 */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}
