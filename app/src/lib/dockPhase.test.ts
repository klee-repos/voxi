import { test, expect, describe } from 'bun:test'
import { deriveDockPhase, dockPhaseLabel } from './dockPhase'
import type { DeepDiveState } from '../state/deepDiveStore'

const dd = (state: DeepDiveState) => state

describe('deriveDockPhase — the dock state machine', () => {
  test('no band → loading (the orb overlay owns the screen)', () => {
    expect(deriveDockPhase({ band: null, researchComplete: false, isRevisit: false, deepDiveState: dd('idle') })).toBe('loading')
    expect(deriveDockPhase({ band: undefined, researchComplete: true, isRevisit: false, deepDiveState: dd('ready') })).toBe('loading')
  })

  test('band set + research streaming + NOT a revisit → researching (the ribbon is lead content)', () => {
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: false, deepDiveState: dd('idle') })).toBe('researching')
    expect(deriveDockPhase({ band: 'PROBABLE', researchComplete: false, isRevisit: false, deepDiveState: dd('failed') })).toBe('researching')
  })

  test('R1 fold B — a cache-MISS revisit (band set, !researchComplete, isRevisit) does NOT enter researching', () => {
    // cold-launch collection tap replays the BFF stream: band truthy, researchComplete=false, isRevisit=true
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: true, deepDiveState: dd('idle') })).toBe('idle')
  })

  test('composing/slow → generating, checked BEFORE researching (a first-fact dd auto-start leads)', () => {
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: false, deepDiveState: dd('composing') })).toBe('generating')
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: false, deepDiveState: dd('slow') })).toBe('generating')
    // even a revisit mid-bggen shows generating (the dd is real progress, not a stale "researching")
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: true, deepDiveState: dd('composing') })).toBe('generating')
  })

  test('ready → ready (checked before everything else after band)', () => {
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: false, isRevisit: false, deepDiveState: dd('ready') })).toBe('ready')
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: true, isRevisit: true, deepDiveState: dd('ready') })).toBe('ready')
  })

  test('band set + research complete + dd idle/failed → idle (the Generate fallback CTA path)', () => {
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: true, isRevisit: false, deepDiveState: dd('idle') })).toBe('idle')
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: true, isRevisit: false, deepDiveState: dd('failed') })).toBe('idle')
  })

  test('a revisit with research complete → idle (ribbon hidden, BucketCard has full content)', () => {
    expect(deriveDockPhase({ band: 'CONFIDENT', researchComplete: true, isRevisit: true, deepDiveState: dd('idle') })).toBe('idle')
  })
})

describe('dockPhaseLabel — short phase text', () => {
  test('each phase has a label', () => {
    expect(dockPhaseLabel('loading')).toBe('Identifying')
    expect(dockPhaseLabel('researching')).toBe('Researching')
    expect(dockPhaseLabel('generating')).toBe('Generating Deep Dive')
    expect(dockPhaseLabel('ready')).toBe('Deep Dive ready')
    expect(dockPhaseLabel('idle')).toBe('Details')
  })
})
