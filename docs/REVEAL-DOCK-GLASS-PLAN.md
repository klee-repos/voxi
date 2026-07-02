# Reveal dock — icon alignment + Liquid Glass material — PLAN

Status: **IMPLEMENTED + VERIFIED (2026-07-02).** Gates passed: `/plan-eng-review` (6 findings folded) → 6-lens
adversarial workflow (14 raw → 7 confirmed → all resolved, §10) → implemented → **full TS suite 391/0**, app typecheck
(0 errors in the changed files; expo-blur + expo-glass-effect resolve), `lint:selectors`, converge **reveal-rnw** GREEN
(incl. the 2 new deterministic assertions: dock `justify-content:space-between` + a translucent `backdrop-filter`
material), converge **reveal-agentic** GREEN (autonomous real-click run), and 3 visual screenshots (alignment flush at
default + 375px; glass blurred-not-white; morph card a clean thick frosted sheet with the dock hidden beneath it).
Author: Claude. Date: 2026-07-02.
Scope: `app/src/components/RevealDock.tsx` + `app/app/reveal.tsx` + `app/src/lib/theme.ts` + one new `GlassSurface`
component (web + native). Two asks:

1. **Alignment.** The reveal dock's `Title` is left-aligned but the icon row below it is centered — the row's
   left/right edges don't match the title. Apply **space-between** to the icon group so the icons span the same
   width and share the same start (left) as the title. (Visual consistency.)
2. **Material.** Replace the dock's flat **white** background (`surface.surface` = `#FFFFFF`) with **Liquid Glass**
   (Apple, *Adopting Liquid Glass*): a translucent, blurred, specular material floating over the full-bleed photo.

## 0. Why these two, precisely

The reveal READY screen is a full-bleed captured **photo** with a compact **floating card** at the bottom holding
the identification title + a 5-icon dock (`RevealDock.tsx` `BucketDock`). Today:

- `reveal.tsx:237` — `floatCard` = `{ backgroundColor: surface.surface }` (opaque white `#FFFFFF`) + shallow `shadow`.
- `RevealDock.tsx:311` — `styles.dock` = `flexDirection:'row', justifyContent:'center', alignItems:'flex-start',
  gap: space.xs`. Because the group is narrower than the card and **centered**, the first icon does **not** align
  with the title's left edge (the ask #1 defect). `styles.iconWrap` (`:312`) is `width:56, alignItems:'center'`.
- `RevealDock.tsx:249` — the morph `BucketCard` also uses `{ backgroundColor: surface.surface }` (white), over a
  `scrim`-dimmed photo.

A photo backdrop with a floating control layer is the canonical **Liquid Glass** use case (a translucent material
that samples and blurs the content behind it). This plan makes the dock (and, for consistency, the morph card) that
material, and fixes the icon alignment in the same file.

## 1. Locked decisions

- **D1 — Alignment = full-width `space-between`, edges flush with the title.** `styles.dock` →
  `justifyContent:'space-between'` and stretch to the card's content width so the **left edge of the first icon**
  and the **right edge of the last icon** line up with the title text (flush to `floatCard`'s content box).
  Correct the optical inset (glyph circle is 44 centered inside a 56 wrap) with a symmetric negative horizontal
  margin **derived from the token widths, not a magic number** (eng-review A1): `ICON_WRAP = 56`, `ICON_CIRCLE = 44`,
  `const DOCK_EDGE_INSET = -(ICON_WRAP - ICON_CIRCLE) / 2` → the *visible circles* (not the invisible wrap boxes)
  align with the title edges. Verified by a computed-style assertion + screenshot, not by eye.
- **D2 — The `·`-divider is dropped in favor of even distribution.** With `space-between` across all five icons the
  divider would consume a full spacing slot and read as clutter. The blue **Ask** lane stays set off by its color
  (`accentSecondary`) + caption (design.md two-lane), which is sufficient signal; `styles.divider` and its render
  are removed. (Design-review may re-add a zero-width absolutely-positioned hairline that claims no flex slot;
  default = remove.)
- **D3 — Liquid Glass is a cross-platform `GlassSurface` component, native-split like `AudioElement`.**
  - `GlassSurface.tsx` (**web + converge**, the *verified* deliverable): translucent warm tint +
    `Platform.OS==='web'` `backdropFilter:'blur(24px) saturate(150%)'` (RNW 0.21 supports & auto-prefixes it) + a
    hairline specular border. No native dependency → the converge esbuild bundle resolves this file (it ignores
    `.native.tsx`, proven by `AudioElement`) and needs **zero new aliases**.
  - `GlassSurface.native.tsx` (**iOS/Android**): true iOS 26 Liquid Glass via `expo-glass-effect` `GlassView` when
    `isLiquidGlassAvailable()`; falls back to `expo-blur` `BlurView` (`tint:'light'`, `intensity` from the token);
    final fallback = the shared translucent tint. **Decided (you): add both deps** (`expo install expo-blur
    expo-glass-effect`). This path is device/iOS-gated — not verifiable in this environment — so it is built to the
    documented APIs and the WEB path carries the acceptance proof. Native needs a `npx expo prebuild` + device
    rebuild (flagged in §6).
- **D4 — Warm-tinted glass, not cold system glass — reconciled with `design.md`.** `design.md` reserves pure white
  for floating cards and warns against a second accent hue; a cold gray Apple-system glass would read off-brand. So
  the material tint is **warm** (parchment-derived), green/blue stay the only accents.
- **D5 — Contrast is a design-system token with an automated AA guard, not an eyeball.** The tint's **alpha is
  contrast-load-bearing**: over a bright photo, dark title text (`sepia900 #262524`) on a too-transparent glass could
  fail WCAG AA. The tint is defined in `theme.ts` (`glass` token, D6) at an opacity high enough that `#262524`
  clears **AA (≥4.5)** composited over the worst case (white photo). Target `rgba(255,255,255,0.62)` (tunable
  0.55–0.72). A **`theme.test.ts` unit test** composites the tint over `#FFFFFF` and asserts the ratio ≥ 4.5, so a
  future alpha drop fails CI instead of silently harming readability (eng-review Q3).
- **D6 — The material is a first-class design token in `theme.ts`** (eng-review Q2). Add a `glass` token
  `{ tint, tintStrong, border, blur, intensity }` consumed by BOTH `GlassSurface.tsx` and `.native.tsx`, so the
  material can never drift between platforms and lives in the design system (design.md is the source of truth).
- **D7 — `GlassSurface` OWNS the shadow + radius + clip split; call sites stay clean (DRY, eng-review Q1).** Blur
  materials need `overflow:'hidden'` to clip to `borderRadius`, but `shadow` needs `overflow:'visible'`. Rather than
  repeat the outer-wrapper dance at each call site, `GlassSurface` renders `<Outer shadow+radius><Inner glass
  radius+overflowHidden>{children}</Inner></Outer>` internally, taking `radius` + optional `shadow` props. Call
  sites become `<GlassSurface radius={radius.xl} shadow style={...}>…</GlassSurface>`.
- **D8 — Behavior, IDs, and the honesty spine are untouched.** No change to any `testID`, `data-*`, bucket state
  machine, audio, or the store. Every existing converge/E2E/unit assertion stays green unchanged.
- **D9 — Both the dock face AND the morph card get glass** (consistency). `floatCard` (over the photo) and
  `BucketCard.card` (over the scrim) both become `GlassSurface`. The small `iconCircle` chips stay warm solids
  (controls *on* the glass, matching Apple's glass-on-glass treatment).

## 2. Detailed design

### 2.1 Alignment (`RevealDock.tsx`)

```
const ICON_WRAP = 56, ICON_CIRCLE = 44
const DOCK_EDGE_INSET = -(ICON_WRAP - ICON_CIRCLE) / 2   // = -6; flush the outer CIRCLES to the title edges

styles.dock:
-  { flexDirection:'row', alignItems:'flex-start', justifyContent:'center', gap: space.xs, marginTop: space.md, flexWrap:'nowrap' }
+  { flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between',
+    marginTop: space.md, marginHorizontal: DOCK_EDGE_INSET, flexWrap:'nowrap' }
styles.iconWrap: width: ICON_WRAP            // reference the constant, not a literal 56
styles.iconCircle: width: ICON_CIRCLE, height: ICON_CIRCLE
```

- Remove `styles.divider` and its `<View style={styles.divider}/>` render (`:157`, `:319`). Ask stays set off by
  blue + caption (D2).
- Drop `gap: space.xs` (space-between now owns distribution). Keep `iconWrap` width 56 (captions like "Purpose"
  need ~50px; the caption stays centered under the glyph).
- **375px budget check:** 5 × 56 = 280px of wraps; a 375px screen minus `floatCard` `paddingHorizontal: space.lg`
  (16×2) minus `floatWrap` `paddingHorizontal: space.md` (12×2) = 319px content. 319 − 280 = 39px free → ~9.75px
  between each of the 4 gaps. Positive → no overlap, ≥44pt targets preserved. On wide screens `floatCard`
  `maxWidth:460` caps it and space-between spreads within that.

### 2.2 Design token (`theme.ts`, new)

```ts
/** Liquid Glass material (Apple "Adopting Liquid Glass"), warm-tinted to design.md's palette. The tint alpha is
 *  contrast-load-bearing: theme.test.ts asserts #262524 clears AA composited over white. Consumed by both
 *  GlassSurface variants so the material never drifts between web and native. */
export const glass = {
  tint: 'rgba(255,255,255,0.62)',        // dock face over a photo — AA-guaranteed for #262524 over white
  tintStrong: 'rgba(255,255,255,0.72)',  // morph card over the scrim (already dimmed; can go a touch denser)
  border: 'rgba(255,255,255,0.55)',      // specular hairline edge
  blur: 24,                              // px, web backdrop-filter radius
  saturate: 1.5,                         // web backdrop-filter saturation boost (color "pops" through glass)
  intensity: 40,                         // native BlurView intensity (0-100)
} as const
```

### 2.3 `GlassSurface` component (new, DRY-owns the wrapper — D7)

`app/src/components/GlassSurface.tsx` (web/converge + safe default):

```tsx
import React from 'react'
import { View, Platform, StyleSheet, type ViewStyle } from 'react-native'
import { glass, shadow as shadowToken } from '../lib/theme'

export interface GlassSurfaceProps {
  children?: React.ReactNode
  style?: ViewStyle | ViewStyle[]      // outer sizing/positioning (margins, width, maxWidth…)
  radius?: number                       // corner radius (applied to both wrapper + clipped glass)
  padding?: number                      // inner content padding
  shadow?: boolean                      // lift off the photo
  strong?: boolean                      // use the denser tint (morph card over the scrim)
  testProps?: Record<string, unknown>   // spread tid(...) onto the OUTER node when a call site needs it
}

export function GlassSurface({ children, style, radius = 0, padding = 0, shadow, strong, testProps }: GlassSurfaceProps): React.ReactElement {
  // Web: backdrop-filter is a CSS prop RN core's ViewStyle doesn't type; RNW 0.21 renders + auto-prefixes it.
  const web = Platform.OS === 'web'
    ? ({ backdropFilter: `blur(${glass.blur}px) saturate(${glass.saturate})`, WebkitBackdropFilter: `blur(${glass.blur}px) saturate(${glass.saturate})` } as ViewStyle)
    : null
  return (
    <View {...testProps} style={[shadow ? shadowToken : null, radius ? { borderRadius: radius } : null, style]}>
      <View style={[styles.glass, { borderRadius: radius, padding, backgroundColor: strong ? glass.tintStrong : glass.tint }, web]}>
        {children}
      </View>
    </View>
  )
}
const styles = StyleSheet.create({
  glass: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border },
})
```

`app/src/components/GlassSurface.native.tsx` (device-gated; **never** entered by esbuild):

```tsx
import React from 'react'
import { View, StyleSheet } from 'react-native'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { BlurView } from 'expo-blur'
import { glass, shadow as shadowToken } from '../lib/theme'
import type { GlassSurfaceProps } from './GlassSurface'

export function GlassSurface({ children, style, radius = 0, padding = 0, shadow, strong, testProps }: GlassSurfaceProps): React.ReactElement {
  const clip = { borderRadius: radius, overflow: 'hidden' as const, padding }
  const Inner = isLiquidGlassAvailable() ? (
    <GlassView glassEffectStyle="regular" style={[clip, StyleSheet.absoluteFill]} />
  ) : (
    <BlurView tint="light" intensity={glass.intensity} style={[clip, StyleSheet.absoluteFill]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: strong ? glass.tintStrong : glass.tint }]} />
    </BlurView>
  )
  return (
    <View {...testProps} style={[shadow ? shadowToken : null, radius ? { borderRadius: radius } : null, style]}>
      <View style={[clip, { borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border }]}>
        {Inner}
        <View style={{ padding }}>{children}</View>
      </View>
    </View>
  )
}
```

> The two files share `GlassSurfaceProps` (imported from the base file by the native file — a type-only import, so
> esbuild never pulls the native file). The native layout (absolute blur layer behind padded content) is built to
> the documented `expo-blur` / `expo-glass-effect` APIs; it is device-verified by you after the prebuild.

### 2.4 Call sites — do NOT animate the backdrop-filter node on web (eng-review P2)

- `reveal.tsx` `floatCard`: `<GlassSurface radius={radius.xl} padding={space.lg} shadow style={styles.floatCard}>…`
  Remove the opaque `backgroundColor` and the inline `shadow`/`paddingHorizontal`/`paddingVertical` (now owned by
  GlassSurface). `styles.floatCard` keeps only `width:'100%', maxWidth:460`.
- `RevealDock.tsx` `BucketCard`: the morph animates `opacity`+`translateY`+`scale` (`:233-241`). **Animating a
  backdrop-filter node forces the browser to re-sample the blurred backdrop every frame → jank.** So the animated
  `Animated.View` gets the transform + opacity ONLY; the glass material sits on a **non-animated inner**
  `GlassSurface` (`strong`, over the scrim). Structure:
  `<Animated.View style={[styles.cardWrap, cardStyle]}><GlassSurface radius={radius.xl} padding={space.lg} shadow
  strong testProps={tidWith(ids.reveal.bucketCard,{bucket})}>…</GlassSurface></Animated.View>`. The scrim (`:248`)
  and the reduce-motion cross-fade path are unchanged. `tidWith(ids.reveal.bucketCard,{bucket})` still lands on a
  real node so the E2E `data-bucket` assertion holds.
- The loading-state `loadingPill` (`reveal.tsx:166`) already uses a translucent dark fill; out of scope, unchanged.

### 2.5 Stacked-blur cost (eng-review P1 — noted, accepted)

When the morph card is open it sits over the (also-glass) dock face → two stacked backdrop-filters. For a static
control layer this is acceptable on web and standard on native (the card's scrim dims the dock behind it anyway).
If device profiling later shows jank, the cheap mitigations are: drop the dock-face blur while a card is open, or
lower `glass.blur`. Not doing either now (no evidence of a problem; reversibility is one token edit).

## 3. Converge / E2E safety (no cheating, nothing weakened)

- **Bundle:** `GlassSurface.tsx` (base) is what esbuild resolves; imports only `react-native` + `theme`. No new
  alias, no native module in the browser bundle. `.native.tsx` (expo-blur/expo-glass) is never seen by esbuild
  (default `resolveExtensions` has no `.native.tsx`; `AudioElement.native.tsx` proves the pattern).
- **backdropFilter on RNW:** RNW 0.21 lists `backdropFilter` in View style types and auto-prefixes `-webkit-` (in
  `modules/prefixStyles/static.js`) → renders in headless Chromium → visible + computed-style-assertable in converge.
- **Assertions:** `reveal-rnw.web.ts` / `reveal-agentic.web.ts` assert `testID`s, `data-state`, audio round-trips,
  nav intents — none touch background color, the divider, or `justifyContent`. Removing the divider `View` removes
  no `testID`. Every existing assertion holds unchanged.

## 4. File-by-file

| File | Change |
|---|---|
| `app/src/lib/theme.ts` | **+`glass` token** (tint/tintStrong/border/blur/saturate/intensity). |
| `app/src/lib/theme.test.ts` | **+AA-contrast test**: `#262524` over `glass.tint` composited on white ≥ 4.5:1. |
| `app/src/components/GlassSurface.tsx` | **NEW** — web/converge material; owns shadow+radius+clip (DRY). |
| `app/src/components/GlassSurface.native.tsx` | **NEW** — iOS 26 `GlassView` → `BlurView` fallback. |
| `app/src/components/RevealDock.tsx` | `styles.dock` → space-between + `DOCK_EDGE_INSET`; remove `styles.divider` + render; `BucketCard` → non-animated `GlassSurface` inside the animated wrapper. |
| `app/app/reveal.tsx` | `floatCard` → `GlassSurface radius padding shadow`; drop opaque `backgroundColor`. |
| `app/package.json` | `expo install expo-blur expo-glass-effect` (native only; absent from converge bundle). |
| `e2e/web/converge/reveal-rnw.web.ts` | **+2 deterministic visual assertions** (§5): dock `justify-content:space-between`; glass surface renders `backdrop-filter` (not opaque white). |
| `docs/REVEAL-DOCK-GLASS-PLAN.md` | this plan. |

No changes to: any `testID`/registry, `captureStore`, events, BFF, narrator, or existing E2E assertions.

## 5. Test & verification plan

```
CODE / TOKEN                                          VISUAL / E2E (real render)
[+] theme.glass token                                 [→VISUAL] converge /?scan=confident screenshot:
  └── [★★★ ADD] theme.test.ts: #262524 over tint         ├── 5 icons span the card width; icon-1 left ≈ title left,
        composited on #FFFFFF ≥ 4.5:1 (AA guard, D5)      │     icon-5 right ≈ title right (alignment)
[+] GlassSurface.tsx (web)                               ├── dock reads as frosted glass over the photo, not white
  ├── renders children + shadow wrapper + clip          └── title / whatItIs legible (AA) over the glass
  └── web branch sets backdropFilter               [→E2E ADD] reveal-rnw.web.ts (DETERMINISTIC, no eyeball):
[+] GlassSurface.native.tsx (device-only, built to      ├── getComputedStyle(dock).justifyContent === 'space-between'
      expo-glass/expo-blur API; user device-verifies)    └── getComputedStyle(glass surface).backdropFilter contains
[+] existing suites UNCHANGED-GREEN (no logic touched)         'blur(' AND backgroundColor is not opaque #fff (rgba a<1)
  ├── bun test (whole TS suite)                     [→E2E] reveal-rnw.web.ts existing checks: UNCHANGED-GREEN
  ├── bun run typecheck (incl. new .tsx + .native.tsx  [→E2E] reveal-agentic.web.ts: UNCHANGED-GREEN (agent opens
  │     against expo-blur/expo-glass types)                What/Facts, Ask nav) — REAL CLICKS, the user's ask
  └── bun run lint:selectors (no testID delta)       [→VISUAL] :8081 dev web (Playwright, REAL expo-image photo behind
                                                             glass) — the memory verify path: bright photo → blur+contrast
                                                       [→VISUAL] 375px width: no icon overlap, ≥44pt, captions un-clipped

COVERAGE: new token + web component + 2 platform files; 1 AA unit test; 2 deterministic E2E visual assertions;
          3 screenshot gates; every existing suite unchanged-green.
```

Acceptance = all existing suites green + the AA unit test + the two new deterministic converge assertions +
the three visual gates (alignment flush, glass visible, text legible) + the agentic real-click run green.

## 6. Failure modes & risks

| Risk | Test / error handling | User sees | Silent? |
|---|---|---|---|
| backdrop-filter not applied by RNW → flat tint, no blur | new converge assertion checks computed `backdrop-filter` contains `blur(` | flat translucent tint (still "not white") if it ever regresses | **no** — asserted |
| Text unreadable over a bright photo | `theme.test.ts` AA guard + bright-photo screenshot | dark title stays ≥AA by the tint floor | **no** — CI + screenshot |
| `space-between` + removed divider loses the Ask "lane" set-off | design-review + screenshot | Ask still blue + captioned | no |
| BlurView/GlassView clip vs shadow conflict on native | `GlassSurface` owns the outer-shadow / inner-clip split (D7) | correct rounded glass with lift | device-verified |
| Animating a backdrop-filter node janks the morph | P2 fix: blur on non-animated inner, transform on outer | smooth 240ms morph | no |
| New native deps force a prebuild the user must run | flagged; `expo install` keeps typecheck green; web path carries the proof | one `npx expo prebuild` + rebuild | no — flagged |
| esbuild resolves `.native.tsx` and pulls expo-blur | default `resolveExtensions` excludes it; `AudioElement.native.tsx` proves it | n/a | no |

## 7. NOT in scope (considered, deferred)

- Glass-ifying the LOADING-state `loadingPill` / other dark-shell chrome — the ask is the reveal dock; the pill is
  already a non-white translucent fill.
- Reconciling `theme.ts` ↔ `design.md` palette drift (a pre-existing, separately-tracked task per CLAUDE.md).
- iOS 26 `GlassView` interactive/morphing effects (`isInteractive`, glass-to-glass transitions) — baseline static
  glass first; motion later if desired.
- Removing/redesigning the `iconCircle` chips — they stay as warm solids on the glass (intentional, D9).

## 8. What already exists (reused, not rebuilt)

- The dock + `floatCard` + `BucketCard` structure, all `testID`s, and the bucket state machine — reused as-is; this
  is a style-only overlay on top.
- The `.native.tsx` / base `.tsx` platform-split convention (`AudioElement`, `CameraView`) — the exact pattern
  `GlassSurface` follows; no new build mechanism invented.
- `theme.ts` tokens (`shadow`, `radius`, `space`, `surface`) + `theme.test.ts` a11y-contrast harness — extended,
  not duplicated.
- The converge computed-style capability (Playwright `page.evaluate`) — already used for `currentTime`/attrs;
  reused for the new alignment + glass assertions.

## 9. Worktree parallelization

Sequential — all changes funnel through `app/src/` (theme → GlassSurface → the two call sites in the same two
files) with a tight dependency chain (token → component → call sites → e2e assertions). No independent lanes;
one worktree.

## 10. Adversarial review — 7 confirmed findings & resolutions (SUPERSEDES §2.2–2.4 where noted)

A 6-lens red-team + per-finding verification + completeness critic (14 raw → 7 confirmed) forced a **design pivot**:
stop *wrapping* the cards in a glass container (which is what broke the ScrollView height-chain, the bottom-sheet
shape, and the padding), and instead drop an **absolute-fill glass layer (`GlassFill`)** as the first child of the
*existing, unchanged* `floatCard` / `styles.card`. The cards keep every current style (paddings, `maxHeight:'80%'`,
top-only radius, flex children); only `backgroundColor` is removed and the glass layer is inserted behind content.

- **AF1 [P1] — AA guard was inert; fix = warm tint + composite over BLACK.** White-tint-over-white is white at every
  alpha → the test can't fail. Resolution: (a) `glass.tint` is **warm** `rgba(247,244,237,α)` (parchment-derived,
  honors D4; also fixes AF-warm below), (b) `theme.test.ts` composites the tint over **`#000000`** (worst case for
  dark `#262524`) and asserts ≥ 4.5:1. At α=0.66 → 6.0:1 (pass, margin); at α=0.55 → 4.3:1 (**fails** → alpha is now
  load-bearing, guard works). **Captions caveat:** muted caption text (`#605E58`) cannot clear AA over glass on a
  *pure-black* photo region without α≈0.87 (opaque, not glass) — physically impossible for a translucent material
  (Apple solves this with adaptive vibrancy, unavailable in RNW). Captions stay **supplementary** (the icon glyph +
  the full a11y label are the real signifier; design.md treats small duplicated meta as decorative). The guard
  therefore pins **primary** text (Title / body) AA, which is the load-bearing copy.
- **AF2 [P3→resolved] — tint was pure white, not "warm" (D4 mismatch).** Fixed by AF1's warm parchment tint.
- **AF3 [P2] — iOS 26 `GlassView` dropped the warm tint.** Resolution: pass `tintColor={strong ? glass.tintStrong :
  glass.tint}` to `GlassView` so D4/D5 hold on the real-glass path too.
- **AF4 [P2] — native double-padding.** Gone by construction: `GlassFill` is an absolute layer with **no padding**;
  the card's existing padding is the single source.
- **AF5 [P2] — legacy 3-icon reveals scatter under space-between.** Pre-redesign revisits hide purpose+maker
  (`captureStore.ts:147`). Resolution: **fixed 5-slot grid** — `BucketDock` renders a hidden research bucket as an
  invisible `width:ICON_WRAP` spacer (not `null`), so `space-between` always distributes the same 5 slots; What stays
  flush-left, Ask flush-right, in every state. (New converge assertion checks the rendered flex-item count = 5.)
- **AF6 [P2] — uniform radius rounds the morph card's bottom (flush bottom-sheet, top-only today).** Resolution:
  `GlassFill` takes a `radiusStyle: ViewStyle` (any `border*Radius` keys), applied to the clip layer. Dock face →
  `{borderRadius: radius.xl}`; morph card → `{borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl}`.
- **AF7 [P2] — `maxHeight`/ScrollView height-chain severed by wrapper Views.** Gone by construction: `GlassFill` is
  `position:absolute` (`pointerEvents:'none'`), so the card's real flex children (head, ScrollView `flexShrink:1`,
  play button, tabs) stay **direct** children of the `maxHeight`-capped node exactly as today. Zero flex disturbance.
- **AF8 [P2] — the glassed testID node had `backdrop-filter:none` (material was on an inner child).** With `GlassFill`
  the material node is a sibling behind the content; the converge assertion reads it via **subtree traversal**
  (`page.evaluate` → within the reveal card, assert some element's computed `backdropFilter`/`webkitBackdropFilter`
  contains `blur(`). This is registry-independent, adds NO testID (honors D8), and is allowed by `lint-selectors`
  (it bans `page.locator` on non-testid strings, not `page.evaluate`+`querySelector` — verified in the runner).
- **AF9 [P3] — RNW does NOT auto-prefix inline styles.** The explicit `WebkitBackdropFilter` key is **load-bearing**
  (kept); plan rationale corrected (do not claim RNW auto-prefixes an inline literal). Functionally fine in Chromium.
- **AF10 [P2] — typecheck needs the deps actually installed** (tsc compiles `.native.tsx` directly). Resolution:
  `bun add` `expo-blur` + `expo-glass-effect` in the app workspace and run `tsc` BEFORE claiming green; if
  `expo-glass-effect` has no SDK-57 build, add a local `app/types/*.d.ts` shim so tsc resolves it (native still uses
  the real module at runtime on device). Also preserved: the morph card's asymmetric `paddingBottom: space.xl` safe
  inset (kept — the card's own style is untouched by the absolute-layer approach).

### 10.1 Final `GlassFill` (replaces the §2.3 `GlassSurface` wrapper)

```tsx
// app/src/components/GlassFill.tsx  (web/converge + safe default)  — an absolute-fill glass layer, dropped as the
// FIRST child of an existing card; blurs the page behind, clips to the card's radius, never touches card layout.
export interface GlassFillProps { radiusStyle?: ViewStyle; strong?: boolean }
export function GlassFill({ radiusStyle, strong }: GlassFillProps): React.ReactElement {
  const web = Platform.OS === 'web'
    ? ({ backdropFilter: `blur(${glass.blur}px) saturate(${glass.saturate})`,
         WebkitBackdropFilter: `blur(${glass.blur}px) saturate(${glass.saturate})` } as ViewStyle) // Webkit key REQUIRED (AF9)
    : null
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fill, radiusStyle,
    { backgroundColor: strong ? glass.tintStrong : glass.tint }, web]} />
}
const styles = StyleSheet.create({ fill: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border } })
```

```tsx
// app/src/components/GlassFill.native.tsx  (iOS 26 GlassView → BlurView fallback; never seen by esbuild)
export function GlassFill({ radiusStyle, strong }: GlassFillProps): React.ReactElement {
  const clip = [StyleSheet.absoluteFill, { overflow: 'hidden' as const }, radiusStyle]
  if (isLiquidGlassAvailable())
    return <GlassView glassEffectStyle="regular" tintColor={strong ? glass.tintStrong : glass.tint} style={clip} pointerEvents="none" /> // AF3
  return (
    <BlurView tint="light" intensity={glass.intensity} pointerEvents="none" style={clip}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: strong ? glass.tintStrong : glass.tint, borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border }, radiusStyle]} />
    </BlurView>
  )
}
```

Call sites (cards otherwise UNCHANGED — remove only `backgroundColor: surface.surface`):
- `reveal.tsx` `floatCard`: `<View style={[styles.floatCard, shadow]}><GlassFill radiusStyle={{borderRadius: radius.xl}} /> …title/dock/details…</View>`
- `RevealDock.tsx` `BucketCard`: `<Animated.View style={[styles.card, shadow, cardStyle]}><GlassFill strong radiusStyle={{borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl}} /> …head/scroll/play/tabs…</Animated.View>`

### 10.2 Token (final)

```ts
export const glass = {
  tint: 'rgba(247,244,237,0.66)',        // warm parchment-derived; AA-guarded for #262524 over black (6.0:1)
  tintStrong: 'rgba(247,244,237,0.76)',  // morph card over the (already dimmed) scrim
  border: 'rgba(255,255,255,0.5)',       // specular rim
  blur: 24, saturate: 1.5, intensity: 40,
} as const
```

## 11. Post-implementation fix — "looks gray" → DARK Control-Center glass (2026-07-02)

First implementation used a **light** warm tint (`rgba(247,244,237,0.66)`). On device it "just looked gray." Two
root causes, found by screenshotting the REAL render over a realistic photo (my earlier screenshots injected a fake
vivid backdrop, which hid the problem — a lesson: always verify the material over a real/simulated photo, since the
converge shim has no photo):

1. **A heavy light tint washes any photo to flat gray** — it doesn't let the content show through, so it reads as a
   muddy gray-taupe panel, not glass. Confirmed via an A/B tint sweep over a photographic backdrop.
2. **Native blur needs a prebuild** — `expo-blur`/`expo-glass-effect` are native modules; a JS-reload over the old
   app binary leaves them unlinked → no blur → the flat tint → gray. No library avoids this (iOS blur is native).

**Fix (approved by user): DARK "Control Center" glass with LIGHT text.** The dock floats over a full-bleed photo, so
the material is a dark warm frost (`rgba(20,17,13,0.68)`, `tintStrong 0.84`) + a light specular rim
(`rgba(255,255,255,0.22)`): the photo shows through **dimmed + blurred** (never gray) and near-white text is legible
over ANY photo — the same treatment the reveal's `loadingPill` already uses. The dock content flips to light via a
nested `<SurfaceProvider surface="dark">` (Title/Muted/TextField) + passing the `dark` surface to
`BucketDock`/`BucketCard`. The AA guard now composites LIGHT text (`dark.text`) over the tint on **white** (the
mirror worst case) and asserts ≥4.5 (α≥~0.68). The dark tint degrades to a clean dark scrim when blur is absent
(intentional, not gray). Re-verified: theme AA test, converge reveal-rnw + reveal-agentic GREEN, full suite 391/0,
typecheck clean, and visual screenshots over a realistic photo (dock @402/@375 + morph card) all read as premium
frosted glass. **Native blur still requires one `npx expo prebuild` + `expo run:ios` on the user's Mac/device.**

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues, 0 critical gaps — all folded (§ review report) |
| Adversarial | 6-lens workflow + verify + critic | Independent red-team | 1 | CLEAR | 14 raw → 7 confirmed → all resolved (§10) |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (presentational change) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | covered by adversarial + the 3 visual gates |

**Adversarial pivot:** wrapper → absolute-fill `GlassFill` layer, which resolves AF4/AF5/AF6/AF7/AF-padding by
construction (cards keep their exact layout). AA guard made load-bearing (warm tint + composite-over-black, AF1).
Native honors the warm tint on the real-glass path (AF3). Deps get truly installed + typechecked (AF10).

**UNRESOLVED:** none.
**VERDICT:** ENG + ADVERSARIAL CLEARED — implement §10 (final design). No critical failure-mode gaps: every web
codepath is machine-checked (AA unit test + 3 deterministic converge assertions + agentic real-click run); the
native path is built to the documented APIs and device-verified by the user after one prebuild.

**Eng-review findings folded (all applied):**
- **A1 (arch):** magic `-6` inset → `DOCK_EDGE_INSET` derived from `ICON_WRAP`/`ICON_CIRCLE` (explicit > clever). §2.1
- **Q1 (DRY):** `GlassSurface` owns the shadow+radius+clip split; call sites don't repeat it. D7 / §2.3
- **Q2 (design-system):** material lives in a `theme.ts` `glass` token shared by both platform variants. D6 / §2.2
- **Q3 (a11y):** automated `theme.test.ts` AA guard (tint alpha is load-bearing) replaces eyeballed contrast. D5
- **Test:** two DETERMINISTIC converge assertions (`justify-content:space-between`, computed `backdrop-filter`)
  upgrade the visual claims from screenshot-only to machine-checked (repo doctrine: assert real observable state). §5
- **P2 (perf):** do NOT animate the backdrop-filter node on web (re-sample jank) — blur on the non-animated inner,
  transform on the outer wrapper. §2.4. **P1** (stacked blur) noted + accepted with a one-token mitigation. §2.5

**Decision resolved (user):** native Liquid Glass = **add `expo-blur` + `expo-glass-effect`** (real iOS 26
`GlassView` + `BlurView` fallback); web path carries the automated proof; one device prebuild required (flagged).

**UNRESOLVED:** none.
**VERDICT:** ENG CLEARED — ready for adversarial review, then implement. No critical failure-mode gaps
(every new codepath has a test or is device-verified; nothing fails silently).
