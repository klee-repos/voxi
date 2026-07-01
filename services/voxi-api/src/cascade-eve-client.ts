/**
 * The REAL EveClient the BFF runs (replacing the test fake): a photo → the live identification cascade
 * (safety_gate → identify_object[LiveVisionProvider: Vertex Gemini + Cloud Vision + catalog moat → arbiter] →
 * LiveNarrator) → the events.ts NDJSON stream the app renders. This is the production identification path
 * assembled into the `EveClient` seam createApp consumes. (The full durable eve workflow — storyteller episodes,
 * interviewer, schedules — is the framework tier; this delivers the core capture→identify→narrate loop, live.)
 *
 * The catalog "moat" (Stage 3) is ADDITIVE and OPTIONAL: pass CatalogDeps and each scan (a) short-circuits on a
 * prior-scan vector hit and (b) grows a per-user private catalog after a CONFIDENT/PROBABLE reveal. With no
 * catalog injected — or an empty one — the stream is byte-identical to the vlm+web-only path.
 */
import type { EveClient } from './app'
import { runIdentificationCascade } from '../../eve-agent/agent/cascade'
import { LiveVisionProvider, type CatalogDeps } from '../../eve-agent/agent/providers/live-vision'
import { LiveSafetyClassifier } from '../../eve-agent/agent/providers/live-safety'
import { LiveNarrator } from '../../eve-agent/agent/providers/live-narrator'
import { LiveResearcher } from '../../eve-agent/agent/providers/live-research'
import { NarrationStore } from './narration-store'
import { loadImageBytes } from '../../eve-agent/agent/lib/gcp-vision'
import { parseEventLine } from '../../../packages/shared/src/events'
import type { StreamEvent } from '../../../packages/shared/src/events'

export class CascadeEveClient implements EveClient {
  private photos = new Map<string, string>()
  /** SERVER-OWNED reveal narration, captured once + pinned per session (A11). See NarrationStore. */
  private narrations = new NarrationStore()
  private vision: LiveVisionProvider
  private safety = new LiveSafetyClassifier()
  private narrator = new LiveNarrator()
  private researcher = new LiveResearcher()
  private n = 0

  /** @param catalogDeps OPTIONAL — inject a Catalog + EmbeddingProvider to enable the Stage-3 moat. Omit → the
   *  exact vlm+web-only production path (unchanged). */
  constructor(private catalogDeps?: CatalogDeps) {
    this.vision = new LiveVisionProvider(catalogDeps)
  }

  async createSession({ userId, photoUrl }: { userId: string; photoUrl: string }) {
    const sessionId = `sess_${userId}_${Date.now().toString(36)}_${this.n++}`
    this.photos.set(sessionId, photoUrl)
    return { sessionId, continuationToken: `ct_${sessionId}` }
  }

  /** SERVER-OWNED narration for the spoken reveal — owner-scoped (the sessionId encodes the owner). */
  async narrationText(sessionId: string, userId: string): Promise<string | null> {
    return this.narrations.get(sessionId, userId)
  }

  /** Deletion cascade hook: drop every stored photo AND narration for this user's sessions. Returns photos purged. */
  purgeUser(userId: string): number {
    const prefix = `sess_${userId}_`
    let n = 0
    for (const sid of [...this.photos.keys()]) if (sid.startsWith(prefix)) { this.photos.delete(sid); n++ }
    this.narrations.purgeUser(userId)
    return n
  }

  async *stream(sessionId: string, userId: string, startIndex = 0): AsyncIterable<string> {
    const photoUrl = this.photos.get(sessionId)
    if (!photoUrl) {
      // Unknown/expired session → a typed hard_failure the app can retry (never a silent hang).
      yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'session expired — capture again' })
      yield JSON.stringify({ type: 'done', index: 1, sessionId })
      return
    }

    // Preload the image ONCE here (when a catalog is wired) so the SAME b64 feeds both the cascade AND the
    // post-ID catalog upsert. A fetch failure must still read as a technical hard_failure — NOT a refusal — so
    // on any preload error we fall back to the original path (inject loadImageBytes as the cascade's preloader,
    // which reproduces today's exact hard_failure behaviour). With NO catalog we take that original path always.
    let bytes: { b64: string; mime: string } | undefined
    if (this.catalogDeps) {
      try { bytes = await loadImageBytes(photoUrl) } catch { bytes = undefined }
    }

    const image = bytes
      ? { uri: photoUrl, userId, bytes } // bytes present → cascade uses them; provider embeds this exact b64
      : { uri: photoUrl, userId }

    const events = runIdentificationCascade(sessionId, image, {
      vision: this.vision,
      safety: this.safety,
      narrator: this.narrator,
      researcher: this.researcher,
      // Only wire preload when we did NOT already load bytes — preserves the "dead uri → hard_failure" behaviour.
      ...(bytes ? {} : { preload: loadImageBytes }),
    })

    let band: Extract<StreamEvent, { type: 'confidence_band' }> | undefined
    const captured: string[] = [] // full narration for this run, tapped BEFORE the startIndex filter (A11)
    for await (const ev of events) {
      if (ev.type === 'confidence_band') band = ev
      if (ev.type === 'token') captured.push(ev.text)
      if (ev.index < startIndex) continue // ?startIndex= reconnection: replay only from the last acked index
      // Re-validate against the shared contract so the app never receives an off-contract line.
      yield JSON.stringify(parseEventLine(JSON.stringify(ev)))
    }
    // Pin the narration on the FIRST run only — a reconnect re-runs the (temp 0.7) narrator, so NarrationStore
    // refuses to overwrite, keeping /speech byte-consistent with the whatItIs the app rendered on the first drain.
    this.narrations.capture(sessionId, captured)

    // AFTER the reveal: grow the moat. Upsert the accepted id as a PRIVATE catalog item (guarded end-to-end in
    // the provider). Only runs with a catalog + the bytes we loaded above; UNKNOWN/refusals are never upserted.
    if (this.catalogDeps && bytes && band) {
      await this.vision.upsertAccepted(userId, bytes.b64, { label: band.title, confidence_band: band.band })
    }
  }
}
