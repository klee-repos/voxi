/**
 * Native (iOS/Android) platform impl — @sentry/react-native. This is the deliverable that matters most: crash
 * reporting from the real binary (native signal handlers + JS error handler + Hermes symbolication via the EAS
 * source-map upload configured by the Expo plugin in app.json).
 *
 * Sentry.wrap() around the router root is the documented Expo-Router integration (routing instrumentation +
 * native context); the shared VoxiErrorBoundary additionally captures React render errors.
 */
import type { ComponentType } from 'react'
import * as Sentry from '@sentry/react-native'
import { redactDeep } from '../../../../packages/telemetry/src/redact'

export function initClient(dsn: string, environment: string, release: string | undefined): void {
  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeSend(event) {
      try {
        return redactDeep(event)
      } catch {
        return null
      }
    },
  })
}

export function captureError(err: unknown, ctx?: Record<string, unknown>): void {
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined)
}

export function setClientUser(user: { id: string } | null): void {
  Sentry.setUser(user)
}

/** Wrap the router root so Sentry gets native context + Expo-Router instrumentation. */
export function wrapRootImpl<T>(component: T): T {
  return Sentry.wrap(component as ComponentType<Record<string, unknown>>) as T
}

export function flushClient(): Promise<boolean> {
  // @sentry/react-native's flush() takes no timeout arg (unlike the browser/node SDK).
  return Sentry.flush()
}
