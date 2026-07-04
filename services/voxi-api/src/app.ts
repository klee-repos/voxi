/**
 * voxi-api — the BFF and the ONLY public surface (PLAN §3, §4.3, §6.4).
 *
 * Responsibilities verified by app.test.ts: verify the Clerk JWT (401 otherwise), mint hardened signed URLs,
 * create threads (charging a scan), proxy the eve session/stream, gate paid podcast generation atomically +
 * idempotently, and cascade account deletion. The eve backend is reached via an injected client (never
 * exposed publicly); in tests it's a fake. No business state is trusted from the client.
 */
import { Hono, type Context } from 'hono'
import { bearerFrom, type Verifier } from './auth'
import { mintSignedUrl, mintPhotoUrl, verifyPhotoUrl } from './signing'
import { threadOwnerVerdict } from './acl'
import type { StreamEvent } from '../../../packages/shared/src/events'
import { isAudioBucket, type AudioBucket } from '../../../packages/shared/src/events'
import type { PodcastContext } from '../../../packages/shared/src/podcast'
import type { Evidence } from '../../../packages/shared/src/confidence'
import { gatePodcastGeneration, charge, type Store, type Meter } from './metering'
import { logger } from '../../../packages/telemetry/src/index'
import { verifyAndApplyTransaction, applyNotification, planForUser, type AppleJwsVerifier, type EntitlementStore } from './appstore'
import {
  runDedupSweep,
  type DedupCandidate,
  type DuplicateJudge,
  type DedupDecision,
} from '../../eve-agent/agent/schedules/dedup'
import {
  runPromotionSweep,
  type PromotionCluster,
  type PromotionOutcome,
} from '../../eve-agent/agent/schedules/promote'

export interface EveClient {
  createSession(args: { userId: string; photoUrl: string }): Promise<{ sessionId: string; continuationToken: string }>
  stream(sessionId: string, userId: string, startIndex?: number): AsyncIterable<string>
  /**
   * The SERVER-OWNED, honesty-gated reveal narration captured for this session (the exact `token` clauses the app
   * rendered as `whatItIs`). Owner-scoped: returns null for a non-owner or a session with no captured narration.
   * `/v1/threads/:id/speech` voices this — the client never supplies the text (the BFF never trusts the client).
   */
  narrationText?(sessionId: string, userId: string, bucket?: AudioBucket): Promise<string | null>
  /** Delete-cascade hook: drop the per-session captured photo + pinned narration held in-process. The caller has
   *  already ACL'd the owner; this only clears the in-memory scan artifacts a durable purge can't reach. */
  purgeSession?(sessionId: string): void
  /** Regenerate hook: optionally RE-SEED the session's photo (so a cold client after a restart re-reads the image
   *  instead of a hard_failure) and ALWAYS clear the session's pinned narration so the fresh run re-pins new
   *  clauses. Omit `photoUrl` to leave the in-process photo untouched (clear narration only). */
  primeSession?(sessionId: string, photoUrl?: string): void
}

/** A grounded "Ask Voxi" chat turn for the conversation screen. The Guide answers the user's question ABOUT the
 *  item using ONLY the durable reveal's grounded context + facts (never client-supplied), run through the SAME
 *  deterministic honesty gate as the narrator (`validateClaims`). `grounded=false` means nothing could be proven
 *  in persona and `text` is a hedge — surfaced so the caller/UI never mistakes a hedge for an answer. */
export interface ChatTurn { role: 'user' | 'guide'; text: string }
export interface ChatReply { text: string; grounded: boolean }
export interface ChatProvider {
  reply(args: { context: string; evidence: Evidence[]; history: ChatTurn[]; question: string }): Promise<ChatReply>
}

/** Single-voice TTS seam for the spoken reveal (ElevenLabs in prod, a deterministic fake in tests). */
export interface NarrationTtsProvider {
  /** Uint8Array<ArrayBuffer> so the bytes satisfy Hono's `c.body` Data type under strict tsc. */
  synthesize(text: string): Promise<Uint8Array<ArrayBuffer>>
}

/** Content-addressed audio cache so a stable narration is synthesized ONCE (bounds paid-vendor cost, A10). */
export interface NarrationAudioCache {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
}

export interface DeletionService {
  cascade(userId: string): Promise<{ deleted: string[] }>
}

/** A persisted thread row (the user's "collection"). ownerUserId is the ACL key — reads are owner-scoped. */
export interface ThreadRecord {
  threadId: string
  ownerUserId: string
  title: string
  createdAt: number
  /** durable eve continuation token so a revisit resumes the same session (thread-03). */
  continuationToken: string
  /** the identified confidence band, set once the reveal is persisted (null until then). */
  band?: string | null
  /** the identified label (e.g. "1976 Canon AE-1"). SEPARATE from `title` (the auto-title) — adversarial A8. */
  revealTitle?: string | null
  /** mime of the persisted photo; presence ⇒ a /media photo URL is available for this thread. */
  photoMime?: string | null
}

/** Repository for the user's threads. Owner-scoped reads are enforced in the route, never trusted from client. */
export interface ThreadStore {
  put(rec: ThreadRecord): Promise<void>
  /** Only the caller's own threads — the ACL boundary for the collection screen. */
  listByOwner(userId: string): Promise<ThreadRecord[]>
  get(threadId: string): Promise<ThreadRecord | null>
  /** Denormalize the identified label + band onto the row (NEVER touches `title`). Optional per A7. */
  applyReveal?(threadId: string, r: { revealTitle: string; band: string }): Promise<void>
  /** Flag that a durable photo exists for this thread (records its mime). Optional per A7. */
  markPhoto?(threadId: string, mime: string): Promise<void>
  /** Delete the caller's own thread row (owner-scoped). The item-delete cascade's LAST step (the ACL anchor). */
  deleteOwned?(threadId: string, ownerUserId: string): Promise<void>
  /** Clear the denormalized band + reveal_title (regenerate) so the collection tile isn't stuck on the old label
   *  until the fresh reveal re-pins. NEVER touches `title`. Owner-scoped. */
  resetReveal?(threadId: string, ownerUserId: string): Promise<void>
}

/** Durable captured-photo bytes, keyed by thread. Local stand-in for GCS behind app.threads.photo_url. */
export interface PhotoStore {
  put(rec: { threadId: string; ownerUserId: string; mime: string; bytes: Uint8Array }): Promise<void>
  get(threadId: string): Promise<{ ownerUserId: string; mime: string; bytes: Uint8Array } | null>
  has(threadId: string): Promise<boolean>
  /** Delete the captured photo bytes for this thread (item-delete cascade). */
  delete?(threadId: string): Promise<void>
}

/** The durable projection of the generated reveal (== app.turns). `events` is the source of truth for replay. */
export interface RevealRecord {
  threadId: string
  ownerUserId: string
  band: 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN'
  title: string
  candidates: string[]
  events: StreamEvent[]
  narration: string
  createdAt: number
}
export interface RevealStore {
  /** First successful drain wins (ON CONFLICT DO NOTHING). Returns whether this call actually wrote the row. */
  put(rec: RevealRecord): Promise<{ inserted: boolean }>
  get(threadId: string): Promise<RevealRecord | null>
  /** Delete the durable reveal for this thread. Item-delete removes it; regenerate clears it so the next /stream
   *  leaves the replay branch, re-runs the live cascade, and re-pins a fresh reveal (first-write-wins is unblocked). */
  delete?(threadId: string): Promise<void>
}

/** The item's durable podcast episode (== app.podcast_assets). Owner-scoped (adversarial A9). */
export interface PodcastAssetRecord {
  token: string
  userId: string
  catalogItemId: string
  version: number
  status: 'composing' | 'ready' | 'failed'
  audioUrl?: string | null
  transcript?: { speaker: 'ARLO' | 'MAVE'; text: string; endSec?: number }[] | null
  createdAt: number
  updatedAt: number
}
export interface PodcastAssetStore {
  upsert(rec: PodcastAssetRecord): Promise<void>
  getByToken(token: string, userId: string): Promise<PodcastAssetRecord | null>
  getByItem(catalogItemId: string, version: number, userId: string): Promise<PodcastAssetRecord | null>
  /** Delete every episode (all versions) for a catalog item, OWNER-SCOPED — catalog_item_id is not user-unique
   *  for a global catalog id, so the user_id predicate is required to avoid wiping another user's episodes. */
  deleteByItem?(catalogItemId: string, userId: string): Promise<void>
  /** The distinct catalogItemIds this user has episodes for — enumerated BEFORE an account purge deletes the rows,
   *  so the deletion cascade can find + purge the corresponding GCS audio/state objects (which the rows index). */
  listItemIdsByUser?(userId: string): Promise<string[]>
}

/** Durable conversation history (== app.messages). The single writer is idempotent on (threadId, clientKey). */
export interface MessageRecord {
  id: string
  threadId: string
  userId: string
  role: 'user' | 'guide'
  text: string
  source: 'text' | 'voice'
  clientKey: string | null
  createdAt: number
}
export interface MessageStore {
  append(rec: {
    threadId: string
    userId: string
    role: 'user' | 'guide'
    text: string
    source?: 'text' | 'voice'
    clientKey?: string | null
  }): Promise<{ id: string; duplicate: boolean }>
  listByThread(threadId: string): Promise<MessageRecord[]>
  /** Delete all conversation messages for this thread (item-delete cascade). */
  deleteByThread?(threadId: string): Promise<void>
}

/** Durable, once-ever refund guard (adversarial A15): a refused/failed scan credits back exactly once. */
export interface RefundStore {
  /** Atomically mark this thread refunded; returns true only the FIRST time (i.e. proceed with the credit). */
  markRefunded(threadId: string): Promise<boolean>
  /** Drop the refund guard row (item-delete cascade). Regenerate does NOT call this — it LATCHES the guard. */
  delete?(threadId: string): Promise<void>
}

/** Worker-reported status of a paid podcast render (the BFF polls/proxies; it never fabricates "ready"). */
export interface PodcastStatusService {
  /** status for an (item,version) the CALLER already owner-scoped (app.ts resolves it from getByToken(token,userId)). */
  status(
    catalogItemId: string,
    version: number,
  ): Promise<{ state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string; endSec?: number }[] } | null>
}

/** Trust + moderation surface for user contributions (TL0 → review queue; TL2+ → live). */
export interface ContributionService {
  /** the contributor's trust level (0..n); drives whether a tip goes live or to human review. */
  trustLevel(userId: string): Promise<number>
  /** persist a tip; returns its moderation disposition (real gate, not a client-trusted flag). */
  submitTip(args: { userId: string; catalogItemId: string; text: string; trustLevel: number }): Promise<{
    tipId: string
    status: 'pending_review' | 'live'
  }>
  /** file a report against a tip/episode; first report auto-hides pending SLA review (kb-04). */
  report(args: { userId: string; targetId: string; kind: 'tip' | 'episode' }): Promise<{ autoHidden: boolean }>
}

/** Interview persistence: a new catalog candidate the user is being interviewed about (default PRIVATE). */
export interface InterviewService {
  create(args: { userId: string; threadId: string; visibility: 'private' | 'global' }): Promise<{
    interviewId: string
    visibility: 'private' | 'global'
    questions: { id: string; prompt: string; whyAsked: string }[]
  }>
  answer(args: { interviewId: string; userId: string; questionId: string; answer: string | null }): Promise<{ done: boolean }>
}

export interface Deps {
  verifier: Verifier
  store: Store
  eve: EveClient
  deletion: DeletionService
  bucket: string
  /** ownership map sessionId -> userId, enforced so user A can't stream user B's session (§4.3). */
  sessionOwner: Map<string, string>
  now?: () => number
  // ---- optional collaborators (defaulted) so the core BFF tests/harness need not wire every surface ----
  threads?: ThreadStore
  /** durable persistence for the collection (adversarial-reviewed): photo bytes, the generated reveal (for
   *  deterministic replay), the podcast episode, the conversation, and the once-ever refund guard. Absent →
   *  the routes degrade gracefully (no photo/replay), never crash. */
  photos?: PhotoStore
  reveals?: RevealStore
  podcasts?: PodcastAssetStore
  messages?: MessageStore
  refunds?: RefundStore
  podcastStatus?: PodcastStatusService
  /** enqueue a gated podcast render to the worker (called once per fresh token; replays don't re-enqueue). The
   *  `context` is the server-owned reveal projection (identity + what/purpose/maker + grounded facts) so the Deep
   *  Dive is built from everything the reveal already learned — never re-derived from a client-supplied subject. */
  podcastEnqueue?: (args: { token: string; catalogItemId: string; version: number; subject: string; userId: string; context?: PodcastContext }) => Promise<void>
  /** Purge a catalog item's rendered podcast objects from GCS (audio + private state), across all versions. Wired to
   *  the deletion cascade so the audio the render worker produced is actually removed — the SQL row delete alone
   *  would orphan it. Best-effort: a GCS failure must not block the owner-scoped row cascade. */
  deletePodcastAudio?: (catalogItemId: string) => Promise<void>
  contributions?: ContributionService
  interviews?: InterviewService
  /** plan label for the settings/subscription surface (free|explorer|voyager). */
  planFor?: (userId: string) => Promise<'free' | 'explorer' | 'voyager'>
  /**
   * Spoken-reveal TTS (PLAN §6.2; ANALYSIS-VOICE-PLAN B). `POST /v1/threads/:id/speech` voices the SERVER-OWNED
   * narration in Voxi's British voice. Absent → the route 503s (loud, not a fake success). The `cache` (keyed by
   * a hash of the narration text) makes a stable reveal synthesize exactly once, so repeat/autoplay+tap plays are
   * free and an abusive loop collapses to one paid call. Absent cache → synth-through (fail-safe, still correct).
   */
  speech?: { tts: NarrationTtsProvider; cache?: NarrationAudioCache }
  /**
   * Grounded "Ask Voxi" chat (PLAN §6.3 — the blue conversation lane). `POST /v1/threads/:id/ask` answers the
   * user's question ABOUT the item from the SERVER-OWNED durable reveal (buildItemContext + its cited facts) —
   * never client-supplied — through the SAME deterministic honesty gate as the narrator (claim-structured
   * `validateClaims`, NOT "trust the prompt"). Absent → the route 503s (`guide_unavailable`), loud not fake.
   * Charge is a voiceMin (the existing chat/voice meter lane), fail-closed like `/v1/voice/session`.
   */
  chat?: ChatProvider
  /**
   * Direct StoreKit 2 entitlement verification (replaces RevenueCat): the Apple JWS verifier + the entitlement
   * store. When present, `/v1/purchases/verify` and the `/appstore/notifications` webhook are live and `/v1/me`
   * reads the server-verified plan from it. No third-party billing vendor.
   */
  appStore?: { verify: AppleJwsVerifier; entitlements: EntitlementStore }
  /**
   * Cloud-Scheduler-drivable moat sweeps (PLAN §7.2/§7.4, §22.3 S1). The dedup + promotion schedules are
   * exposed behind BFF cron routes so the catalog machinery does NOT inherit eve's world-postgres scheduler
   * risk — Cloud Scheduler POSTs `/internal/cron/{dedup,promote}` and this BFF runs the REAL sweep. The
   * collaborators are injected so the ROUTE + the sweep invocation are real while the DB fetch + the LLM judge
   * (Gemini in prod) are pluggable (a deterministic fake in tests). When absent, the routes 503 (fail loudly).
   */
  cron?: {
    /** shared secret Cloud Scheduler presents (`Authorization: Bearer <secret>` / X-Cron-Key). Server-derived, never client-trusted. */
    secret: string
    dedup?: {
      /** fetch the de-dup candidates to sweep (block-by-category + ANN in prod; a fixture in tests). */
      candidates: () => Promise<DedupCandidate[]>
      /** the similarity judge — Gemini LLM-judge in prod; a deterministic fake in tests. */
      judge: DuplicateJudge
      /** apply the computed merge decisions (the sweep itself is idempotent + does not mutate). */
      apply?: (decisions: DedupDecision[]) => Promise<void>
    }
    promote?: {
      /** the already-clustered owner signals (computed in a system context, §22.4). */
      clusters: () => Promise<PromotionCluster[]>
      /** apply the minted 'pending_global' drafts under a compare-and-set (held for moderation, §7.4). */
      apply?: (outcomes: PromotionOutcome[]) => Promise<void>
    }
  }
}

/** Content hash for the narration-audio cache key (SHA-256 hex; `crypto.subtle` is global in Bun/workers). */
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Replay a persisted reveal's events as NDJSON lines — the DURABLE revisit/reconnect path. Once a reveal has
 * settled and been pinned to the RevealStore, GET /stream serves these exact events (no cascade re-run, no
 * re-charge) so revisiting a past capture works even after a restart evicted the live in-memory photo/session.
 * `startIndex` mirrors the live stream's reconnection replay (events below the last acked index are skipped).
 */
async function* replayReveal(events: readonly StreamEvent[], startIndex: number): AsyncIterable<string> {
  for (const ev of events) {
    const idx = (ev as { index?: number }).index
    if (typeof idx === 'number' && idx < startIndex) continue
    yield JSON.stringify(ev)
  }
}

/**
 * Build the SERVER-OWNED grounded chat context for "tell me more" (PROMPT-QUALITY §3.E). Reconstructed from the
 * DURABLE reveal — the identified title, the narration, and the cited `fact` events (each with its source) — so the
 * conversation is grounded in exactly the same evidence the reveal was, with each fact's provenance attached. It is
 * NEVER supplied by the client (the BFF never trusts the client for grounding), and the honesty rules carry into
 * voice unchanged: a falsifiable follow-up must cite this evidence or a fresh web lookup, else hedge in persona.
 */
export function buildItemContext(reveal: RevealRecord): string {
  const facts = reveal.events.filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
  // The two narrative research buckets, so "tell me more" is grounded in exactly what the reveal's icons showed.
  const section = (bucket: string): string | null => {
    const secs = reveal.events.filter(
      (e): e is Extract<StreamEvent, { type: 'section' }> => e.type === 'section' && e.bucket === bucket && !!e.text,
    )
    return secs.length ? secs[secs.length - 1]!.text : null
  }
  const purpose = section('purpose')
  const maker = section('maker')
  const made = section('made')
  return [
    `OBJECT: ${reveal.title} (confidence: ${reveal.band}).`,
    reveal.narration ? `WHAT IT IS: ${reveal.narration}` : '',
    purpose ? `WHAT IT'S FOR: ${purpose}` : '',
    maker ? `WHO MADE IT: ${maker}` : '',
    made ? `WHEN MADE: ${made}` : '',
    facts.length ? 'GROUNDED FACTS you may cite (fact — source):' : '',
    ...facts.map((f) => `  • ${f.text} — ${f.sourceUrl}`),
    'GROUNDING: only assert a falsifiable claim (spec/date/provenance/superlative) if it is grounded above, or you verify it with a fresh web_search/web_crawl and cite the source. If you cannot ground it, say so in persona. The confidence band still rules — do not promote a hedged identity to certain.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Server-owned per-bucket text for `/speech/:bucket` on a DURABLE reveal (owner-scoped): `what` → the pinned
 *  narration, `facts` → the joined verified facts, `purpose`/`maker` → the last non-empty `section` of that bucket. */
export function speechBucketText(reveal: RevealRecord | null, userId: string, bucket: AudioBucket): string | null {
  if (!reveal || reveal.ownerUserId !== userId) return null
  if (bucket === 'what') return reveal.narration || null
  if (bucket === 'facts') {
    const facts = reveal.events.filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
    return facts.length ? facts.map((f) => f.text).join(' ') : null
  }
  const secs = reveal.events.filter(
    (e): e is Extract<StreamEvent, { type: 'section' }> => e.type === 'section' && e.bucket === bucket && !!e.text,
  )
  return secs.length ? secs[secs.length - 1]!.text : null
}

/**
 * The server-owned reveal projection threaded into a Deep Dive render (`PodcastContext`). Owner-scoped and built
 * ONLY from the caller's DURABLE reveal — the identity + confidence band, the what/purpose/maker sections (with
 * their grounding when the reveal captured a source), and the grounded `fact` events — so the two-voice interview
 * is written from everything the reveal already learned, IN ADDITION to the worker's own deep-dive research.
 * Returns null when there is no reveal or it isn't the caller's: this is defence in depth — the podcast route also
 * ownership-checks the thread, but that check is a no-op when the id isn't a thread row, so (mirroring every other
 * reveal reader: speechBucketText, the /context route) we re-check ownership here rather than trust a sibling gate.
 */
export function buildPodcastContext(reveal: RevealRecord | null, userId: string): PodcastContext | null {
  if (!reveal || reveal.ownerUserId !== userId) return null
  const lastSection = (bucket: string): { text: string; sourceUrl: string } | null => {
    const secs = reveal.events.filter(
      (e): e is Extract<StreamEvent, { type: 'section' }> => e.type === 'section' && e.bucket === bucket && !!e.text,
    )
    const s = secs[secs.length - 1]
    return s ? { text: s.text, sourceUrl: s.sourceUrl } : null
  }
  const purpose = lastSection('purpose')
  const maker = lastSection('maker')
  const made = lastSection('made')
  const priorFacts = reveal.events
    .filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
    .map((f) => ({ text: f.text, sourceUrl: f.sourceUrl, sourceTitle: f.sourceTitle, quote: f.quote }))
  return {
    subject: reveal.title,
    band: reveal.band,
    ...(reveal.narration ? { whatItIs: reveal.narration } : {}),
    ...(purpose ? { purpose: purpose.text, ...(purpose.sourceUrl ? { purposeSourceUrl: purpose.sourceUrl } : {}) } : {}),
    ...(maker ? { maker: maker.text, ...(maker.sourceUrl ? { makerSourceUrl: maker.sourceUrl } : {}) } : {}),
    ...(made ? { whenMade: made.text, ...(made.sourceUrl ? { whenMadeSourceUrl: made.sourceUrl } : {}) } : {}),
    ...(priorFacts.length ? { priorFacts } : {}),
  }
}

/**
 * A cached `podcast_assets.audio_url` is a point-in-time snapshot that can rot when the worker's serving scheme
 * changes. The pre-GCS worker served `<worker-origin>/audio/:item/v:version/episode.mp3` (an in-memory route);
 * the GCS worker has NO `/audio/` route and serves the MP3 at a public GCS URL. A durable `ready` row rendered on
 * the old worker cached its worker-relative URL — which now 404s forever, and AVPlayer spins on it silently
 * ("takes forever, never finishes, no error"). The BFF must not vouch for a cached URL it can't serve: only a URL
 * on the public GCS host is servable. Pure so the two read paths (the thread payload + the poll route) share one
 * check and a unit test can pin it. NOTE: a non-servable URL is treated as MISSING (omitted), never as a downgrade
 * of the row's `status` — the "ready never regresses" invariant (app.ts ~837, ~874-875) holds; the row keeps its
 * state and the client's `state==='ready' && audioUrl` probe simply fails to seed, so the user sees Generate and
 * taps through a FREE idempotent_replay regen (the gate keys on the separate gen_tokens table, not podcast_assets).
 */
export function isServableAudioUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith('https://storage.googleapis.com/')
}

/**
 * Decode ONLY a real `data:` URI into bytes (adversarial A3). A scheme/plain photoUrl ('capture://local',
 * 'obj:confident', a signed https URL) has no inline bytes → returns null and the caller skips photo persistence
 * (never a fabricated placeholder — the repo's "seams, not stubs-that-fake-success" rule).
 */
function decodeDataUri(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s)
  if (!m) return null
  const mime = m[1] || 'application/octet-stream'
  try {
    const bytes = m[2]
      ? new Uint8Array(Buffer.from(m[3], 'base64'))
      : new Uint8Array(Buffer.from(decodeURIComponent(m[3]), 'utf8'))
    return bytes.length ? { mime, bytes } : null
  } catch {
    return null
  }
}

export function createApp(deps: Deps): Hono {
  const app = new Hono()
  const now = deps.now ?? Date.now
  // Threads whose scan was already refunded (terminal refusal/hard-fail) — keeps refunds idempotent across reconnects.
  const refundedThreads = new Set<string>()
  // D5: regenerate is FREE in v1 (re-running a bad identification shouldn't cost the user a scan). Flip to true to
  // meter it exactly like a fresh capture — the ONLY charge site for regenerate, so the toggle is self-contained.
  const REGEN_CHARGES_SCAN = false

  // Auth middleware — every route requires a valid principal.
  app.use('/v1/*', async (c, next) => {
    const principal = await deps.verifier(bearerFrom(c.req.header('authorization')) ?? '')
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    c.set('userId' as never, principal.userId as never)
    await next()
  })

  const uid = (c: { get: (k: never) => never }) => c.get('userId' as never) as unknown as string

  // Short-TTL, user-bound, non-enumerable upload URL.
  app.post('/v1/uploads/sign', (c) => {
    const signed = mintSignedUrl({ bucket: deps.bucket, userId: uid(c), scope: 'private', now: now() })
    return c.json(signed)
  })

  // Create a thread = 1 photo = 1 eve session. Charges a scan; refusals/hard-fails are charged elsewhere.
  app.post('/v1/threads', async (c) => {
    const userId = uid(c)
    // Two intake shapes: JSON `{photoUrl}` (web/e2e; photoUrl may already be a data: URI), OR multipart with a
    // `photo` file part — the RN client streams the captured file:// natively (no Blob/base64 on device, which
    // RN iOS can't do). A multipart photo is read here into a data: URI the cascade decodes.
    let photoUrl: string | undefined
    let title: string | undefined
    let photoBytes: { mime: string; bytes: Uint8Array } | null = null
    if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
      const form = await c.req.parseBody().catch(() => null)
      const photo = form?.['photo']
      if (photo instanceof File) {
        const bytes = new Uint8Array(await photo.arrayBuffer())
        const mime = photo.type || 'image/jpeg'
        photoBytes = { mime, bytes }
        photoUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
      }
      title = typeof form?.['title'] === 'string' ? (form['title'] as string) : undefined
    } else {
      const body = await c.req.json<{ photoUrl: string; title?: string }>().catch(() => null)
      photoUrl = body?.photoUrl
      title = body?.title
    }
    if (!photoUrl) return c.json({ error: 'photoUrl required' }, 400)
    if (!(await charge(deps.store, userId, 'scan'))) return c.json({ error: 'scan_limit_reached' }, 402)
    const session = await deps.eve.createSession({ userId, photoUrl })
    deps.sessionOwner.set(session.sessionId, userId)
    await deps.threads?.put({
      threadId: session.sessionId,
      ownerUserId: userId,
      title: title ?? 'Untitled capture',
      createdAt: now(),
      continuationToken: session.continuationToken,
    })
    // A3: persist ONLY real captured bytes (multipart photo or a data: URI). A scheme/plain string has no
    // inline bytes → skip (no fake placeholder). The photo now survives a restart + is servable via /media.
    const decoded = photoBytes ?? decodeDataUri(photoUrl)
    if (decoded && deps.photos) {
      await deps.photos.put({ threadId: session.sessionId, ownerUserId: userId, mime: decoded.mime, bytes: decoded.bytes })
      await deps.threads?.markPhoto?.(session.sessionId, decoded.mime)
    }
    return c.json({ threadId: session.sessionId })
  })

  // The collection — ONLY the caller's own threads (owner-scoped ACL; never trust a client-supplied userId).
  // Each item carries the identified label + band (A8: title stays the auto-title) and a signed thumbnail URL
  // when a photo was persisted, so the grid shows real durable captures instead of title-only stubs.
  app.get('/v1/threads', async (c) => {
    if (!deps.threads) return c.json({ threads: [] })
    const userId = uid(c)
    const list = await deps.threads.listByOwner(userId)
    return c.json({
      threads: list.map((t) => ({
        threadId: t.threadId,
        title: t.title,
        revealTitle: t.revealTitle ?? null,
        band: t.band ?? null,
        createdAt: t.createdAt,
        photoUrl: t.photoMime ? mintPhotoUrl({ threadId: t.threadId, userId, now: now() }) : null,
      })),
    })
  })

  // Revisit a single thread → resume the DURABLE eve session (thread-03). ACL'd to the owner (shared verdict).
  // Carries the signed photo URL, identified label/band, and the item's durable podcast + conversation state so a
  // revisit renders a COMPLETE past capture (image + content + episode + chat), not a blank shell.
  app.get('/v1/threads/:id', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    // This route needs the durable row for its response, so a map-owned-but-not-yet-persisted session is 404 here.
    if (!acl.ok || !acl.rec) return c.json({ error: acl.ok ? 'not_found' : acl.error }, acl.ok ? 404 : acl.status)
    const rec = acl.rec
    const podcast = (await deps.podcasts?.getByItem(id, 1, userId)) ?? null
    const convo = deps.messages ? await deps.messages.listByThread(id) : []
    return c.json({
      threadId: rec.threadId,
      title: rec.title,
      revealTitle: rec.revealTitle ?? null,
      band: rec.band ?? null,
      continuationToken: rec.continuationToken,
      resumes: true,
      photoUrl: rec.photoMime ? mintPhotoUrl({ threadId: id, userId, now: now() }) : null,
      podcast: podcast ? { state: podcast.status, audioUrl: isServableAudioUrl(podcast.audioUrl) ? podcast.audioUrl : undefined, transcript: podcast.transcript ?? undefined } : null,
      hasConversation: convo.length > 0,
    })
  })

  // Delete a cataloged item — the owner-scoped per-thread cascade (mirrors the account purge, scoped to one
  // thread). ORDER MATTERS: the durable `threads` row (the ACL anchor) is deleted LAST, so a mid-cascade failure
  // leaves the item still owner-resolvable and a retry self-heals — there is no cross-table transaction on the
  // PgLike seam (a child-delete throw surfaces as a 500 with the thread intact, never a half-deleted item).
  app.delete('/v1/threads/:id', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    // Children first (independent tables, any order among them); the threads row LAST (see above).
    await deps.reveals?.delete?.(id)
    await deps.messages?.deleteByThread?.(id)
    await deps.refunds?.delete?.(id)
    await deps.podcasts?.deleteByItem?.(id, userId)
    // The rendered audio + state live in GCS (the row above only indexes them); purge them too. Best-effort so a
    // GCS blip never leaves the item half-deleted — the row is already gone, and a re-render re-creates the objects.
    await deps.deletePodcastAudio?.(id).catch(() => {})
    await deps.photos?.delete?.(id)
    await deps.threads?.deleteOwned?.(id, userId)
    // In-process scan artifacts a durable purge can't reach: the eve client's photo+narration, the ownership map,
    // and the in-memory refund latch (so a later thread that somehow reused the id can't inherit a stale guard).
    deps.eve.purgeSession?.(id)
    deps.sessionOwner.delete(id)
    refundedThreads.delete(id)
    return c.body(null, 204)
  })

  // Regenerate a cataloged item's identification — re-run the live cascade for the SAME thread. Clearing the durable
  // reveal makes the next GET /stream leave the replay branch and re-run live + re-pin (first-write-wins unblocked);
  // resetting the denorm stops the tile showing the old label mid-run; re-seeding the cascade's in-process photo from
  // the durable store lets a cold post-restart client re-settle instead of hard_failure; clearing the pinned
  // narration forces a fresh re-pin. FREE in v1 (D5). We LATCH the refund guard shut first so the reused /stream
  // refund tap can't credit a scan on a should-not-happen pre-band failure of this free re-run (the tap has no
  // notion of "this run charged nothing").
  app.post('/v1/threads/:id/regenerate', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    if (REGEN_CHARGES_SCAN && !(await charge(deps.store, userId, 'scan'))) return c.json({ error: 'scan_limit_reached' }, 402)
    if (deps.refunds) await deps.refunds.markRefunded(id) // latch the durable guard shut (never credits on this re-run)
    refundedThreads.add(id) // and the in-memory fallback guard
    await deps.reveals?.delete?.(id)
    await deps.threads?.resetReveal?.(id, userId)
    // Re-seed the in-process photo from durable bytes (cold-client safety) + clear the pinned narration. Omitting the
    // photoUrl (no durable bytes) still clears narration but leaves any same-process in-memory photo intact.
    let dataUri: string | undefined
    if (deps.photos) {
      const p = await deps.photos.get(id)
      if (p && p.ownerUserId === userId) dataUri = `data:${p.mime};base64,${Buffer.from(p.bytes).toString('base64')}`
    }
    deps.eve.primeSession?.(id, dataUri)
    return c.json({ ok: true })
  })

  // Serve a persisted photo. OUTSIDE the /v1/* Clerk middleware so a browser <img>/<Image> can load it WITHOUT
  // an auth header; the ?u=&exp=&sig= HMAC (owner+threadId+exp bound, full-length) is the gate (adversarial A1),
  // cross-checked against the stored photo's owner. The local stand-in for a GCS signed URL.
  app.get('/media/threads/:id/photo', async (c) => {
    const id = c.req.param('id')
    const u = c.req.query('u') ?? ''
    const exp = Number(c.req.query('exp') ?? 0)
    const sig = c.req.query('sig') ?? ''
    const v = verifyPhotoUrl({ threadId: id, u, exp, sig, now: now() })
    if (!v.ok) return c.json({ error: v.reason ?? 'forbidden' }, 403)
    const photo = deps.photos ? await deps.photos.get(id) : null
    if (!photo) return c.json({ error: 'not_found' }, 404)
    if (photo.ownerUserId !== u) return c.json({ error: 'forbidden' }, 403) // defence in depth beyond the HMAC
    return c.body(photo.bytes as unknown as Uint8Array<ArrayBuffer>, 200, {
      'content-type': photo.mime,
      'cache-control': 'private, max-age=600',
    })
  })

  // Stream the eve NDJSON. Route auth only authenticates; we ACL by owner (shared verdict, no longer the strict
  // in-memory-only check that fail-closed on every pre-restart session — that WAS the revisit-403 bug).
  app.get('/v1/threads/:id/stream', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    const startIndex = Number(c.req.query('startIndex') ?? 0)

    // DURABLE REVISIT: once a reveal has settled and been pinned, replay its exact events instead of re-running
    // the cascade from a (possibly evicted) in-memory photo. This survives a restart, never re-charges a scan,
    // and can never hit the hard_failure/refund path — so revisiting a past capture actually shows the object.
    const persisted = deps.reveals ? await deps.reveals.get(id) : null
    const replay = !!persisted && persisted.ownerUserId === userId
    const source: AsyncIterable<string> = replay
      ? replayReveal(persisted.events, startIndex)
      : deps.eve.stream(id, userId, startIndex)

    return c.body(
      new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          const collected: StreamEvent[] = []
          let band: Extract<StreamEvent, { type: 'confidence_band' }> | undefined
          const clauses: string[] = []
          for await (const line of source) {
            if (!replay) {
              // Live path only: tap the events for durable persistence + the once-ever refund on a terminal fail.
              try {
                const ev = JSON.parse(line) as StreamEvent & { code?: string }
                collected.push(ev)
                if (ev.type === 'confidence_band') band = ev
                if (ev.type === 'token') clauses.push(ev.text)
                // §13/F9: a safety-refused or hard-failed scan must NOT count against the quota — credit it back
                // exactly once. Durable RefundStore when wired (survives restarts); else the in-memory guard.
                // GUARD (PROMPT-QUALITY adversarial #9): only a PHASE-1 identification failure (before any band
                // settled) refunds. The async research phase streams AFTER the band and must never emit a terminal
                // error, but this `!band` guard is defence-in-depth so a stray phase-2 error can never credit back
                // a scan the user already consumed on a successful reveal.
                if (ev.type === 'error' && !band && (ev.code === 'safety_refusal' || ev.code === 'hard_failure')) {
                  let firstTime: boolean
                  if (deps.refunds) firstTime = await deps.refunds.markRefunded(id)
                  else {
                    firstTime = !refundedThreads.has(id)
                    refundedThreads.add(id)
                  }
                  if (firstTime) await deps.store.credit(userId, 'scan', 1)
                }
              } catch {
                /* non-JSON line — pass through unchanged */
              }
            }
            controller.enqueue(enc.encode(line + '\n'))
          }
          // Pin the settled reveal for durable replay — first full drain only (a mid-scan reconnect at
          // startIndex>0 has partial events; the initial startIndex=0 drain owns persistence). RevealStore
          // is first-write-wins, so a later re-run can never overwrite what the user already read.
          // A10: persist ONLY a real identification (CONFIDENT/PROBABLE). UNKNOWN carries a rejected label + no
          // narration; freezing it would clobber the label, trap the item in /interview on every revisit, and
          // block it from later catalog growth — so UNKNOWN stays retryable, exactly like a refusal.
          const settled = band && (band.band === 'CONFIDENT' || band.band === 'PROBABLE')
          if (!replay && startIndex === 0 && band && settled && deps.reveals) {
            await deps.reveals
              .put({
                threadId: id,
                ownerUserId: userId,
                band: band.band,
                title: band.title,
                candidates: band.candidates ?? [],
                events: collected,
                narration: clauses.join(' '),
                createdAt: now(),
              })
              .catch(() => {}) // persistence is best-effort; a store hiccup must never break the live stream
            // Denormalize the label + band onto the collection row (NEVER touches title). Optional per A7.
            await deps.threads?.applyReveal?.(id, { revealTitle: band.title, band: band.band }).catch(() => {})
          }
          controller.close()
        },
      }),
      200,
      { 'content-type': 'application/x-ndjson' },
    )
  })

  // Speak a reveal BUCKET in Voxi's British voice (ANALYSIS-VOICE-PLAN B + ANALYSIS-UX §5.C). The text is
  // SERVER-OWNED — read from the eve client / durable reveal, never supplied by the client — so the BFF can't be
  // coerced into voicing arbitrary text; the client only names WHICH bucket via a validated enum path segment.
  // `/speech` (no bucket) == `/speech/what` (back-compat). Fail-closed order: auth → bucket valid? → ownership ACL
  // → speech configured? → server-owned text present? → (cache hit ? bytes : synth+cache) → audio/mpeg.
  const speechHandler = async (c: Context) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const bucketParam = c.req.param('bucket')
    if (bucketParam !== undefined && !isAudioBucket(bucketParam)) return c.json({ error: 'invalid_bucket' }, 400)
    const bucket: AudioBucket = isAudioBucket(bucketParam) ? bucketParam : 'what'
    // Soft map check (belt) — a known-but-non-owned session is forbidden; the strict layers below are owner-scoped.
    if (deps.sessionOwner.get(id) && deps.sessionOwner.get(id) !== userId) return c.json({ error: 'forbidden' }, 403)
    if (!deps.speech) return c.json({ error: 'speech_unconfigured' }, 503) // loud, never a fake success
    // Server-owned text: the live eve client (same process) OR the DURABLE reveal (survives a restart, so a
    // revisited capture is still speakable). Both owner-scoped — the client can never inject text to voice.
    const durableReveal = deps.reveals ? await deps.reveals.get(id) : null
    const durableText = speechBucketText(durableReveal, userId, bucket)
    const text = (await deps.eve.narrationText?.(id, userId, bucket)) || durableText || null
    if (!text) return c.json({ error: 'no_narration' }, 404)
    const key = await sha256hex(text)
    let bytes = (await deps.speech.cache?.get(key)) ?? null
    if (!bytes) {
      try {
        bytes = await deps.speech.tts.synthesize(text)
      } catch (e) {
        logger.error('speech_synth_failed', e instanceof Error ? e : new Error(String(e)), { threadId: id, bucket })
        return c.json({ error: 'synthesis_failed' }, 502)
      }
      await deps.speech.cache?.put(key, bytes).catch(() => {}) // caching is best-effort; never fail the response
    }
    return c.body(bytes, 200, { 'content-type': 'audio/mpeg' })
  }
  app.post('/v1/threads/:id/speech', speechHandler)
  app.post('/v1/threads/:id/speech/:bucket', speechHandler)

  // The grounded conversation context for "tell me more" (PROMPT-QUALITY §3.E). Owner-scoped: built ONLY from the
  // caller's own DURABLE reveal (title + narration + the cited facts), so the voice/text agent is seeded with the
  // same evidence the reveal carried — never client-supplied. Absent a persisted reveal → 404 (nothing to ground).
  app.get('/v1/threads/:id/context', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    if (deps.sessionOwner.get(id) && deps.sessionOwner.get(id) !== userId) return c.json({ error: 'forbidden' }, 403)
    const reveal = deps.reveals ? await deps.reveals.get(id) : null
    if (!reveal || reveal.ownerUserId !== userId) return c.json({ error: 'no_context' }, 404)
    const facts = reveal.events.filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
    return c.json({
      subject: reveal.title,
      band: reveal.band,
      itemContext: buildItemContext(reveal),
      facts: facts.map((f) => ({ text: f.text, sourceUrl: f.sourceUrl, sourceTitle: f.sourceTitle, quote: f.quote })),
    })
  })

  // "Ask Voxi" grounded chat (PLAN §6.3 blue lane / PROMPT-QUALITY §3.E). Answers the user's question ABOUT the
  // item from the SERVER-OWNED durable reveal — never client-supplied — through the same deterministic honesty
  // gate as the narrator (the ChatProvider emits claim-structured clauses + runs validateClaims internally; it is
  // NOT freeform "trust the prompt"). Fail-closed order: auth → ACL → idempotent replay → no_context → charge →
  // reply → persist. The guide turn is persisted with a deterministic clientKey derived from the user's so a
  // network retry is a free replay (no re-charge, no re-call) — the idempotency arbiter is (thread_id, client_key),
  // NOT role-scoped, so the guide's clientKey is `${userClientKey}:g`.
  app.post('/v1/threads/:id/ask', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const body = await c.req.json<{ text: string; userClientKey?: string }>().catch(() => null)
    if (!body?.text) return c.json({ error: 'text required' }, 400)
    const userClientKey = body.userClientKey ?? null
    const guideKey = userClientKey ? `${userClientKey}:g` : null
    // F1d: userClientKey is required (the client always mints one — apiClient.ts:271). A null key skips the replay
    // dedup below + the ON CONFLICT arbiter (pg-stores WHERE client_key IS NOT NULL), so a null-key spammer could
    // insert unbounded free rows on the no-reveal path. Reject null up front (matches the client's contract).
    if (!userClientKey) return c.json({ error: 'userClientKey required' }, 400)

    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)

    // Idempotent replay (M3): a network retry AFTER a successful answer returns the previously-persisted guide
    // turn — no re-charge, no re-call. (A retry after a FAILED reply re-charges; refunding that is a fast-follow.)
    if (deps.messages) {
      const prior = (await deps.messages.listByThread(id)).find((m) => m.clientKey === guideKey)
      if (prior) return c.json({ text: prior.text, id: prior.id, replay: true })
    }

    const reveal = deps.reveals ? await deps.reveals.get(id) : null
    // F1a: split the condition. A wrong-owner reveal is defense-in-depth (the thread-owner ACL above already
    // rejected non-owners; a mismatch here is a data inconsistency) → keep it a hard 404. A MISSING reveal fails
    // open to a route-owned honest reply (Bug A: 26 of 57 cataloged threads have no reveal — their cascade stalled
    // during the legacy GLM-5.2 untimed-call bug; the user gets an honest, loop-free Guide reply instead of a dead
    // 404). NO charge, NO vendor call — there is no evidence to ground, so the honesty gate has nothing to gate;
    // calling the LLM with empty evidence would risk hallucination. The route owns the reply.
    if (reveal && reveal.ownerUserId !== userId) return c.json({ error: 'no_context' }, 404)
    if (!reveal) {
      const NO_REVEAL_REPLY = "I haven't been able to identify this one yet. Try photographing it again and I'll have another look."
      let guideId = undefined
      if (deps.messages) {
        await deps.messages.append({ threadId: id, userId, role: 'user', text: body.text, source: 'text', clientKey: userClientKey })
        const g = await deps.messages.append({ threadId: id, userId, role: 'guide', text: NO_REVEAL_REPLY, source: 'text', clientKey: guideKey })
        guideId = g.id
      }
      return c.json({ text: NO_REVEAL_REPLY, id: guideId, replay: false, grounded: false })
    }
    if (!deps.chat) return c.json({ error: 'guide_unavailable' }, 503)
    // Charge a voice minute BEFORE the LLM call, fail-closed (the existing chat/voice meter lane, same as
    // /v1/voice/session). A spammer can't run unbounded Gemini — every turn costs a minute.
    if (!(await charge(deps.store, userId, 'voiceMin', 1))) return c.json({ error: 'voice_limit_reached' }, 402)

    // Server-owned grounding (the same evidence the reveal carried) + recent turns for continuity.
    const context = buildItemContext(reveal)
    const factEvents = reveal.events.filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
    const evidence: Evidence[] = factEvents.map((f, i) => ({ ref: `fact${i}`, sourceUrl: f.sourceUrl, claim: f.text }))
    if (reveal.band === 'CONFIDENT') evidence.push({ ref: 'id', sourceUrl: 'voxi:cascade', claim: reveal.title })
    const history: ChatTurn[] = deps.messages
      ? (await deps.messages.listByThread(id)).slice(-8).map((m) => ({ role: m.role, text: m.text }))
      : []

    let reply: ChatReply
    try {
      reply = await deps.chat.reply({ context, evidence, history, question: body.text })
    } catch (e) {
      logger.error('chat_reply_failed', e instanceof Error ? e : new Error(String(e)), { threadId: id })
      return c.json({ error: 'guide_unavailable' }, 503)
    }

    // Persist both turns (each idempotent on its own clientKey). The user turn first, then the guide reply.
    let guideId = undefined
    if (deps.messages) {
      await deps.messages.append({ threadId: id, userId, role: 'user', text: body.text, source: 'text', clientKey: userClientKey })
      const g = await deps.messages.append({ threadId: id, userId, role: 'guide', text: reply.text, source: 'text', clientKey: guideKey })
      guideId = g.id
    }
    return c.json({ text: reply.text, id: guideId, replay: false, grounded: reply.grounded })
  })

  // Gate paid podcast generation — atomic decrement + idempotent token (retries/double-taps collapse).
  app.post('/v1/podcast', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ catalogItemId: string; version: number; subject?: string }>().catch(() => null)
    if (!body?.catalogItemId) return c.json({ error: 'catalogItemId required' }, 400)
    const version = body.version ?? 1
    // A9: if catalogItemId names a thread, it MUST be the caller's — else user A could occupy user B's episode
    // slot / attach an episode to B's item. A non-thread catalogItemId (a global catalog id) is allowed.
    const asThread = await deps.threads?.get(body.catalogItemId)
    if (asThread && asThread.ownerUserId !== userId) return c.json({ error: 'forbidden' }, 403)
    const r = await gatePodcastGeneration(deps.store, {
      userId,
      catalogItemId: body.catalogItemId,
      version,
      mintToken: () => `gen_${crypto.randomUUID()}`,
    })
    if (!r.ok) return c.json({ error: r.reason }, 402)
    // The prior durable episode, read BEFORE we (re)stamp it — a retry after a FAILED (or worker-orphaned) render
    // must actually re-enqueue, not dead-end on an idempotent replay. A genuinely-ready episode is a true replay.
    const prior = (await deps.podcasts?.getByItem(body.catalogItemId, version, userId).catch(() => null)) ?? null
    const alreadyReady = prior?.status === 'ready' && !!prior.audioUrl
    // Record the item's episode durably (composing) so the collection item "remembers" it — owner-scoped keyspace.
    // Never downgrade a ready episode back to composing.
    if (!alreadyReady && deps.podcasts) {
      // NON-swallowing (P6b): a durable composing row MUST land before we enqueue, so the deletion cascade can always
      // find the render's GCS objects and the status poll can resolve (item,version) from the token. A transient
      // store failure → 503 (retryable); the retry is an idempotent_replay so the credit is never double-spent.
      try {
        await deps.podcasts.upsert({ token: r.token, userId, catalogItemId: body.catalogItemId, version, status: 'composing', createdAt: now(), updatedAt: now() })
      } catch (e) {
        logger.error('podcast_compose_upsert_failed', e instanceof Error ? e : new Error(String(e)), { catalogItemId: body.catalogItemId })
        return c.json({ error: 'unavailable' }, 503)
      }
    }
    // Build the server-owned reveal context (identity + what/purpose/maker + grounded facts) so the Deep Dive is
    // written from everything the reveal already learned. Owner-scoped and NEVER client-trusted: the subject is the
    // reveal's own title (not the client string), and the whole context is dropped when the reveal isn't the
    // caller's. Absent a durable reveal (an older item / a non-thread global catalog id) we fall back to the client
    // subject exactly as before, so nothing regresses.
    const reveal = deps.reveals ? await deps.reveals.get(body.catalogItemId).catch(() => null) : null
    const podcastContext = buildPodcastContext(reveal, userId)
    const subject = podcastContext?.subject ?? body.subject ?? body.catalogItemId
    // Enqueue a render on a FRESH gate (credit spent), OR on an idempotent replay whose episode is NOT ready —
    // i.e. a retry of a failed render, or one the worker lost (a restart). The worker's CAS makes a genuinely
    // in-flight render a no-op, so a redundant enqueue is safe; a replay of a ready episode never re-renders.
    if (r.reason !== 'idempotent_replay' || !alreadyReady) {
      await deps
        .podcastEnqueue?.({ token: r.token, catalogItemId: body.catalogItemId, version, subject, userId, ...(podcastContext ? { context: podcastContext } : {}) })
        .catch((e) =>
          logger.error('podcast_enqueue_failed', e instanceof Error ? e : new Error(String(e)), {
            token: r.token,
            catalogItemId: body.catalogItemId,
          }),
        )
    }
    return c.json({ token: r.token, replay: r.reason === 'idempotent_replay' })
  })

  // Poll a paid render's status (composing → ready). The BFF proxies the worker; it never fabricates "ready".
  // Owner-scoped. A READY status is cached durably so a revisited item's episode survives a worker restart; if
  // the worker is later unreachable but we hold a durable READY, we serve it (a ready episode never regresses).
  app.get('/v1/podcast/:token', async (c) => {
    const userId = uid(c)
    const token = c.req.param('token')
    // Resolve the (item,version) from the OWNER-SCOPED durable record — this is the ACL (getByToken requires the
    // owning userId) AND how the stateless worker is addressed (it keys on item+version, not the token). A durable
    // READY is served straight off (survives the worker scaling to zero); otherwise we proxy the worker's honest state.
    const rec = deps.podcasts ? await deps.podcasts.getByToken(token, userId) : null
    if (rec?.status === 'ready' && isServableAudioUrl(rec.audioUrl)) {
      return c.json({ state: 'ready', audioUrl: rec.audioUrl ?? undefined, transcript: rec.transcript ?? undefined })
    }
    const st = rec ? ((await deps.podcastStatus?.status(rec.catalogItemId, rec.version)) ?? null) : null
    if (st?.state === 'ready' && deps.podcasts && rec) {
      await deps.podcasts
        .upsert({
          token,
          userId,
          catalogItemId: rec.catalogItemId,
          version: rec.version,
          status: 'ready',
          audioUrl: st.audioUrl ?? null,
          transcript: st.transcript ?? null,
          createdAt: now(),
          updatedAt: now(),
        })
        .catch(() => {})
    }
    if (st) return c.json(st)
    // No worker word yet but a durable row exists → report its (composing) state; no row at all → not_found.
    if (rec) return c.json({ state: rec.status })
    return c.json({ error: 'not_found' }, 404)
  })

  // Durable conversation (== app.messages). Append is idempotent on (threadId, clientKey) — the voice-bot is the
  // single writer in prod; the client also writes text turns. Both owner-scoped (shared verdict, never client id).
  app.post('/v1/threads/:id/messages', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    if (!deps.messages) return c.json({ error: 'unavailable' }, 503)
    const body = await c.req.json<{ role: 'user' | 'guide'; text: string; source?: 'text' | 'voice'; clientKey?: string }>().catch(() => null)
    if (!body?.text || (body.role !== 'user' && body.role !== 'guide')) return c.json({ error: 'role and text required' }, 400)
    const r = await deps.messages.append({
      threadId: id,
      userId,
      role: body.role,
      text: body.text,
      source: body.source === 'voice' ? 'voice' : 'text',
      clientKey: body.clientKey ?? null,
    })
    return c.json(r)
  })

  // Replay a thread's conversation on revisit (owner-scoped).
  app.get('/v1/threads/:id/messages', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const acl = await threadOwnerVerdict(deps, id, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    if (!deps.messages) return c.json({ messages: [] })
    const list = await deps.messages.listByThread(id)
    return c.json({ messages: list.map((m) => ({ id: m.id, role: m.role, text: m.text, source: m.source, createdAt: m.createdAt })) })
  })

  // Open an interview for a thread (the "first witness" path). Visibility DEFAULTS to private (kb-02); a global
  // exemplar requires an explicit toggle + consent. Persists nothing the client claims about ownership.
  app.post('/v1/interview', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ threadId: string; visibility?: 'private' | 'global' }>().catch(() => null)
    if (!body?.threadId) return c.json({ error: 'threadId required' }, 400)
    // Fail-CLOSED owner ACL (shared verdict): a soft-only map check fails OPEN after a restart empties the map,
    // letting anyone open an interview against another user's threadId. Defer to the durable row on a map miss.
    const acl = await threadOwnerVerdict(deps, body.threadId, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)
    if (!deps.interviews) return c.json({ error: 'unavailable' }, 503)
    const r = await deps.interviews.create({ userId, threadId: body.threadId, visibility: body.visibility ?? 'private' })
    return c.json(r)
  })

  // Answer / skip an interview question (skip = answer:null). Capped Q-count is enforced by the service.
  app.post('/v1/interview/:id/answer', async (c) => {
    const userId = uid(c)
    const id = c.req.param('id')
    const body = await c.req.json<{ questionId: string; answer: string | null }>().catch(() => null)
    if (!body?.questionId) return c.json({ error: 'questionId required' }, 400)
    if (!deps.interviews) return c.json({ error: 'unavailable' }, 503)
    const r = await deps.interviews.answer({ interviewId: id, userId, questionId: body.questionId, answer: body.answer ?? null })
    return c.json(r)
  })

  // Submit a tip. The status banner is driven by the SERVER-side trust level, never a client flag:
  // TL0 → routed to human review ("a moderator will review"); TL2+ → goes live immediately ("live now").
  app.post('/v1/tips', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ catalogItemId: string; text: string }>().catch(() => null)
    if (!body?.catalogItemId || !body?.text) return c.json({ error: 'catalogItemId and text required' }, 400)
    if (!deps.contributions) return c.json({ error: 'unavailable' }, 503)
    const trustLevel = await deps.contributions.trustLevel(userId)
    const r = await deps.contributions.submitTip({ userId, catalogItemId: body.catalogItemId, text: body.text, trustLevel })
    return c.json({ ...r, trustLevel })
  })

  // Report a tip or episode → first report auto-hides pending review (kb-04 / pod-04 cache invalidation).
  app.post('/v1/reports', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ targetId: string; kind: 'tip' | 'episode' }>().catch(() => null)
    if (!body?.targetId || !body?.kind) return c.json({ error: 'targetId and kind required' }, 400)
    if (!deps.contributions) return c.json({ error: 'unavailable' }, 503)
    const r = await deps.contributions.report({ userId, targetId: body.targetId, kind: body.kind })
    return c.json(r)
  })

  // Settings/account surface: subscription status + live entitlement counts (no business state from client).
  app.get('/v1/me', async (c) => {
    const userId = uid(c)
    // Plan source of truth: an injected planFor, else the server-verified App Store entitlement store, else free.
    const plan = deps.planFor
      ? await deps.planFor(userId)
      : deps.appStore
        ? await planForUser(deps.appStore.entitlements, userId, now())
        : 'free'
    const meters: Meter[] = ['scan', 'podcast', 'voiceMin']
    const remaining: Record<string, number> = {}
    for (const m of meters) remaining[m] = await deps.store.remaining(userId, m)
    return c.json({ userId, plan, remaining })
  })

  // Verify a StoreKit 2 purchase — the device posts the SIGNED transaction (JWS); we verify it against Apple and
  // persist the entitlement. The client is never trusted; GET /v1/me reflects the server-verified plan. The
  // transaction's appAccountToken must match this user (anti-replay). Replaces the former RevenueCat webhook.
  app.post('/v1/purchases/verify', async (c) => {
    const userId = uid(c)
    if (!deps.appStore) return c.json({ error: 'unavailable' }, 503)
    const body = await c.req.json<{ signedTransaction: string }>().catch(() => null)
    if (!body?.signedTransaction) return c.json({ error: 'signedTransaction required' }, 400)
    const plan = await verifyAndApplyTransaction(body.signedTransaction, userId, deps.appStore.verify, deps.appStore.entitlements)
    if (!plan) return c.json({ error: 'transaction_verification_failed' }, 400)
    return c.json({ plan })
  })

  // Account deletion (Apple-required) — cascades across photos/embeddings/sessions/contributions.
  app.delete('/v1/account', async (c) => {
    const r = await deps.deletion.cascade(uid(c))
    return c.json(r)
  })

  // App Store Server Notifications V2 (Apple → us: renew/expire/refund/revoke). Authenticated by Apple's JWS
  // signature, NOT Clerk — so it lives OUTSIDE the /v1/* auth middleware. Fail-closed: unverifiable → 400 (Apple
  // retries on non-2xx). This keeps entitlements current without any third-party billing vendor.
  app.post('/appstore/notifications', async (c) => {
    if (!deps.appStore) return c.json({ error: 'unavailable' }, 503)
    const body = await c.req.json<{ signedPayload: string }>().catch(() => null)
    if (!body?.signedPayload) return c.json({ error: 'signedPayload required' }, 400)
    const decoded = await deps.appStore.verify(body.signedPayload)
    if (!decoded) return c.json({ error: 'invalid_signature' }, 400)
    await applyNotification(decoded as { notificationType?: string; data?: { signedTransactionInfo?: string } }, deps.appStore.verify, deps.appStore.entitlements)
    return c.json({ ok: true })
  })

  // ---- Cloud Scheduler cron routes (PLAN §7.2/§7.4, §22.3 S1) — additive block ---------------------------
  // These run the REAL dedup/promotion sweeps (services/eve-agent/agent/schedules/{dedup,promote}.ts) off eve's
  // world-postgres scheduler. They live OUTSIDE the /v1/* Clerk auth (the caller is Cloud Scheduler, not a
  // user); they are gated by a server-side shared secret (Cloud Scheduler presents it; also fronted by Cloud
  // Run OIDC ingress in prod). Fail-closed: no `cron` deps → 503; wrong/absent secret → 401.
  const cronAuthed = (c: { req: { header: (k: string) => string | undefined } }): boolean => {
    if (!deps.cron) return false
    const presented = bearerFrom(c.req.header('authorization')) ?? c.req.header('x-cron-key') ?? ''
    // Constant-time-ish compare (lengths differ fast-path); the secret is never client-derived.
    return presented.length > 0 && presented === deps.cron.secret
  }

  // POST /internal/cron/dedup — DEDUP_CRON.bffRoute. Runs runDedupSweep over the current candidates.
  app.post('/internal/cron/dedup', async (c) => {
    if (!deps.cron?.dedup) return c.json({ error: 'unavailable' }, 503)
    if (!cronAuthed(c)) return c.json({ error: 'unauthorized' }, 401)
    const candidates = await deps.cron.dedup.candidates()
    const decisions = await runDedupSweep(candidates, deps.cron.dedup.judge)
    await deps.cron.dedup.apply?.(decisions)
    return c.json({
      ran: 'dedup',
      candidates: candidates.length,
      decisions: decisions.length,
      autoMerges: decisions.filter((d) => d.action === 'auto_merge').length,
      queuedForReview: decisions.filter((d) => d.action === 'queue_review').length,
    })
  })

  // POST /internal/cron/promote — PROMOTE_CRON.bffRoute. Runs runPromotionSweep over the clustered signals.
  app.post('/internal/cron/promote', async (c) => {
    if (!deps.cron?.promote) return c.json({ error: 'unavailable' }, 503)
    if (!cronAuthed(c)) return c.json({ error: 'unauthorized' }, 401)
    const clusters = await deps.cron.promote.clusters()
    const outcomes = runPromotionSweep(clusters)
    await deps.cron.promote.apply?.(outcomes)
    return c.json({
      ran: 'promote',
      clusters: clusters.length,
      promoted: outcomes.filter((o) => o.promote).length,
      held: outcomes.filter((o) => o.promote && o.draft?.visibility === 'pending_global').length,
    })
  })

  return app
}
