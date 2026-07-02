/**
 * Deterministic tests for the server-owned reveal narration store (ANALYSIS-VOICE-PLAN A11 + ANALYSIS-UX §5.C). No
 * creds: proves the idempotent "captured once + pinned" invariant, per-bucket partitioning, and owner-scoping that
 * keep `/speech[/:bucket]` honest and consistent with what the user read — the parts that would otherwise diverge
 * under the temperature-0.7 narrator re-running on every reconnect/retry.
 */
import { test, expect, describe } from 'bun:test'
import { NarrationStore } from './narration-store'

describe('NarrationStore — captured once, pinned, per-bucket, owner-scoped', () => {
  test('first non-empty capture wins per bucket; a later (different) run does NOT overwrite (pinned)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', 'what', 'A 1976 Canon AE-1, a 35mm SLR.')
    // A reconnect re-runs the temp-0.7 narrator → different clauses; the pin must refuse to overwrite.
    s.capture('sess_A_1', 'what', 'Something else entirely.')
    expect(s.get('sess_A_1', 'A', 'what')).toBe('A 1976 Canon AE-1, a 35mm SLR.')
  })

  test('buckets are independent — `what`, `purpose`, `maker`, `facts` are stored + read separately', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', 'what', 'A 35mm SLR.')
    s.capture('sess_A_1', 'purpose', 'For enthusiast photographers.')
    s.capture('sess_A_1', 'maker', 'Made by Canon.')
    s.capture('sess_A_1', 'facts', 'It sold over a million units.')
    expect(s.get('sess_A_1', 'A', 'purpose')).toBe('For enthusiast photographers.')
    expect(s.get('sess_A_1', 'A', 'maker')).toBe('Made by Canon.')
    expect(s.get('sess_A_1', 'A', 'facts')).toBe('It sold over a million units.')
    expect(s.get('sess_A_1', 'A', 'what')).toBe('A 35mm SLR.')
  })

  test('an EMPTY capture never pins — a later real run still wins (a partial reconnect can’t erase it)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', 'what', '') // e.g. a startIndex reconnect that yields no tokens
    s.capture('sess_A_1', 'what', 'The real narration.')
    expect(s.get('sess_A_1', 'A', 'what')).toBe('The real narration.')
  })

  test('owner-scoped: a non-owner reads null (no cross-user leak); an uncaptured (session,bucket) reads null', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', 'what', 'A owns this.')
    expect(s.get('sess_A_1', 'B', 'what')).toBeNull() // B is not the owner encoded in the sessionId
    expect(s.get('sess_A_1', 'A', 'what')).toBe('A owns this.')
    expect(s.get('sess_A_1', 'A', 'maker')).toBeNull() // never captured that bucket
    expect(s.get('sess_B_9', 'B', 'what')).toBeNull() // never captured
  })

  test('purgeUser drops only the user’s sessions (deletion-cascade hygiene)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', 'what', 'A one')
    s.capture('sess_A_2', 'what', 'A two')
    s.capture('sess_B_1', 'what', 'B one')
    s.purgeUser('A')
    expect(s.get('sess_A_1', 'A', 'what')).toBeNull()
    expect(s.get('sess_A_2', 'A', 'what')).toBeNull()
    expect(s.get('sess_B_1', 'B', 'what')).toBe('B one') // untouched
  })
})
