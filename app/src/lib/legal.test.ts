/** Legal links must be absolute https URLs (they open in the browser from the consent microcopy). */
import { expect, test } from 'bun:test'
import { LEGAL } from './legal'

test('terms + privacy are absolute https URLs', () => {
  expect(LEGAL.terms).toMatch(/^https:\/\/\S+$/)
  expect(LEGAL.privacy).toMatch(/^https:\/\/\S+$/)
})
