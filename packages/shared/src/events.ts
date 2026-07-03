/**
 * The BFF↔eve NDJSON stream event contract (PLAN §4.3 / DX-6).
 *
 * The client must handle exactly this taxonomy; `?startIndex=` reconnection replays from an event index.
 * Zod schemas validate at the boundary so the client and BFF can never silently disagree on shapes.
 */
import { z } from 'zod'

export const ConfidenceBand = z.enum(['CONFIDENT', 'PROBABLE', 'UNKNOWN'])

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), index: z.number().int(), text: z.string() }),
  z.object({ type: z.literal('tool_start'), index: z.number().int(), tool: z.string() }),
  z.object({ type: z.literal('tool_result'), index: z.number().int(), tool: z.string(), ok: z.boolean() }),
  z.object({
    type: z.literal('confidence_band'),
    index: z.number().int(),
    band: ConfidenceBand,
    title: z.string(),
    candidates: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal('partial_id'), index: z.number().int(), title: z.string() }),
  z.object({ type: z.literal('error'), index: z.number().int(), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('done'), index: z.number().int(), sessionId: z.string() }),
  // A grounded, verified interesting fact — streamed one-by-one as async research verifies each (PROMPT-QUALITY
  // §3.C). Carries its PROVENANCE (the sourceUrl + verbatim quote) — the durable "proof if challenged" the UI shows
  // per fact. `index` continues the single monotonic session sequence past the deferred `done` (§3.B4).
  z.object({
    type: z.literal('fact'),
    index: z.number().int(),
    text: z.string(),
    sourceUrl: z.string(),
    sourceTitle: z.string().default(''),
    quote: z.string(),
  }),
  // The richer, dossier-grounded description replacing the instant first-pass narration (visual; §3.C).
  z.object({ type: z.literal('description_upgrade'), index: z.number().int(), text: z.string() }),
  // A normalized research SECTION — one grounded bucket of the reveal beyond the identity (ANALYSIS-UX §5.A). Voxi
  // answers fixed questions about any object; `what_is_it` rides `whatItIs`/`description_upgrade`, `facts` ride the
  // `fact` events, and the narrative buckets — `purpose` (what it's for), `maker` (who made it), and `made` (when it
  // was made) — stream as their own `section` event carrying the grounded text + optional source proof. `bucket` is
  // a FREE STRING (never a z.enum): a server that adds a bucket must NOT crash shipped clients that know `section`
  // but not the new value (the tolerant reader skips unknown TYPES, not unknown enum values within a known type),
  // and a bucket need not be voiceable — `made` streams as a section but is NOT in AUDIO_BUCKETS. The voiceable
  // enum lives only on the `/speech/:bucket` route param. Each carries its own monotonic `index` past the reveal.
  z.object({
    type: z.literal('section'),
    index: z.number().int(),
    bucket: z.string(),
    text: z.string(),
    sourceUrl: z.string().default(''),
    sourceTitle: z.string().default(''),
    quote: z.string().default(''),
  }),
])

export type StreamEvent = z.infer<typeof StreamEvent>

/** The closed set of known event `type` discriminators (the tolerant reader's allow-list). */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'token', 'tool_start', 'tool_result', 'confidence_band', 'partial_id', 'error', 'done', 'fact', 'description_upgrade',
  'section',
])

/** Parse one NDJSON line; throws on a malformed/unknown event (the client must never see an untyped event). */
export function parseEventLine(line: string): StreamEvent {
  return StreamEvent.parse(JSON.parse(line))
}

/**
 * FORWARD-COMPATIBLE parse for long-lived CLIENTS (PROMPT-QUALITY §2.4 / adversarial #10). A shipped app binary
 * bundles its own copy of this taxonomy, so a server that starts emitting a NEW event type must not crash old
 * clients. This reads the `.type` discriminator FIRST and returns `null` (skip) ONLY for a type not in the known
 * set. A KNOWN type that fails schema validation still THROWS — a malformed `token`/`fact`/… is a real
 * server↔client disagreement and must surface, never be silently swallowed. (Malformed JSON also still throws.)
 */
export function parseEventLineTolerant(line: string): StreamEvent | null {
  const raw = JSON.parse(line) as { type?: unknown }
  if (!raw || typeof raw.type !== 'string' || !KNOWN_EVENT_TYPES.has(raw.type)) return null // unknown → skip
  return StreamEvent.parse(raw) // known type → must validate (malformed KNOWN type throws loud)
}

/** Resume helper: given the last index the client saw, the startIndex to request on reconnect. */
export function nextStartIndex(lastSeenIndex: number | null): number {
  return lastSeenIndex === null ? 0 : lastSeenIndex + 1
}

/**
 * The four normalized reveal buckets that `/speech/:bucket` can voice (ANALYSIS-UX §5.C). This IS an enum — it
 * validates a client-supplied ROUTE PARAM (reject unknown → 400), unlike the `section` event's free-string `bucket`
 * (which must stay open for forward-compat). `what` → the what-only narration; `facts` → the joined verified facts;
 * `purpose`/`maker` → their section texts. Text is always server-owned; the client only names which bucket.
 */
export const AUDIO_BUCKETS = ['what', 'purpose', 'maker', 'facts'] as const
export type AudioBucket = (typeof AUDIO_BUCKETS)[number]
export function isAudioBucket(x: unknown): x is AudioBucket {
  return typeof x === 'string' && (AUDIO_BUCKETS as readonly string[]).includes(x)
}
