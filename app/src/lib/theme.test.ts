/**
 * Deterministic guard for the design.md migration (docs/design-migration-plan.md).
 *
 * The e2e web tier is a testID-driven mock and cannot see token values; there is no
 * native render here. So this pure test is the real guard that the reskin is correct
 * and stays accessible: it pins the exact brand tokens the primitives consume and
 * enforces the app's WCAG AA contract on BOTH surfaces — including the ONE documented
 * sub-AA exception (white on the primary green, per design.md).
 */
import { test, expect, describe } from 'bun:test'
import { dark, parchment, bands, speakers, onColorInk, type, radius, scrim, shadow, glass, photoLabelScrim } from './theme'

// ---- WCAG relative luminance + contrast ----
function luminance(hex: string): number {
  const c = hex.replace('#', '')
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4))
}
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const HEX = /^#[0-9A-Fa-f]{6}$/
const REQUIRED_KEYS = [
  'bg', 'surface', 'card', 'border', 'text', 'textMuted', 'textTertiary',
  'accent', 'accentSoft', 'accentSecondary', 'sunken', 'onAccent', 'danger', 'offline',
] as const

describe('theme tokens — completeness', () => {
  for (const [name, s] of [['dark', dark], ['parchment', parchment]] as const) {
    test(`${name} surface exposes every required token as a valid hex`, () => {
      for (const k of REQUIRED_KEYS) {
        expect(HEX.test((s as Record<string, string>)[k]), `${name}.${k} missing/invalid`).toBe(true)
      }
    })
  }
})

describe('theme tokens — exact design.md values', () => {
  test('brand action colors', () => {
    expect(dark.accent).toBe('#29AB60') // design.md primary green
    expect(parchment.accent).toBe('#29AB60')
    expect(dark.onAccent).toBe('#FFFFFF') // white on green
    expect(parchment.onAccent).toBe('#FFFFFF')
    expect(dark.accentSoft).toBe('#57B871') // ON toggles (design.md green-soft)
    expect(dark.accentSecondary).toBe('#3D89F5') // links (design.md blue)
    expect(dark.danger).toBe('#C56A3E') // terracotta
  })
  test('surfaces map to design.md themes', () => {
    expect(dark.bg).toBe('#17181A') // Dark theme — darkened near-black canvas (reconciled in design.md)
    expect(parchment.bg).toBe('#F4F1E8') // Warm theme
    expect(bands.CONFIDENT.color).toBe('#29AB60') // harmonized to brand green
  })
  test('typography + shape', () => {
    expect(type.serif).toBe('Fraunces_700Bold')
    expect(type.sans).toBe('Nunito_400Regular')
    expect(type.family.sans['600']).toBe('Nunito_600SemiBold')
    expect(type.family.serif['800']).toBe('Fraunces_800ExtraBold')
    expect(radius.pill).toBe(999)
    expect(radius.lg).toBe(16)
  })
})

describe('theme tokens — WCAG AA contract', () => {
  // Body/label text must clear AA (4.5:1) on its own surface.
  test('primary + muted text ≥ 4.5:1 on both surfaces', () => {
    for (const s of [dark, parchment]) {
      expect(contrast(s.text, s.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(s.textMuted, s.bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  // Blue links render on the dark shell (settings) — must clear AA as text.
  test('accentSecondary (blue link) ≥ 4.5:1 on dark shell', () => {
    expect(contrast(dark.accentSecondary, dark.bg)).toBeGreaterThanOrEqual(4.5)
  })

  // Dark ink on saturated/pastel fills (confident chip + podcast speaker tags).
  test('onColorInk ≥ 4.5:1 on green + speaker pastels', () => {
    expect(contrast(onColorInk, bands.CONFIDENT.color)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(onColorInk, speakers.ARLO.color)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(onColorInk, speakers.MAVE.color)).toBeGreaterThanOrEqual(4.5)
  })

  // Offline banner: white on the offline fill.
  test('white on offline fill ≥ 4.5:1', () => {
    expect(contrast(dark.onAccent, dark.offline)).toBeGreaterThanOrEqual(4.5)
  })

  // All three ConfidenceChip bands are SOLID-filled (they can sit over an arbitrary photo), so text-on-fill
  // must clear AA regardless of the surface behind them. CONFIDENT uses white (the green exception below);
  // PROBABLE gold + UNKNOWN neutral carry dark onColorInk.
  test('onColorInk ≥ 4.5:1 on PROBABLE gold + UNKNOWN neutral chip fills', () => {
    expect(contrast(onColorInk, bands.PROBABLE.color)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(onColorInk, bands.UNKNOWN.color)).toBeGreaterThanOrEqual(4.5)
  })

  // DOCUMENTED EXCEPTIONS — pinned so they can't silently drift.
  // (1) Primary green button: white-on-#29AB60 ≈ 2.96 — a deliberate sub-AA control
  //     per design.md (matches the reference brand). NOT allowed to get worse.
  test('white on primary green is the documented ~2.96 exception (≥ 2.9)', () => {
    const c = contrast(dark.onAccent, dark.accent)
    expect(c).toBeGreaterThanOrEqual(2.9)
    expect(c).toBeLessThan(3.1) // if this fires, the green changed — re-review the exception
  })
  // (2) Terracotta danger fill carries white at large-text tier (≥ 3.0): "● live", refusal.
  test('white on terracotta danger ≥ 3.0 (large-text tier)', () => {
    expect(contrast(dark.onAccent, dark.danger)).toBeGreaterThanOrEqual(3.0)
  })
})

describe('theme tokens — decorative-only + drawer/depth tokens', () => {
  // text-tertiary is a DOCUMENTED sub-AA token (~2.3:1 on cream): decorative / duplicated meta ONLY, never
  // essential copy (which uses text-secondary ≥5.7:1). Pinned BELOW AA so a refactor that promotes it to a
  // body/label color trips this guard.
  test('parchment.textTertiary is intentionally below AA on cream (decorative-only)', () => {
    expect(contrast(parchment.textTertiary, parchment.bg)).toBeLessThan(4.5)
    expect(HEX.test(parchment.textTertiary)).toBe(true)
    expect(HEX.test(dark.textTertiary)).toBe(true)
  })

  test('scrim is an rgba string; shadow carries the single shallow-depth shape', () => {
    expect(scrim).toMatch(/^rgba\(/)
    expect(shadow.shadowOpacity).toBeLessThanOrEqual(0.1)
    expect(shadow.shadowOffset).toEqual({ width: 0, height: 2 })
  })
})

// ---- Liquid Glass material (GlassFill) — the tint ALPHA is contrast-load-bearing ----
// Composite an `rgba(r,g,b,a)` string over an opaque hex backdrop → the resulting opaque hex (source-over).
function compositeOver(rgba: string, bgHex: string): string {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(rgba)
  if (!m) throw new Error(`not an rgba() string: ${rgba}`)
  const a = Number(m[4])
  const bg = (i: number) => parseInt(bgHex.replace('#', '').slice(i, i + 2), 16)
  const hx = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  const mix = (fg: number, back: number) => fg * a + back * (1 - a)
  return `#${hx(mix(Number(m[1]), bg(0)))}${hx(mix(Number(m[2]), bg(2)))}${hx(mix(Number(m[3]), bg(4)))}`
}

describe('glass material — Liquid Glass AA guard (docs/REVEAL-DOCK-GLASS-PLAN.md §10)', () => {
  // The dock is DARK glass with LIGHT text (mist100) over the full-bleed photo. Worst case for light text = the tint
  // composited over the BRIGHTEST backdrop (a white photo region) → lightest composite → lowest contrast. Guard that
  // light text still clears AA there, so a future alpha drop (glass too see-through → washes toward gray) fails CI.
  // Small muted captions are SUPPLEMENTARY (icon glyph + a11y label carry meaning); a translucent material can't keep
  // muted text AA over the brightest photo region without going opaque (see theme.ts `glass`).
  test('light text ≥ 4.5:1 over glass.tint / glass.tintStrong / glass.tintCard composited on white', () => {
    expect(contrast(dark.text, compositeOver(glass.tint, '#FFFFFF'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark.text, compositeOver(glass.tintStrong, '#FFFFFF'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark.text, compositeOver(glass.tintCard, '#FFFFFF'))).toBeGreaterThanOrEqual(4.5)
  })

  // The reveal BucketCard's SOURCE TITLE is a blue link (dark.accentSecondary) — the load-bearing signifier of the
  // Sources list, so it must clear AA. It reads AA ONLY because the morph card always sits over CARD_SCRIM (the deep
  // scrim behind the card, RevealDock.tsx CARD_SCRIM) UNDER the card glass (tintCard): that composite ≈ dark.bg,
  // where blue is ~5:1. Guard it (the plain scrim-less form is ~4.2:1 and would FAIL) so removing the scrim behind
  // the card, or lightening tintCard, re-opens the issue in CI. (docs/REVEAL-CARD-CLEANUP-PLAN.md §2a/§6 R4.)
  const CARD_SCRIM = 'rgba(20,18,14,0.60)' // = RevealDock.tsx CARD_SCRIM (scrim behind the morph card)
  test('blue source-title link ≥ 4.5:1 on the card material (tintCard over CARD_SCRIM over white)', () => {
    const cardBackdrop = compositeOver(glass.tintCard, compositeOver(CARD_SCRIM, '#FFFFFF'))
    expect(contrast(dark.accentSecondary, cardBackdrop)).toBeGreaterThanOrEqual(4.5)
    // Document the dependency on the scrim: bare glass over a white photo is sub-AA for this blue.
    expect(contrast(dark.accentSecondary, compositeOver(glass.tintCard, '#FFFFFF'))).toBeLessThan(4.5)
  })

  // The Collection tile's WHITE label sits over a capture photo on a flat foot scrim (photoLabelScrim). Worst case
  // for the white label = the scrim composited over the BRIGHTEST photo (a white pixel) → lightest composite →
  // lowest contrast. Guard that WHITE still clears AA there, so dropping the scrim alpha (foot too see-through)
  // fails CI. (The current shipping tile scrim rgba(20,18,14,0.42) is ~2.76:1 — sub-AA — hence this stronger foot.)
  test('white label ≥ 4.5:1 over photoLabelScrim composited on white (Collection tile)', () => {
    expect(contrast('#FFFFFF', compositeOver(photoLabelScrim, '#FFFFFF'))).toBeGreaterThanOrEqual(4.5)
  })

  // A DARK, warm, translucent frost (Control-Center style): dark so light text is legible + so a photo shows through
  // DIMMED (a LIGHT tint here is exactly the gray-wash bug); warm so it stays on-brand; translucent so it's glass.
  test('glass.tint is a dark, warm, translucent frost', () => {
    const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\)/.exec(glass.tint)
    expect(m).not.toBeNull()
    const [r, g, b, a] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]
    expect(a).toBeGreaterThan(0.4) // opaque-enough for light-text AA over a bright photo
    expect(a).toBeLessThan(0.92) // still translucent — the photo shows through
    expect(r).toBeLessThan(64) // DARK (a light tint here washes the photo to gray — the reported bug)
    expect(r).toBeGreaterThanOrEqual(g) // warm bias: red ≥ green ≥ blue
    expect(g).toBeGreaterThanOrEqual(b)
  })
})

// ---- Deep Dive karaoke legibility (G-A3) — the word highlight must stay AA on the dark player ----
describe('karaoke word highlight — AA on the dark Deep Dive player', () => {
  // KaraokeTranscript.tsx: the ACTIVE word is bright text (mist100) over a translucent-green box; spoken words are
  // mist100; UPCOMING words are mist300. All must clear AA on the darker canvas so the read-along stays legible.
  const ACTIVE_BOX = 'rgba(41,171,96,0.38)' // = KaraokeTranscript styles.activeWord backgroundColor
  test('active-word text (mist100) ≥ 4.5:1 over the highlight box on the dark canvas', () => {
    const box = compositeOver(ACTIVE_BOX, dark.bg)
    expect(contrast(dark.text, box)).toBeGreaterThanOrEqual(4.5)
  })
  test('upcoming-word text (mist300) ≥ 4.5:1 on the dark canvas (dimmed but still readable)', () => {
    expect(contrast(dark.textMuted, dark.bg)).toBeGreaterThanOrEqual(4.5)
  })
})
