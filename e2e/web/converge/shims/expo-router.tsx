/**
 * expo-router web shim for the converge scope ONLY.
 *
 * Two modes:
 *  1) SINGLE-SCREEN entries (camera-entry, reveal client, …) mount one screen with NO NavHost. `useRouter()`
 *     falls back to a recorder that writes the last navigation onto `<body data-last-nav>` so a Playwright
 *     assertion can verify the screen's navigation INTENT fired (the original converge behavior).
 *  2) FLOW entry (flow-entry) wraps the app in `<NavHost>`, a minimal real router: `push/replace/navigate/back`
 *     actually swap the rendered screen (routes map path → real screen component). This lets an agentic test
 *     click through camera → processing → reveal exactly as a user does, with the real Zustand store carrying
 *     the captured image + band across screens (the screens read state, not route params). Still records
 *     `data-last-nav` for assertions.
 *
 * Under the real Expo web build, expo-router IS present; this is a converge-scope stand-in. No app/ is edited.
 */
import React, { createContext, useContext, useMemo, useState } from 'react'

export interface Router {
  push: (href: string) => void
  replace: (href: string) => void
  navigate: (href: string) => void
  back: () => void
  // The universal AppHeader's guarded dismiss calls this (mirrors the real expo-router router). Single-screen
  // entries have no stack → false (so the header takes its deterministic replace-fallback branch); NavHost →
  // stack.length > 1. Without it, a header back-press throws `router.canGoBack is not a function` in converge.
  canGoBack: () => boolean
}

function record(kind: string, href: string): void {
  const w = globalThis as { document?: Document }
  if (w.document?.body) w.document.body.setAttribute('data-last-nav', `${kind}:${href}`)
}

const recordingRouter: Router = {
  push: (href) => record('push', href),
  replace: (href) => record('replace', href),
  navigate: (href) => record('navigate', href),
  back: () => record('back', ''),
  canGoBack: () => false, // single-screen mount → no parent, so the header falls back to replace(fallback)
}

const NavCtx = createContext<Router | null>(null)
const PathCtx = createContext<string>('/')

export function useRouter(): Router {
  return useContext(NavCtx) ?? recordingRouter
}
export function usePathname(): string {
  return useContext(PathCtx)
}
export function useLocalSearchParams<T = Record<string, string>>(): T {
  return {} as T
}
export function useSegments(): string[] {
  return []
}
export function Link(): null {
  return null
}
export function Redirect(): null {
  return null
}

// Accept both string hrefs and expo-router object hrefs (`{ pathname, params }`) — the auth screens use the
// object form for the sign-up↔sign-in switch (email prefill). Extract the pathname; drop the query.
const norm = (h: unknown): string => {
  const raw = typeof h === 'string' ? h : ((h as { pathname?: string } | null)?.pathname ?? '/')
  return raw.split('?')[0] ?? raw
}

/**
 * Minimal real router for the flow harness: swaps the rendered screen on navigation.
 *
 * `wrap` lets a persistent chrome component (e.g. the real DrawerHost) sit INSIDE the router context while staying
 * mounted across navigations. This matters: under real expo-router the drawer and the screens share one global
 * router, so a drawer row navigates. If DrawerHost were mounted OUTSIDE NavHost, its `useRouter()` would fall back
 * to the no-op recording router and drawer rows would only record (never navigate). Wrapping here fixes that while
 * keeping the drawer's open/closed state across screen swaps (Wrap is stable; only its child screen changes).
 */
export function NavHost({
  routes,
  initial,
  wrap: Wrap,
}: {
  routes: Record<string, React.ComponentType>
  initial: string
  wrap?: React.ComponentType<{ children: React.ReactNode }>
}): React.ReactElement {
  const [stack, setStack] = useState<string[]>([initial])
  const cur = stack[stack.length - 1] ?? initial
  const router = useMemo<Router>(
    () => ({
      push: (h) => {
        record('push', h)
        setStack((s) => [...s, norm(h)])
      },
      replace: (h) => {
        record('replace', h)
        setStack((s) => [...s.slice(0, -1), norm(h)])
      },
      navigate: (h) => {
        record('navigate', h)
        setStack((s) => {
          const n = norm(h)
          const i = s.indexOf(n)
          return i >= 0 ? s.slice(0, i + 1) : [...s, n]
        })
      },
      back: () => {
        record('back', '')
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
      },
      canGoBack: () => stack.length > 1,
    }),
    [stack.length],
  )
  const Comp = routes[cur] ?? routes['*']
  const body = Comp ? <Comp /> : null
  return (
    <NavCtx.Provider value={router}>
      <PathCtx.Provider value={cur}>{Wrap ? <Wrap>{body}</Wrap> : body}</PathCtx.Provider>
    </NavCtx.Provider>
  )
}
