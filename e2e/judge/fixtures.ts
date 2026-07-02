/**
 * Judge fixtures (PROMPT-QUALITY §3.D2) — canonical objects with ground-truth expectations for the deterministic
 * gate, plus the subject + Wikipedia lead image the LIVE eval runs the real cascade against. Chosen as high-signal
 * subjects with rich sources so ≥3 verified facts is reliably achievable.
 */
import type { FixtureExpect } from './gate'

export interface Fixture {
  id: string
  subject: string
  scope: 'item' | 'class'
  subjectTerms: string[]
  /** a Wikipedia page whose lead image the live eval identifies (title path); undefined → research-only. */
  wikiPage?: string
  expect: FixtureExpect
}

export const FIXTURES: Fixture[] = [
  {
    id: 'canon-ae1',
    subject: 'Canon AE-1',
    scope: 'item',
    subjectTerms: ['Canon', 'AE-1'],
    wikiPage: 'Canon_AE-1',
    expect: {
      titleTokens: ['canon', 'ae'],
      maxTitleWords: 6,
      requiredDescriptionTokens: ['slr', 'camera', '35 mm', '35mm'],
      minDescriptionWords: 35,
      minFacts: 3,
    },
  },
  {
    id: 'gameboy',
    subject: 'Nintendo Game Boy',
    scope: 'item',
    subjectTerms: ['Nintendo', 'Game Boy'],
    wikiPage: 'Game_Boy',
    expect: {
      titleTokens: ['game', 'boy'],
      maxTitleWords: 6,
      requiredDescriptionTokens: ['nintendo', 'handheld', 'console'],
      minDescriptionWords: 35,
      minFacts: 3,
    },
  },
  {
    id: 'lacroix',
    subject: 'LaCroix Sparkling Water',
    scope: 'item',
    subjectTerms: ['LaCroix'],
    // no free Wikipedia lead image — research-only (the reason the title spike used other fixtures).
    expect: {
      titleTokens: ['lacroix'],
      maxTitleWords: 6,
      requiredDescriptionTokens: ['sparkling', 'water', 'national beverage', 'carbonated'],
      minDescriptionWords: 30,
      minFacts: 3,
    },
  },
]
