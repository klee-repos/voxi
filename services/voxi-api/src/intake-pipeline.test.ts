/**
 * Executable tests for the legally load-bearing intake ordering (RT-2 / RT-4). `bun test`.
 * Asserts the no-cheating invariants: CSAM never stored/redacted, redactor fail-closed, embed only redacted.
 */
import { test, expect, describe } from 'bun:test'
import { intake, type IntakeDeps } from './intake-pipeline'

const bytes = (s: string) => new TextEncoder().encode(s)

function deps(over: Partial<IntakeDeps> = {}): { deps: IntakeDeps; calls: Record<string, number> } {
  const calls: Record<string, number> = { ncmec: 0, redact: 0, deleteOriginal: 0 }
  const base: IntakeDeps = {
    hash: { isCsam: async () => false },
    safeSearch: { isDisallowed: async () => false },
    redactor: {
      redact: async () => {
        calls.redact++
        return { redactedObjectKey: 'redacted/abc' }
      },
    },
    ncmec: { quarantineAndReport: async () => void (calls.ncmec++) },
    store: { scheduleOriginalDeletion: async () => void (calls.deleteOriginal++) },
  }
  return { deps: { ...base, ...over }, calls }
}

describe('intake pipeline ordering', () => {
  test('CSAM match → quarantine+NCMEC only, never redacted, never stored normally', async () => {
    const { deps: d, calls } = deps({ hash: { isCsam: async () => true } })
    const out = await intake(bytes('bad'), 'orig/1', d)
    expect(out.kind).toBe('csam_quarantined')
    expect(calls.ncmec).toBe(1)
    expect(calls.redact).toBe(0) // original must NOT be redacted (preserve evidentiary original)
    expect(calls.deleteOriginal).toBe(0) // not deleted — preserved 90 days for NCMEC
  })

  test('NSFW → blocked before persona, nothing stored', async () => {
    const { deps: d, calls } = deps({ safeSearch: { isDisallowed: async () => true } })
    const out = await intake(bytes('nsfw'), 'orig/2', d)
    expect(out.kind).toBe('blocked_nsfw')
    expect(calls.redact).toBe(0)
  })

  test('redactor failure → upload REJECTED, fail-closed (never store unredacted)', async () => {
    const { deps: d, calls } = deps({ redactor: { redact: async () => null } })
    const out = await intake(bytes('clean'), 'orig/3', d)
    expect(out.kind).toBe('rejected_redactor_failed')
    expect(calls.deleteOriginal).toBe(0)
  })

  test('redactor throw → still fail-closed', async () => {
    const { deps: d } = deps({
      redactor: {
        redact: async () => {
          throw new Error('timeout')
        },
      },
    })
    const out = await intake(bytes('clean'), 'orig/4', d)
    expect(out.kind).toBe('rejected_redactor_failed')
  })

  test('clean image → only redacted derivative proceeds, original scheduled for deletion', async () => {
    const { deps: d, calls } = deps()
    const out = await intake(bytes('clean'), 'orig/5', d)
    expect(out.kind).toBe('accepted')
    if (out.kind === 'accepted') {
      expect(out.embedSource).toBe('redacted')
      expect(out.redactedObjectKey).toBe('redacted/abc')
    }
    expect(calls.redact).toBe(1)
    expect(calls.deleteOriginal).toBe(1)
  })
})
