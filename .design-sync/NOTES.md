# design-sync NOTES — Voxi

Repo-specific gotchas for syncing the Voxi design system to claude.ai/design. Read this first on every re-sync.

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

## cardMode overrides applied
- `Screen` → column; `ConfirmDialog` → single 390x420. (Add overlay overrides for RecentCard / RevealMoreMenu /
  BucketCard / DrawerHost if their sheets escape/collapse — decide from the render.)

## Known render warns
- (none recorded yet)

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
