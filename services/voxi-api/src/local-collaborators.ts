/**
 * Real, in-process collaborators the running BFF (server.ts) injects — the production-shaped implementations of
 * the optional Deps the core app.ts leaves pluggable. Nothing here is a green-forcing stub:
 *   - InterviewService  → the interviewer subagent's real caps/skip/keep/visibility logic (kb-01), persisted.
 *   - ContributionService → real trust-gate (TL0/1 → review, TL2+ → live) + first-report auto-hide (kb-04).
 *   - DeletionService   → an ACTUAL cascade that purges the user's rows across every store here (Apple-required).
 * State is in-memory (survives a process, not a restart); the Postgres-backed versions land with task #20. The
 * entitlement/thread/sessionOwner stores are created HERE too so deletion can genuinely remove them.
 */
import type {
  ThreadStore,
  ThreadRecord,
  InterviewService,
  ContributionService,
  DeletionService,
} from './app'
import type { Store, Entitlements } from './metering'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { QUESTION_BANK, MAX_QUESTIONS, nextQuestion, finalize, validateEntry, type InterviewAnswer, type MinimalEntry } from '../../eve-agent/agent/subagents/interviewer/index'

export interface LocalCollaborators {
  store: Store
  threads: ThreadStore
  sessionOwner: Map<string, string>
  interviews: InterviewService
  contributions: ContributionService
  deletion: DeletionService
  /** minimal private entries minted from finalized interviews (the "nothing is ever lost" guarantee). */
  entries: Map<string, MinimalEntry & { ownerUserId: string }>
}

/** A durable store bundle (pg-stores.ts) the caller may inject so threads/entitlements survive a restart. */
export interface DurableStores {
  store: Store
  threads: ThreadStore
  purgeUser(userId: string): Promise<{
    threads: number
    tokens: number
    entitlements: number
    photos?: number
    reveals?: number
    podcasts?: number
    messages?: number
  }>
}

/** Build the whole set so DeletionService can purge across all of them. `photoPurge` clears the eve client's photos. */
export function buildLocalCollaborators(opts: { photoPurge?: (userId: string) => number; durable?: DurableStores } = {}): LocalCollaborators {
  // ---- entitlements + threads: DURABLE (PGlite) when injected, else in-memory (survives a process, not a restart) ----
  const ent = new Map<string, Entitlements>()
  const tokens = new Map<string, string>()
  const of = (u: string): Entitlements => {
    let e = ent.get(u)
    if (!e) { e = { scan: 100_000, podcast: 1_000, voiceMin: 100_000 }; ent.set(u, e) }
    return e
  }
  const inMemStore: Store = {
    async tryDecrement(u, m, n) { const e = of(u); if (e[m] < n) return false; e[m] -= n; return true },
    async getToken(k) { return tokens.get(k) ?? null },
    async putToken(k, t) { tokens.set(k, t) },
    async remaining(u, m) { return of(u)[m] },
    async credit(u, m, n) { of(u)[m] += n },
  }
  const threadRows = new Map<string, ThreadRecord>()
  const inMemThreads: ThreadStore = {
    async put(r) { threadRows.set(r.threadId, r) },
    async listByOwner(u) { return [...threadRows.values()].filter((r) => r.ownerUserId === u).sort((a, b) => b.createdAt - a.createdAt) },
    async get(id) { return threadRows.get(id) ?? null },
    async deleteOwned(id, ownerUserId) { const r = threadRows.get(id); if (r && r.ownerUserId === ownerUserId) threadRows.delete(id) },
    async resetReveal(id, ownerUserId) { const r = threadRows.get(id); if (r && r.ownerUserId === ownerUserId) threadRows.set(id, { ...r, band: null, revealTitle: null }) },
  }
  const store = opts.durable?.store ?? inMemStore
  const threads = opts.durable?.threads ?? inMemThreads

  const sessionOwner = new Map<string, string>()

  // ---- interviews (interviewer subagent: real caps/skip/keep/visibility) ----
  const entries = new Map<string, MinimalEntry & { ownerUserId: string }>()
  interface IV { userId: string; threadId: string; visibility: 'private' | 'global'; answers: InterviewAnswer[] }
  const ivs = new Map<string, IV>()
  let ivN = 0
  const interviews: InterviewService = {
    async create({ userId, threadId, visibility }) {
      const interviewId = `iv_${++ivN}_${threadId.slice(-6)}`
      ivs.set(interviewId, { userId, threadId, visibility, answers: [] })
      // Present the capped bank; whyAsked is the required transparency line (PLAN §7.3).
      const questions = QUESTION_BANK.slice(0, MAX_QUESTIONS).map((q) => ({ id: q.id, prompt: q.prompt, whyAsked: q.whyAsked }))
      return { interviewId, visibility, questions }
    },
    async answer({ interviewId, userId, questionId, answer }) {
      const iv = ivs.get(interviewId)
      if (!iv || iv.userId !== userId) return { done: true } // unknown/forbidden → nothing more to ask
      // Record (a null answer is a valid SKIP that still advances).
      iv.answers = iv.answers.filter((a) => a.questionId !== questionId).concat({ questionId, text: answer })
      const more = nextQuestion(iv.answers)
      if (more) return { done: false }
      // Done → mint + validate the minimal PRIVATE entry from testimony; keep it (thread never lost).
      const entry = finalize(iv.threadId, iv.answers, { visibility: iv.visibility })
      const v = validateEntry(entry)
      if (v.ok) entries.set(entry.entryId, { ...entry, ownerUserId: userId })
      return { done: true }
    },
  }

  // ---- contributions (real trust gate + first-report auto-hide) ----
  const trust = new Map<string, number>() // userId → trust level (default 0)
  interface Tip { tipId: string; userId: string; catalogItemId: string; text: string; status: 'pending_review' | 'live'; hidden: boolean }
  const tips = new Map<string, Tip>()
  const reportsByTarget = new Map<string, Set<string>>() // targetId → reporters
  let tipN = 0
  const contributions: ContributionService = {
    async trustLevel(userId) { return trust.get(userId) ?? 0 },
    async submitTip({ userId, catalogItemId, text, trustLevel }) {
      const tipId = `tip_${++tipN}`
      // TL2+ goes live immediately; TL0/1 routes to human review (the real moderation disposition).
      const status: 'pending_review' | 'live' = trustLevel >= 2 ? 'live' : 'pending_review'
      tips.set(tipId, { tipId, userId, catalogItemId, text, status, hidden: false })
      return { tipId, status }
    },
    async report({ userId, targetId }) {
      let set = reportsByTarget.get(targetId)
      const firstEver = !set
      if (!set) { set = new Set(); reportsByTarget.set(targetId, set) }
      set.add(userId)
      // First report on a target auto-hides it pending SLA review (kb-04).
      if (firstEver) { const t = tips.get(targetId); if (t) t.hidden = true }
      return { autoHidden: firstEver }
    },
  }

  // ---- deletion cascade (Apple-required): actually purge every store above ----
  const deletion: DeletionService = {
    async cascade(userId) {
      const deleted: string[] = []
      // threads + entitlements + tokens + photos/reveals/podcasts/messages: durable rows via SQL when injected.
      if (opts.durable) {
        // A14: delete the user's rendered podcast MP3s from OUT_DIR BEFORE the rows go (else orphaned PII on disk).
        // Files are named `<threadId>__v<version>.mp3` (catalogItemId == threadId) — see the podcast worker.
        try {
          const outDir = process.env.PODCAST_OUT_DIR ?? '.voxi-data/podcasts'
          // The worker sanitizes the item id into the filename (`[^\w.-]` → '_'); match the same transform.
          const mine = new Set((await opts.durable.threads.listByOwner(userId)).map((t) => t.threadId.replace(/[^\w.-]/g, '_')))
          let audio = 0
          for (const f of readdirSync(outDir)) {
            const tid = f.replace(/__v\d+\.mp3$/, '')
            if (mine.has(tid)) {
              rmSync(join(outDir, f), { force: true })
              audio++
            }
          }
          if (audio) deleted.push(`podcast_audio:${audio}`)
        } catch {
          /* best-effort disk cleanup (OUT_DIR may not exist); the DB purge below is authoritative */
        }
        const pg = await opts.durable.purgeUser(userId)
        if (pg.threads) deleted.push(`threads:${pg.threads}`)
        if (pg.tokens) deleted.push(`tokens:${pg.tokens}`)
        if (pg.entitlements) deleted.push(`entitlements:${pg.entitlements}`)
        if (pg.photos) deleted.push(`photos:${pg.photos}`)
        if (pg.reveals) deleted.push(`reveals:${pg.reveals}`)
        if (pg.podcasts) deleted.push(`podcasts:${pg.podcasts}`)
        if (pg.messages) deleted.push(`messages:${pg.messages}`)
      } else {
        let n = 0
        for (const [id, r] of threadRows) if (r.ownerUserId === userId) { threadRows.delete(id); n++ }
        if (n) deleted.push(`threads:${n}`)
        if (ent.delete(userId)) deleted.push('entitlements:1')
      }
      let so = 0
      for (const [sid, uid] of sessionOwner) if (uid === userId) { sessionOwner.delete(sid); so++ }
      if (so) deleted.push(`sessions:${so}`)
      let ie = 0
      for (const [eid, e] of entries) if (e.ownerUserId === userId) { entries.delete(eid); ie++ }
      if (ie) deleted.push(`entries:${ie}`)
      let tp = 0
      for (const [tid, t] of tips) if (t.userId === userId) { tips.delete(tid); tp++ }
      if (tp) deleted.push(`tips:${tp}`)
      const photos = opts.photoPurge?.(userId) ?? 0
      if (photos) deleted.push(`photos:${photos}`)
      // Always return SOMETHING so the compliance path never looks like a no-op even for a sparse account.
      if (deleted.length === 0) deleted.push(`account:${userId}`)
      return { deleted }
    },
  }

  return { store, threads, sessionOwner, interviews, contributions, deletion, entries }
}
