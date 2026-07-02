/**
 * Typed client for the voxi-api BFF — the ONLY public surface (services/voxi-api/src/app.ts).
 *
 * One method per route, request/response shapes mirrored from `createApp`. The NDJSON stream is parsed with
 * the SHARED contract (packages/shared/src/events.ts) so the client can never silently disagree with the BFF
 * on event shapes; `?startIndex=` reconnection uses `nextStartIndex` from the same module.
 *
 * Pluggable by design (PLAN §3): a `getToken` seam (Clerk in prod, a `test:<user>` bearer in the E2E web
 * harness) and a `fetchImpl` seam (the e2e/web server exposes the real BFF under /api). Nothing here trusts
 * business state from the client — the BFF enforces auth, metering, and per-user ACL.
 */
import {
  parseEventLineTolerant,
  nextStartIndex,
  type StreamEvent,
  type AudioBucket,
} from '../../../packages/shared/src/events'
import { captureIfUnexpected } from './observability'

export type { StreamEvent, AudioBucket }

// ---- route I/O types (mirror services/voxi-api/src/app.ts) ----
export interface SignedUploadUrl {
  url: string
  objectKey: string
  expiresAt: number
}
export interface CreateThreadBody {
  photoUrl: string
  title?: string
  /** E2E-only band steer (native Maestro tier). Sent as the `X-Voxi-Test-Seed` header, never in the body; the
   *  test-BFF maps it to a deterministic reveal band. Undefined in production. */
  testSeed?: string
}
export interface CreateThreadResult {
  threadId: string
}
/** A confidence band, mirrored from the shared contract, for the collection tile chip. */
export type Band = 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN'

export interface ThreadSummary {
  threadId: string
  title: string
  /** the identified label (e.g. "1976 Canon AE-1"); falls back to `title` when not yet revealed. */
  revealTitle?: string | null
  band?: Band | null
  createdAt: number
  /** absolute URL of the persisted capture thumbnail (signed), or null when no photo was stored. */
  photoUrl?: string | null
}
export interface ThreadDetail {
  threadId: string
  title: string
  revealTitle?: string | null
  band?: Band | null
  continuationToken: string
  resumes: boolean
  photoUrl?: string | null
  /** the item's durable podcast episode, if one was generated. */
  podcast?: { state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[] } | null
  hasConversation?: boolean
}
/** A persisted conversation message (durable history replayed on revisit). */
export interface ThreadMessage {
  id: string
  role: 'user' | 'guide'
  text: string
  source: 'text' | 'voice'
  createdAt: number
}
export interface PodcastGateBody {
  catalogItemId: string
  version?: number
  /** the object's title (e.g. "1976 Canon AE-1") — the render subject the worker researches + narrates. */
  subject?: string
}
export interface PodcastGateResult {
  token: string
  replay: boolean
}
export interface PodcastStatus {
  state: 'composing' | 'ready' | 'failed'
  audioUrl?: string
  /** the real two-host read-along transcript (speaker-tagged), returned once the episode is ready. */
  transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[]
}
export interface InterviewBody {
  threadId: string
  visibility?: 'private' | 'global'
}
export interface InterviewQuestion {
  id: string
  prompt: string
  whyAsked: string
}
export interface InterviewResult {
  interviewId: string
  visibility: 'private' | 'global'
  questions: InterviewQuestion[]
}
export interface InterviewAnswerBody {
  questionId: string
  answer: string | null
}
export interface TipBody {
  catalogItemId: string
  text: string
}
export interface TipResult {
  tipId: string
  status: 'pending_review' | 'live'
  trustLevel: number
}
export interface ReportBody {
  targetId: string
  kind: 'tip' | 'episode'
}
export interface ReportResult {
  autoHidden: boolean
}
export interface MeResult {
  userId: string
  plan: 'free' | 'explorer' | 'voyager'
  remaining: Record<'scan' | 'podcast' | 'voiceMin', number>
}
export interface DeleteAccountResult {
  deleted: string[]
}

/** The error envelope every BFF route returns on a non-2xx (`{ error: string }`). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${status}: ${code}`)
    this.name = 'ApiError'
  }
}

export interface ApiClientOptions {
  baseUrl: string
  /** Returns a bearer token (Clerk session JWT in prod; `test:<user>` in the web harness). */
  getToken: () => Promise<string | null>
  /** Injectable fetch (defaults to global fetch). The e2e/web harness passes its own. */
  fetchImpl?: typeof fetch
}

export class ApiClient {
  private baseUrl: string
  private getToken: () => Promise<string | null>
  private fetchImpl: typeof fetch

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.getToken = opts.getToken
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken()
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { ...(await this.authHeaders()), ...(init?.headers as Record<string, string>) },
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[api] fetch FAILED → ${init?.method ?? 'GET'} ${url} :: ${e instanceof Error ? e.name + ': ' + e.message : String(e)}`)
      // A transport failure (fetch threw) is a CLIENT-only signal the BFF never saw — capture it. HTTP error
      // responses (ApiError below) are NOT captured here: a 5xx is already reported server-side, and 402/refusal
      // are expected outcomes.
      captureIfUnexpected(e, { kind: 'network', method: init?.method ?? 'GET', path })
      throw e
    }
    // eslint-disable-next-line no-console
    console.log(`[api] ${init?.method ?? 'GET'} ${url} → ${res.status}`)
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? 'unknown')
    return body as T
  }

  // POST /v1/uploads/sign — short-TTL, user-bound signed URL for the captured photo.
  signUpload(): Promise<SignedUploadUrl> {
    return this.json<SignedUploadUrl>('/v1/uploads/sign', { method: 'POST' })
  }

  // POST /v1/threads — create a thread (1 photo = 1 eve session). Charges a scan; 402 → paywall.
  createThread(body: CreateThreadBody): Promise<CreateThreadResult> {
    const { testSeed, ...rest } = body
    // The E2E band seed rides a header (the native analog of the web harness's ?scan Referer), not the body.
    const headers = testSeed ? { 'x-voxi-test-seed': testSeed } : undefined
    return this.json<CreateThreadResult>('/v1/threads', { method: 'POST', body: JSON.stringify(rest), headers })
  }

  /**
   * POST /v1/threads with the captured photo as multipart/form-data. On React Native this streams the local
   * `file://` JPEG natively — no Blob/FileReader/base64 (RN iOS throws "Creating blobs from ArrayBuffer … not
   * supported"). We deliberately DON'T set content-type so the RN networking layer sets the multipart boundary.
   */
  async createThreadWithPhoto(photoUri: string, title?: string): Promise<CreateThreadResult> {
    const fd = new FormData()
    // RN's FormData accepts a { uri, type, name } file descriptor; the platform reads the file at send time.
    fd.append('photo', { uri: photoUri, type: 'image/jpeg', name: 'capture.jpg' } as unknown as Blob)
    if (title) fd.append('title', title)
    const token = await this.getToken()
    const url = `${this.baseUrl}/v1/threads`
    let res: Response
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[api] multipart upload FAILED → ${url} :: ${e instanceof Error ? e.name + ': ' + e.message : String(e)}`)
      captureIfUnexpected(e, { kind: 'network', method: 'POST', path: '/v1/threads' })
      throw e
    }
    const text = await res.text()
    const parsed = text ? JSON.parse(text) : {}
    if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string }).error ?? 'unknown')
    return parsed as CreateThreadResult
  }

  /** The BFF returns a RELATIVE signed photo path (`/media/...`); make it absolute so <Image> can load it on
   *  both native (LAN base URL) and web (`/api` origin) without an auth header. */
  private absPhoto(p: string | null | undefined): string | null {
    if (!p) return null
    return /^https?:\/\//.test(p) ? p : `${this.baseUrl}${p}`
  }

  // GET /v1/threads — the caller's own collection (owner-scoped ACL). Thumbnails + identified labels + band.
  async listThreads(): Promise<{ threads: ThreadSummary[] }> {
    const r = await this.json<{ threads: ThreadSummary[] }>('/v1/threads')
    return { threads: r.threads.map((t) => ({ ...t, photoUrl: this.absPhoto(t.photoUrl) })) }
  }

  // GET /v1/threads/:id — revisit → the durable capture (photo + identified label + podcast + conversation state).
  async getThread(threadId: string): Promise<ThreadDetail> {
    const d = await this.json<ThreadDetail>(`/v1/threads/${encodeURIComponent(threadId)}`)
    return { ...d, photoUrl: this.absPhoto(d.photoUrl) }
  }

  // GET /v1/threads/:id/messages — the durable conversation history, replayed on revisit.
  listMessages(threadId: string): Promise<{ messages: ThreadMessage[] }> {
    return this.json<{ messages: ThreadMessage[] }>(`/v1/threads/${encodeURIComponent(threadId)}/messages`)
  }

  // POST /v1/threads/:id/messages — persist a conversation turn (idempotent on clientKey).
  postMessage(
    threadId: string,
    body: { role: 'user' | 'guide'; text: string; source?: 'text' | 'voice'; clientKey?: string },
  ): Promise<{ id: string; duplicate: boolean }> {
    return this.json<{ id: string; duplicate: boolean }>(`/v1/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  // POST /v1/podcast — gate paid generation (atomic decrement + idempotent token).
  generatePodcast(body: PodcastGateBody): Promise<PodcastGateResult> {
    return this.json<PodcastGateResult>('/v1/podcast', { method: 'POST', body: JSON.stringify(body) })
  }

  // GET /v1/podcast/:token — poll a render's status (composing → ready).
  podcastStatus(token: string): Promise<PodcastStatus> {
    return this.json<PodcastStatus>(`/v1/podcast/${encodeURIComponent(token)}`)
  }

  // POST /v1/interview — open the unknown-item interview (default PRIVATE).
  openInterview(body: InterviewBody): Promise<InterviewResult> {
    return this.json<InterviewResult>('/v1/interview', { method: 'POST', body: JSON.stringify(body) })
  }

  // POST /v1/interview/:id/answer — answer or skip (answer:null = skip).
  answerInterview(interviewId: string, body: InterviewAnswerBody): Promise<{ done: boolean }> {
    return this.json<{ done: boolean }>(`/v1/interview/${encodeURIComponent(interviewId)}/answer`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  // POST /v1/tips — submit a tip; server-side trust level drives the status banner.
  submitTip(body: TipBody): Promise<TipResult> {
    return this.json<TipResult>('/v1/tips', { method: 'POST', body: JSON.stringify(body) })
  }

  // POST /v1/reports — report a tip/episode (first report auto-hides).
  report(body: ReportBody): Promise<ReportResult> {
    return this.json<ReportResult>('/v1/reports', { method: 'POST', body: JSON.stringify(body) })
  }

  // GET /v1/me — subscription status + live entitlement counts.
  me(): Promise<MeResult> {
    return this.json<MeResult>('/v1/me')
  }

  // POST /v1/purchases/verify — forward a StoreKit 2 signed transaction (JWS) for server-side verification.
  // The server is the source of truth; a subsequent me() reflects the verified plan.
  verifyPurchase(signedTransaction: string): Promise<{ plan: 'free' | 'explorer' | 'voyager' }> {
    return this.json<{ plan: 'free' | 'explorer' | 'voyager' }>('/v1/purchases/verify', {
      method: 'POST',
      body: JSON.stringify({ signedTransaction }),
    })
  }

  // DELETE /v1/account — Apple-required deletion cascade.
  deleteAccount(): Promise<DeleteAccountResult> {
    return this.json<DeleteAccountResult>('/v1/account', { method: 'DELETE' })
  }

  /**
   * POST /v1/threads/:id/speech[/:bucket] — hear a reveal bucket in Voxi's British voice. The text is SERVER-OWNED
   * (the BFF voices the honesty-gated clauses it produced; the client sends no text — only names WHICH bucket via a
   * validated enum path segment). `bucket` omitted → the `what` narration (back-compat with the pre-redesign route).
   * Returns a playable `data:audio/mpeg` URL, or `null` when there's nothing to speak / speech is unconfigured
   * (400/404/502/503) so the caller can no-op gracefully — never a thrown error on the reveal's happy path.
   */
  async speakNarration(threadId: string, bucket?: AudioBucket): Promise<string | null> {
    const seg = bucket && bucket !== 'what' ? `/${bucket}` : ''
    const url = `${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/speech${seg}`
    let res: Response
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers: await this.authHeaders() })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[speech] POST ${url} FAILED (offline?): ${e instanceof Error ? e.message : String(e)}`)
      return null // offline / network drop → no narration audio, the reveal still stands
    }
    if (!res.ok) {
      // Loud, so a stale server (no /speech route → 404) or a missing ELEVENLABS_API_KEY (503) is diagnosable
      // instead of silently playing nothing. 404 no_narration | 502 synth_failed | 503 speech_unconfigured.
      // eslint-disable-next-line no-console
      console.warn(`[speech] POST ${url} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)} (restart the BFF if the /speech route is missing)`)
      return null
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // eslint-disable-next-line no-console
    console.log(`[speech] got ${bytes.length} bytes of ${res.headers.get('content-type') ?? 'audio'}`)
    return bytes.length ? `data:audio/mpeg;base64,${bytesToBase64(bytes)}` : null
  }

  /**
   * GET /v1/threads/:id/stream — consume the eve NDJSON stream as typed events.
   *
   * Each line is parsed with the FORWARD-COMPATIBLE parser: an UNKNOWN event type (a newer server) is skipped,
   * but a malformed KNOWN event still throws (the client must never silently accept an off-shape known event).
   * `startIndex` supports `?startIndex=` reconnection; pass the last index you saw and call `nextStartIndex(last)`
   * to resume. Yields one validated `StreamEvent` per line.
   */
  async *streamThread(
    threadId: string,
    opts: { startIndex?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = opts.startIndex ?? 0
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/stream?startIndex=${start}`,
      { headers: await this.authHeaders(), signal: opts.signal },
    )
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ApiError(res.status, (text && safeError(text)) || 'stream_failed')
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        // Forward-compatible: skip an UNKNOWN event type (a newer server), never throw — but a malformed KNOWN
        // event still throws (parseEventLineTolerant, §2.4). This lets a shipped app survive a new event type.
        if (line) {
          const ev = parseEventLineTolerant(line)
          if (ev) yield ev
        }
      }
    }
    const tail = buf.trim()
    if (tail) {
      const ev = parseEventLineTolerant(tail)
      if (ev) yield ev
    }
  }
}

/** Portable base64 (RN Hermes has no reliable global btoa/Buffer) — encodes the TTS mp3 bytes for a data: URL. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64[b2 & 63]
  }
  return out
}

function safeError(text: string): string | null {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? null
  } catch {
    return null
  }
}

export { nextStartIndex }
