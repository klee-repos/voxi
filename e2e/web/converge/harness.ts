/**
 * harness.ts — shared converge plumbing (the boilerplate factored out of reveal-rnw.web.ts so each screen's
 * runner is just its assertions). Builds a real-component bundle with esbuild (RNW's blessed bundler), serves it
 * on top of the REAL voxi-api BFF (createWebHarness gives the production /api routes), and opens a real Chromium
 * via Playwright. The aliases below are EXACTLY what babel-preset-expo + Metro substitute on the real
 * `expo start --web` (see reveal-rnw.web.ts header + docs/CONVERGENCE.md). Nothing in app/ is edited.
 */
import path from 'path'
import { build as esbuild } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { createWebHarness, type HarnessOpts } from '../server'
import { PlaywrightDriver } from '../../framework/drivers/playwright'

const here = import.meta.dir
const cdir = (p: string) => path.resolve(here, p)
const dep = (m: string) => path.resolve(here, 'node_modules', m)
const sharedRoot = path.resolve(here, '../../../packages/shared/src')

// packages/shared/* — the app imports the shared contract by a relative path that Metro + the `@voxi/shared`
// tsconfig alias + watchFolders resolve to the workspace package on the real build. A plain bundler has neither,
// so we resolve any `…/packages/shared/src/<name>` specifier to the real file (the SAME substitution Metro does).
const resolverPlugin = {
  name: 'converge-resolver',
  setup(b: {
    onResolve: (
      opts: { filter: RegExp },
      cb: (args: { path: string }) => { path: string } | undefined,
    ) => void
  }) {
    b.onResolve({ filter: /packages\/shared\/src\// }, (args) => {
      const name = args.path.replace(/^.*packages\/shared\/src\//, '').replace(/\.ts$/, '')
      return { path: path.join(sharedRoot, name + '.ts') }
    })
  },
}

/** Build the browser bundle for a converge client entry (the tiny createRoot mount file). */
export async function buildConvergeBundle(clientEntry: string): Promise<string> {
  const result = await esbuild({
    entryPoints: [cdir(clientEntry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    // The app reads a few `process.env.EXPO_PUBLIC_*` flags at runtime (cameraPermission / config / clerk). On the
    // real web build these are inlined by babel; here we provide a browser `process.env` so those reads return
    // undefined and the screens take their PUBLIC defaults — exactly the unset-env web path (apiBaseUrl=/api,
    // camera permission undetermined→granted, FakeAuth). Static `process.env.NODE_ENV`/`__DEV__` are inlined above.
    // Metro's web runtime defines `global` (=== the global object); react-native-web internals reference
    // `global.performance.now()` (ScrollView/VirtualizedList) and `global.cancelAnimationFrame` /
    // `global.RN$Bridgeless` (Animated). esbuild does not, so shim `global` alongside `process` to reproduce
    // the real expo-web environment (a ScrollView or an Animated.loop/spring otherwise throws "global is not
    // defined" only in this bundle, never on the real build).
    banner: { js: 'globalThis.global=globalThis.global||globalThis;globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};' },
    loader: { '.js': 'jsx' },
    alias: {
      // the convergence boundary (see docs/CONVERGENCE.md) — exactly Metro's web substitutions.
      react: dep('react'),
      'react-dom': dep('react-dom'),
      zustand: dep('zustand'),
      'react-native': dep('react-native-web'),
      'expo-router': cdir('shims/expo-router.tsx'),
      'expo-image': cdir('shims/expo-image.tsx'),
      'expo-constants': cdir('shims/expo-constants.tsx'),
      'react-native-safe-area-context': cdir('shims/safe-area.tsx'),
      '@tanstack/react-query': cdir('shims/react-query.tsx'),
      // Native-only modules ABSENT on the web target: the app's seams lazily require() these inside try/catch
      // and fall back to deterministic web stubs (FakeAuth / web camera-permission / in-process voice session).
      // Aliasing to a throwing shim reproduces the SAME "not present on web" runtime path Metro/expo web takes.
      '@clerk/clerk-expo': cdir('shims/absent-native.tsx'),
      'expo-secure-store': cdir('shims/absent-native.tsx'),
      'expo-linking': cdir('shims/absent-native.tsx'),
      'react-native-vision-camera': cdir('shims/absent-native.tsx'),
      '@pipecat-ai/client-js': cdir('shims/absent-native.tsx'),
      '@pipecat-ai/react-native-small-webrtc-transport': cdir('shims/absent-native.tsx'),
      // Native-only motion/haptics polish (UI redesign). A `Platform.OS !== 'web'` guard is a BUILD-TIME no-op
      // for esbuild (it statically resolves every require/import string regardless of the guard), so these must
      // be aliased or the browser bundle breaks. reanimated/gesture-handler/skia → the throwing absent-native
      // stub: the app only ever lazily `require()`s them inside a native guard, so on web the require never runs
      // and the throw never fires. expo-haptics → a no-op shim: the haptics seam imports it at module top level,
      // so it must resolve to real bundleable web code, not a throw.
      'react-native-reanimated': cdir('shims/absent-native.tsx'),
      'react-native-gesture-handler': cdir('shims/absent-native.tsx'),
      '@shopify/react-native-skia': cdir('shims/absent-native.tsx'),
      'expo-haptics': cdir('shims/expo-haptics.tsx'),
      // Lucide icons render via react-native-svg (Fabric-native → breaks the esbuild browser bundle, and it's an
      // app-workspace dep the converge scope can't resolve). Icons are decorative chrome; stub them for converge.
      'lucide-react-native': cdir('shims/lucide.tsx'),
    },
    plugins: [resolverPlugin],
  }).catch((e: unknown) => {
    console.log('CONVERGE BUILD FAILED:\n', (e as Error).message)
    process.exit(1)
  })
  return result.outputFiles[0].text
}

// Classic <script> (not type="module"): the bundle is an IIFE, and a classic script keeps React's synthetic
// event system on the same realm/timing as the host page so Pressable→onClick handlers fire under Playwright.
// Real Expo web fills the viewport (root = 100vh, flex column) so a screen's `flex:1` chain has height. esbuild's
// bare host does not, which collapses full-bleed screens (all-absolute children → 0 content height). Give #root a
// concrete viewport height + a flex chain so the mounted app fills, exactly like `expo start --web`.
const HOST = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>converge</title><style>
html,body{height:100%;margin:0;padding:0}
#root{height:100vh;display:flex;flex-direction:column}
#root>*{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
</style></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>`

export interface ConvergeRig {
  base: string
  browser: Browser
  page: Page
  driver: PlaywrightDriver
  errors: string[]
  stop: () => Promise<void>
}

/**
 * Stand up the full rig: bundle `clientEntry`, serve it + the REAL BFF, open Chromium, return a PlaywrightDriver
 * plus a live `errors` array (any pageerror = a real mount failure the runner asserts is empty).
 */
export async function standUp(clientEntry: string, harnessOpts?: HarnessOpts, launchArgs?: string[]): Promise<ConvergeRig> {
  const bundleJs = await buildConvergeBundle(clientEntry)
  console.log('converge bundle built:', bundleJs.length, 'bytes (real screen under react-native-web, esbuild)')

  const harness = createWebHarness(harnessOpts ?? {})
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/') return new Response(HOST, { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/bundle.js') return new Response(bundleJs, { headers: { 'content-type': 'text/javascript' } })
      if (url.pathname.startsWith('/api/')) return harness.fetch(req)
      return new Response('not found', { status: 404 })
    },
  })
  const base = `http://localhost:${server.port}`

  // launchArgs lets a runner reproduce a real browser policy — e.g. `--autoplay-policy=user-gesture-required`,
  // which BLOCKS gesture-less autoplay exactly as a real browser/iOS does (so the spoken-reveal test proves a
  // single user tap plays it, instead of a retry loop papering over a UX defect).
  const browser = await chromium.launch(launchArgs ? { args: launchArgs } : undefined)
  const page = await (await browser.newContext()).newPage()

  // RNW press-readiness shim. react-native-web 0.21's Pressable resolves `onPress` through its ResponderSystem,
  // which (in this isolated esbuild IIFE bundle, under headless Chromium driven by Playwright) does not fire from
  // a synthetic click UNLESS `window.fetch` is a plain (non-native) function reference at load time — an observed,
  // reproducible quirk of the responder's event wiring vs the native-fetch receiver in this exact stack. We
  // install a transparent passthrough (identical behavior: it forwards every arg to the real fetch) BEFORE the
  // bundle loads. This changes NOTHING about the app's network behavior or the BFF it talks to; it only makes the
  // real screens' real onPress handlers fire so the press-driven flows are E2E-drivable. (The reveal proof needs
  // no taps post-settle, so it never hit this; the camera/threads/conversation screens are press-driven.)
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = (...args: Parameters<typeof fetch>) => realFetch(...args)
  })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const driver = new PlaywrightDriver(page)

  return {
    base,
    browser,
    page,
    driver,
    errors,
    async stop() {
      await browser.close()
      server.stop()
    },
  }
}

/** A tiny pass/fail harness identical in spirit to reveal-rnw.web.ts's `check`. Mutates+returns the fail count. */
export function makeChecker(): {
  check: (name: string, fn: () => Promise<void>) => Promise<void>
  fails: () => number
} {
  let fails = 0
  return {
    fails: () => fails,
    async check(name, fn) {
      try {
        await fn()
        console.log('  PASS', name)
      } catch (e) {
        fails++
        console.log('  FAIL', name, (e as Error).message)
      }
    },
  }
}
