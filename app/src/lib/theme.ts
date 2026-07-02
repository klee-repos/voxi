/**
 * Design tokens — SOURCE OF TRUTH: /design.md (Voxi's design system).
 *
 * TWO surfaces map 1:1 to design.md's two themes:
 *   • DARK SHELL     (camera, threads, processing, chat) → design.md **Dark**  (charcoal #212325)
 *   • PARCHMENT      (reveal card + podcast read-along)   → design.md **Warm**  (cream #F4F1E8)
 *
 * Action color follows design.md's two lanes: GREEN (#29AB60) for primary/fills,
 * BLUE (#3D89F5) for links/secondary. Semantic colors (confidence bands, podcast
 * speakers, the orb gradient) are app-owned and sit inside the new palette.
 *
 * a11y: every fg/bg pairing clears WCAG AA on its own surface (≥4.5 body, ≥3 large/UI)
 * EXCEPT the one documented brand exception — white on the primary green #29AB60 is
 * ~2.96:1 (per design.md, matching the reference brand). Enforced by theme.test.ts.
 */

// ---- raw palette (design.md → Colors) ----
const palette = {
  // Dark shell → design.md Dark theme
  ink900: '#212325', // dark-background (app canvas)
  ink800: '#2A2C2E', // dark-surface (raised)
  ink700: '#2A2C2E', // dark-surface (cards — barely lighter than canvas by design)
  ink600: '#343638', // dark-hairline (borders / dividers)
  mist300: '#9D9E9E', // dark-text-secondary (≈ 5.8:1 on ink900 — AA)
  mist100: '#ECEEEE', // dark-text-primary (≈ 13:1 on ink900 — AAA)

  // Parchment reading surface → design.md Warm theme
  parchment: '#F4F1E8', // background — warm cream
  parchmentRaise: '#FFFFFF', // surface (white card/sheet)
  parchmentWarm: '#FBF9F3', // surface-warm (feed card)
  sepia900: '#262524', // text-primary — warm near-black (≈ 14:1 — AAA)
  sepia700: '#605E58', // text-secondary (≈ 5.7:1 — AA)
  sepiaLine: '#E6E2D7', // hairline on parchment

  // Brand action colors (design.md)
  green: '#29AB60', // PRIMARY action / fills (brand green)
  greenSoft: '#57B871', // ON toggles / soft accents
  blue: '#3D89F5', // links / secondary lane
  onGreen: '#FFFFFF', // text on green fills (documented ~2.96:1 exception)
  onColorInk: '#131313', // dark ink for text on bright/pastel fills (chips, speaker tags)

  // sunken (inset fields, chips, ghost fills)
  sunkenDark: '#2A2C2E',
  sunkenWarm: '#EDEAE0',

  // text-tertiary — DECORATIVE ONLY (duplicated/decorative meta), never essential copy.
  sepiaTertiary: '#A3A19B', // on cream ~2.3:1 (below AA BY DESIGN — enforced decorative in theme.test)
  inkTertiary: '#5E6061', // on charcoal

  // confidence bands (app-owned semantics — chip treatment changes by band, PLAN §10.2 §5)
  confident: '#29AB60', // solid green success (harmonized to brand green)
  probable: '#E8B45C', // warm gold "confident maybe" (status color, NOT an error red)
  unknown: '#9AA0C0', // neutral "not in the Guide yet"

  // status / safety (semantic, app-owned)
  danger: '#C56A3E', // refusal / destructive — terracotta (design.md), museum-warm not alarm-red
  warn: '#E8B45C',
  offline: '#5E6061', // offline banner fill (white text ≈ 6:1)

  // podcast hosts — per-speaker data-viz identity (surface-independent pastels), unchanged
  arlo: '#6FB1FC', // enthusiast (cool blue)
  mave: '#E8A0C0', // skeptic/fact-checker (warm rose)

  // orb — aurora sphere in design.md's palette: green core → blue halo (no 2nd hue).
  orbCore: '#F2FBF5', // hot center — reads on charcoal AND cream
  orbGreenSoft: '#57B871', // inner glow (design.md green-soft)
  orbGreen: '#29AB60', // sphere body (design.md brand green)
  orbBlue: '#3D89F5', // outer shell / cool rim (design.md blue)
  orbGlow: '#6FB1FC', // bloom halo — emitted cool light (matches `arlo` light-blue)
} as const

/** The Orb's brand palette — aurora sphere: green core → blue halo. Consumed by `components/Orb.tsx`. */
export const orbPalette = {
  core: palette.orbCore,
  greenSoft: palette.orbGreenSoft,
  green: palette.orbGreen,
  blue: palette.orbBlue,
  glow: palette.orbGlow,
} as const

/** Back-compat 3-stop array (kept for the `theme` object); the Orb now consumes `orbPalette`. */
export const orbGradient = [palette.orbGreen, palette.orbBlue, palette.orbCore] as const

/** Dark ink for text sitting ON a bright/saturated fill (confident chip, speaker tags). */
export const onColorInk = palette.onColorInk

/** The dark shell surface (default app chrome) → design.md Dark theme. */
export const dark = {
  name: 'dark' as const,
  bg: palette.ink900,
  surface: palette.ink800,
  card: palette.ink700,
  border: palette.ink600,
  text: palette.mist100,
  textMuted: palette.mist300,
  textTertiary: palette.inkTertiary, // decorative-only meta
  accent: palette.green, // green — primary fills
  accentSoft: palette.greenSoft, // ON toggles
  accentSecondary: palette.blue, // links / secondary lane
  sunken: palette.sunkenDark,
  onAccent: palette.onGreen, // white on green
  accentText: palette.onGreen, // back-compat alias
  danger: palette.danger,
  offline: palette.offline,
}

/** The parchment reading surface (entry reveal + podcast read-along) → design.md Warm theme. */
export const parchment = {
  name: 'parchment' as const,
  bg: palette.parchment,
  surface: palette.parchmentRaise,
  card: palette.parchmentWarm,
  border: palette.sepiaLine,
  text: palette.sepia900,
  textMuted: palette.sepia700,
  textTertiary: palette.sepiaTertiary, // decorative-only meta (below AA — never essential copy)
  accent: palette.green,
  accentSoft: palette.greenSoft,
  accentSecondary: palette.blue,
  sunken: palette.sunkenWarm,
  onAccent: palette.onGreen,
  accentText: palette.onGreen,
  danger: palette.danger,
  offline: palette.offline,
}

export type Surface = typeof dark | typeof parchment

export const bands = {
  CONFIDENT: { color: palette.confident, label: 'identified' },
  PROBABLE: { color: palette.probable, label: 'a confident maybe' },
  UNKNOWN: { color: palette.unknown, label: 'not in the Guide yet' },
} as const

export const speakers = {
  ARLO: { color: palette.arlo, name: 'Arlo' },
  MAVE: { color: palette.mave, name: 'Mave' },
} as const

/**
 * Type scale — serif = Fraunces (wordmark/display), sans = Nunito (UI). Fonts loaded in src/lib/fonts.ts.
 * RN ignores fontWeight on a named static instance — pick the weight-specific family from `family`
 * (e.g. type.family.sans['600']) instead of pairing a base family with a fontWeight prop.
 */
export const type = {
  serif: 'Fraunces_700Bold', // logo/display serif — the "voxi" wordmark & reveal titles
  sans: 'Nunito_400Regular', // Nunito — the UI face
  family: {
    sans: {
      '400': 'Nunito_400Regular',
      '500': 'Nunito_500Medium',
      '600': 'Nunito_600SemiBold',
      '700': 'Nunito_700Bold',
      '800': 'Nunito_800ExtraBold',
    },
    serif: {
      '700': 'Fraunces_700Bold',
      '800': 'Fraunces_800ExtraBold', // the wordmark weight
      '900': 'Fraunces_900Black',
    },
  } as const,
  size: { xs: 12, sm: 14, base: 16, lg: 20, xl: 26, xxl: 34, display: 44 },
  leading: { tight: 1.15, body: 1.5, loose: 1.7 },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700' } as const,
  clamp: { min: 0.85, max: 1.4 },
}

/**
 * Ready-to-use text styles, built from `type.family` (string family NAMES only — no `.ttf` imports, so this is
 * safe to pull into the react-native-web converge bundle, unlike `src/lib/fonts.ts`). Prefer these over composing
 * `type.family.*` + sizes by hand. `fonts.ts` re-exports this for back-compat.
 */
export const typeStyles = {
  logo:         { fontFamily: type.family.serif['800'], fontSize: 22, letterSpacing: -0.22, lineHeight: 22 },
  heading:      { fontFamily: type.family.sans['700'],  fontSize: 24, letterSpacing: -0.24, lineHeight: 28 },
  display:      { fontFamily: type.family.sans['700'],  fontSize: 22, lineHeight: 26 },
  headline:     { fontFamily: type.family.sans['600'],  fontSize: 17, lineHeight: 21 },
  name:         { fontFamily: type.family.sans['600'],  fontSize: 16, lineHeight: 20 },
  body:         { fontFamily: type.family.sans['400'],  fontSize: 16, lineHeight: 22 },
  calloutBold:  { fontFamily: type.family.sans['700'],  fontSize: 15, lineHeight: 20 },
  sectionLabel: { fontFamily: type.family.sans['500'],  fontSize: 15, lineHeight: 20 },
  subhead:      { fontFamily: type.family.sans['500'],  fontSize: 15, lineHeight: 20 },
  overline:     { fontFamily: type.family.sans['600'],  fontSize: 13, letterSpacing: 0.78, lineHeight: 16, textTransform: 'uppercase' as const },
  footnote:     { fontFamily: type.family.sans['400'],  fontSize: 13, lineHeight: 17 },
  caption:      { fontFamily: type.family.sans['500'],  fontSize: 12, lineHeight: 14 },
} as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const // lg→16, +xl (design.md)
export const hit = { min: 44 } as const // 44pt min touch target (PLAN §10.3)

/** Motion tokens. `reduceMotion` swaps particle sequences for cross-fades but keeps the orb (PLAN §10.3). */
export const motion = {
  fast: 140,
  base: 240,
  slow: 420,
  orbIdle: 4200, // idle breathe period (full cycle)
  spring: { damping: 18, stiffness: 160 },
}

/** Dim behind the drawer + bottom sheets (design.md scrim). */
export const scrim = 'rgba(20,18,14,0.35)' as const
/** The single shallow card shadow — the only depth in the system (design.md: y2, blur12, ~0.06). */
export const shadow = {
  shadowColor: '#14120E',
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
} as const

/**
 * Liquid Glass material — a DARK, warm frost for the reveal dock floating over a full-bleed photo. Consumed by both
 * `GlassFill` variants (web backdrop-filter / native GlassView+BlurView) so the material can't drift between platforms.
 *
 * The `tint` ALPHA is contrast-load-bearing: `theme.test.ts` composites the LIGHT text (mist100) over the tint on WHITE
 * (worst case) and asserts ≥ AA (4.5:1). At 0.68 → 5.6:1 (pass); drop it toward ~0.6 and the guard fails on purpose.
 * Muted captions are SUPPLEMENTARY (the icon glyph + a11y label are the real signifier). Without the native blur module
 * (no prebuild), the tint alone degrades to a clean dark scrim panel.
 */
export const glass = {
  tint: 'rgba(20,17,13,0.68)', // dock over the photo — dark warm frost; AA-guaranteed for LIGHT text (mist100)
  tintStrong: 'rgba(20,17,13,0.84)', // morph card — denser (a "thick" modal material over the scrim)
  border: 'rgba(255,255,255,0.22)', // light specular rim (the Liquid-Glass edge catching light on a dark material)
  blur: 30, // px — web backdrop-filter blur radius
  saturate: 1.4, // web backdrop-filter saturation boost (photo colour still "pops" through the dark frost)
  intensity: 45, // native BlurView intensity (0–100)
} as const

export const theme = { dark, parchment, bands, speakers, type, space, radius, hit, motion, orbGradient, scrim, shadow }
export type Theme = typeof theme
