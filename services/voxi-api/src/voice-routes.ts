/**
 * BFF voice route (PLAN §6.3 / §6.4 — "Ask Voxi" realtime conversation) — a MOUNTABLE sub-app.
 *
 * The BFF is the only public surface, so the realtime voice tier is admitted here: a client asks for a voice
 * session, the BFF verifies the JWT, charges a voiceMin entitlement (fail-closed), and hands back a
 * per-session connect URL that points the app's Pipecat SmallWebRTC client at the voice server (the media
 * plane in services/voice-bot/voice_server.py). The voice server never sees the user's identity directly —
 * it is reached only via this BFF-minted, per-session scoped connect URL.
 *
 * This module is DELIBERATELY separate from app.ts (owned by another change stream). It exports a factory
 * that returns a standalone Hono app you can either serve on its own or mount into the main BFF. To wire it
 * into the production entrypoint (infra/docker/voxi-api/server.ts), add:
 *
 *     import { createVoiceRoutes } from '../../../services/voxi-api/src/voice-routes'
 *     const voice = createVoiceRoutes({ verifier: deps.verifier, store: deps.store, sessionOwner: deps.sessionOwner })
 *     // inside serve({ fetch }) BEFORE `return app.fetch(req)`:
 *     if (url.pathname.startsWith('/v1/voice/')) return voice.fetch(req)
 *
 * or mount on the Hono app directly if app.ts ever exposes it: `app.route('/', createVoiceRoutes(...))`.
 * It re-applies the SAME auth middleware + userId ACL as app.ts, so it is safe to mount independently.
 */
import { Hono } from 'hono'
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
  /** durable thread rows — the fail-CLOSED backstop when the in-memory map is empty after a restart (else the
   *  soft map check fails OPEN and lets anyone open a voice session against another user's threadId). */
  threads?: ThreadStore
  /** durable reveal rows — the voice-bot fetches the GROUNDED item context (F5) for a minted session via
   *  GET /v1/voice/session/:connectId/context. Absent → the route returns persona-only (voice still starts). */
  reveals?: RevealStore
  /**
   * Base URL of the voice media server (Pipecat SmallWebRTC signalling). In prod this is the in-VPC voice
   * server; in dev it is http://<lan-ip>:<voiceport>. Read from env so no secret is hardcoded.
   */
  voiceServerBaseUrl?: string
  /** minutes charged when a session is opened (fail-closed before any media connect). Default 1. */
  minutesPerSession?: number
  now?: () => number
  /** injectable id generator (tests pin it deterministically). */
  mintConnectId?: () => string
}

/** Build the mountable voice sub-app. */
export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? Date.now
  const minutes = deps.minutesPerSession ?? 1
  const base = deps.voiceServerBaseUrl ?? process.env.VOICE_SERVER_BASE_URL ?? ''
  const mintId = deps.mintConnectId ?? (() => `vc_${crypto.randomUUID()}`)
  // Minted sessions: connectId → (userId, threadId, minutes). The connectId is the capability for BOTH the refund
  // (F5-LIFECYCLE: credit back if the client never connected) AND the context fetch (F5: the voice-bot resolves
  // the owner-scoped threadId from the capability — a client can't swap ?thread= to another user's reveal, F5-CAP-THREAD).
  const charged = new Map<string, { userId: string; threadId: string; minutes: number }>()
  const refunded = new Set<string>()

  // Auth gate for the user-facing voice routes (/session, /refund). The voice-bot's /context fetch is CAPABILITY-
  // auth'd by the connectId in the path (server-minted, unguessable, bound to the payer at mint) — it carries no
  // user JWT, so exempt it from the user-JWT middleware; the /context handler enforces the capability itself.
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
   *   2. thread ownership ACL (a voice session is bound to a thread the caller owns),
   *   3. media-plane config check (`VOICE_SERVER_BASE_URL` set? else 503 — BEFORE the charge so a
   *      guaranteed-fail config never bills a minute),
   *   4. voiceMin entitlement charge (atomic tryDecrement) — NO connect URL is returned if it fails,
   *   5. mint a per-session connect URL pointing at the voice media server.
   * The client feeds `connectUrl` to createVoiceSession (app/src/lib/pipecat.ts).
   */
  app.post('/v1/voice/session', async (c) => {
    const userId = uid(c)
    const body = await c.req.json<{ threadId: string }>().catch(() => null)
    if (!body?.threadId) return c.json({ error: 'threadId required' }, 400)

    // ACL: a voice session may only be opened for a thread the caller owns. Shared verdict — the previous
    // soft-only map check fails OPEN after a restart empties the map; defer to the durable row on a miss.
    const acl = await threadOwnerVerdict(deps, body.threadId, userId)
    if (!acl.ok) return c.json({ error: acl.error }, acl.status)

    if (!base) {
      // Loud failure, not a fake success: the media plane must be configured to admit a real session. This runs
      // BEFORE the charge so a guaranteed-fail config (the F6-mounted-but-F7-not-deployed window, or a future
      // secret removal) never bills a user a minute for a session that can never connect.
      return c.json(
        { error: 'voice_server_unconfigured', detail: 'VOICE_SERVER_BASE_URL is not set' },
        503,
      )
    }

    // Fail-closed: charge a voice minute BEFORE handing out any connect URL. No fake success on empty balance.
    if (!(await charge(deps.store, userId, 'voiceMin', minutes))) {
      return c.json({ error: 'voice_limit_reached' }, 402)
    }

    const connectId = mintId()
    // Record the charge + the owner-scoped threadId the capability binds (F5-CAP-THREAD: the /context fetch
    // resolves threadId from HERE, never from a client-supplied ?thread=).
    charged.set(connectId, { userId, threadId: body.threadId, minutes })
    // The connect URL carries the session, not the identity. The voice server's /offer is the signalling entry;
    // the sessionId scopes the pipeline's transcript write-back + tool bridge back through the BFF.
    const connectUrl = `${base.replace(/\/$/, '')}/offer?session=${encodeURIComponent(connectId)}&thread=${encodeURIComponent(body.threadId)}`

    return c.json({
      connectId,
      connectUrl,
      threadId: body.threadId,
      minutesCharged: minutes,
      issuedAt: now(),
    })
  })

  /**
   * Refund a voice minute when the client never reached the media plane (dismiss-during-mint or connect()
   * failure / timeout). Idempotent on connectId (once-ever); only the payer can refund their own session. The
   * client calls this on unmount-before-connect AND on a connect() failure — the once-ever guard means a late
   * /offer confirm or a double-tap can't double-credit. Charge stays BEFORE the URL (fail-closed at mint); the
   * refund never opens a connect-without-paying race because it only CREDITS an already-charged session.
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
   * unguessable, bound to the payer + threadId at mint) — this route is exempt from the user-JWT middleware above
   * because the voice-bot holds no user identity. The threadId is resolved from the CAPABILITY, never from a
   * client/voice-bot-supplied ?thread= (F5-CAP-THREAD: a malicious client can't swap it to another user's reveal).
   * Returns the SAME server-owned grounding /ask uses (buildItemContext) so the Guide converses ABOUT the item.
   * Absent reveal (entered before the cascade pinned one) → 404 no_context → the voice-bot fails open to persona.
   */
  app.get('/v1/voice/session/:connectId/context', async (c) => {
    const rec = charged.get(c.req.param('connectId'))
    if (!rec) return c.json({ error: 'not_found' }, 404) // unknown/expired capability — never leak existence
    // Defense-in-depth: re-verify the capability's (threadId, userId) still owns the thread.
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
