/**
 * Web / react-native-web platform impl (also what the E2E converge bundle uses). @sentry/react-native is
 * native-only; on web the correct SDK is @sentry/browser. Metro resolves `.native.ts` on device, esbuild + Metro
 * resolve this `.ts` on web — the repo's standard platform split (see nativeStartup / photo).
 */
import * as Sentry from '@sentry/browser'
import { redactDeep } from '../../../../packages/telemetry/src/redact'

export function initClient(dsn: string, environment: string, release: string | undefined): void {
  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Breadcrumbs auto-capture console/fetch/xhr strings — which include signed /media?sig= URLs and API URLs.
    // Drop them at the source; beforeSend is the value-aware backstop.
    maxBreadcrumbs: 0,
    integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs'),
    // Use the real global fetch as the transport's sender. @sentry/browser's default grabs an "un-instrumented"
    // fetch from a hidden iframe (to avoid capturing its own requests) — that trick silently no-ops under
    // react-native-web in the bundled/headless E2E, so nothing sends. It's safe to use the plain fetch here: we
    // disable breadcrumbs + tracing, so there's no self-instrumentation loop to dodge.
    transport: (opts) =>
      Sentry.makeFetchTransport(opts, typeof window !== 'undefined' ? window.fetch.bind(window) : fetch),
    beforeSend(event) {
      try {
        return redactDeep(event)
      } catch {
        return null
      }
    },
  })
  // A deterministic flush the E2E can await via page.evaluate (no arbitrary sleeps). Its mere presence also proves
  // init actually ran, so a mis-wired harness fails loudly instead of passing on an empty sink.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __voxiSentryFlush?: () => Promise<boolean> }).__voxiSentryFlush = () => Sentry.flush(2000)
  }
}

export function captureError(err: unknown, ctx?: Record<string, unknown>): void {
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined)
}

export function setClientUser(user: { id: string } | null): void {
  Sentry.setUser(user)
}

/** Web needs no root wrapper (the VoxiErrorBoundary handles render errors); return the component unchanged. */
export function wrapRootImpl<T>(component: T): T {
  return component
}

export function flushClient(): Promise<boolean> {
  return Sentry.flush(2000)
}
