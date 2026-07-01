/**
 * Hardened signed URLs for GCS objects (PLAN §11 / D9 / eng-F5).
 *
 * Invariants enforced here (and tested): short TTL, bound to the requesting user, non-enumerable object key
 * (UUID), and HMAC-signed so the BFF stays the only authority. Private assets are never served from a shared
 * CDN path; audio cached by catalog item id is global-only (callers pass `scope`).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export interface SignedUrl {
  url: string
  objectKey: string
  expiresAt: number
}

export interface SignOpts {
  bucket: string
  userId: string
  scope: 'private' | 'global'
  ttlSeconds?: number // default 120s (short)
  now?: number
}

const DEFAULT_DEV_SECRET = 'test-signing-key'

/**
 * The URL-signing secret. FAIL-CLOSED in production (adversarial A1): the `/media/threads/:id/photo` route
 * serves raw photo bytes authenticated ONLY by this HMAC, outside the Clerk /v1/* middleware — so shipping with
 * the well-known default key would let anyone who knows a threadId (which embeds the owner's userId) forge a
 * valid URL and exfiltrate another user's private capture. We therefore REFUSE to sign with the default when
 * running in production; dev/test may use the default (the harness sets VOXI_TEST_MODE=1).
 */
function signingSecret(): string {
  const k = process.env.VOXI_URL_SIGNING_KEY
  const isProd = process.env.VOXI_ENV === 'production' || process.env.NODE_ENV === 'production'
  if (isProd && (!k || k.length < 16)) {
    throw new Error(
      'VOXI_URL_SIGNING_KEY is unset or too short (>=16 chars) — refusing to sign URLs with a default key in production',
    )
  }
  return k && k.length >= 16 ? k : DEFAULT_DEV_SECRET
}

/** Startup guard for server.ts (fail fast in prod rather than at the first sign() call). */
export function assertSigningKeyConfigured(): void {
  signingSecret()
}

function sign(payload: string): string {
  return createHmac('sha256', signingSecret()).update(payload).digest('hex').slice(0, 32)
}

/** Constant-time hex compare (avoids leaking the signature via timing). */
function sigEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Photo capability URL (adversarial A1): a self-authenticating, owner-bound, short-TTL URL the client's
// <img>/<Image> loads WITHOUT an auth header (RN-web <img> can't send one). This is the local stand-in for a
// GCS signed URL. FULL-LENGTH HMAC (not the 32-hex slice above) since it is the sole gate on private bytes.
// ---------------------------------------------------------------------------
function photoSig(threadId: string, userId: string, exp: number): string {
  return createHmac('sha256', signingSecret()).update(`photo|${threadId}|${userId}|${exp}`).digest('hex')
}

/** Mint a relative `/media/threads/:id/photo?u=&exp=&sig=` path (client prepends baseUrl). TTL ≤ 600s. */
export function mintPhotoUrl(opts: { threadId: string; userId: string; ttlSeconds?: number; now?: number }): string {
  const ttl = Math.min(opts.ttlSeconds ?? 600, 900)
  const exp = (opts.now ?? Date.now()) + ttl * 1000
  const sig = photoSig(opts.threadId, opts.userId, exp)
  return `/media/threads/${encodeURIComponent(opts.threadId)}/photo?u=${encodeURIComponent(opts.userId)}&exp=${exp}&sig=${sig}`
}

/** Verify a `/media` read: signature valid (owner+threadId+exp bound) and not expired. */
export function verifyPhotoUrl(opts: { threadId: string; u: string; exp: number; sig: string; now?: number }): {
  ok: boolean
  reason?: string
} {
  if (!opts.u || !opts.sig || !Number.isFinite(opts.exp)) return { ok: false, reason: 'missing_params' }
  if (!sigEqual(opts.sig, photoSig(opts.threadId, opts.u, opts.exp))) return { ok: false, reason: 'bad_signature' }
  if ((opts.now ?? Date.now()) > opts.exp) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export function mintSignedUrl(opts: SignOpts): SignedUrl {
  const ttl = opts.ttlSeconds ?? 120
  if (ttl > 900) throw new Error('signed URL TTL too long (max 900s)')
  const now = opts.now ?? Date.now()
  const expiresAt = now + ttl * 1000
  // Non-enumerable key. Private assets live under a per-user prefix that never maps to a cacheable CDN path.
  const objectKey = opts.scope === 'private' ? `u/${opts.userId}/${randomUUID()}` : `g/${randomUUID()}`
  const payload = `${opts.bucket}|${objectKey}|${opts.userId}|${opts.scope}|${expiresAt}`
  const sig = sign(payload)
  const url = `https://storage.example/${opts.bucket}/${objectKey}?u=${opts.userId}&s=${opts.scope}&exp=${expiresAt}&sig=${sig}`
  return { url, objectKey, expiresAt }
}

/** Verify a read attempt: signature valid, not expired, and the caller is the bound user (cross-tenant denied). */
export function authorizeRead(url: string, asUserId: string, now = Date.now()): { ok: boolean; reason?: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'bad_url' }
  }
  const objectKey = parsed.pathname.split('/').slice(2).join('/')
  const bucket = parsed.pathname.split('/')[1]
  const u = parsed.searchParams.get('u') ?? ''
  const scope = parsed.searchParams.get('s') ?? ''
  const exp = Number(parsed.searchParams.get('exp') ?? 0)
  const sig = parsed.searchParams.get('sig') ?? ''

  const expected = sign(`${bucket}|${objectKey}|${u}|${scope}|${exp}`)
  if (sig !== expected) return { ok: false, reason: 'bad_signature' }
  if (now > exp) return { ok: false, reason: 'expired' }
  // Cross-tenant: a private object bound to user X cannot be read by user Y.
  if (scope === 'private' && u !== asUserId) return { ok: false, reason: 'cross_tenant_denied' }
  return { ok: true }
}
