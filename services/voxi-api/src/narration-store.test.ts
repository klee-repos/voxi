/**
 * Deterministic tests for the server-owned reveal narration store (ANALYSIS-VOICE-PLAN A11). No creds: proves
 * the idempotent "captured once + pinned" invariant and owner-scoping that keep `/speech` honest and consistent
 * with what the user read — the parts that would otherwise diverge under the temperature-0.7 narrator re-running
 * on every reconnect/retry.
 */
import { test, expect, describe } from 'bun:test'
import { NarrationStore } from './narration-store'

describe('NarrationStore — captured once, pinned, owner-scoped', () => {
  test('first non-empty capture wins; a later (different) run does NOT overwrite (pinned)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', ['A 1976 Canon AE-1.', 'A 35mm SLR.'])
    // A reconnect re-runs the temp-0.7 narrator → different clauses; the pin must refuse to overwrite.
    s.capture('sess_A_1', ['Something else entirely.'])
    expect(s.get('sess_A_1', 'A')).toBe('A 1976 Canon AE-1. A 35mm SLR.')
  })

  test('an EMPTY capture never pins — a later real run still wins (a partial reconnect can’t erase it)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', []) // e.g. a startIndex reconnect that yields no tokens
    s.capture('sess_A_1', ['The real narration.'])
    expect(s.get('sess_A_1', 'A')).toBe('The real narration.')
  })

  test('owner-scoped: a non-owner reads null (no cross-user leak); an uncaptured session reads null', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', ['A owns this.'])
    expect(s.get('sess_A_1', 'B')).toBeNull() // B is not the owner encoded in the sessionId
    expect(s.get('sess_A_1', 'A')).toBe('A owns this.')
    expect(s.get('sess_B_9', 'B')).toBeNull() // never captured
  })

  test('purgeUser drops only the user’s sessions (deletion-cascade hygiene)', () => {
    const s = new NarrationStore()
    s.capture('sess_A_1', ['A one'])
    s.capture('sess_A_2', ['A two'])
    s.capture('sess_B_1', ['B one'])
    s.purgeUser('A')
    expect(s.get('sess_A_1', 'A')).toBeNull()
    expect(s.get('sess_A_2', 'A')).toBeNull()
    expect(s.get('sess_B_1', 'B')).toBe('B one') // untouched
  })
})
