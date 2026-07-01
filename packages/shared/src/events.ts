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
])

export type StreamEvent = z.infer<typeof StreamEvent>

/** The closed set of known event `type` discriminators (the tolerant reader's allow-list). */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'token', 'tool_start', 'tool_result', 'confidence_band', 'partial_id', 'error', 'done', 'fact', 'description_upgrade',
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
