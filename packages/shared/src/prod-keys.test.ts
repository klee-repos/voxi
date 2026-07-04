import { test, expect } from 'bun:test'
import { assertProdKeys, REQUIRED_PROD_KEYS } from './prod-keys'

test('required keys are exactly the OpenAI + Firecrawl secrets the cascade/worker call', () => {
  expect([...REQUIRED_PROD_KEYS]).toEqual(['OPENAI_API_KEY', 'FIRECRAWL_API_KEY'])
})

test('no-op when not on Cloud Run (K_SERVICE unset) — local dev + tests never crash', () => {
  expect(() => assertProdKeys({}, false)).not.toThrow()
  expect(() => assertProdKeys({})).not.toThrow()
})

test('throws on Cloud Run when either secret is missing', () => {
  expect(() => assertProdKeys({ K_SERVICE: 'voxi-api' }, true)).toThrow(/OPENAI_API_KEY, FIRECRAWL_API_KEY/)
  expect(() => assertProdKeys({ K_SERVICE: 'voxi-api', OPENAI_API_KEY: 'k' }, true)).toThrow(/FIRECRAWL_API_KEY/)
  expect(() => assertProdKeys({ K_SERVICE: 'voxi-api', FIRECRAWL_API_KEY: 'f' }, true)).toThrow(/OPENAI_API_KEY/)
})

test('both secrets present on Cloud Run → no throw', () => {
  expect(() => assertProdKeys({ K_SERVICE: 'voxi-api', OPENAI_API_KEY: 'k', FIRECRAWL_API_KEY: 'f' }, true)).not.toThrow()
})

test('an empty/whitespace value counts as missing (catches a typo’d empty binding)', () => {
  expect(() => assertProdKeys({ K_SERVICE: 'voxi-api', OPENAI_API_KEY: '', FIRECRAWL_API_KEY: '   ' }, true)).toThrow(
    /OPENAI_API_KEY, FIRECRAWL_API_KEY/,
  )
})