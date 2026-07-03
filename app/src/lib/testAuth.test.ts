/**
 * testAuth seam — the native E2E auth-mode source that FakeAuth reads to start signed-out and steer its error
 * branches. Two invariants matter: (1) it is INERT unless EXPO_PUBLIC_TEST_MODE=1 (production safety), and (2)
 * only the three known modes pass through (a stray/typo'd deep-link value never sets a mode).
 */
import { expect, test, afterEach } from 'bun:test'
import { setAuthMode, getAuthMode, isFreshAuth } from './testAuth'

const original = process.env.EXPO_PUBLIC_TEST_MODE
afterEach(() => {
  setAuthMode(null)
  if (original === undefined) delete process.env.EXPO_PUBLIC_TEST_MODE
  else process.env.EXPO_PUBLIC_TEST_MODE = original
})

test('production-safe: a set mode is ignored when TEST_MODE is off', () => {
  process.env.EXPO_PUBLIC_TEST_MODE = '0'
  setAuthMode('exists')
  expect(getAuthMode()).toBeNull()
  expect(isFreshAuth()).toBe(false)
})

test('in test mode: the three known modes pass through', () => {
  process.env.EXPO_PUBLIC_TEST_MODE = '1'
  for (const m of ['fresh', 'exists', 'noaccount'] as const) {
    setAuthMode(m)
    expect(getAuthMode()).toBe(m)
    expect(isFreshAuth()).toBe(true)
  }
})

test('in test mode: an unknown/empty mode resolves to null (no accidental steer)', () => {
  process.env.EXPO_PUBLIC_TEST_MODE = '1'
  setAuthMode('bogus')
  expect(getAuthMode()).toBeNull()
  setAuthMode(null)
  expect(getAuthMode()).toBeNull()
  expect(isFreshAuth()).toBe(false)
})
