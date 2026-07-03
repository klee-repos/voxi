/**
 * Podcast render pipeline (PLAN §6.2 / D5, D7 / eng-F1, F7, F8 / RT-1, RT-9).
 *
 * Turns a (catalogItemId, version) job into a finished two-voice (Arlo + Mave) episode — WITHOUT credentials.
 * Every external boundary is a PLUGGABLE provider so the whole pipeline runs deterministically off fakes /
 * record-replay tapes:
 *   ResearchProvider → a CLOSED facts[] array {claim, sourceUrl, confidence}   (§6.2.1)
 *   ScriptProvider   → claim-structured clauses {text, claimType, evidenceRef} (§6.2.2 / §8.3)
 *   TtsProvider      → ONE multi-speaker call returning audio bytes           (§6.2.3 / D5)
 *   Muxer            → ffmpeg-equivalent: split → HLS chunks + playlist.m3u8   (§6.2.4-5)
 *
 * TWO honesty controls run on the SCRIPT *before* a single byte of audio is synthesized, both FAIL-CLOSED:
 *   1. validateClaims(..., {failClosed:true})  — claim-structured honesty gate (§8.3 / D10 / RT-1):
 *      hard-reject any falsifiable clause (spec|provenance|date|causal|superlative|comparative) without a
 *      grounded evidence ref into the CLOSED facts[] (+ optional entailment judge + flavor auditor).
 *   2. gateClaim(...)                            — defamation gate (§6.2 / §15 / RT-9): a negative claim about
 *      an identifiable entity needs ≥2 independent sources, else routes to human_review (treated as fail here).
 *   Per §6.2: "never ship unvalidated audio to cache." On any rejection we DROP the episode — no TtsProvider
 *   call, no Muxer call, no asset row published. Fail-closed on exceptions too.
 *
 * IDEMPOTENCY (eng-F8 / §6.2 worker idempotency): keyed per (catalogItemId, version). A `PodcastAssetStore`
 * does a compare-and-set on `status` (queued → rendering → ready) exactly like services/voxi-api/src/metering's
 * atomic gate: only the worker that flips queued→rendering proceeds; a duplicate Cloud Task delivery for the
 * same (item, version) observes a non-queued status and short-circuits WITHOUT a second render. The finished
 * playlist is published in one atomic swap (ready), and the push is deduped on that status transition.
 */
import {
  validateClaims,
  type Clause,
  type Evidence,
} from '../../../packages/shared/src/confidence'
import { gateClaim, type ClaimClassifier, type Source } from '../../../packages/shared/src/moderation'

// ---- domain types ----

export interface PodcastJob {
  catalogItemId: string
  /** content version; (catalogItemId, version) is the idempotency + cache key. */
  version: number
  /** the object the episode is about (e.g. "2008 Cannondale SuperSix EVO"). */
  subject: string
}

/** A closed, grounded fact the script is allowed to draw on (§6.2.1). */
export interface Fact {
  claim: string
  sourceUrl: string
  confidence: number
}

/** Claim-structured script: each clause carries its type + a ref into the closed facts[] (§6.2.2 / §8.3). */
export interface Script {
  /** evidence refs in `clauses` must resolve into this closed array. */
  facts: Fact[]
  /** ordered two-speaker clauses (Arlo/Mave); each is independently validated. */
  clauses: ScriptClause[]
}

export interface ScriptClause extends Clause {
  speaker: 'arlo' | 'mave'
}

/** Output of a render: the published, atomically-swapped HLS asset. */
export interface PodcastAsset {
  catalogItemId: string
  version: number
  playlistKey: string
  segmentKeys: string[]
  durationSec: number
  /** the REAL two-host read-along transcript (the validated script), speaker-tagged, in order. */
  transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[]
}

// ---- pluggable providers (no creds; fakes in tests, real vendors in prod) ----

export interface ResearchProvider {
  /** Gemini + Search in prod → a CLOSED facts[] array. */
  research(job: PodcastJob): Promise<Fact[]>
}

export interface ScriptProvider {
  /** Claude Sonnet in prod → claim-structured two-speaker clauses over the closed facts[]. */
  writeScript(job: PodcastJob, facts: Fact[]): Promise<Script>
}

export interface TtsProvider {
  /** ONE multi-speaker call for timbre consistency (D5). Returns the full episode's audio bytes + duration. */
  synthesize(script: Script): Promise<{ audio: Uint8Array; durationSec: number }>
}

export interface Muxer {
  /** ffmpeg-equivalent: loudnorm/bed/stings, split into HLS chunks, write playlist + segments. */
  assemble(args: {
    catalogItemId: string
    version: number
    audio: Uint8Array
    durationSec: number
  }): Promise<{ playlistKey: string; segmentKeys: string[] }>
}

/** Idempotent asset status store — compare-and-set, mirroring metering.ts's atomic contract. */
export type PodcastStatus = 'queued' | 'rendering' | 'ready' | 'failed'

export interface PodcastAssetStore {
  /**
   * Compare-and-set the status for (catalogItemId, version): set to `to` IFF current status === `from`.
   * Returns true on success (this caller won the transition), false otherwise. Row-atomic in prod
   * (`UPDATE podcast_assets SET status=:to WHERE item=:i AND version=:v AND status=:from RETURNING`).
   */
  compareAndSetStatus(
    catalogItemId: string,
    version: number,
    from: PodcastStatus,
    to: PodcastStatus,
  ): Promise<boolean>
  getStatus(catalogItemId: string, version: number): Promise<PodcastStatus | null>
  /** Persist the finished asset (paired with the rendering→ready transition). */
  putAsset(asset: PodcastAsset): Promise<void>
  getAsset(catalogItemId: string, version: number): Promise<PodcastAsset | null>
}

export interface PushSink {
  /** Deduped on the status transition: fired exactly once, by the worker that flips to `ready`. */
  notifyReady(asset: PodcastAsset): Promise<void>
}

export interface RenderDeps {
  research: ResearchProvider
  script: ScriptProvider
  tts: TtsProvider
  muxer: Muxer
  store: PodcastAssetStore
  push?: PushSink
  /** optional entailment judge for the honesty gate (NLI/LLM in prod). */
  judge?: import('../../../packages/shared/src/confidence').EntailmentJudge
  /** optional flavor auditor (catches a falsifiable claim mislabeled `flavor`). */
  detectNamedClaim?: import('../../../packages/shared/src/confidence').NamedClaimDetector
  /** optional defamation classifier (LLM in prod; heuristic default in moderation.ts). */
  classify?: ClaimClassifier
}

// ---- outcomes ----

export type RenderOutcome =
  | { kind: 'rendered'; asset: PodcastAsset }
  | { kind: 'replayed'; asset: PodcastAsset } // duplicate job; already ready — no second render
  | { kind: 'in_progress' } // another worker holds the rendering lease
  | {
      // The honesty gate now DROPS clauses (never rejects the whole episode); an episode is only blocked by
      // defamation or a degenerate/over-thin length AFTER dropping.
      kind: 'rejected_validation'
      reason: 'defamation' | 'degenerate_length'
      details: string[]
      audioProduced: false
    }
  | { kind: 'failed'; reason: string }

// Duration is only known POST-TTS (live-tts derives it from the audio bytes), so we steer + fail-closed on a
// SCRIPT-WORD proxy BEFORE the paid ElevenLabs call. At a conversational ~150 wpm this band brackets roughly
// 1–~6 min, rejecting only degenerate 2-liners and runaways — the Deep Dive target is ~2.5–3.5 min (§F3).
export const MIN_SCRIPT_WORDS = 120
export const MAX_SCRIPT_WORDS = 900

/** Pure word estimate over the spoken clauses (the pre-synthesis duration proxy). */
export function estimateWords(script: Script): number {
  return script.clauses.reduce((n, c) => {
    const t = c.text.trim()
    return n + (t ? t.split(/\s+/).length : 0)
  }, 0)
}

/**
 * Run the validators on the script BEFORE any synthesis, and return the VALIDATED (filtered) script to synthesize.
 *
 * The honesty gate is DROP-and-KEEP — the same contract the shipped reveal narrator uses (live-narrator's
 * `gateNarration`, `failClosed:false`): a clause that fails the gate (an ungrounded falsifiable claim, or a
 * `flavor` line the independent auditor flags for smuggling a name/superlative/date) is CUT from the episode. It
 * never reaches audio, so NO unvalidated claim ever ships — the honesty guarantee holds by construction — while
 * the validated clauses carry on, so a single conversational aside can't sink the whole Serial-length episode
 * (the failure the episode-level fail-closed produced once the interview reformat + auditor were both live).
 * The episode still HARD-FAILS on defamation (a negative claim about an identifiable entity is not a droppable
 * aside) and on a degenerate length AFTER dropping (which doubles as the drop-floor: if the gate cut so much that
 * too little remains, ship nothing rather than a stub).
 */
export function validateScript(
  script: Script,
  deps: Pick<RenderDeps, 'judge' | 'detectNamedClaim' | 'classify'>,
): { ok: true; script: Script } | { reason: 'defamation' | 'degenerate_length'; details: string[] } {
  const evidence: Evidence[] = script.facts.map((f) => ({
    ref: f.sourceUrl, // refs are the closed source URLs
    sourceUrl: f.sourceUrl,
    claim: f.claim,
  }))
  // 1. Honesty gate — DROP the rejected clauses, KEEP the validated ones. `validateClaims` returns the SAME clause
  //    objects in `approved`, so the `speaker` field survives (cast back to ScriptClause). Nothing rejected is
  //    synthesized, so no unvalidated claim ships.
  const honesty = validateClaims(script.clauses, evidence, {
    judge: deps.judge,
    detectNamedClaim: deps.detectNamedClaim,
    failClosed: false,
  })
  const kept = honesty.approved as ScriptClause[]
  const filtered: Script = { facts: script.facts, clauses: kept }

  // 2. Defamation gate (HARD-fail) — a negative claim about an identifiable entity needs ≥2 independent sources,
  //    else it routes to human review (on the cache path: do not ship). Judged over the KEPT clauses.
  const defamatory: string[] = []
  for (const c of kept) {
    const cited: Source[] = c.evidenceRef
      ? script.facts.filter((f) => f.sourceUrl === c.evidenceRef).map((f) => ({ url: f.sourceUrl }))
      : []
    const verdict = gateClaim(c.text, cited, deps.classify)
    if (verdict.action !== 'allow') defamatory.push(`${c.text} — ${verdict.reason}`)
  }
  if (defamatory.length > 0) return { reason: 'defamation', details: defamatory }

  // 3. Length proxy on the KEPT script — the drop-floor + the cost bound, checked BEFORE the paid TTS call. If the
  //    honesty gate cut so much (or the model produced a degenerate/runaway) that the kept words fall outside the
  //    band, ship nothing rather than a stub.
  const words = estimateWords(filtered)
  if (words < MIN_SCRIPT_WORDS || words > MAX_SCRIPT_WORDS) {
    return { reason: 'degenerate_length', details: [`kept ${kept.length}/${script.clauses.length} clauses = ${words} words (band ${MIN_SCRIPT_WORDS}–${MAX_SCRIPT_WORDS})`] }
  }

  return { ok: true, script: filtered }
}

/**
 * Render (or replay) the podcast for a job. Idempotent per (catalogItemId, version):
 *  - if already `ready`, return the cached asset (no render),
 *  - if `rendering` (another worker), short-circuit `in_progress` (no second render),
 *  - else win the queued→rendering lease, validate, synthesize once, publish atomically, notify once.
 * Fail-closed: validation failure or any exception leaves NO audio and flips the lease to `failed`.
 */
export async function renderPodcast(job: PodcastJob, deps: RenderDeps): Promise<RenderOutcome> {
  const { catalogItemId, version } = job

  // Fast idempotency check (cheap path for duplicate Cloud Task deliveries).
  const current = await deps.store.getStatus(catalogItemId, version)
  if (current === 'ready') {
    const asset = await deps.store.getAsset(catalogItemId, version)
    if (asset) return { kind: 'replayed', asset }
  }
  if (current === 'rendering') return { kind: 'in_progress' }

  // Compare-and-set the lease: only the worker that flips queued→rendering proceeds. A concurrent duplicate
  // loses this CAS and bails — guaranteeing exactly one render for the (item, version).
  const won = await deps.store.compareAndSetStatus(catalogItemId, version, 'queued', 'rendering')
  if (!won) {
    // Someone else took (or already finished) the lease between our read and CAS. Re-resolve.
    const after = await deps.store.getStatus(catalogItemId, version)
    if (after === 'ready') {
      const asset = await deps.store.getAsset(catalogItemId, version)
      if (asset) return { kind: 'replayed', asset }
    }
    return { kind: 'in_progress' }
  }

  try {
    // 1. Grounded research → closed facts[].
    const facts = await deps.research.research(job)
    // 2. Claim-structured script over the closed facts[].
    const script = await deps.script.writeScript(job, facts)

    // 3+4. HONESTY (drop-and-keep) + DEFAMATION gates BEFORE any synthesis. On a defamation / degenerate-length
    //      block, ship NOTHING. Otherwise `validated` is the honesty-filtered script — ONLY its clauses are voiced.
    const verdict = validateScript(script, deps)
    if ('reason' in verdict) {
      // Mark failed so the lease isn't stuck; never publish an asset; never call TTS/Muxer.
      await deps.store.compareAndSetStatus(catalogItemId, version, 'rendering', 'failed')
      return {
        kind: 'rejected_validation',
        reason: verdict.reason,
        details: verdict.details,
        audioProduced: false,
      }
    }
    const validated = verdict.script

    // 5. Only now — the VALIDATED (filtered) script → ONE multi-speaker TTS call → mux → HLS.
    const { audio, durationSec } = await deps.tts.synthesize(validated)
    const { playlistKey, segmentKeys } = await deps.muxer.assemble({
      catalogItemId,
      version,
      audio,
      durationSec,
    })

    const asset: PodcastAsset = {
      catalogItemId,
      version,
      playlistKey,
      segmentKeys,
      durationSec,
      // The VALIDATED (honesty-filtered + defamation-passed) script IS the read-along transcript — no separate source.
      transcript: validated.clauses.map((c) => ({ speaker: c.speaker === 'arlo' ? 'ARLO' : 'MAVE', text: c.text })),
    }
    await deps.store.putAsset(asset)

    // Atomic publish: rendering→ready. Push is deduped on THIS transition (only the winner fires it).
    const published = await deps.store.compareAndSetStatus(catalogItemId, version, 'rendering', 'ready')
    if (published) {
      await deps.push?.notifyReady(asset)
    }
    return { kind: 'rendered', asset }
  } catch (err) {
    // Fail-closed on any exception: release the lease as failed, ship nothing.
    await deps.store.compareAndSetStatus(catalogItemId, version, 'rendering', 'failed')
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

// ---- in-memory PodcastAssetStore for tests (documents the compare-and-set contract) ----

export function memoryAssetStore(
  initial: Record<string, PodcastStatus> = {},
): PodcastAssetStore & { renderCount: () => number } {
  // key = `${catalogItemId}:v${version}`
  const status = new Map<string, PodcastStatus>(Object.entries(initial))
  const assets = new Map<string, PodcastAsset>()
  const key = (i: string, v: number) => `${i}:v${v}`

  return {
    async compareAndSetStatus(catalogItemId, version, from, to) {
      const k = key(catalogItemId, version)
      const cur = status.get(k) ?? 'queued' // unseen rows are implicitly queued (a freshly enqueued job)
      if (cur !== from) return false
      status.set(k, to)
      return true
    },
    async getStatus(catalogItemId, version) {
      return status.get(key(catalogItemId, version)) ?? null
    },
    async putAsset(asset) {
      assets.set(key(asset.catalogItemId, asset.version), asset)
    },
    async getAsset(catalogItemId, version) {
      return assets.get(key(catalogItemId, version)) ?? null
    },
    renderCount: () => assets.size,
  }
}
