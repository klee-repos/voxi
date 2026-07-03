# Voxi app-icon generator

The Voxi app icons are **generated from SVG**, not hand-edited PNGs. `art.js` is the source of truth (the aurora
Orb — the same character the app renders in `app/src/components/Orb.tsx`); `generate.js` rasterizes it to every PNG
the Expo config consumes.

## Regenerate

```sh
cd scripts/icons
bun install        # installs @resvg/resvg-js + sharp locally (this folder is NOT a workspace, so these
                   # never touch the app / EAS bundle install)
node generate.js   # writes PNGs into app/assets/icon/** and app/assets/favicon.png
```

## What it emits (the "format iOS requires")

- `app/assets/icon/prod/{light,dark,tinted}.png` — 1024x1024, the iOS-18 appearance set. `light` is the App Store
  marketing icon: **opaque, no alpha, sRGB** (asserted by the generator). `tinted` is a grayscale luminance the
  system tints; `dark` is a deeper-ground variant for the dark home screen.
- `app/assets/icon/preview/icon.png`, `app/assets/icon/dev/icon.png` — 1024, the same Orb with a shifted ground hue
  and a `BETA` / `DEV` band so local + TestFlight + store builds are distinguishable at a glance.
- `app/assets/icon/android-foreground.png` — 1024, orb on transparent with adaptive safe-zone padding.
- `app/assets/favicon.png` — web favicon.
- `*.svg` next to each PNG — the exact source, committed for review/diff.

Expo generates every smaller iOS size from the 1024 at prebuild; `app.config.js` selects the per-variant icon by
`APP_VARIANT`.

## Notes / gotchas

- **Fonts:** the `BETA`/`DEV` band text renders via a system font (resvg `loadSystemFonts`, `defaultFontFamily`
  Helvetica). Run generation on macOS (where Helvetica/Arial exist). Prod has no text, so it's font-independent.
- **Seeing the new icon:** `app/ios/` is gitignored and Expo prebuilds it fresh, so a new icon only appears after
  `expo prebuild --clean` or an EAS build — not on a hot reload.
- **No-alpha:** `generate.js` flattens `light`/`dark`/badged icons on the opaque ground and asserts
  `hasAlpha === false` (Apple rejects a marketing icon with an alpha channel).
- Determinism is pinned by the exact `@resvg/resvg-js` + `sharp` versions in this folder's `package.json`.
