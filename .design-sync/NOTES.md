# design-sync NOTES — Voxi

Repo-specific gotchas for syncing the Voxi design system to claude.ai/design. Read this first on every re-sync.

## Upload status (first sync DONE — future runs are re-syncs)

- The initial upload **completed 2026-07-03** into claude.ai/design project **"Voxi"**
  (`projectId` pinned in `config.json`: `7aa4c428-76f1-4143-bd16-5fa4b2c8ba00`). All 36 components,
  200 files, render-check clean, all previews graded good. The prior blocker was auth only (design scopes
  weren't on the token) — resolved via `/design-login`.
- Because `projectId` is now pinned **before** any future run starts, re-syncs take the **atomic path**
  (verify everything, then upload in one pass) — not the incremental path this first sync used. Fetch the
  project's `_ds_sync.json` → `.design-sync/.cache/remote-sync.json` and run `resync.mjs --remote …`.
- **`finalize_plan` `localDir` gotcha:** pass an **absolute** path (`/Users/kvnlee/dev/voxi/ds-bundle`),
  NOT `./ds-bundle`. The tool resolved the relative path against the shell's persisted cwd (which a prior
  `cd …/ds-bundle` had moved), producing `…/ds-bundle/ds-bundle` → ENOENT. Same applies to any `localPath`.

## What this DS is (the big picture)

Voxi is a **React Native / Expo app**, NOT a conventional web component library. There is **no Storybook and
no compiled `dist/`**. The "design system" is `design.md` (tokens) + `app/src/lib/theme.ts` (token impl) +
`app/src/components/*.tsx`. Components are built from `react-native` primitives and only render in a browser via
**react-native-web**. So this sync is deliberately OFF the converter's default path — it works because:

- **`.design-sync/entry.ts`** is a hand-written barrel that re-exports the web-safe component sources (NEVER a
  `.native.tsx`, never `app/src/lib/fonts.ts` which imports `.ttf` and has no esbuild loader). It also re-exports
  `ThemeProvider`/`SurfaceProvider` (for the preview provider) and the `dark`/`parchment` surface tokens (for the
  few components that take a `surface` prop). Its first line MUST stay `import './preamble'`.
- **`.design-sync/preamble.ts`** sets the RN-web runtime globals (`global`, `process`, `__DEV__`) that Metro's web
  runtime provides but a bare esbuild bundle does not — RNW's ScrollView/Animated reach them. Must be the FIRST
  import so it evaluates before any RNW module.
- **`.design-sync/tsconfig.bundle.json`** — the converter reads its `compilerOptions.paths` (via
  `tsconfigPathsPlugin`) to remap bare specifiers: `react-native` → `react-native-web`, and every Expo/native
  module → the repo's own proven converge shims in `e2e/web/converge/shims/`. This is EXACTLY the alias map in
  `e2e/web/converge/harness.ts` (the E2E convergence harness that already renders these screens under RNW).
  **Gotcha:** the converter's tsconfig comment-stripper is naive — do NOT put `//`-style comments or a `"//"` key
  in this file, or `JSON.parse` mangles it and the paths silently don't load (bundle then tries to parse the real
  Flow-typed `react-native` and dies with "Unexpected typeof").
- **`.design-sync/fonts.css`** — ships the brand fonts (Nunito UI sans, Fraunces wordmark, Open Sans fallback)
  from `@expo-google-fonts/*` `.ttf` files, wired via `cfg.extraFonts`. The `@font-face` family names MUST match
  the RN instance names verbatim (e.g. `Nunito_600SemiBold`) because RNW sets `font-family` to that string. Only
  the 11 weights `fonts.ts` actually loads are shipped. Verified: both Nunito AND Fraunces render in the capture.
- **`.design-sync/rnw-rootfix.ts`** (imported second in the entry) — renames RNW's injected
  `<style id="react-native-stylesheet">`. Its id starts with "r", which collides with
  `package-validate`'s render-check root selector `querySelectorAll('#root, [id^="r"]')`: the empty
  stylesheet becomes `roots[0]` → **every authored preview falsely reports `rootEmpty`/`bad`** even though
  it renders perfectly. RNW caches the CSSOM sheet ref at creation, so renaming the id is safe. Do NOT remove
  this — without it the whole render-check gate is a false red.
- **`--node-modules ./app/node_modules`** (deps live there via bun workspace symlinks into `node_modules/.bun`).
- **Build:** `[CSS_RUNTIME]` is EXPECTED and non-blocking — RNW injects styles at runtime (CSS-in-JS), so the
  bundle self-styles; there is no shipped stylesheet. Do not chase it or set `cfg.cssEntry`.

## The build / verify commands

```sh
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./app/node_modules --entry ./.design-sync/entry.ts --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
```
Chromium for the render check is already cached (`~/Library/Caches/ms-playwright/chromium-1208|1228`); playwright
1.61.1 is installed in `.ds-sync/node_modules` — no browser download needed.

**Extra dep on re-sync:** the staged-scripts install must ALSO include `lucide-react` (real icons — see below):
`(cd .ds-sync && npm i esbuild ts-morph @types/react playwright@1.61.1 lucide-react)`.

## Icons — REAL lucide (not the converge stub)

`tsconfig.bundle.json` aliases `lucide-react-native` → `.ds-sync/node_modules/lucide-react/dist/esm/lucide-react.mjs`
(NOT the converge `shims/lucide.tsx` empty-View stub). `lucide-react` renders real DOM `<svg>` icons that display
correctly inside RNW View trees (same `size`/`color`/`strokeWidth` prop API as `lucide-react-native`), so
PlayerTransport / AppHeader / RevealDock / RevealMoreMenu / CaptureOrb / BucketDock show their real glyphs. All 26
icon names the app uses exist in lucide-react (verified). If a future app version imports an icon lucide-react
lacks, that component throws "Element type is invalid" — add the icon or re-stub.

## Provider + surface conventions (for authored previews)

- Global provider = `ThemeProvider` (parchment/cream surface). Every preview is auto-wrapped.
- **Parchment (cream) components** → wrap the cell in `<View style={{ backgroundColor:'#F4F1E8', padding:24 }}>`.
- **Dark-shell components** (camera/voice/deep-dive/reveal-over-photo) → wrap in
  `<SurfaceProvider surface="dark"><View style={{ backgroundColor:'#17181A', padding:24 }}>…</View></SurfaceProvider>`.
- A few components take a `surface` PROP (not context): `KaraokeTranscript`, `ConfirmDialog`, `BucketDock`,
  `BucketCard`. Import `{ dark, parchment }` from `'voxi'` and pass it.
- Previews import components from `'voxi'`, layout from `'react-native'`; NO `import React` (automatic JSX); NO
  types (esbuild strips them) — inline realistic data, cast complex objects `as any`.

## Component-specific gotchas

- **CameraView** — DROPPED. Its web variant renders `null` (native-only viewfinder); it's not in the DS.
- **DrawerHost** — DROPPED. It's a structural host (mounts DrawerMenu + the slide animation), no standalone visual.
- **DrawerMenu** — KEPT. Reads `useApi()` + `useAuth()` (both throw without their provider). Its preview wraps in
  `AuthProvider` + `ApiProvider` (both exported from the barrel); `AuthProvider` picks FakeAuth via
  `EXPO_PUBLIC_TEST_MODE=1` (set in `preamble.ts`). The `['me']` query has no server → settles to signed-in chrome.
- **RecentCard** — renders correctly on a REAL clock (validate uses one; the app does too), but its entrance
  `Animated.Value(0)→1` tween never advances under `package-capture`'s FROZEN clock (`page.clock.setFixedTime`),
  so its grading capture is BLANK. It is graded good from the real-clock render (validate contact sheet + a manual
  `?story=` real-clock probe). If a re-sync re-captures it blank, that's the same artifact — confirm via a
  real-clock render, don't regrade to needs-work. (BucketCard/ConfirmDialog avoid this by seeding their
  Animated.Value to the settled value under reduceMotion.)
- **`useDrawer()`** (AppHeader, DrawerMenu) no-ops without a `DrawerHost` provider — renders fine standalone.
- **CatalogTile** — uses `expo-image`; no network in the capture sandbox, so a remote `photoUrl` paints blank.
  Feed an inline `data:image/svg+xml;…` URI; also show the `photoUrl: null` branch (different code path). Grid
  tiles are `flex:1`/`aspectRatio:1` — wrap in a fixed `180x180` view.
- **ConfirmDialog** — absolute-fill overlay; takes `surface`/`reduceMotion` as props + 3 required testId strings.
  Override: `cfg.overrides.ConfirmDialog = {cardMode:single, viewport:390x420}` (already set).
- **Screen** — full-width surface container; `cfg.overrides.Screen = {cardMode:column}` (already set). Wrap in a
  fixed-height View so its `flex:1` has a box.
- **CodeInput** — set `autoFocus={false}` in previews; a partial value (`'4821'`) best shows the active-cell border.
- **Text primitives** (Title/Wordmark/Body/Muted) paint transparent — always give a backdrop.

## Known render warns
- **AudioElement** — headless by design: renders an invisible DOM `<audio controls=false>`, no visual chrome. Its
  preview shows it in a labelled frame. A `[RENDER_BLANK]`/`variants identical` warn on it is EXPECTED, not a defect.
- **RecentCard** — blank in `package-capture` (frozen-clock artifact, see above). Not a new warn.

## cardMode overrides applied (final)
Screen/AppHeader/TextField/ErrorState/CodeInput/LegalNote/SafetyRefusal/Scrubber → `column` (full-width / grid
overflow). ConfirmDialog/RevealMoreMenu → `single 390x420`; LoadingOverlay → `single 390x480`;
RecentCard → `single 390x520`; ComposeHero/BucketCard → `single 390x560` (overlays / phone-sized full-bleed).

## Re-sync risks (what can silently go stale)
- **Shim drift:** the aliases point at `e2e/web/converge/shims/*`. If the app adds a new native dep a component
  imports, add a matching alias to `tsconfig.bundle.json` (and, if needed, a shim). A missing alias surfaces as an
  esbuild "Could not resolve" or a Flow-syntax parse error at build.
- **Font paths** in `fonts.css` point at `app/node_modules/@expo-google-fonts/*/<weight>/<Instance>.ttf`. A
  version bump of those packages keeps the path (per-weight subdir) but verify if a build shows `[FONT_DANGLING]`.
- **`dtsPropsFor`** is hand-written (no `.d.ts` tree exists to auto-extract from). If a component's props change in
  source, update its `dtsPropsFor` entry — nothing auto-detects the drift.
- **RNW version:** `react-native` aliases to `app/node_modules/react-native-web/dist/index.js`. A major RNW bump
  could change rendering; re-verify the contact sheets.
