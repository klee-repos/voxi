/**
 * Pure honesty-gate test for the LiveChatProvider (the WS1 crux). The chat reply is NOT freeform prose — the
 * provider emits claim-structured clauses + runs the REAL shared `validateClaims` gate, exactly like the
 * narrator. This proves a free-form user question cannot coerce an ungrounded confident assertion: any
 * falsifiable clause without valid grounding is dropped, and if nothing survives the reply is an in-persona
 * hedge. No Gemini / no creds — `gateChat` is the pure, testable core.
 */
import { test, expect, describe } from 'bun:test'
import { gateChat } from './live-chat'
import type { Clause, Evidence } from '../../../../packages/shared/src/confidence'

const evidence: Evidence[] = [
  { ref: 'fact0', sourceUrl: 'https://example.com/x', claim: 'Made in Pennsylvania in 2008.' },
  { ref: 'id', sourceUrl: 'voxi:cascade', claim: 'Cannondale' },
]

describe('LiveChatProvider honesty gate (gateChat)', () => {
  test('grounds a clause that cites valid evidence', () => {
    const r = gateChat([{ text: 'It was made in Pennsylvania.', claimType: 'provenance', evidenceRef: 'fact0' } as Clause], evidence)
    expect(r.grounded).toBe(true)
    expect(r.text).toContain('Pennsylvania')
  })

  test('drops a falsifiable clause with NO evidenceRef → hedge (no hallucination)', () => {
    const r = gateChat([{ text: 'It is worth five hundred pounds.', claimType: 'spec' } as Clause], evidence)
    expect(r.grounded).toBe(false)
    expect(r.text).not.toContain('five hundred')
  })

  test('drops a clause citing a non-existent evidenceRef → hedge', () => {
    const r = gateChat([{ text: 'It won Best in Show.', claimType: 'superlative', evidenceRef: 'made.up' } as Clause], evidence)
    expect(r.grounded).toBe(false)
  })

  test('keeps a flavor (persona) clause that asserts nothing falsifiable', () => {
    const r = gateChat([{ text: 'A fine question.', claimType: 'flavor' } as Clause], evidence)
    expect(r.grounded).toBe(true)
    expect(r.text).toContain('fine question')
  })

  test('mixed: keeps the grounded clause, drops the ungrounded one, renders approved-only', () => {
    const r = gateChat(
      [
        { text: 'It was made in Pennsylvania.', claimType: 'provenance', evidenceRef: 'fact0' } as Clause,
        { text: 'It is the fastest ever made.', claimType: 'superlative' } as Clause, // no ref → dropped
      ],
      evidence,
    )
    expect(r.grounded).toBe(true)
    expect(r.text).toContain('Pennsylvania')
    expect(r.text).not.toContain('fastest')
  })

  test('all clauses dropped → in-persona hedge, grounded=false', () => {
    const r = gateChat([{ text: 'It is worth a fortune.', claimType: 'spec' } as Clause], evidence)
    expect(r.grounded).toBe(false)
    expect(r.text.toLowerCase()).toContain("can't prove") // in-persona hedge, never an overclaim
  })
})
