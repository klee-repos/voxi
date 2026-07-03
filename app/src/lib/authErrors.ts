/**
 * Auth error taxonomy + the E2E error-branch decision — kept in a dependency-light module (no React / react-native
 * imports) so it is unit-testable under bun, and re-exported from clerk.tsx for the app. The screens map these to
 * calm, in-persona copy + the sign-up↔sign-in cross-links.
 */
import type { AuthMode } from './testAuth'

/** Sign-up was attempted for an email that already has an account → route the user to /sign-in. */
export class EmailExistsError extends Error {
  constructor() {
    super('That email already has an account.')
    this.name = 'EmailExistsError'
  }
}

/**
 * Sign-in was attempted for an email with no account → route to /sign-up. NOTE: on a prod Clerk instance with
 * enumeration protection ON this is NOT reliably thrown (Clerk masks non-existence and sends a placeholder code);
 * the enumeration-safe switch happens at the CODE stage ("that code didn't match — create an account"). This
 * fires only when Clerk surfaces `form_identifier_not_found` (dev instances, protection OFF).
 */
export class NoAccountError extends Error {
  constructor() {
    super('No account found for that email.')
    this.name = 'NoAccountError'
  }
}

/**
 * The deterministic error a FakeAuth start* should raise for the E2E auth mode (null → happy path). Pure so the
 * exists/no-account branches are unit-testable without a React renderer. `exists` fails sign-UP (→ "log in");
 * `noaccount` fails sign-IN (→ "create one"); every other combination succeeds.
 */
export function authModeError(kind: 'signUp' | 'signIn', mode: AuthMode | null): Error | null {
  if (kind === 'signUp' && mode === 'exists') return new EmailExistsError()
  if (kind === 'signIn' && mode === 'noaccount') return new NoAccountError()
  return null
}
