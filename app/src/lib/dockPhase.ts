/**
 * The reveal DOCK's state-machine phase — a single derived value that drives the animated
 * bottom bar (REVEAL-STREAMING-PLAN F3, Uber-Eats-bottom-nav style). Pure + unit-pinned so
 * the dock-face + ribbon-mount contract is testable without a render harness.
 *
 *   loading     → no band yet (the orb overlay owns the screen)
 *   researching → band set, research still streaming, NOT a revisit (the Research Ribbon is
 *                 the lead content; the Deep Dive icon is soft-dimmed "still researching").
 *                 `!isRevisit` is load-bearing: a cold-launch cache-MISS revisit replays the
 *                 BFF stream with band-set + researchComplete=false for the network window —
//                    without the term the dock would enter 'researching' on a KNOWN item
//                    (adversarial R1 fold B; revealCache is in-memory so cold-launch = miss).
 *   generating  → the Deep Dive is composing/slow (the dock morphs; the icon spins). Checked
 *                 BEFORE researching: once the dd is generating it leads, even if research is
 *                 still streaming facts (the user perceives learning + generating at once).
 *   ready       → the Deep Dive episode is durable-ready.
 *   idle        → band set, research done, dd not started/failed (the podcast.tsx Generate
 *                 CTA fallback path).
 *
 * The order matters: `generating`/`ready` take precedence over `researching` so a first-fact
 * dd auto-start (F2) flips the dock to generating the moment the compose kicks off, regardless
 * of the remaining streaming facts.
 */
import type { DeepDiveState } from '../state/deepDiveStore'

export type DockPhase = 'loading' | 'researching' | 'generating' | 'ready' | 'idle'

export interface DockPhaseInput {
  band: unknown | null | undefined
  researchComplete: boolean
  isRevisit: boolean
  deepDiveState: DeepDiveState
}

export function deriveDockPhase(s: DockPhaseInput): DockPhase {
  if (!s.band) return 'loading'
  if (s.deepDiveState === 'ready') return 'ready'
  if (s.deepDiveState === 'composing' || s.deepDiveState === 'slow') return 'generating'
  if (!s.researchComplete && !s.isRevisit) return 'researching'
  return 'idle'
}

/** One short phase label for accessibility / the ribbon's transient lead chip. */
export function dockPhaseLabel(p: DockPhase): string {
  switch (p) {
    case 'researching':
      return 'Researching'
    case 'generating':
      return 'Generating Deep Dive'
    case 'ready':
      return 'Deep Dive ready'
    case 'loading':
      return 'Identifying'
    default:
      return 'Details'
  }
}
