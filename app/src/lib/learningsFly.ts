/**
 * The "facts fly into the Details icon" transition geometry (INITIAL-LEARNINGS-PLAN F3). Pure math so it's unit-
 * pinned; the component applies these numbers to an Animated clone. The clone travels from the LearningsBar slot's
 * center to the Details icon's center, scaling down + fading (the satisfying "collected" arc — Mobbin fly-to-cart).
 *
 * The component measures both rects via `measureInWindow` AFTER the dock card reappears + lays out (the B2
 * sequencing: dockBack → onLayout of Details → measure → fly). If either rect is invalid (measure returned 0 — a
 * layout race or web/converge), `rectIsValid` returns false + the component degrades to a cross-fade (no clone).
 */
export type Rect = { x: number; y: number; w: number; h: number }

export type FlyPath = {
  /** clone start center (the bar slot center), in window coords. */
  fromX: number
  fromY: number
  /** clone end center (the Details icon center), in window coords. */
  toX: number
  toY: number
  /** the translate the clone animates: end - start. */
  dx: number
  dy: number
  durationMs: number
  /** the clone's scale at journey's end (it shrinks into the icon). */
  scaleTo: number
}

export const FLY_DURATION_MS = 420
export const FLY_SCALE_TO = 0.22

/** A measure rect is valid only if it has non-zero size + on-screen coords (measureInWindow returns 0,0,0,0 pre-layout). */
export function rectIsValid(r: Rect | null | undefined): boolean {
  return !!r && r.w > 0 && r.h > 0
}

export function computeFlyPath(barRect: Rect, iconRect: Rect): FlyPath {
  const fromX = barRect.x + barRect.w / 2
  const fromY = barRect.y + barRect.h / 2
  const toX = iconRect.x + iconRect.w / 2
  const toY = iconRect.y + iconRect.h / 2
  return { fromX, fromY, toX, toY, dx: toX - fromX, dy: toY - fromY, durationMs: FLY_DURATION_MS, scaleTo: FLY_SCALE_TO }
}
