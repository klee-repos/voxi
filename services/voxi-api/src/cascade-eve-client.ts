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
import { runIdentificationCascade, type CascadeDeps } from '../../eve-agent/agent/cascade'
import { LiveVisionProvider, type CatalogDeps } from '../../eve-agent/agent/providers/live-vision'
import { LiveSafetyClassifier } from '../../eve-agent/agent/providers/live-safety'
import { LiveNarrator } from '../../eve-agent/agent/providers/live-narrator'
import { LiveResearcher } from '../../eve-agent/agent/providers/live-research'
import { dossierProviderFromEnv, type DossierProvider } from '../../eve-agent/agent/providers/live-dossier'
import { NarrationStore } from './narration-store'
import { loadImageBytes } from '../../eve-agent/agent/lib/gcp-vision'
import { parseEventLine, isAudioBucket, type AudioBucket } from '../../../packages/shared/src/events'
import type { StreamEvent } from '../../../packages/shared/src/events'

export class CascadeEveClient implements EveClient {
  private photos = new Map<string, string>()
  /** SERVER-OWNED reveal narration, captured once + pinned per session (A11). See NarrationStore. */
  private narrations = new NarrationStore()
  private vision: LiveVisionProvider
  private safety = new LiveSafetyClassifier()
  private narrator = new LiveNarrator()
  private researcher = new LiveResearcher()
  /** The async deep-research provider (Firecrawl+Gemini deep path when keyed, else the Gemini-grounding path). It
   *  produces the durable, fully-cited dossier that streams the progressive `fact` chips AND the grounded
   *  `description_upgrade` that replaces the thin first-pass narration — the whole point of PROMPT-QUALITY §3.B/§3.C.
   *  Without this wired the deep-research code never runs and the reveal reads generic ("what a watch is"). */
  private dossier: DossierProvider = dossierProviderFromEnv()
  private n = 0

  /**
   * @param catalogDeps OPTIONAL — inject a Catalog + EmbeddingProvider to enable the Stage-3 moat. Omit → the
   *  exact vlm+web-only production path (unchanged).
   * @param overrides OPTIONAL test seam (creds-free) — replace any live provider fed to the cascade with a fake so
   *  the assembled stream (including the deep-research `fact`/`description_upgrade` wiring) can be exercised without
   *  GCP/Firecrawl. Production never passes this; the live providers above are the default.
   */
  constructor(
    private catalogDeps?: CatalogDeps,
    private overrides?: Partial<Pick<CascadeDeps, 'vision' | 'safety' | 'narrator' | 'researcher' | 'dossier'>>,
  ) {
    this.vision = new LiveVisionProvider(catalogDeps)
  }

  async createSession({ userId, photoUrl }: { userId: string; photoUrl: string }) {
    const sessionId = `sess_${userId}_${Date.now().toString(36)}_${this.n++}`
    this.photos.set(sessionId, photoUrl)
    return { sessionId, continuationToken: `ct_${sessionId}` }
  }

  /** SERVER-OWNED narration for a spoken reveal BUCKET — owner-scoped (the sessionId encodes the owner). `what` is
   *  the default (back-compat with the pre-redesign `/speech` route); `purpose`/`maker`/`facts` are the other buckets. */
  async narrationText(sessionId: string, userId: string, bucket: AudioBucket = 'what'): Promise<string | null> {
    return this.narrations.get(sessionId, userId, bucket)
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
      vision: this.overrides?.vision ?? this.vision,
      safety: this.overrides?.safety ?? this.safety,
      narrator: this.overrides?.narrator ?? this.narrator,
      researcher: this.overrides?.researcher ?? this.researcher,
      // PIN the server-owned narration the INSTANT the narrator produces its clauses — synchronously, before the
      // first `token` is even streamed and long before the async deep-research phase (which holds the stream open
      // for ~a minute). The app requests POST /v1/threads/:id/speech the moment the reveal renders; capturing only
      // at end-of-stream (the safety net above) left it 404ing `no_narration` for that whole window. Pin-once, so a
      // reconnect's re-run can't clobber the exact clauses the app rendered + spoke on the first drain.
      // The `what` bucket audio = the what-only first-pass clauses (cascade passes only `what_is_it` clauses here),
      // pinned synchronously so /speech/what has text the instant the reveal renders — never the full composite.
      onNarration: (clauses) => this.narrations.capture(sessionId, 'what', clauses.join(' ')),
      // The deep-research pass: after the instant reveal it streams verified `fact` chips + a grounded
      // `description_upgrade` that replaces the thin first-pass narration on the same open stream (§3.B4). Best-effort
      // in the cascade — any research failure/timeout leaves the instant reveal exactly as it was.
      dossier: this.overrides?.dossier ?? this.dossier,
      // Only wire preload when we did NOT already load bytes — preserves the "dead uri → hard_failure" behaviour.
      ...(bytes ? {} : { preload: loadImageBytes }),
    })

    let band: Extract<StreamEvent, { type: 'confidence_band' }> | undefined
    const captured: string[] = [] // what-only narration for this run, tapped BEFORE the startIndex filter (A11)
    const factTexts: string[] = [] // accumulated verified fact texts → the `facts` bucket audio (stable at `done`)
    for await (const ev of events) {
      if (ev.type === 'confidence_band') band = ev
      if (ev.type === 'token') captured.push(ev.text)
      // Tap the per-bucket audio text off the stream AS IT PASSES (adversarial P1-2) — so /speech/:bucket has text
      // the instant that bucket's icon flips active, not ~a minute later at end-of-stream. purpose/maker ← their
      // `section` text (empty-marker sections carry no text → capture() no-ops); facts ← the joined fact texts.
      if (ev.type === 'section' && ev.text && isAudioBucket(ev.bucket)) this.narrations.capture(sessionId, ev.bucket, ev.text)
      if (ev.type === 'fact') factTexts.push(ev.text)
      if (ev.type === 'done' && factTexts.length) this.narrations.capture(sessionId, 'facts', factTexts.join(' '))
      if (ev.index < startIndex) continue // ?startIndex= reconnection: replay only from the last acked index
      // Re-validate against the shared contract so the app never receives an off-contract line.
      yield JSON.stringify(parseEventLine(JSON.stringify(ev)))
    }
    // Safety net: pin the `what` narration at end-of-stream too. The PRIMARY capture is the synchronous
    // `onNarration` callback above (fires the instant the narrator produces its what-only clauses, before the
    // ~minute-long async deep-research phase). capture() is pin-once, so this is a no-op once onNarration has
    // fired; it still covers a reconnect (startIndex>0) that re-runs with no onNarration hit.
    this.narrations.capture(sessionId, 'what', captured.join(' '))

    // AFTER the reveal: grow the moat. Upsert the accepted id as a PRIVATE catalog item (guarded end-to-end in
    // the provider). Only runs with a catalog + the bytes we loaded above; UNKNOWN/refusals are never upserted.
    if (this.catalogDeps && bytes && band) {
      await this.vision.upsertAccepted(userId, bytes.b64, { label: band.title, confidence_band: band.band })
    }
  }
}
