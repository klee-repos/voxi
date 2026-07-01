/**
 * Vendor record/replay (PLAN e2e/README: determinism control).
 *
 * Wraps any external vendor call (Gemini, Cloud Vision, ElevenLabs, Deepgram, Clerk). In `replay` mode it
 * returns the byte-for-byte taped response keyed by a hash of the request (so CI is deterministic and free);
 * in `record` mode it calls the real vendor (creds) and stores the response. A replay miss THROWS — it never
 * silently fabricates a response (that would be cheating). Tapes are saved to fixtures and committed.
 */
import { createHash } from 'node:crypto'

export interface TapedCall {
  key: string
  vendor: string
  response: unknown
}

export type Mode = 'replay' | 'record'
export type VendorFn<Req, Res> = (req: Req) => Promise<Res>

function stableStringify(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']'
  const keys = Object.keys(o as Record<string, unknown>).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((o as Record<string, unknown>)[k])).join(',') + '}'
}

export function hashRequest(vendor: string, req: unknown): string {
  return vendor + ':' + createHash('sha256').update(stableStringify(req)).digest('hex').slice(0, 16)
}

export class VendorTape {
  private map = new Map<string, unknown>()

  constructor(entries: TapedCall[] = []) {
    for (const e of entries) this.map.set(e.key, e.response)
  }

  wrap<Req, Res>(vendor: string, real: VendorFn<Req, Res>, mode: Mode): VendorFn<Req, Res> {
    return async (req: Req): Promise<Res> => {
      const key = hashRequest(vendor, req)
      if (mode === 'replay') {
        if (!this.map.has(key)) {
          throw new Error(`vendor-tape: no recording for ${vendor} (${key}). Re-record with --live.`)
        }
        return this.map.get(key) as Res
      }
      // record: hit the real vendor once, store the response.
      const res = await real(req)
      this.map.set(key, res)
      return res
    }
  }

  export(vendorOf: (key: string) => string = (k) => k.split(':')[0]): TapedCall[] {
    return [...this.map.entries()].map(([key, response]) => ({ key, vendor: vendorOf(key), response }))
  }
}
