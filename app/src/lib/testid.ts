/**
 * The single bridge between a rendered RN element and the selector contract (e2e/framework/testids.ts).
 *
 * Every interactive element in the app MUST spread `tid(ids.x.y)` so it carries BOTH a `testID` (native /
 * Maestro / iOS) AND an `accessibilityLabel` (react-native-web → DOM, where the Playwright/agent-browser
 * E2E drivers locate by `data-testid`/`aria-label`). The contract file is THE source of truth; we never
 * hand-type id strings — we import `ids` and pass a value through here so a rename is one edit upstream.
 *
 * On react-native-web, `testID` renders as `data-testid` and `accessibilityLabel` as `aria-label`, so the
 * same call satisfies both the web harness selectors and the native shell.
 */
import { ids } from '../../../e2e/framework/testids'

export { ids }

export interface TestIdProps {
  testID: string
  accessibilityLabel: string
}

/**
 * Spread onto any element to satisfy the selector contract on both native and web.
 *
 * `testID`/`data-testid` is ALWAYS the raw id (the web E2E drivers locate by `data-testid` only, never
 * `aria-label`), so an optional human `label` is free to set a real `accessibilityLabel` for VoiceOver on
 * icon-only controls (hamburger, capture orb, the reveal play orb) without affecting any selector. Defaults
 * to the id when no label is given.
 */
export function tid(id: string, label?: string): TestIdProps {
  return { testID: id, accessibilityLabel: label ?? id }
}

/**
 * Variant that attaches the dynamic state an id "carries" (see comments in testids.ts), e.g. the orb's
 * `orb.state` or the confidence chip's `chip.band`.
 *
 * CRITICAL for the web E2E drivers: they read carried state from `data-*` attributes (playwright.ts strips
 * `data-` and exposes the rest as `attrs`, so `{ band: 'PROBABLE' }` must reach the DOM as `data-band`).
 * react-native-web maps the `dataSet` prop → `data-*` attributes, so we set `dataSet` for the web path AND an
 * `accessibilityValue.text` for native VoiceOver/Maestro. `dataSet` is ignored on native; `accessibilityValue`
 * is ignored on web — each platform reads the one it understands.
 */
export function tidWith(id: string, data: Record<string, string>, label?: string): TestIdProps & {
  dataSet: Record<string, string>
  accessibilityValue: { text: string }
} {
  const text = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(';')
  return { testID: id, accessibilityLabel: label ?? id, dataSet: { ...data }, accessibilityValue: { text } }
}
