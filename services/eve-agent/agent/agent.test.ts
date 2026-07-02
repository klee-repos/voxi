/**
 * Deterministic tests for the eve AGENT LAYER (PLAN §4.2, §7, §22.3) — the parts that run with NO creds.
 *
 * These drive the REAL agent-layer modules (config registry, the Clerk-AuthFn + session-ownership ACL channel,
 * the storyteller + interviewer subagents, and the dedup/promote schedules) through the REAL shared modules
 * (confidence honesty gate, defamation gate, promotion sybil guard, dedup guard). Nothing is stubbed to force a
 * verdict — the gates/guards decide; the fakes only supply inputs a live vendor would supply.
 *
 * The one thing that genuinely CANNOT run here is binding to a live eve process (no pinned toolchain, no
 * Postgres world) — that is the G3 boot spike, which records its TRUE result honestly in g3-spike/.
 */
import { test, expect, describe } from 'bun:test'
import {
  AGENT,
  AgentConfigSchema,
  validateAgentConfig,
  roleFromEnv,
  MODEL,
  WORLD,
  loadEveRuntime,
} from './agent'
import {
  makeAuthFn,
  memorySessionOwnership,
  onSessionCreated,
  clerkVerifier,
  bearerFrom,
  type TokenVerifier,
} from './channels/eve'
import { buildScript, OUTPUT_SCHEMA, type ScriptLine, type StorytellerInput } from './subagents/storyteller'
import {
  nextQuestion,
  finalize,
  validateEntry,
  MAX_QUESTIONS,
  type InterviewAnswer,
} from './subagents/interviewer'
import { classifyPair, runDedupSweep, guardCreate, DEDUP_CRON } from './schedules/dedup'
import { decidePromotion, runPromotionSweep, draftIsStructuredOnly, PROMOTE_CRON } from './schedules/promote'
import { CreateGuard } from '../../../packages/shared/src/dedup'
import type { OwnerSignal } from '../../../packages/shared/src/promotion'

// ---------------------------------------------------------------------------
// agent.ts — model + world + registry (PLAN §4.2)
// ---------------------------------------------------------------------------
describe('agent.ts — config registry, model, world', () => {
  test('the static AGENT registry validates against its schema', () => {
    expect(() => validateAgentConfig()).not.toThrow()
    expect(AgentConfigSchema.safeParse(AGENT).success).toBe(true)
  })

  test('brain default = anthropic claude-sonnet-4-6 with compaction on (§4.2)', () => {
    expect(MODEL.provider).toBe('@ai-sdk/anthropic')
    expect(MODEL.id).toBe('claude-sonnet-4-6')
    expect(MODEL.compaction).toBe(true)
  })

  test('workflow world = postgres (the non-serverless durable seam, §4.4)', () => {
    expect(WORLD.kind).toBe('postgres')
    expect(WORLD.pkg).toBe('@workflow/world-postgres')
    expect(WORLD.dsnEnv).toBe('WORLD_DATABASE_URL')
  })

  test('the registry mounts the real authored layout (tools/subagents/skills/schedules/channel)', () => {
    expect(AGENT.tools).toContain('tools/identify_object.ts')
    expect(AGENT.tools).toContain('tools/web_research.ts')
    expect(AGENT.subagents).toEqual(['subagents/storyteller', 'subagents/interviewer', 'subagents/researcher'])
    expect(AGENT.skills).toContain('skills/interview-unknown-item/SKILL.md')
    expect(AGENT.schedules).toEqual(['schedules/dedup.ts', 'schedules/promote.ts'])
    expect(AGENT.channel).toBe('channels/eve.ts')
  })

  test('split-topology role is read from the environment (front default, poller opt-in)', () => {
    expect(roleFromEnv({} as NodeJS.ProcessEnv)).toBe('front')
    expect(roleFromEnv({ WORKFLOW_ROLE: 'poller' } as unknown as NodeJS.ProcessEnv)).toBe('poller')
  })

  test('loadEveRuntime reports HONESTLY (no fake green) — ok when the pinned toolchain resolves, else the exact failing stage', async () => {
    const r = await loadEveRuntime()
    // The contained §4.5 adapter NEVER pretends: either it genuinely resolved eve+world+model (ok:true, the
    // installed/pinned reality — task #22 installs the toolchain isolated under services/eve-agent, proven by
    // agent/server.ts booting a real Postgres world), or it reports the EXACT import that failed. Both are
    // correct; the invariant is that it can never return a fake success. This asserts whichever branch is true
    // in the current environment, so it passes with the toolchain present (dev) OR absent (a bare CI checkout).
    if (r.ok) {
      // toolchain resolved — the world + model provider handles are live (the world's createWorld and the
      // AI-SDK anthropic provider). eve@0.17.x exports defineAgent (not a named `Agent`), so the mapped
      // `Agent` handle may be undefined in this version; the load succeeding is the contract that matters.
      expect(r.world).toBeDefined()
      expect(r.model).toBeDefined()
    } else {
      // toolchain absent — it named the exact failing stage rather than faking a boot.
      expect(['eve', 'world', 'model']).toContain(r.stage)
      expect(typeof r.error).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// channels/eve.ts — Clerk AuthFn (networkless) + session-ownership ACL (PLAN §4.3, §12)
// ---------------------------------------------------------------------------
describe('channels/eve.ts — networkless Clerk verify + per-user session-ownership ACL', () => {
  // A fake networkless verifier: a `clerk:<userId>` bearer "verifies" (stands in for a signature check).
  const verify: TokenVerifier = async (bearer) => {
    const m = /^clerk:([a-z0-9_-]+)$/i.exec(bearer)
    return m ? { userId: m[1]! } : null
  }

  test('a missing/invalid token is 401 (authenticate)', async () => {
    const authFn = makeAuthFn(verify, memorySessionOwnership())
    expect(await authFn({ authorization: null, kind: 'create' })).toMatchObject({ ok: false, status: 401 })
    expect(await authFn({ authorization: 'Bearer garbage', kind: 'create' })).toMatchObject({ ok: false, status: 401 })
  })

  test('a valid token may create; ownership is recorded and the owner may then stream', async () => {
    const own = memorySessionOwnership()
    const authFn = makeAuthFn(verify, own)
    const created = await authFn({ authorization: 'Bearer clerk:alice', kind: 'create' })
    expect(created).toMatchObject({ ok: true, principal: { userId: 'alice' } })
    await onSessionCreated(own, 'sess1', 'alice')
    expect(await authFn({ authorization: 'Bearer clerk:alice', kind: 'stream', sessionId: 'sess1' })).toMatchObject({ ok: true })
  })

  test('THE LOAD-BEARING ACL: user B cannot stream user A’s session even with a valid token (§4.3)', async () => {
    const own = memorySessionOwnership()
    const authFn = makeAuthFn(verify, own)
    await onSessionCreated(own, 'sessA', 'alice')
    const denied = await authFn({ authorization: 'Bearer clerk:bob', kind: 'stream', sessionId: 'sessA' })
    expect(denied).toMatchObject({ ok: false, status: 403 })
  })

  test('an unknown session is 403, not a silent allow', async () => {
    const authFn = makeAuthFn(verify, memorySessionOwnership())
    expect(await authFn({ authorization: 'Bearer clerk:alice', kind: 'continue', sessionId: 'nope' })).toMatchObject({ ok: false, status: 403 })
  })

  test('clerkVerifier is networkless: it calls the injected verifyToken (no fetch) and maps sub→userId', async () => {
    let called = 0
    const v = clerkVerifier(async (tok) => {
      called++
      if (tok === 'good') return { sub: 'user_123' }
      throw new Error('bad signature')
    }, 'PEM')
    expect(await v(bearerFrom('Bearer good') ?? '')).toEqual({ userId: 'user_123' })
    expect(await v('bad')).toBeNull() // a throw → null → 401, never a leak
    expect(called).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// subagents/storyteller — claim-structured script + fail-closed honesty gate (PLAN §6.2, §8.3, RT-1, RT-9)
// ---------------------------------------------------------------------------
describe('subagents/storyteller — fail-closed two-voice script', () => {
  const input: StorytellerInput = {
    subject: '2008 Cannondale SuperSix EVO',
    evidence: [
      { ref: 'f1', sourceUrl: 'https://cannondale.com/history', claim: 'The SuperSix EVO debuted as a carbon road frame.' },
      { ref: 'f2', sourceUrl: 'https://bikepedia.example/supersix', claim: 'It was marketed for its low frame weight.' },
    ],
    sources: [{ url: 'https://cannondale.com/history' }, { url: 'https://bikepedia.example/supersix' }],
  }

  test('a fully-grounded two-voice script ships and satisfies the output schema', () => {
    const lines: ScriptLine[] = [
      { speaker: 'ARLO', clauses: [{ text: 'A carbon road frame, the SuperSix EVO.', claimType: 'provenance', evidenceRef: 'f1' }] },
      { speaker: 'MAVE', clauses: [{ text: 'Marketed on its low weight — that part we can ground.', claimType: 'spec', evidenceRef: 'f2' }] },
      { speaker: 'ARLO', clauses: [{ text: 'A lovely thing to look at.', claimType: 'flavor' }] },
    ]
    const r = buildScript(input, lines)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(OUTPUT_SCHEMA.hasTwoSpeakers(r.script)).toBe(true)
      expect(OUTPUT_SCHEMA.everyFalsifiableClauseCited(r.script)).toBe(true)
      expect(r.droppedLines).toBe(0)
    }
  })

  test('FAIL-CLOSED: an uncited spec line is DROPPED, not spoken', () => {
    const lines: ScriptLine[] = [
      { speaker: 'ARLO', clauses: [{ text: 'A carbon road frame.', claimType: 'provenance', evidenceRef: 'f1' }] },
      { speaker: 'MAVE', clauses: [{ text: 'It weighs exactly 695 grams.', claimType: 'spec' }] }, // NO evidenceRef → reject → drop
      { speaker: 'ARLO', clauses: [{ text: 'Low weight was the pitch.', claimType: 'spec', evidenceRef: 'f2' }] },
    ]
    const r = buildScript(input, lines)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.droppedLines).toBe(1)
      const allText = r.script.lines.flatMap((l) => l.clauses.map((c) => c.text)).join(' ')
      expect(allText).not.toContain('695 grams') // the fabricated spec never reaches the script
    }
  })

  test('FAIL-CLOSED: too few grounded lines fails the WHOLE episode in persona (no husk shipped)', () => {
    const lines: ScriptLine[] = [
      { speaker: 'ARLO', clauses: [{ text: 'It is the rarest of its era.', claimType: 'superlative' }] }, // uncited → drop
      { speaker: 'MAVE', clauses: [{ text: 'And it never sold, which is why...', claimType: 'causal' }] }, // uncited → drop
    ]
    const r = buildScript(input, lines, { minLines: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.inPersona).toMatch(/couldn't verify enough/i)
  })

  test('a negative claim about an identifiable entity with <2 independent sources is DROPPED (defamation, RT-9)', () => {
    const oneSource: StorytellerInput = {
      subject: 'Acme Widget',
      evidence: [{ ref: 'g1', sourceUrl: 'https://news.example/recall', claim: 'Acme recalled the widget.' }],
      sources: [{ url: 'https://news.example/recall' }], // only ONE registrable domain
    }
    // Mid-sentence capitalized entity so the shared heuristic classifier flags identifiableEntity (its real
    // signal is `\s[A-Z]`, a brand name not at sentence start). Negative word ("recall"/"defect") + entity +
    // only ONE independent source → the REAL defamation gate routes to human_review → fail-closed DROP.
    const lines: ScriptLine[] = [
      { speaker: 'MAVE', clauses: [{ text: 'This widget by Acme was recalled for a defect.', claimType: 'provenance', evidenceRef: 'g1' }] },
      { speaker: 'ARLO', clauses: [{ text: 'A neat little gadget all the same.', claimType: 'flavor' }] },
    ]
    const r = buildScript(oneSource, lines, { minLines: 1 })
    // The negative recall line is dropped by the defamation gate; the neutral flavor line survives.
    expect(r.ok).toBe(true)
    if (r.ok) {
      const text = r.script.lines.flatMap((l) => l.clauses.map((c) => c.text)).join(' ')
      expect(text).not.toMatch(/recalled for a defect/i)
      expect(r.droppedLines).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// subagents/interviewer — capped, skippable, thread-kept, private-default (PLAN §7.3, kb-01)
// ---------------------------------------------------------------------------
describe('subagents/interviewer — first-witness Q&A invariants', () => {
  test('the interview is capped at 2–3 questions, never more', () => {
    const answers: InterviewAnswer[] = []
    let asked = 0
    for (;;) {
      const q = nextQuestion(answers)
      if (!q) break
      asked++
      answers.push({ questionId: q.id, text: `answer-${asked}` })
      if (asked > 10) throw new Error('cap not enforced') // safety
    }
    expect(asked).toBeLessThanOrEqual(MAX_QUESTIONS)
  })

  test('every question carries a required "why am I asked this" line (§7.3)', () => {
    const q = nextQuestion([])
    expect(q?.whyAsked).toBeTruthy()
  })

  test('THREAD KEPT ON BAIL: zero answers still mints a resumable private placeholder', () => {
    const e = finalize('thread-x', [])
    expect(e.entryId).toBe('thread-x')
    expect(e.minimalPlaceholder).toBe(true)
    expect(e.visibility).toBe('private') // never global by default
    expect(validateEntry(e).ok).toBe(true)
  })

  test('a skipped answer (null) is valid and advances; testimony is captured for real answers only', () => {
    const e = finalize('thread-y', [
      { questionId: 'what', text: 'a brass thingamajig' },
      { questionId: 'markings', text: null }, // skipped
    ])
    expect(e.name).toBe('a brass thingamajig')
    expect(e.testimony.markings).toBeUndefined()
    expect(e.minimalPlaceholder).toBe(false)
  })

  test('global requires explicit opt-in; testimony may NOT assert verified id fields (§8.3)', () => {
    const e = finalize('thread-z', [{ questionId: 'what', text: 'a gizmo' }], { visibility: 'global' })
    expect(e.visibility).toBe('global')
    // validateEntry rejects smuggled verified-id fields
    const bad = { ...e, testimony: { verified_make: 'Cannondale' } }
    expect(validateEntry(bad).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// schedules/dedup — concurrent-create guard + merge bands, Cloud-Scheduler-drivable (PLAN §7.2, §22.3 S1)
// ---------------------------------------------------------------------------
describe('schedules/dedup — guard + sweep bands', () => {
  test('concurrent creates in one bucket converge to ONE entry (eng-F10, reuses shared CreateGuard)', () => {
    const guard = new CreateGuard()
    const a = guardCreate(guard, { newEntryId: 'e1', embedding: [0.5, 0.5, 0, 0], category: 'bike' })
    const b = guardCreate(guard, { newEntryId: 'e2', embedding: [0.5, 0.5, 0, 0], category: 'bike' })
    expect(a.result).toBe('created')
    expect(b.result).toBe('merged')
    expect(b.entryId).toBe('e1') // both converge to the first
  })

  test('merge bands: ≥0.95 auto-merge (reversible); 0.88–0.95 human queue; <0.88 ignore (PLAN §7.2)', () => {
    expect(classifyPair({ a: '1', b: '2', similarity: 0.97 }).action).toBe('auto_merge')
    expect(classifyPair({ a: '1', b: '2', similarity: 0.97 }).reversible).toBe(true)
    expect(classifyPair({ a: '1', b: '2', similarity: 0.9 }).action).toBe('queue_review')
    expect(classifyPair({ a: '1', b: '2', similarity: 0.5 }).action).toBe('ignore')
  })

  test('the sweep blocks by category and only surfaces non-ignore pairs (idempotent: computes, never mutates)', async () => {
    const judge = async () => 0.96 // deterministic fake judge
    const decisions = await runDedupSweep(
      [
        { entryId: 'b1', category: 'bike', embedding: [1, 0] },
        { entryId: 'b2', category: 'bike', embedding: [1, 0] },
        { entryId: 't1', category: 'teapot', embedding: [0, 1] }, // different category → never paired with bikes
      ],
      judge,
    )
    expect(decisions).toHaveLength(1) // only the in-category bike pair
    expect(decisions[0]!.action).toBe('auto_merge')
  })

  test('exposes a Cloud-Scheduler-drivable BFF cron route (off eve’s scheduler, §22.3 S1)', () => {
    expect(DEDUP_CRON.bffRoute).toBe('/internal/cron/dedup')
  })
})

// ---------------------------------------------------------------------------
// schedules/promote — sybil-resistant promotion, structured-only, held for moderation (PLAN §7.4, §22.2/.3)
// ---------------------------------------------------------------------------
describe('schedules/promote — sybil-resistant, structured-only, moderation-held', () => {
  const owner = (id: string, deviceId: string): OwnerSignal => ({
    ownerId: id,
    deviceId,
    accountAgeDays: 30,
    deviceAttested: true,
    geoTimeDispersed: true,
  })

  test('≥N weighted distinct owners (on distinct devices) → promote, minting a pending_global draft', () => {
    const out = decidePromotion({
      clusterId: 'c1',
      category: 'bike',
      privateEntryIds: ['p1', 'p2', 'p3'],
      owners: [owner('u1', 'd1'), owner('u2', 'd2'), owner('u3', 'd3')],
      structuredFields: { make: 'Cannondale', model: 'SuperSix EVO', year: '2008' },
    })
    expect(out.promote).toBe(true)
    expect(out.draft?.visibility).toBe('pending_global') // HELD for moderation, not live
  })

  test('SYBIL GUARD: confirmations all from one device do NOT promote (reuses shared shouldPromote)', () => {
    const out = decidePromotion({
      clusterId: 'c2',
      category: 'bike',
      privateEntryIds: ['p1', 'p2'],
      owners: [owner('u1', 'same'), owner('u2', 'same')],
      structuredFields: { make: 'X' },
    })
    expect(out.promote).toBe(false)
  })

  test('STRUCTURED-FIELDS-ONLY: the minted draft never carries keys outside structuredFields (no private leak)', () => {
    const cluster = {
      clusterId: 'c3',
      category: 'bike',
      privateEntryIds: ['p1', 'p2', 'p3'],
      owners: [owner('u1', 'd1'), owner('u2', 'd2'), owner('u3', 'd3')],
      structuredFields: { make: 'Cannondale', model: 'SuperSix EVO' },
    }
    const out = decidePromotion(cluster)
    expect(out.draft).toBeDefined()
    expect(draftIsStructuredOnly(cluster, out.draft!)).toBe(true)
    expect(Object.keys(out.draft!.fields)).toEqual(['make', 'model'])
  })

  test('the sweep + Cloud-Scheduler-drivable route exist (off eve’s scheduler, §22.3 S1)', () => {
    const outs = runPromotionSweep([
      { clusterId: 'c1', category: 'bike', privateEntryIds: ['p1'], owners: [owner('u1', 'd1')], structuredFields: {} },
    ])
    expect(outs).toHaveLength(1)
    expect(PROMOTE_CRON.bffRoute).toBe('/internal/cron/promote')
  })
})
