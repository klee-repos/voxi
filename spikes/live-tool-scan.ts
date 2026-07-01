/**
 * Proof that the real eve `identify_object` TOOL — the exact code the app runs — produces the reveal-shaped
 * {label, confidence_band, granularity_level, unsupported_fields, route, candidates} from a LIVE scan via the
 * LiveVisionProvider (real Gemini + Cloud Vision). Run: `bun spikes/live-tool-scan.ts <image-path-or-url>`.
 */
import { identify_object } from '../services/eve-agent/agent/tools/identify_object'
import { LiveVisionProvider } from '../services/eve-agent/agent/providers/live-vision'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: bun spikes/live-tool-scan.ts <image-path-or-url>')
  process.exit(1)
}
const result = await identify_object({ uri: arg }, new LiveVisionProvider())
console.log('\n── identify_object (the REAL tool) on a LIVE scan ──')
console.log(JSON.stringify(result, null, 2))
