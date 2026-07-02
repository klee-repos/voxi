/**
 * Provides a single ApiClient bound to the current auth token + base URL, via React context.
 *
 * The client is rebuilt when the token getter identity changes; `getToken` always reads the live Clerk (or
 * Fake) session, so screens never thread tokens manually. The `fetchImpl` seam stays default in the app; the
 * E2E web harness injects the BFF directly when needed.
 */
import React, { createContext, useContext, useEffect, useMemo } from 'react'
import { ApiClient } from './apiClient'
import { useAuth } from './clerk'
import { config } from './config'
import { wireBilling } from './wireBilling'

const ApiContext = createContext<ApiClient | null>(null)

export function ApiProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { getToken } = useAuth()
  const client = useMemo(
    () => new ApiClient({ baseUrl: config.apiBaseUrl, getToken }),
    [getToken],
  )
  // Wire the StoreKit 2 billing seam (platform-split; no-op on web) with this client's server verifier.
  // Non-fatal: a wiring failure must never crash the app — purchases just fall back to the stub.
  useEffect(() => {
    try {
      wireBilling(client)
    } catch (err) {
      console.warn('[billing] seam wiring skipped:', err)
    }
  }, [client])
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error('useApi must be used within <ApiProvider>')
  return ctx
}
