/**
 * Root layout — mounts every provider (PLAN §9) and the expo-router Stack.
 *
 * Provider order (outer→inner): SafeArea → Clerk auth → React Query → Theme → ApiClient.
 * The ApiClient depends on the auth token, so ApiProvider sits inside AuthProvider. Routes:
 *   index           → entry redirect (auth gate)
 *   welcome         → email-first auth + EULA/age gate
 *   first-run       → "Meet Voxi" + permission priming + consent
 *   (tabs)          → camera (default landing) · threads · settings
 *   processing      → event-driven scan UX (modal-ish full screen)
 *   reveal          → entry card (parchment surface)
 *   podcast         → two-voice player (parchment read-along)
 *   conversation    → full-screen voice/keyboard
 *   interview       → unknown-item interview
 *   contribute      → add-a-tip sheet
 *   paywall         → limit / subscribe
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
})

/**
 * Seeds + keeps the theme's reduce-motion flag in sync with the OS/browser preference (PLAN §10.3), so a user
 * who has Reduce Motion on at the platform level gets the calm orb on first launch — not only after toggling
 * it in Settings. Mounted inside ThemeProvider; renders nothing.
 */
function ReduceMotionBridge(): null {
  const { setReduceMotion } = useTheme()
  useReducedMotionSync(setReduceMotion)
  return null
}

/**
 * The global left push-drawer (design.md primary nav) now wraps the WHOLE route Stack — not just `(tabs)` — so
 * the hamburger opens it in place on the camera home AND on the pushed capture flow (processing/reveal), which
 * previously had no drawer host. Mounted inside every provider `DrawerMenu` needs (Auth/Query/Theme/Api).
 * `enabled={isSignedIn}` keeps the drawer + its edge-swipe off the pre-auth screens (index/welcome/first-run),
 * which have no hamburger anyway — so their behavior is unchanged.
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
        <Stack.Screen name="first-run" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="processing" options={{ animation: 'fade' }} />
        <Stack.Screen name="reveal" />
        <Stack.Screen name="podcast" options={{ presentation: 'modal' }} />
        <Stack.Screen name="conversation" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="interview" />
        <Stack.Screen name="contribute" options={{ presentation: 'modal' }} />
        <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
      </Stack>
    </DrawerHost>
  )
}

export default function RootLayout(): React.ReactElement | null {
  // Load the design-system fonts (Nunito + Fraunces) before painting UI. On a
  // load error we fall through and render with system fallbacks rather than
  // hang on a blank screen. .ttf are bundled, so this resolves near-instantly.
  const [fontsLoaded, fontError] = useVoxiFonts()
  if (!fontsLoaded && !fontError) return null

  return (
    <SafeAreaProvider>
      <AuthProvider>
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
  )
}
