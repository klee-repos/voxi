/**
 * LIVE identification CLI: real Vertex Gemini + Cloud Vision (via the gcp-vision lib, authed through the
 * gcloud CLI — no ADC, no SA key) fed into the shared arbitration. This is a thin wrapper over the single
 * source of truth in services/eve-agent/agent/lib/gcp-vision.ts. Run: `bun spikes/live-identify.ts <img>`.
 */
import { arbitrate, type Candidate } from '../packages/shared/src/arbitration'
import { geminiIdentify, visionWebDetect, loadImageBytes } from '../services/eve-agent/agent/lib/gcp-vision'

/** Full live cascade for one image → the arbitrated decision (shared by the CLI below). */
export async function identify(pathOrUrl: string) {
  const { b64, mime } = await loadImageBytes(pathOrUrl)
  const [vlm, web] = await Promise.all([geminiIdentify(b64, mime), visionWebDetect(b64)])
  const vlmName = [vlm.year_or_range, vlm.make, vlm.model].filter(Boolean).join(' ').trim()
  const candidates: { catalog?: Candidate; web?: Candidate; vlm?: Candidate } = {
    vlm: { name: vlmName, make: vlm.make || undefined, model: vlm.model || undefined, source: 'vlm', confidence: vlm.fine_confidence ?? 0.5 },
  }
  if (web.bestGuess) candidates.web = { name: web.bestGuess, source: 'web', confidence: web.entities[0]?.score ? Math.min(1, web.entities[0].score) : 0.6 }
  return { vlm, web, vlmName, decision: arbitrate(candidates) }
}

if (import.meta.main) {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: bun spikes/live-identify.ts <image-path-or-url>')
    process.exit(1)
  }
  const { vlm, web, vlmName, decision } = await identify(arg)
  console.log('\n── LIVE identification (real Gemini + Cloud Vision via gcloud CLI) ──')
  console.log('VLM  (Gemini):', vlmName, `  conf=${vlm.fine_confidence}`, vlm.distinguishing_features?.length ? `  features=${vlm.distinguishing_features.join(', ')}` : '')
  if (vlm.ocr_text?.length) console.log('OCR :', vlm.ocr_text.join(' | '))
  console.log('WEB  (Vision bestGuess):', web.bestGuess ?? '(none)')
  if (web.entities?.length) console.log('WEB  entities:', web.entities.map((e) => e.description).join(', '))
  console.log('→ ARBITRATED:', decision.band, '·', decision.route, '·', decision.chosen?.name ?? decision.candidates.map((c) => c.name).join(' | '), `(${decision.reason})`)
}
