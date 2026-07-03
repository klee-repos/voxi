/**
 * HTTP byte-range (RFC 7233) responses for a rendered Deep Dive episode.
 *
 * Why this exists (RCA): the /audio endpoint used to `return new Response(Bun.file(f), …)` and advertise
 * `Accept-Ranges: bytes`, but in a Bun.serve fetch handler that does NOT honor a `Range:` request — it answers
 * every range with `200 OK` + the whole file. iOS AVPlayer (react-native-track-player → SwiftAudioEx → AVPlayer)
 * treats a server that answers a Range request with 200 instead of 206 as a NON-SEEKABLE progressive stream:
 * play/pause work, but the scrubber and ±15 do nothing ("it doesn't remember all the audio"). We must slice the
 * file ourselves and return a real `206 Partial Content` + `Content-Range` so the asset is seekable.
 *
 * Bun 1.3.11 note: a `Response` built in-process reports auto Content-Length as `null` (it is computed lazily at
 * serialization), so we set `Content-Length` EXPLICITLY on every branch — otherwise it's absent both to an
 * in-process test and, defensively, on the wire. A malformed / multi-range / non-`bytes` range degrades to the
 * full 200 (RFC 7233 §3.1 allows ignoring a range we won't honor) — never a corrupt 206.
 */

type FileLike = ReturnType<typeof Bun.file>

const BASE_HEADERS = {
  'content-type': 'audio/mpeg',
  'accept-ranges': 'bytes',
  'cache-control': 'public, max-age=86400',
} as const

/** 200 with the whole file — byte-identical to the pre-fix response, plus an explicit Content-Length. */
function fullResponse(file: FileLike, size: number): Response {
  return new Response(file, { headers: { ...BASE_HEADERS, 'content-length': String(size) } })
}

/** 416 Range Not Satisfiable — MUST carry `Content-Range: bytes *​/size` (RFC 7233 §4.4). */
function unsatisfiable(size: number): Response {
  return new Response('range not satisfiable', {
    status: 416,
    headers: { ...BASE_HEADERS, 'content-range': `bytes */${size}`, 'content-length': '0' },
  })
}

/**
 * Build the response for a GET of a rendered episode, honoring a single `bytes=` range if present.
 * `size` is the file's byte length (pass `file.size` after confirming it exists).
 */
export function audioRangeResponse(file: FileLike, size: number, rangeHeader: string | null): Response {
  if (!rangeHeader) return fullResponse(file, size)

  // Single `bytes=a-b` / `bytes=a-` / `bytes=-N` only. Anything else (multi-range with a comma, another unit,
  // garbage) is ignored with a full 200 rather than risk a corrupt partial response.
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) return fullResponse(file, size)
  const startRaw = m[1] ?? ''
  const endRaw = m[2] ?? ''
  if (startRaw === '' && endRaw === '') return fullResponse(file, size) // "bytes=-" — malformed

  let start: number
  let end: number
  if (startRaw === '') {
    // Suffix range: the last N bytes.
    const n = Number(endRaw)
    if (!Number.isFinite(n) || n <= 0) return unsatisfiable(size)
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return unsatisfiable(size)
  }

  // Bun.file(...).slice(start, end) is end-EXCLUSIVE (Blob semantics); Content-Range end is INCLUSIVE.
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...BASE_HEADERS,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  })
}
