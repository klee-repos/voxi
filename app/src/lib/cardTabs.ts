/**
 * Pure helpers for the morph-card's section tabs — the ordering + clamp logic the swipe gesture needs, kept out of
 * the component so it unit-tests with no React/native deps. The clamp is the load-bearing invariant: a swipe past
 * either end is a no-op, never a wrap.
 */

/** Direction of a horizontal swipe over the card body: +1 = forward (next tab), -1 = back (previous tab). */
export type TabDir = 1 | -1

/**
 * The next/previous tab in an ordered list, CLAMPED at the ends — `null` means "no-op" (swiped past the first/last
 * tab, or `current` isn't in `tabs`). Never wraps.
 *
 * The clamp semantics live here (unit-pinned) because the converge swipe CAN'T distinguish a correct null-clamp
 * from a broken undefined-return — the caller's truthiness guard absorbs both — so the contract is tested directly.
 */
export function nextTab<T extends string>(current: T, dir: TabDir, tabs: readonly T[]): T | null {
  const i = tabs.indexOf(current)
  if (i < 0) return null // `current` isn't a tab → no-op (defensive; the card always passes a live bucket)
  const j = i + dir
  if (j < 0 || j >= tabs.length) return null // clamped at the ends
  return tabs[j] ?? null
}
