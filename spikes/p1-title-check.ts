/**
 * P1 validation — the real identify_object cascade (LiveVisionProvider → real Gemini + Cloud Vision) now returns a
 * clean human `display_title` for the single primary object, and the cascade shows it on a CONFIDENT reveal.
 * Prints: arbitrated label (old title) vs displayTitle (new reveal title) vs band, per fixture.
 * Run: `bun spikes/p1-title-check.ts`  (needs gcloud auth).
 */
import { identify_object } from '../services/eve-agent/agent/tools/identify_object'
import { LiveVisionProvider } from '../services/eve-agent/agent/providers/live-vision'

const PAGES = ['LaCroix_Sparkling_Water', 'Canon_AE-1', 'Game_Boy', 'Rolex_Submariner']

async function imageFor(page: string): Promise<string | null> {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: { 'user-agent': 'voxi-p1-check/1.0' } })
  if (!r.ok) return null
  const j = (await r.json()) as { originalimage?: { source: string }; thumbnail?: { source: string } }
  return j.originalimage?.source ?? j.thumbnail?.source ?? null
}

const provider = new LiveVisionProvider()
console.log('\n── P1 title check: real identify_object, single-primary + display_title ──')
for (const page of PAGES) {
  await new Promise((r) => setTimeout(r, 1200))
  try {
    const url = await imageFor(page)
    if (!url) { console.log(`  ? ${page} — no image`); continue }
    const res = await identify_object({ uri: url }, provider)
    const revealTitle = res.confidence_band === 'CONFIDENT' ? res.displayTitle ?? res.label : res.label
    console.log(`\n  ${page}`)
    console.log(`    band          : ${res.confidence_band}`)
    console.log(`    label (old)   : "${res.label}"`)
    console.log(`    displayTitle  : ${res.displayTitle ? `"${res.displayTitle}"` : '(none — falls back to label)'}`)
    console.log(`    REVEAL TITLE  : "${revealTitle}"`)
  } catch (e) {
    console.log(`  ✗ ${page} — ${(e as Error).message.slice(0, 90)}`)
  }
}
console.log('')
