/**
 * LiveChatProvider — Voxi's grounded "Ask Voxi" follow-up chat (PLAN §6.3 blue lane / PROMPT-QUALITY §3.E).
 *
 * A free-form chat turn is a NEW hallucination surface the narrator/researcher didn't have, so this provider
 * does NOT emit freeform prose and "trust the prompt." It reuses the EXACT honesty discipline as the narrator:
 * Vertex Gemini returns CLAIM-STRUCTURED clauses (each with a claimType + an evidenceRef citing one of the
 * closed evidence[] the route built from the durable reveal), and the REAL shared `validateClaims` gate drops
 * any falsifiable clause without valid grounding before a word is returned. Approved clauses are joined into the
 * reply; if NOTHING is approved the reply is an in-persona hedge (`grounded:false`) — so the UI never mistakes a
 * hedge for an answer. The confidence band still rules: only CONFIDENT reveals contribute an `id` evidence ref.
 *
 * Same Vertex Gemini text call + gcloud auth as identification (`geminiJSON`) — NO new creds. A deterministic fake
 * is injected in tests (the route is unit-tested with a fake ChatProvider, no Gemini).
 */
import { geminiJSON } from '../lib/gcp-vision'
import { validateClaims, type ClaimType, type Clause, type Evidence } from '../../../../packages/shared/src/confidence'
import { smugglesFalsifiable } from './live-narrator'
import type { ChatProvider, ChatReply, ChatTurn } from '../../../voxi-api/src/app'

/** The hedge the Guide offers when nothing in the reply could be grounded. In-persona; never an overclaim. */
const HEDGE: ChatReply = {
  text: "I can't prove that from what I've found here. Try photographing it again, or ask me something else about it.",
  grounded: false,
}

/** The claim shapes the gate knows about (mirrors the narrator's schema). `flavor` = non-falsifiable persona glue. */
const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          claimType: { type: 'string', enum: ['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative', 'observation', 'flavor'] as ClaimType[] },
          /** must cite one of the provided evidence refs (e.g. "fact0", "id"); falsifiable types REQUIRE it. */
          evidenceRef: { type: 'string' },
        },
        required: ['text', 'claimType'],
      },
    },
  },
  required: ['clauses'],
}

/** Build the closed evidence vocabulary the LLM may cite. Mirrors the narrator's `id`-only-on-CONFIDENT rule. */
function systemPrompt(evidence: Evidence[]): string {
  const refs = evidence.length ? evidence.map((e) => `  • ${e.ref} — ${e.claim}`).join('\n') : '  (none — the reveal is ungrounded; you cannot assert any falsifiable claim)'
  return [
    'You are Voxi, a dry, witty British Guide. The user photographed an object and is now asking a follow-up question about it.',
    'Answer using ONLY the grounded item context provided in the user turn. Return JSON { clauses: [...] } where each clause is ONE asserted sentence with a claimType and an evidenceRef that cites ONE of the available evidence refs below.',
    'claimType: spec|provenance|date|causal|superlative|comparative|observation|flavor. Use "flavor" for in-persona connective tissue that asserts NOTHING falsifiable.',
    'RULES: do not assert any spec/date/provenance/superlative/comparative/causal claim unless its evidenceRef directly supports it. If the question cannot be answered from the evidence, return clauses: [] and the system will hedge in persona. Never invent facts, prices, dates, or comparisons not in the evidence. Keep it dry, brief, and never overclaim.',
    'Available evidence refs you may cite:',
    refs,
  ].join('\n')
}

/** Render the approved clauses as reply prose; drop rejected ones (the gate's verdict is the honesty guarantee). */
function renderReply(approved: Clause[]): ChatReply {
  if (!approved.length) return HEDGE
  return { text: approved.map((c) => c.text).join(' '), grounded: true }
}

/** The pure, testable core (no Gemini): gate drafted clauses → reply prose. Exposed for direct unit testing. */
export function gateChat(clauses: Clause[], evidence: Evidence[]): ChatReply {
  const verdict = validateClaims(clauses, evidence, { detectNamedClaim: smugglesFalsifiable, failClosed: false })
  return renderReply(verdict.approved)
}

/** The production ChatProvider: a claim-structured Vertex Gemini call + the deterministic honesty gate. */
export class LiveChatProvider implements ChatProvider {
  async reply(args: { context: string; evidence: Evidence[]; history: ChatTurn[]; question: string }): Promise<ChatReply> {
    const system = systemPrompt(args.evidence)
    const history = args.history.map((t) => `${t.role === 'guide' ? 'Voxi' : 'User'}: ${t.text}`).join('\n')
    const user = `${args.context}\n\n${history ? `Conversation so far:\n${history}\n\n` : ''}User's question: ${args.question}`

    // Retry a transient empty/failed Gemini response (mirrors the narrator's retry); a gate that legitimately
    // drops every clause is NOT retried (same input → same drop) — honest-empty stays honest-empty.
    let clauses: Clause[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await geminiJSON<{ clauses: Clause[] }>(system, user, CHAT_SCHEMA, 0.4)
        clauses = out.clauses ?? []
        if (clauses.length) break
      } catch {
        /* transient Gemini failure → retry; chat is best-effort, never a crash */
      }
    }
    return gateChat(clauses, args.evidence)
  }
}
