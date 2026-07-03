/**
 * authModeError — the pure decision behind FakeAuth's deterministic error branches (the enumeration-safe E2E
 * seam). `exists` must fail ONLY sign-up (→ "log in instead"); `noaccount` must fail ONLY sign-in (→ "create
 * one"); the happy modes never throw. Crossing these would make the E2E error-branch flows green on the wrong
 * screen.
 */
import { expect, test } from 'bun:test'
import { authModeError, EmailExistsError, NoAccountError } from './authErrors'

test('exists → EmailExistsError on sign-up, but sign-in is unaffected', () => {
  expect(authModeError('signUp', 'exists')).toBeInstanceOf(EmailExistsError)
  expect(authModeError('signIn', 'exists')).toBeNull()
})

test('noaccount → NoAccountError on sign-in, but sign-up is unaffected', () => {
  expect(authModeError('signIn', 'noaccount')).toBeInstanceOf(NoAccountError)
  expect(authModeError('signUp', 'noaccount')).toBeNull()
})

test('the happy modes never throw', () => {
  for (const kind of ['signUp', 'signIn'] as const) {
    expect(authModeError(kind, null)).toBeNull()
    expect(authModeError(kind, 'fresh')).toBeNull()
  }
})
