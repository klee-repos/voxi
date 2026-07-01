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
import { dark, parchment, bands, speakers, onColorInk, type, radius, scrim, shadow } from './theme'

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
    expect(dark.bg).toBe('#212325') // Dark theme
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
