/**
 * Capture-store bucket state machine (ANALYSIS-UX §4.4). The four reveal-dock buckets derive their icon state
 * (loading|active|empty|unavailable|hidden) purely from stream-driven store fields — this is the deterministic
 * contract the dock renders and the converge proof asserts, so it is unit-pinned here.
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { useCaptureStore, deriveBucketStatus, type StatusSlice } from './captureStore'

const base: StatusSlice = {
  band: null,
  sections: {},
  facts: [],
  researchComplete: false,
  researchError: false,
  sawAnySection: false,
}

describe('deriveBucketStatus', () => {
  test('what is active the instant the band settles (never a jarring loading→active flip)', () => {
    expect(deriveBucketStatus('what', base, false)).toBe('loading')
    expect(deriveBucketStatus('what', { ...base, band: 'CONFIDENT' }, false)).toBe('active')
    // active on band-settle even before any whatItIs token has streamed
    expect(deriveBucketStatus('what', { ...base, band: 'PROBABLE' }, false)).toBe('active')
  })

  test('facts: loading → active on first fact → empty on researchComplete', () => {
    const settled = { ...base, band: 'CONFIDENT' as const }
    expect(deriveBucketStatus('facts', settled, false)).toBe('loading')
    expect(deriveBucketStatus('facts', { ...settled, facts: [{ text: 'x', sourceUrl: 'u', sourceTitle: '', quote: 'q' }] }, false)).toBe('active')
    expect(deriveBucketStatus('facts', { ...settled, researchComplete: true }, false)).toBe('empty')
  })

  test('purpose/maker: section-with-text → active; empty-marker section → empty', () => {
    const settled = { ...base, band: 'CONFIDENT' as const, sawAnySection: true }
    expect(deriveBucketStatus('purpose', { ...settled, sections: { purpose: { text: 'A 35mm rangefinder.', sourceUrl: '', sourceTitle: '', quote: '' } } }, false)).toBe('active')
    // an explicit empty-marker section = "researched, nothing groundable" → empty, NOT perpetual loading
    expect(deriveBucketStatus('maker', { ...settled, sections: { maker: { text: '', sourceUrl: '', sourceTitle: '', quote: '' } } }, false)).toBe('empty')
  })

  test('maker settles to empty on researchComplete when other sections were seen (new-era reveal)', () => {
    const s = { ...base, band: 'CONFIDENT' as const, researchComplete: true, sawAnySection: true }
    expect(deriveBucketStatus('maker', s, false)).toBe('empty')
  })

  test('LEGACY revisit (researchComplete, zero sections ever) HIDES purpose/maker — never a false "nothing to add"', () => {
    const legacy = { ...base, band: 'CONFIDENT' as const, researchComplete: true, sawAnySection: false }
    expect(deriveBucketStatus('purpose', legacy, false)).toBe('hidden')
    expect(deriveBucketStatus('maker', legacy, false)).toBe('hidden')
  })

  test('a stream drop / offline before content → unavailable (retriable), distinct from empty', () => {
    const settled = { ...base, band: 'CONFIDENT' as const }
    expect(deriveBucketStatus('purpose', { ...settled, researchError: true }, false)).toBe('unavailable')
    expect(deriveBucketStatus('facts', settled, true /* offline */)).toBe('unavailable')
  })
})

describe('capture store actions', () => {
  beforeEach(() => useCaptureStore.getState().reset())

  test('appendSection is last-write-wins per bucket and latches sawAnySection', () => {
    const st = useCaptureStore.getState()
    st.appendSection('purpose', { text: 'first pass', sourceUrl: '', sourceTitle: '', quote: '' })
    st.appendSection('purpose', { text: 'dossier upgrade', sourceUrl: 'u', sourceTitle: 't', quote: 'q' })
    expect(useCaptureStore.getState().sections.purpose?.text).toBe('dossier upgrade')
    expect(useCaptureStore.getState().sawAnySection).toBe(true)
  })

  test('researchComplete / researchError / lastSeenIndex set + reset clears them', () => {
    const st = useCaptureStore.getState()
    st.setResearchComplete()
    st.setResearchError()
    st.setLastSeenIndex(9)
    st.setLastSeenIndex(3) // monotonic — does not go backwards
    expect(useCaptureStore.getState().researchComplete).toBe(true)
    expect(useCaptureStore.getState().researchError).toBe(true)
    expect(useCaptureStore.getState().lastSeenIndex).toBe(9)
    useCaptureStore.getState().reset()
    expect(useCaptureStore.getState()).toMatchObject({ researchComplete: false, researchError: false, lastSeenIndex: null, sawAnySection: false })
    expect(useCaptureStore.getState().sections).toEqual({})
  })
})
