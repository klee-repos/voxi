/**
 * BFF voice route (PLAN §6.3 / §6.4 — "Ask Voxi" realtime conversation) — a MOUNTABLE sub-app.
 *
 * LiveKit edition. The BFF is the only public surface: a client asks for a voice session, the BFF verifies
 * the JWT, charges a voiceMin entitlement (fail-closed), and hands back a per-session LiveKit token + URL
 * that the app's @livekit/react-native Room connects with. The LiveKit server dispatches the voice-bot
 * (services/voice-bot, a livekit-agents Worker) into the caller's room; the bot never sees the user's
 * identity directly — it reaches the grounded item context through the BFF-minted capability (the connectId).
 *
 * (Was: Pipecat SmallWebRTC. Migrated after pipecat-ai #2755 + a deeper MediaStreamError in the SmallWebRTC
 * audio path proved unsalvageable. LiveKit owns the WebRTC media plane — the audio bug is gone by construction.)
 *
 * This module is DELIBERATELY separate from app.ts (owned by another change stream). Mount it in the prod
 * entrypoint (infra/docker/voxi-api/server.ts) BEFORE `return app.fetch(req)`:
 *     if (url.pathname.startsWith('/v1/voice/')) return voice.fetch(req)
 */
import { Hono } from 'hono'
import { AccessToken } from 'livekit-server-sdk'
import { bearerFrom, type Verifier } from './auth'
import { charge, type Store } from './metering'
import { threadOwnerVerdict } from './acl'
import { buildItemContext, type ThreadStore, type RevealStore } from './app'
import type { StreamEvent } from '../../../packages/shared/src/events'

export interface VoiceRoutesDeps {
  verifier: Verifier
  store: Store
  /** ownership map sessionId -> userId, shared with the BFF so a voice session is ACL'd to the thread owner. */
  sessionOwner: Map<string, string>
  /** durable thread rows — the fail-CLOSED backstop when the in-memory map is empty after a restart. */
  threads?: ThreadStore
  /** durable reveal rows — the voice-bot fetches the GROUNDED item context (F5) for a minted session via
   *  GET /v1/voice/session/:connectId/context. Absent → the route returns persona-only (voice still starts). */
  reveals?: RevealStore
  /** LiveKit server URL (e.g. ws://host:7880 dev / wss://prod). Default: process.env.LIVEKIT_URL. */
  livekitUrl?: string
  /** LiveKit API key (token-signing). Default: process.env.LIVEKIT_API_KEY. */
  livekitApiKey?: string
  /** LiveKit API secret (token-signing). Default: process.env.LIVEKIT_API_SECRET. */
  livekitApiSecret?: string
  /** minutes charged when a session is opened (fail-closed before any media connect). Default 1. */
  minutesPerSession?: number
  /** token TTL in seconds. Default 1h — a voice session is short. */
  tokenTtlSeconds?: number
  now?: () => number
  /** injectable id generator (tests pin it deterministically). */
  mintConnectId?: () => string
}

/** Build the mountable voice sub-app. */
export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? Date.now
  const minutes = deps.minutesPerSession ?? 1
  const livekitUrl = deps.livekitUrl ?? process.env.LIVEKIT_URL ?? ''
  const apiKey = deps.livekitApiKey ?? process.env.LIVEKIT_API_KEY ?? ''
  const apiSecret = deps.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET ?? ''
  const ttl = deps.tokenTtlSeconds ?? 60 * 60
  const mintId = deps.mintConnectId ?? (() => `vc_${crypto.randomUUID()}`)
  // Minted sessions: connectId → (userId, threadId, minutes). The connectId is the capability for BOTH the refund
  // (F5-LIFECYCLE: credit back if the client never connected) AND the context fetch (F5: the voice-bot resolves
  // the owner-scoped threadId from the capability — a client can't swap ?thread= to another user's reveal).
  const charged = new Map<string, { userId: string; threadId: string; minutes: number }>()
  const refunded = new Set<string>()

  // Auth gate for the user-facing voice routes (/session, /refund). The voice-bot's /context fetch is CAPABILITY-
  // auth'd by the connectId in the path — exempt it from the user-JWT middleware.
  app.use('/v1/voice/*', async (c, next) => {
    if (c.req.path.endsWith('/context')) { await next(); return }
    const principal = await deps.verifier(bearerFrom(c.req.header('authorization')) ?? '')
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    c.set('userId' as never, principal.userId as never)
    await next()
  })

  const uid = (c: { get: (k: never) => never }) => c.get('userId' as never) as unknown as string

  /**
   * Open a realtime voice session for a thread. Fail-closed order:
   *   1. auth (middleware above),
   *   2. thread ownership ACL,
   *   3. LiveKit config check (url + key + secret set? else 503 — BEFORE the charge),
   *   4. voiceMin charge (atomic tryDecrement) — NO token if it fails,
   *   5. mint a per-session LiveKit token (room=threadId, identity=userId, agent dispatch).
   * The client feeds `url` + `token` to createVoiceSession (app/src/lib/pipecat.ts).
   */
  app.post('/v1/voice/session', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ threadId: string }>().catch(() => null)
    if (!body?.threadId) return c.json({ error: 'threadId required' }, 400)

    // ACL: a voice session may only be opened for a thread the caller owns.
    const acl = await threadOwnerVerdict(deps, body.threadId, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)

    if (!livekitUrl || !apiKey || !apiSecret) {
      // Loud failure, not a fake success. Runs BEFORE the charge so a guaranteed-fail config never bills a minute.
      return c.json(
        { error: 'voice_server_unconfigured', detail: 'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must all be set' },
        503,
      )
    }

    // Fail-closed: charge a voice minute BEFORE minting the token. No fake success on empty balance.
    if (!(await charge(deps.store, userId, 'voiceMin', minutes))) {
      return c.json({ error: 'voice_limit_reached' }, 402)
    }

    const connectId = mintId()
    charged.set(connectId, { userId, threadId: body.threadId, minutes })

    // Mint a per-session LiveKit token. Room = threadId; identity = userId. The metadata carries the connectId
    // capability so the voice-bot can fetch the grounded item context (F5). The agent grant triggers LiveKit to
    // dispatch the voice-bot Worker into the room when this caller joins.
    const token = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      metadata: JSON.stringify({ connectId, threadId: body.threadId, userId }),
      ttl,
    })
    token.addGrant({
      roomJoin: true,
      room: body.threadId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      agent: true,
    })
    const jwt = await token.toJwt()

    return c.json({
      connectId,
      url: livekitUrl,
      token: jwt,
      threadId: body.threadId,
      minutesCharged: minutes,
      issuedAt: now(),
    })
  })

  /**
   * Refund a voice minute when the client never reached the media plane (dismiss-during-mint or connect()
   * failure / timeout). Idempotent on connectId (once-ever); only the payer can refund their own session.
   */
  app.post('/v1/voice/session/:connectId/refund', async (c) => {
    const userId = uid(c)
    const connectId = c.req.param('connectId')
    const rec = charged.get(connectId)
    if (!rec || rec.userId !== userId) return c.json({ error: 'not_found' }, 404) // never leak existence
    if (refunded.has(connectId)) return c.json({ refunded: false, replay: true }) // once-ever
    refunded.add(connectId)
    await deps.store.credit(userId, 'voiceMin', rec.minutes)
    return c.json({ refunded: true, minutes: rec.minutes })
  })

  /**
   * The voice-bot's GROUNDED item context fetch (F5). Capability-auth'd by the connectId (server-minted,
   * unguessable, bound to the payer + threadId at mint). The threadId is resolved from the CAPABILITY, never
   * from a client/voice-bot-supplied ?thread=. Absent reveal → 404 no_context → the voice-bot fails open to persona.
   */
  app.get('/v1/voice/session/:connectId/context', async (c) => {
    const rec = charged.get(c.req.param('connectId'))
    if (!rec) return c.json({ error: 'not_found' }, 404)
    const acl = await threadOwnerVerdict(deps, rec.threadId, rec.userId)
    if (!acl.ok) return c.json({ error: 'no_context' }, 404)
    const reveal = deps.reveals ? await deps.reveals.get(rec.threadId) : null
    if (!reveal || reveal.ownerUserId !== rec.userId) return c.json({ error: 'no_context' }, 404)
    const facts = reveal.events.filter((e): e is Extract<StreamEvent, { type: 'fact' }> => e.type === 'fact')
    return c.json({
      subject: reveal.title,
      band: reveal.band,
      itemContext: buildItemContext(reveal),
      facts: facts.map((f) => ({ text: f.text, sourceUrl: f.sourceUrl, sourceTitle: f.sourceTitle, quote: f.quote })),
    })
  })

  return app
}
