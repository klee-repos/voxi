/**
 * The byte-range contract for the Deep Dive /audio endpoint (`bun test`).
 *
 * This is the gate that would have caught the shipped bug: the endpoint advertised `Accept-Ranges: bytes` but
 * answered a `Range:` request with `200` + the whole file, so iOS AVPlayer treated the episode as non-seekable
 * (scrubber + ±15 dead). These tests pin a REAL `206 Partial Content` with an exact `Content-Range` and body —
 * asserted both in-process (edge cases) and over a real socket (the on-the-wire contract AVPlayer relies on).
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioRangeResponse } from './audio-range'

// A 256-byte fixture where byte i === i, so a slice's bytes are self-describing (byte at offset k is k).
const SIZE = 256
const path = join(tmpdir(), `voxi-audio-range-${process.pid}.bin`)
let file: ReturnType<typeof Bun.file>

beforeAll(async () => {
  await Bun.write(path, new Uint8Array(Array.from({ length: SIZE }, (_, i) => i)))
  file = Bun.file(path)
})

const bytesOf = async (r: Response): Promise<number[]> => Array.from(new Uint8Array(await r.arrayBuffer()))

describe('audioRangeResponse — RFC 7233 byte ranges (the AVPlayer seekability contract)', () => {
  test('no Range → 200 with the full body + explicit Content-Length + Accept-Ranges', async () => {
    const r = audioRangeResponse(file, SIZE, null)
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('content-length')).toBe('256')
    expect(r.headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await bytesOf(r)).length).toBe(256)
  })

  test('bytes=10-19 → 206 with the EXACT sliced bytes, Content-Range and Content-Length', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=10-19')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/256')
    expect(r.headers.get('content-length')).toBe('10')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('cache-control')).toBe('public, max-age=86400') // not dropped on the 206
    expect(await bytesOf(r)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  test('bytes=0- (open-ended, the common AVPlayer probe) → 206 covering the whole file', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=0-')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 0-255/256')
    expect(r.headers.get('content-length')).toBe('256')
    expect((await bytesOf(r)).length).toBe(256)
  })

  test('bytes=250- → 206 to EOF', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=250-')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 250-255/256')
    expect(await bytesOf(r)).toEqual([250, 251, 252, 253, 254, 255])
  })

  test('suffix bytes=-5 → the last 5 bytes', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=-5')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 251-255/256')
    expect(await bytesOf(r)).toEqual([251, 252, 253, 254, 255])
  })

  test('end past EOF clamps: bytes=200-999 → 206 for 200-255', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=200-999')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 200-255/256')
    expect(r.headers.get('content-length')).toBe('56')
  })

  test('unsatisfiable start ≥ size → 416 with Content-Range bytes */size', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=300-400')
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */256')
  })

  test('bytes=-0 (zero-length suffix) → 416', async () => {
    const r = audioRangeResponse(file, SIZE, 'bytes=-0')
    expect(r.status).toBe(416)
  })

  test('malformed / multi-range / other units → ignored, full 200 (never a corrupt 206)', async () => {
    for (const h of ['bytes=abc', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=', 'garbage', 'bytes=5-2']) {
      const r = audioRangeResponse(file, SIZE, h)
      // bytes=5-2 (start>end) is a satisfiable-looking but invalid single range → 416; the rest → full 200.
      if (h === 'bytes=5-2') { expect(r.status).toBe(416); continue }
      expect(r.status).toBe(200)
      expect((await bytesOf(r)).length).toBe(256)
    }
  })
})

// ── The WIRE contract over a real socket — what iOS AVPlayer actually sees (the durable regression gate) ──────
describe('audioRangeResponse — over a real Bun.serve socket (AVPlayer wire contract)', () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => audioRangeResponse(file, SIZE, req.headers.get('range')),
    })
    base = `http://localhost:${server.port}`
  })
  afterAll(() => server.stop(true))

  test('a Range request returns 206 + Content-Range + exactly the requested bytes on the wire', async () => {
    const r = await fetch(base, { headers: { Range: 'bytes=100-149' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 100-149/256')
    expect(r.headers.get('content-length')).toBe('50')
    const body = new Uint8Array(await r.arrayBuffer())
    expect(body.length).toBe(50)
    expect(body[0]).toBe(100)
    expect(body[49]).toBe(149)
  })

  test('a no-Range request returns 200 + the full file (plain download unbroken)', async () => {
    const r = await fetch(base)
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect((await r.arrayBuffer()).byteLength).toBe(256)
  })
})
