/**
 * Accuracy spike — honest scoring through the REAL identify_object tool + LiveVisionProvider. Scores the
 * ARBITRATED result the user actually sees, not "any stage got it". Run: `bun spikes/accuracy-spike.ts`.
 * CAVEAT: Wikipedia lead images are clean product shots — an optimistic upper bound vs. real phone photos.
 */
import { identify_object } from '../services/eve-agent/agent/tools/identify_object'
import { LiveVisionProvider } from '../services/eve-agent/agent/providers/live-vision'

type Item = { page: string; make: string; model: string; vertical: string }
const SET: Item[] = [
  { page: 'Canon_AE-1', make: 'Canon', model: 'AE-1', vertical: 'camera' },
  { page: 'Nikon_F', make: 'Nikon', model: 'F', vertical: 'camera' },
  { page: 'Leica_M3', make: 'Leica', model: 'M3', vertical: 'camera' },
  { page: 'Polaroid_SX-70', make: 'Polaroid', model: 'SX-70', vertical: 'camera' },
  { page: 'Casio_F-91W', make: 'Casio', model: 'F-91W', vertical: 'watch' },
  { page: 'Rolex_Submariner', make: 'Rolex', model: 'Submariner', vertical: 'watch' },
  { page: 'Omega_Speedmaster', make: 'Omega', model: 'Speedmaster', vertical: 'watch' },
  { page: 'Fender_Stratocaster', make: 'Fender', model: 'Stratocaster', vertical: 'guitar' },
  { page: 'Gibson_Les_Paul', make: 'Gibson', model: 'Les Paul', vertical: 'guitar' },
  { page: 'Game_Boy', make: 'Nintendo', model: 'Game Boy', vertical: 'console' },
  { page: 'Volkswagen_Beetle', make: 'Volkswagen', model: 'Beetle', vertical: 'car' },
  { page: 'Raleigh_Chopper', make: 'Raleigh', model: 'Chopper', vertical: 'bike' },
]

async function imageFor(page: string): Promise<string | null> {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: { 'user-agent': 'voxi-spike/1.0' } })
  if (!r.ok) return null
  const j = (await r.json()) as { originalimage?: { source: string }; thumbnail?: { source: string } }
  return j.originalimage?.source ?? j.thumbnail?.source ?? null
}

const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const provider = new LiveVisionProvider()

let surfaced = 0 // correct answer appears in the arbitrated label/candidates (user can pick it)
let confidentCorrect = 0 // CONFIDENT and correct → safe to assert
const rows: string[] = []

for (const it of SET) {
  await new Promise((r) => setTimeout(r, 1500)) // space out Wikimedia requests (429 avoidance)
  try {
    const url = await imageFor(it.page)
    if (!url) {
      rows.push(`  ?  ${it.page.padEnd(22)} — no image`)
      continue
    }
    const res = await identify_object({ uri: url }, provider)
    // WHOLE-TOKEN scoring (not substring): "F" must appear as a standalone token, so a wrong "Nikon FM2" does
    // NOT score as a correct "Nikon F". This is the honest metric — no free credit from common-letter substrings.
    const hayToks = new Set(norm([res.label, ...res.candidates.map((c) => c.name)].join(' ')).split(' ').filter(Boolean))
    const makeOk = norm(it.make).split(' ').filter(Boolean).every((tok) => hayToks.has(tok))
    const modelOk = norm(it.model).split(' ').filter(Boolean).every((tok) => hayToks.has(tok))
    const correct = makeOk && modelOk
    if (correct) surfaced++
    if (correct && res.confidence_band === 'CONFIDENT') confidentCorrect++
    const mark = correct && res.confidence_band === 'CONFIDENT' ? '✓' : correct ? '~' : '✗'
    rows.push(`  ${mark}  ${it.page.padEnd(22)} [${it.vertical}] → "${res.label}"  (${res.confidence_band}/${res.route})${correct ? '' : `  want ${it.make} ${it.model}`}`)
  } catch (e) {
    rows.push(`  ✗  ${it.page.padEnd(22)} — error: ${(e as Error).message.slice(0, 70)}`)
  }
}

const n = SET.length
console.log('\n── H2 accuracy — REAL identify_object tool, honest arbitrated scoring (clean images = upper bound) ──')
console.log(rows.join('\n'))
console.log(`\n  ✓ CONFIDENT & correct (safe to assert):     ${confidentCorrect}/${n}  (${Math.round((100 * confidentCorrect) / n)}%)`)
console.log(`  ~+✓ correct answer surfaced (incl. hedged): ${surfaced}/${n}  (${Math.round((100 * surfaced) / n)}%)`)
console.log('\n  NOTE: clean-image upper bound. Real phone photos are the true test (.gcp/spike-images/ + labels.csv).')
