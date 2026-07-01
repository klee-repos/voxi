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
import type { ThreadStore } from './app'

export interface VoiceRoutesDeps {
  verifier: Verifier
  store: Store
  /** ownership map sessionId -> userId, shared with the BFF so a voice session is ACL'd to the thread owner. */
  sessionOwner: Map<string, string>
  /** durable thread rows — the fail-CLOSED backstop when the in-memory map is empty after a restart (else the
   *  soft map check fails OPEN and lets anyone open a voice session against another user's threadId). */
  threads?: ThreadStore
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

  // Same auth gate as the main BFF — every /v1/* voice route requires a valid principal.
  app.use('/v1/voice/*', async (c, next) => {
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
   *   3. voiceMin entitlement charge (atomic tryDecrement) — NO connect URL is returned if it fails,
   *   4. mint a per-session connect URL pointing at the voice media server.
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

    // Fail-closed: charge a voice minute BEFORE handing out any connect URL. No fake success on empty balance.
    if (!(await charge(deps.store, userId, 'voiceMin', minutes))) {
      return c.json({ error: 'voice_limit_reached' }, 402)
    }

    if (!base) {
      // Loud failure, not a fake success: the media plane must be configured to admit a real session.
      return c.json(
        { error: 'voice_server_unconfigured', detail: 'VOICE_SERVER_BASE_URL is not set' },
        503,
      )
    }

    const connectId = mintId()
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

  return app
}
