/**
 * Runtime configuration (public env only — all vendor secrets stay server-side per PLAN §9).
 *
 * On web (the E2E harness) the BFF is served under `/api` by e2e/web/server.ts, so the default base URL is
 * `/api`. On device, `EXPO_PUBLIC_API_BASE_URL` points at the Cloud Run BFF.
 */
import Constants from 'expo-constants'
import { Platform } from 'react-native'

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>

export const config = {
  apiBaseUrl:
    process.env.EXPO_PUBLIC_API_BASE_URL ??
    extra.apiBaseUrl ??
    (Platform.OS === 'web' ? '/api' : 'http://localhost:8787'),
  pipecatConnectUrl:
    process.env.EXPO_PUBLIC_PIPECAT_CONNECT_URL ?? extra.pipecatConnectUrl ?? '',
}

// Startup diagnostic: the endpoints the device is actually targeting.
// eslint-disable-next-line no-console
console.log(`[config] apiBaseUrl=${config.apiBaseUrl} pipecat=${config.pipecatConnectUrl || '(none)'}`)
