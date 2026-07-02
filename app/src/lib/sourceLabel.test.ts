/**
 * Unit guard for the reveal Sources-list display helpers (docs/REVEAL-CARD-CLEANUP-PLAN.md §3.2/§3.6). These are the
 * only owners of the hostname-fallback, redirect-suppression, and dedupe branches that no deterministic E2E can
 * exhaustively cover, so they are tested here directly (pure, no render).
 */
import { test, expect, describe } from 'bun:test'
import { sourceLabel, sourceHost, dedupeSources, isRedirectHost } from './sourceLabel'

describe('sourceLabel — display title', () => {
  test('prefers a real (non-URL) page title', () => {
    expect(sourceLabel('https://en.wikipedia.org/wiki/Canon_AE-1', 'Canon AE-1 - Wikipedia')).toBe('Canon AE-1 - Wikipedia')
  })
  test('empty title → Title-cased registrable SLD', () => {
    expect(sourceLabel('https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO', '')).toBe('Wikipedia')
    expect(sourceLabel('https://www.cannondale.com/road/supersix-evo')).toBe('Cannondale')
    expect(sourceLabel('https://canon.com/cameras', '')).toBe('Canon')
  })
  test('strips a leading www. before deriving the name', () => {
    expect(sourceLabel('https://www.nikon.com/x')).toBe('Nikon')
  })
  test('a URL-looking "title" is rejected in favour of the hostname name', () => {
    expect(sourceLabel('https://en.wikipedia.org/x', 'https://en.wikipedia.org/x')).toBe('Wikipedia')
  })
  test('malformed / relative / schemeless input never throws and yields ""', () => {
    expect(sourceLabel('not a url', '')).toBe('')
    expect(sourceLabel('/wiki/relative', '')).toBe('')
    expect(sourceLabel('', '')).toBe('')
  })
  test('a Vertex grounding-redirect URL with no real title is non-displayable ("" — never "Google")', () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123'
    expect(sourceLabel(redirect, '')).toBe('')
    expect(sourceLabel(redirect, '')).not.toBe('Google')
    // but a genuinely plumbed title still wins even on a redirect URL
    expect(sourceLabel(redirect, 'Canon Camera Museum')).toBe('Canon Camera Museum')
  })
})

describe('sourceHost — muted "which site" line', () => {
  test('hostname minus a leading www.', () => {
    expect(sourceHost('https://en.wikipedia.org/wiki/x')).toBe('en.wikipedia.org')
    expect(sourceHost('https://www.cannondale.com/road')).toBe('cannondale.com')
  })
  test('strips userinfo and port', () => {
    expect(sourceHost('https://user@example.com:8443/p')).toBe('example.com')
  })
  test('unparseable / redirect → ""', () => {
    expect(sourceHost('not a url')).toBe('')
    expect(sourceHost('https://vertexaisearch.cloud.google.com/grounding-api-redirect/x')).toBe('')
  })
})

describe('isRedirectHost', () => {
  test('true for the Vertex grounding proxy (host or path marker)', () => {
    expect(isRedirectHost('https://vertexaisearch.cloud.google.com/grounding-api-redirect/x')).toBe(true)
    expect(isRedirectHost('https://foo.vertexaisearch.cloud.google.com/x')).toBe(true)
  })
  test('false for real publisher URLs', () => {
    expect(isRedirectHost('https://en.wikipedia.org/wiki/x')).toBe(false)
    expect(isRedirectHost('https://www.cannondale.com/x')).toBe(false)
  })
})

describe('dedupeSources', () => {
  const src = 'https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO'
  const other = 'https://www.cannondale.com/road/supersix-evo'

  test('collapses by URL, order-preserving (3 facts / 1 URL → 1 row)', () => {
    const out = dedupeSources([
      { sourceUrl: src, sourceTitle: 'a' },
      { sourceUrl: src, sourceTitle: 'b' },
      { sourceUrl: src, sourceTitle: 'c' },
    ])
    expect(out.map((s) => s.sourceUrl)).toEqual([src])
  })
  test('keeps distinct URLs as separate rows (title + hostname-fallback both survive)', () => {
    const out = dedupeSources([
      { sourceUrl: src, sourceTitle: 'Cannondale SuperSix EVO' },
      { sourceUrl: src, sourceTitle: 'Cannondale SuperSix EVO' },
      { sourceUrl: other, sourceTitle: '' },
    ])
    expect(out.map((s) => s.sourceUrl)).toEqual([src, other])
  })
  test('drops falsy / undefined / voxi: / redirect URLs (no dead row, no undefined.startsWith crash)', () => {
    const out = dedupeSources([
      { sourceUrl: '', sourceTitle: 'x' },
      { sourceUrl: undefined as unknown as string, sourceTitle: 'x' },
      { sourceUrl: 'voxi:observed', sourceTitle: 'x' },
      { sourceUrl: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', sourceTitle: '' },
      { sourceUrl: src, sourceTitle: 'ok' },
    ])
    expect(out.map((s) => s.sourceUrl)).toEqual([src])
  })
})
