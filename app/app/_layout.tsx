/**
 * Root layout — mounts every provider (PLAN §9) and the expo-router Stack.
 *
 * Provider order (outer→inner): SafeArea → Clerk auth → React Query → Theme → ApiClient.
 * The ApiClient depends on the auth token, so ApiProvider sits inside AuthProvider.
 */
import React from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from '../src/lib/clerk'
import { ApiProvider } from '../src/lib/api'
import { ThemeProvider, useTheme } from '../src/lib/themeProvider'
import { useReducedMotionSync } from '../src/lib/useReducedMotion'
import { DrawerHost } from '../src/components/Drawer'
import { parchment } from '../src/lib/theme'
import { useVoxiFonts } from '../src/lib/fonts'
import {
  initObservability,
  setObservabilityUser,
  VoxiErrorBoundary,
  wrapRoot,
} from '../src/lib/observability'

// Error monitoring — idempotent (index.js inits earliest on native; this backstops web + guarantees init before
// any provider renders). No-op without a DSN.
initObservability()

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
})

/** Tags Sentry events with the signed-in user (id only, no PII) so a native crash is attributable. */
function SentryUserSync(): null {
  const { userId } = useAuth()
  React.useEffect(() => {
    setObservabilityUser(userId ? { id: userId } : null)
  }, [userId])
  return null
}

/**
 * Keeps the theme's reduce-motion flag in sync with the OS/browser preference (PLAN §10.3), so the platform
 * setting is honored on first launch, not only after toggling it in Settings. Mounted inside ThemeProvider.
 */
function ReduceMotionBridge(): null {
  const { setReduceMotion } = useTheme()
  useReducedMotionSync(setReduceMotion)
  return null
}

/**
 * The global left push-drawer (design.md primary nav) wraps the WHOLE route Stack — not just `(tabs)` — so the
 * hamburger opens it on the camera home AND on the pushed capture flow (processing/reveal). Mounted inside every
 * provider `DrawerMenu` needs (Auth/Query/Theme/Api). `enabled={isSignedIn}` keeps the drawer + its edge-swipe
 * off the pre-auth screens (index/welcome/first-run).
 */
function AppShell(): React.ReactElement {
  const { isSignedIn } = useAuth()
  return (
    <DrawerHost enabled={isSignedIn}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: parchment.bg },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="welcome" />
        {/* Auth screens are PUSHED from the landing → slide in (the global default is 'fade', which would
            cross-fade under a back chevron and read as a broken transition). */}
        <Stack.Screen name="sign-up" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="sign-in" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="first-run" />
        {/* camera ⇄ reveal is a SWIPE between the same cached photo — NO screen cross-fade (that read as a "weird
            fade in / fade out" / a phantom loading state). Instant nav; the photo is identical, so the dock simply
            appears over it. `reveal` covers camera→reveal (+ the rare processing→reveal); `(tabs)` covers reveal→camera. */}
        <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
        <Stack.Screen name="processing" options={{ animation: 'fade' }} />
        <Stack.Screen name="reveal" options={{ animation: 'none' }} />
        {/* Deep Dive is a full-screen, dark, Spotify-style player (like `conversation`) — NOT a page-sheet. A
            'modal' page-sheet left a ~10% top gap over the reveal; 'fullScreenModal' covers the whole screen for
            both the composing (loading) and ready (playing) states. The dark surface then extends under the status
            bar, so the screen mounts its own light StatusBar (podcast.tsx). */}
        <Stack.Screen name="podcast" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="conversation" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="interview" />
        <Stack.Screen name="contribute" options={{ presentation: 'modal' }} />
        <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
      </Stack>
    </DrawerHost>
  )
}

function RootLayout(): React.ReactElement | null {
  // Load fonts before painting; on a load error, fall through to system fallbacks rather than hang on a blank screen.
  const [fontsLoaded, fontError] = useVoxiFonts()
  if (!fontsLoaded && !fontError) return null

  return (
    <VoxiErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <SentryUserSync />
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <ReduceMotionBridge />
              <ApiProvider>
                <AppShell />
              </ApiProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </VoxiErrorBoundary>
  )
}

// wrapRoot: native → Sentry.wrap (routing instrumentation + native context); web → identity.
export default wrapRoot(RootLayout)
