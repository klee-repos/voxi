/**
 * Observability (Sentry) — the app-facing interface. Platform-agnostic; the actual SDK is picked by the
 * `./sentry` platform split (@sentry/react-native on device, @sentry/browser on web/E2E).
 *
 * Contract: OPTIONAL + FAIL-SOFT (no DSN → every entry point is an inert no-op; a broken SDK never throws into
 * the app), redaction gates every event (in the platform beforeSend), and one predicate decides what's worth
 * capturing. The E2E injects a same-origin DSN into `window.__VOXI_SENTRY_DSN__` to drive real capture.
 */
import React from 'react'
import { initClient, captureError, setClientUser, wrapRootImpl, flushClient } from './sentry'
import { shouldCapture } from './policy'

export { shouldCapture } from './policy'

declare const __DEV__: boolean

function resolveDsn(): string | undefined {
  // The E2E harness injects a same-origin DSN before the bundle evaluates; prod reads the build-time public env.
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __VOXI_SENTRY_DSN__?: unknown }).__VOXI_SENTRY_DSN__
    if (typeof injected === 'string' && injected.length > 0) return injected
  }
  return process.env.EXPO_PUBLIC_SENTRY_DSN || undefined
}

let inited = false

/** Idempotent. Safe to call from index.js (native), the root layout, and the E2E entry — first DSN wins. */
export function initObservability(): void {
  if (inited) return
  const dsn = resolveDsn()
  if (!dsn) return // disabled — no DSN, nothing to do
  const environment = typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production'
  const release = process.env.EXPO_PUBLIC_SENTRY_RELEASE || undefined
  try {
    initClient(dsn, environment, release)
    inited = true
  } catch {
    // Fail-soft: monitoring must never break app boot.
  }
}

export function isObservabilityEnabled(): boolean {
  return inited
}

/** Capture an error IFF the policy says it's an anomaly (not an expected business outcome). No-op when disabled. */
export function captureIfUnexpected(
  err: unknown,
  ctx?: { kind?: string | number } & Record<string, unknown>,
): void {
  if (!inited) return
  if (!shouldCapture(ctx?.kind)) return
  try {
    captureError(err, ctx)
  } catch {
    // never throw from the telemetry path
  }
}

export function setObservabilityUser(user: { id: string } | null): void {
  if (!inited) return
  try {
    setClientUser(user)
  } catch {
    /* ignore */
  }
}

/** For the E2E: force the transport to drain so an assertion isn't racing delivery. */
export function flushForTest(): Promise<boolean> {
  return inited ? flushClient() : Promise.resolve(true)
}

/** Wrap the router root (native: Sentry.wrap for routing/native context; web: identity). */
export function wrapRoot<T>(component: T): T {
  return wrapRootImpl(component)
}

/**
 * Catches React RENDER errors (which the global handler and Sentry.wrap do NOT) and reports them, then shows a
 * fallback. Deliberately our own (not Sentry's) so it behaves identically on native and web.
 */
export class VoxiErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError(): { hasError: true } {
    return { hasError: true }
  }
  componentDidCatch(error: unknown): void {
    captureIfUnexpected(error, { kind: 'render' })
  }
  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null
    return this.props.children
  }
}
