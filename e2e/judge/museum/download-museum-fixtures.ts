#!/usr/bin/env bun
/**
 * Re-download the museum eval fixtures (gitignored binaries) from Wikimedia Commons and VERIFY each against the
 * committed manifest sha1 — failing LOUDLY on drift rather than silently feeding the cascade different bytes
 * (adversarial D5: Special:FilePath resolves to the LATEST revision, so a re-upload could otherwise change the
 * eval input under a frozen baseline). On any drift/failure this exits non-zero; re-curate the drifted fixture.
 *
 *   bun e2e/judge/museum/download-museum-fixtures.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MuseumFixture } from './gate'

const DIR = import.meta.dir
const FIXTURES = join(DIR, 'fixtures')
mkdirSync(FIXTURES, { recursive: true })
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as MuseumFixture[]

const fileName = (sourceUrl: string): string => decodeURIComponent(sourceUrl.split('/wiki/File:')[1] ?? '')
const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex')

let ok = 0
let drift = 0
let failed = 0
for (const fx of manifest) {
  const name = fileName(fx.source_url)
  if (!name) { console.error(`✗ ${fx.id}: no File name in source_url`); failed++; continue }
  // The SAME immutable-ish render the fixtures were curated from; sha1-verified below so any drift is caught.
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=1600`
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'voxi-eval/1.0 (dev@voxi.test)' }, redirect: 'follow' })
    if (!r.ok) { console.error(`✗ ${fx.id}: ${r.status} ${url}`); failed++; continue }
    const bytes = new Uint8Array(await r.arrayBuffer())
    const got = sha1(bytes)
    if (fx.sha1 && got !== fx.sha1) {
      console.error(`⚠ ${fx.id}: sha1 DRIFT — upstream image changed (want ${fx.sha1.slice(0, 12)}, got ${got.slice(0, 12)}). NOT saved; re-curate this fixture.`)
      drift++
      continue
    }
    writeFileSync(join(FIXTURES, fx.file), bytes)
    ok++
    console.log(`✓ ${fx.id}  (${(bytes.length / 1024) | 0} KB)`)
  } catch (e) {
    console.error(`✗ ${fx.id}: ${(e as Error).message}`)
    failed++
  }
}
console.log(`\n${ok} verified · ${drift} drifted · ${failed} failed  of ${manifest.length}`)
process.exit(drift || failed ? 1 : 0)
