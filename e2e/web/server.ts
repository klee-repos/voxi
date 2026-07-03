/**
 * Web E2E harness: serves the REAL BFF (voxi-api `createApp`) under /api and a web UI that uses the real
 * testIDs and the real NDJSON stream. This is the web reference shell the Playwright scenarios drive in the
 * sandbox; the full Expo screens replace the UI later behind the SAME testIDs (so scenarios don't change).
 *
 * Not a mock of the backend — the BFF auth, metering, session-ownership, streaming, thread persistence,
 * podcast-status proxy, interview/visibility, tip trust-gating, reports, and the /me settings surface are all
 * the production Hono routes. The only "fakes" are the injected vendor collaborators (eve stream, podcast
 * worker, trust source), and those produce DETERMINISTIC, seeded data — never a stub that forces a green.
 *
 * The eve stream's terminal outcome (REVEAL / PARTIAL / INTERVIEW / longWait / failure / safety-refusal) is
 * selected per-thread by the seeded "object" the scan was for (passed through photoUrl), so every processing
 * outcome and downstream screen is reachable and reproducible.
 */
import {
  createApp,
  type Deps,
  type ThreadRecord,
  type ThreadStore,
  type RevealStore,
  type RevealRecord,
  type RefundStore,
  type PhotoStore,
  type PodcastAssetStore,
  type PodcastAssetRecord,
  type MessageStore,
  type MessageRecord,
  type PodcastStatusService,
  type ContributionService,
  type InterviewService,
} from '../../services/voxi-api/src/app'
import { testVerifier } from '../../services/voxi-api/src/auth'
import { memoryStore, type Store, type Entitlements } from '../../services/voxi-api/src/metering'
import { NarrationStore } from '../../services/voxi-api/src/narration-store'
import type { NarrationAudioCache } from '../../services/voxi-api/src/app'
import { registerFor, type ConfidenceBand } from '../../packages/shared/src/confidence'

// ---------------------------------------------------------------------------
// Deterministic eve stream — terminal outcome chosen by the seeded object.
// ---------------------------------------------------------------------------
type Scan = 'probable' | 'confident' | 'unknown' | 'slow' | 'fail' | 'pill' | 'logobrand'

/** Parse the seeded object out of the photoUrl the client sent (e.g. "obj:unknown"); default = probable. */
function scanOf(photoUrl: string): Scan {
  const m = /obj:([a-z]+)/.exec(photoUrl)
  const v = m?.[1]
  return (['probable', 'confident', 'unknown', 'slow', 'fail', 'pill', 'logobrand'] as Scan[]).includes(v as Scan)
    ? (v as Scan)
    : 'probable'
}

/**
 * Pull a `?scan=<object>` out of the request's Referer. The REAL camera screen (converge full-app entry) has no
 * camera on web, so it POSTs a signed-URL photoUrl carrying NO `obj:` marker — every such capture would default
 * to PROBABLE. To let an agentic test steer the band/refusal through a genuine shutter tap, the harness reads the
 * seeded object off the page URL (which fetches carry as their Referer) and rewrites the photoUrl below. Returns
 * null when the Referer has no valid scan, so the mock-shell + data-URI paths are entirely unaffected.
 */
function scanFromReferer(referer: string | null): Scan | null {
  if (!referer) return null
  let v: string | null = null
  try {
    v = new URL(referer).searchParams.get('scan')
  } catch {
    return null
  }
  return (['probable', 'confident', 'unknown', 'slow', 'fail', 'pill', 'logobrand'] as Scan[]).includes(v as Scan) ? (v as Scan) : null
}

/**
 * Native Maestro tier band-steer: the real iOS binary has no browser Referer, so the app forwards its optional
 * band seed as the `X-Voxi-Test-Seed` header (set from the `voxi://e2e?seed=<band>` deep link). Same effect as the
 * Referer path — returns null (untouched, real-bytes + PROBABLE) when absent or invalid, so thumbnail-bearing
 * captures are unaffected.
 */
function scanFromHeader(seed: string | null): Scan | null {
  if (!seed) return null
  return (['probable', 'confident', 'unknown', 'slow', 'fail', 'pill', 'logobrand'] as Scan[]).includes(seed as Scan) ? (seed as Scan) : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The seeded eve NDJSON stream. Real event shapes (events.ts taxonomy); deterministic per object. */
async function* eveStreamFor(scan: Scan, sessionId: string): AsyncIterable<string> {
  if (scan === 'pill') {
    // Safety refusal path — the persona refuses to identify a regulated/medical object. NOT a confidence band.
    yield JSON.stringify({ type: 'error', index: 0, code: 'safety_refusal', message: 'I keep to objects, not medicine. I can describe the category, but I will not identify a specific pill.' })
    yield JSON.stringify({ type: 'done', index: 1, sessionId })
    return
  }
  if (scan === 'fail') {
    yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'The Guide lost the thread. Let us try that capture again.' })
    yield JSON.stringify({ type: 'done', index: 1, sessionId })
    return
  }
  if (scan === 'logobrand') {
    // Round 4 (REVEAL-WHAT-MAKER): a make+model product whose brand is a LOGO (no OCR text) → PROBABLE, but the
    // buckets are the FIXED shape: the WHAT names the category (never a bare hedge), the MAKER names the brand
    // (deriveMaker corroborated-brand lane), the PURPOSE anchors the object. This is the seeded stand-in for the real
    // Xbox reveal so the agentic E2E can prove the real screen SURFACES that content under real bucket taps.
    yield JSON.stringify({ type: 'confidence_band', index: 0, band: 'PROBABLE', title: 'Xbox Wireless Controller', candidates: ['2020 Microsoft Xbox Wireless Controller'] })
    yield JSON.stringify({ type: 'token', index: 1, text: 'This appears to be a wireless game controller, quite likely from the Xbox family of devices.' })
    const src = 'https://en.wikipedia.org/wiki/Xbox'
    yield JSON.stringify({ type: 'fact', index: 2, text: 'The Xbox console was originally called the "DirectX-box" after its graphics software.', sourceUrl: src, sourceTitle: 'Xbox', quote: 'originally called the DirectX-box' })
    yield JSON.stringify({ type: 'fact', index: 3, text: 'Bill Gates pitched the Xbox as a "Trojan horse" for Windows in the living room.', sourceUrl: src, sourceTitle: 'Xbox', quote: 'a Trojan horse for Windows in the living room' })
    yield JSON.stringify({ type: 'fact', index: 4, text: "The console's green colour came from the only marker its designer had to hand.", sourceUrl: src, sourceTitle: 'Xbox', quote: 'the green colour came from the only marker available' })
    yield JSON.stringify({ type: 'section', index: 5, bucket: 'purpose', text: 'This controller is made to play games on an Xbox console, translating a player’s hands into the game without a cable.', sourceUrl: src, sourceTitle: '', quote: 'a controller for playing games on an Xbox console' })
    yield JSON.stringify({ type: 'section', index: 6, bucket: 'maker', text: 'Branded by Microsoft, the American technology company behind the Xbox line of consoles and their controllers.', sourceUrl: src, sourceTitle: '', quote: 'Microsoft, the company behind Xbox' })
    yield JSON.stringify({ type: 'description_upgrade', index: 7, text: 'This appears to be a wireless game controller from the Xbox family — Microsoft’s gaming line.' })
    yield JSON.stringify({ type: 'done', index: 8, sessionId })
    return
  }
  if (scan === 'slow') {
    // > 8–12s wait: the stream stalls, the client shows the longWait ack, THEN a real settle arrives.
    await sleep(900) // compressed for CI; the client's longWait threshold is compressed to match.
    yield JSON.stringify({ type: 'token', index: 0, text: 'Still consulting the Guide…' })
    await sleep(300)
    yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'PROBABLE', title: 'a confident maybe', candidates: ['2007', '2008'] })
    yield JSON.stringify({ type: 'done', index: 2, sessionId })
    return
  }
  if (scan === 'confident') {
    // Phase 1 — the INSTANT reveal (band + first-pass narration), at today's latency.
    yield JSON.stringify({ type: 'token', index: 0, text: 'A 2008 Cannondale SuperSix EVO.' })
    yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'CONFIDENT', title: '2008 Cannondale SuperSix EVO', candidates: [] })
    // Phase 2 — async deep research: each VERIFIED fact streams in with its provenance (sourceUrl + verbatim quote),
    // then a richer description upgrade, THEN the deferred terminal `done`. A single monotonic index across phases.
    // Two facts share the Wikipedia page (a REAL sourceTitle → the reveal Sources list shows the page title); the
    // third cites a DISTINCT URL with NO title, exercising sourceLabel's hostname fallback (cannondale.com →
    // "Cannondale"). dedupeSources therefore yields TWO citation rows — the both-branch converge coverage.
    const src = 'https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO'
    const makerSrc = 'https://www.cannondale.com/en-us/bikes/road/supersix-evo'
    yield JSON.stringify({ type: 'fact', index: 2, text: "The SuperSix EVO is Cannondale's flagship lightweight road racing frame.", sourceUrl: src, sourceTitle: 'Cannondale SuperSix EVO', quote: "the SuperSix EVO is Cannondale's flagship lightweight road racing frame" })
    yield JSON.stringify({ type: 'fact', index: 3, text: 'Its frame is built from carbon fibre.', sourceUrl: src, sourceTitle: 'Cannondale SuperSix EVO', quote: 'the frame is built from carbon fibre' })
    yield JSON.stringify({ type: 'fact', index: 4, text: 'The EVO marks the evolution of the SuperSix platform, introduced in 2011.', sourceUrl: makerSrc, sourceTitle: '', quote: 'the EVO evolution of the SuperSix was introduced in 2011' })
    // Normalized research buckets — each SPECIFIC to THIS exact model (never the generic "what a bicycle is").
    // Sections carry a real URL but NO sourceTitle, mirroring production (cascade.ts sectionFor hardcodes '') so the
    // prose Sources row exercises the hostname fallback, not a fabricated title.
    yield JSON.stringify({ type: 'section', index: 5, bucket: 'purpose', text: 'The EVO was engineered as Cannondale’s lightest climbing frame — stiff enough to sprint on, tuned to smooth rough tarmac.', sourceUrl: src, sourceTitle: '', quote: "the SuperSix EVO is Cannondale's flagship lightweight road racing frame" })
    yield JSON.stringify({ type: 'section', index: 6, bucket: 'maker', text: 'Built by Cannondale, the Connecticut firm that made its name on oversized aluminium frames before going all-in on this carbon platform.', sourceUrl: src, sourceTitle: '', quote: 'the SuperSix EVO is Cannondale’s flagship' })
    yield JSON.stringify({ type: 'description_upgrade', index: 7, text: "A 2008 Cannondale SuperSix EVO — the marque's flagship carbon road racer, built light for the climbs and named for its evolution of the SuperSix platform." })
    yield JSON.stringify({ type: 'done', index: 8, sessionId })
    return
  }
  if (scan === 'unknown') {
    yield JSON.stringify({ type: 'token', index: 0, text: 'I have not seen this one before. Help me catalogue it.' })
    yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'UNKNOWN', title: 'not in the Guide yet', candidates: [] })
    yield JSON.stringify({ type: 'done', index: 2, sessionId })
    return
  }
  // default: PROBABLE — the catalog↔web disagreement "confident maybe", two candidates surfaced.
  yield JSON.stringify({ type: 'token', index: 0, text: 'A 2008 Cannondale SuperSix EVO… or thereabouts.' })
  yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'PROBABLE', title: 'a confident maybe', candidates: ['2007 SuperSix', '2008 SuperSix', '2009 SuperSix'] })
  // Async research at CLASS scope (hedged reveal): facts about the KIND of object, never the specific model.
  const csrc = 'https://en.wikipedia.org/wiki/Racing_bicycle'
  yield JSON.stringify({ type: 'fact', index: 2, text: 'A racing bicycle prioritises low weight and aerodynamic efficiency.', sourceUrl: csrc, sourceTitle: 'Racing bicycle', quote: 'a racing bicycle prioritises low weight and aerodynamic efficiency' })
  yield JSON.stringify({ type: 'fact', index: 3, text: 'Modern racing frames are commonly made from carbon fibre composite.', sourceUrl: csrc, sourceTitle: 'Racing bicycle', quote: 'modern racing frames are commonly made from carbon fibre composite' })
  yield JSON.stringify({ type: 'fact', index: 4, text: 'The UCI sets a minimum weight limit for road racing bicycles.', sourceUrl: csrc, sourceTitle: 'Racing bicycle', quote: 'the UCI sets a minimum weight limit for road racing bicycles' })
  // Class-scope buckets: a grounded "what it's for" (the KIND of object), but `maker` is an EMPTY-marker — at
  // PROBABLE/class scope Voxi will not name a manufacturer, so that icon shows an honest `empty`, never a guess.
  yield JSON.stringify({ type: 'section', index: 5, bucket: 'purpose', text: 'A racing bicycle is built for speed — low weight and aerodynamic efficiency.', sourceUrl: csrc, sourceTitle: 'Racing bicycle', quote: 'a racing bicycle prioritises low weight and aerodynamic efficiency' })
  yield JSON.stringify({ type: 'section', index: 6, bucket: 'maker', text: '', sourceUrl: '', sourceTitle: '', quote: '' })
  yield JSON.stringify({ type: 'done', index: 7, sessionId })
}

// ---------------------------------------------------------------------------
// In-memory production-shaped collaborators (deterministic; real ACL/trust logic).
// ---------------------------------------------------------------------------
function memThreadStore(): ThreadStore {
  const rows = new Map<string, ThreadRecord>()
  return {
    async put(rec) {
      rows.set(rec.threadId, { ...rows.get(rec.threadId), ...rec })
    },
    // Denormalize the identified label + band (A8: never touches title); flag a persisted photo.
    async applyReveal(threadId, r) {
      const row = rows.get(threadId)
      if (row) rows.set(threadId, { ...row, revealTitle: r.revealTitle, band: r.band })
    },
    async markPhoto(threadId, mime) {
      const row = rows.get(threadId)
      if (row) rows.set(threadId, { ...row, photoMime: mime })
    },
    async listByOwner(userId) {
      return [...rows.values()].filter((r) => r.ownerUserId === userId).sort((a, b) => b.createdAt - a.createdAt)
    },
    async get(threadId) {
      return rows.get(threadId) ?? null
    },
    // Item-delete cascade + regenerate denorm reset — owner-scoped, mirroring pg-stores.
    async deleteOwned(threadId, ownerUserId) {
      const r = rows.get(threadId)
      if (r && r.ownerUserId === ownerUserId) rows.delete(threadId)
    },
    async resetReveal(threadId, ownerUserId) {
      const r = rows.get(threadId)
      if (r && r.ownerUserId === ownerUserId) rows.set(threadId, { ...r, band: null, revealTitle: null })
    },
  }
}

/** Podcast worker status: a gated token reports composing, then ready, on the next poll (honest 15–40s wait). */
function memPodcastStatus(): { svc: PodcastStatusService; markComposing: (token: string, userId: string) => void } {
  const polls = new Map<string, number>() // token -> times polled
  const owners = new Map<string, string>() // token -> userId
  return {
    markComposing(token, userId) {
      // idempotent: registering an already-known token must NOT reset its poll progress.
      if (owners.has(token)) return
      owners.set(token, userId)
      polls.set(token, 0)
    },
    svc: {
      async status(token, userId) {
        if (owners.get(token) !== userId) return null // owner-scoped
        const n = (polls.get(token) ?? 0) + 1
        polls.set(token, n)
        if (n >= 2) return { state: 'ready', audioUrl: `g/podcast/${token}.m4a` }
        return { state: 'composing' }
      },
    },
  }
}

function memContributions(trust: Map<string, number>): ContributionService {
  let n = 0
  return {
    async trustLevel(userId) {
      return trust.get(userId) ?? 0
    },
    async submitTip({ trustLevel }) {
      // The trust gate is the real disposition: TL0..1 → human review; TL2+ → live.
      return { tipId: `tip_${++n}`, status: trustLevel >= 2 ? 'live' : 'pending_review' }
    },
    async report() {
      return { autoHidden: true } // first report auto-hides pending the SLA review
    },
  }
}

function memInterviews(): InterviewService {
  const visById = new Map<string, 'private' | 'global'>()
  let n = 0
  return {
    async create({ visibility }) {
      const interviewId = `iv_${++n}`
      visById.set(interviewId, visibility)
      // Capped at 2–3 questions (kb-01). whyAsked explains the model's reason (trust/transparency).
      return {
        interviewId,
        visibility,
        questions: [
          { id: 'q1', prompt: 'What is this, in your words?', whyAsked: 'I could not place it in the Guide, so you are the first witness.' },
          { id: 'q2', prompt: 'Any maker or model markings?', whyAsked: 'A badge or stamp lets me verify before I catalogue it.' },
        ],
      }
    },
    async answer() {
      return { done: false }
    },
  }
}

// ---------------------------------------------------------------------------
// The web UI — every web-testable screen behind its real testID.
// ---------------------------------------------------------------------------
const REGISTER = JSON.stringify({
  CONFIDENT: registerFor('CONFIDENT' as ConfidenceBand),
  PROBABLE: registerFor('PROBABLE' as ConfidenceBand),
  UNKNOWN: registerFor('UNKNOWN' as ConfidenceBand),
})

const HTML = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>Voxi</title>
<style>
:root{--gold:#E6B24A;--caution:#C0392B}
body{font-family:system-ui;background:#0B0B14;color:#eee;margin:0}
.screen{display:none;padding:20px 24px 96px}.screen.active{display:block}
button{padding:10px 16px;margin:6px 6px 6px 0;background:#1d1d2b;color:#eee;border:1px solid #333;border-radius:8px;cursor:pointer}
button.primary{background:var(--gold);color:#111;font-weight:600}
input,textarea{padding:8px;display:block;margin:6px 0;background:#15151f;color:#eee;border:1px solid #333;border-radius:6px;width:280px}
label{display:block;margin:6px 0}
[data-testid="reveal.confidenceChip"]{display:inline-block;padding:4px 12px;border-radius:12px;font-weight:600;background:var(--gold);color:#111}
[data-testid="global.safetyRefusal"]{display:block;padding:12px;border:2px solid var(--caution);background:#2a1414;color:#ffd7d2;border-radius:10px;margin:8px 0}
[data-testid="global.offlineBanner"]{display:none;padding:8px 12px;background:#3a2f10;color:#ffe6a8;border-bottom:1px solid var(--gold)}
[data-testid="processing.longWaitAck"],[data-testid="processing.failureState"]{display:none}
[data-testid="reveal.evidencePanel"]{display:none;border:1px solid #333;border-radius:8px;padding:10px;margin-top:8px}
[data-testid="conversation.minutesExhausted"],[data-testid="paywall.screen"]{display:none}
.tabbar{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:10px;background:#0e0e18;border-top:1px solid #222}
.tabbar button{flex:1;margin:0}
.transcriptLine{padding:6px 8px;border-radius:6px;margin:4px 0}
.transcriptLine[data-speaker="ARLO"]{background:#13202b}
.transcriptLine[data-speaker="MAVE"]{background:#231327}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid .item{border:1px solid #333;border-radius:8px;padding:10px}
.orb{width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#9ad,#247);margin:16px auto}
.muted{color:#9aa;font-size:14px}
.candidate{display:block;border:1px solid #444;border-radius:8px;padding:8px;margin:6px 0;text-align:left}
</style></head>
<body>
<div data-testid="global.offlineBanner">You are offline. The Guide will reconnect.</div>

<!-- ===================== WELCOME (LANDING — no form) ===================== -->
<div id="welcome" class="screen active" data-testid="welcome.screen">
  <div class="orb"></div>
  <h2>voxi</h2>
  <h3>What is that, exactly?</h3>
  <button class="primary" data-testid="welcome.getStarted">Get started</button>
  <button data-testid="welcome.logIn">Log in</button>
  <p class="muted">By continuing you confirm you're 16 or older and agree to Voxi's
    <span data-testid="welcome.terms">Terms</span> and <span data-testid="welcome.privacy">Privacy Policy</span>.</p>
</div>

<!-- ===================== SIGN-UP / SIGN-IN (email → code) ===================== -->
<div id="signup" class="screen" data-testid="signUp.screen">
  <h3 id="authTitle">Let's get you set up.</h3>
  <input data-testid="auth.emailInput" placeholder="email"/>
  <input data-testid="auth.codeInput" placeholder="code" style="display:none"/>
  <button class="primary" data-testid="auth.continue">Continue</button>
  <button data-testid="auth.switchLink">Log in</button>
</div>

<!-- ===================== CAMERA ===================== -->
<div id="camera" class="screen" data-testid="camera.screen">
  <h3>point at an object</h3>
  <div class="muted" id="cameraObj"></div>
  <button class="primary" data-testid="camera.shutter">◉ shutter</button>
</div>

<!-- ===================== PROCESSING ===================== -->
<div id="processing" class="screen" data-testid="processing.screen">
  <div class="orb" data-testid="processing.orb" data-state="thinking"></div>
  <p data-testid="processing.loadingLine">Consulting the Guide…</p>
  <p data-testid="processing.longWaitAck">Still with you — this one is taking a moment.</p>
  <div data-testid="processing.failureState">
    <p>The Guide lost the thread.</p>
    <button data-testid="processing.retryBtn">Try again</button>
  </div>
</div>

<!-- ===================== REVEAL ===================== -->
<div id="reveal" class="screen" data-testid="reveal.card">
  <h2 data-testid="reveal.title"></h2>
  <span data-testid="reveal.confidenceChip"></span>
  <p data-testid="reveal.quip"></p>
  <p data-testid="reveal.whatItIs"></p>
  <div data-testid="reveal.photoThumb" class="muted">[ photo ]</div>
  <div data-testid="reveal.candidateOption"></div>
  <button class="primary" data-testid="reveal.primaryAction">Generate story</button>
  <button data-testid="reveal.addTip">Add a tip</button>
  <button data-testid="reveal.howSure">How sure?</button>
  <button data-testid="reveal.correctId">That's not it</button>
  <div data-testid="reveal.evidencePanel">
    <p class="muted">Voxi cross-checked the catalog against two web sources before settling.</p>
  </div>
  <span data-testid="reveal.generateStory" style="display:none"></span>
  <span data-testid="reveal.askVoxi" style="display:none"></span>
</div>

<!-- ===================== PODCAST ===================== -->
<div id="podcast" class="screen" data-testid="podcast.player">
  <div data-testid="podcast.cover" class="muted">[ cover art ]</div>
  <p data-testid="podcast.composingState">Composing — Arlo and Mave are reading up…</p>
  <audio data-testid="podcast.audio" style="display:none"></audio>
  <button data-testid="podcast.playPause" disabled>▶︎ play</button>
  <button data-testid="podcast.skip15">»15s</button>
  <button data-testid="podcast.reportEpisode">Report episode</button>
  <div id="transcript"></div>
</div>

<!-- ===================== CONVERSATION ===================== -->
<div id="conversation" class="screen" data-testid="conversation.orb">
  <div class="orb" data-testid="conversation.orbVisual" data-state="idle"></div>
  <button data-testid="conversation.micButton">🎙 hold to talk</button>
  <span data-testid="conversation.liveMicIndicator" style="display:none">● live</span>
  <button data-testid="conversation.keyboardToggle">⌨︎ keyboard</button>
  <input data-testid="conversation.textInput" placeholder="type to Voxi" style="display:none"/>
  <button data-testid="conversation.sendBtn" style="display:none">send</button>
  <div data-testid="conversation.voxiTurn" class="muted"></div>
  <div data-testid="conversation.transcriptText" class="muted"></div>
  <div data-testid="conversation.minutesExhausted">
    <p>That's the last of your voice minutes for now.</p>
    <button class="primary" data-testid="conversation.toPaywall">See plans</button>
  </div>
</div>

<!-- ===================== THREADS ===================== -->
<div id="threads" class="screen" data-testid="threads.screen">
  <h3>Your collection</h3>
  <div data-testid="threads.emptyState">
    <p>0 of ∞ — the Guide is empty until you capture something. Use Capture below.</p>
  </div>
  <div data-testid="threads.grid" class="grid"></div>
</div>

<!-- ===================== INTERVIEW ===================== -->
<div id="interview" class="screen" data-testid="interview.screen">
  <h3>First witness</h3>
  <p data-testid="interview.question"></p>
  <p data-testid="interview.whyAsked" class="muted"></p>
  <input data-testid="interview.answerInput" placeholder="your answer"/>
  <label><input type="checkbox" data-testid="interview.visibilityToggle"/> <span id="visLabel">Private (only you)</span></label>
  <button data-testid="interview.skip">Skip</button>
  <button class="primary" id="interviewNext">Next</button>
</div>

<!-- ===================== CONTRIBUTE ===================== -->
<div id="contribute" class="screen" data-testid="contribute.screen">
  <h3>Add a tip</h3>
  <textarea data-testid="contribute.tipInput" placeholder="what do you know about this?"></textarea>
  <button class="primary" data-testid="contribute.submit">Submit tip</button>
  <p data-testid="contribute.statusBanner" class="muted"></p>
  <button data-testid="contribute.reportBtn">Report this entry</button>
</div>

<!-- ===================== PAYWALL ===================== -->
<div id="paywall" class="screen" data-testid="paywall.screen">
  <p data-testid="paywall.limitMessage">The Guide is vast; you've seen your free entries this month.</p>
  <button class="primary" data-testid="paywall.subscribeBtn">Subscribe</button>
  <button data-testid="paywall.restoreBtn">Restore purchases</button>
</div>

<!-- ===================== SETTINGS ===================== -->
<div id="settings" class="screen" data-testid="settings.screen">
  <h3>Settings</h3>
  <p data-testid="settings.subscriptionStatus" class="muted"></p>
  <p data-testid="settings.privacyNoFaceRecognition" class="muted">Voxi never runs face recognition. Faces and plates are redacted before anything is stored.</p>
  <label><input type="checkbox" data-testid="settings.reduceMotion"/> Reduce motion</label>
  <button data-testid="settings.signOut">Sign out</button>
  <button data-testid="settings.deleteAccount">Delete account</button>
</div>

<!-- ===================== TAB BAR ===================== -->
<div class="tabbar" id="tabbar" style="display:none">
  <button class="primary" data-testid="threads.captureCta">Capture</button>
  <button data-testid="nav.threadsTab">Collection</button>
  <button data-testid="nav.settingsTab">Settings</button>
</div>

<script>
const $=s=>document.querySelector(s);const $$=s=>Array.from(document.querySelectorAll(s));
const REGISTER=${REGISTER};
let token=null,otpShown=false,lastThreadId=null,lastBand=null,genToken=null;
const params=new URLSearchParams(location.search);
const scanObj=params.get('scan')||'probable';
const startScreen=(location.hash||'').replace('#/','');
const authHdr=()=>({'authorization':'Bearer '+token,'content-type':'application/json'});

const show=id=>{
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id));
  $('#tabbar').style.display=token?'flex':'none';
};

// ---- landing → sign-up/sign-in (email → code, no checkboxes) ----
$('[data-testid="welcome.getStarted"]').onclick=()=>{show('signup');};
$('[data-testid="welcome.logIn"]').onclick=()=>{show('signup');};
$('[data-testid="auth.continue"]').onclick=()=>{
  if(!otpShown){
    if(!$('[data-testid="auth.emailInput"]').value)return;
    $('[data-testid="auth.codeInput"]').style.display='block';otpShown=true;return;
  }
  const email=$('[data-testid="auth.emailInput"]').value;token='test:'+email.split('@')[0];
  $('#cameraObj').textContent='(seeded object: '+scanObj+')';
  if(startScreen)route(startScreen);else show('camera');
};
$('[data-testid="settings.signOut"]').onclick=()=>{token=null;otpShown=false;$('[data-testid="auth.codeInput"]').style.display='none';show('welcome');};

// ---- scan → processing → terminal outcome ----
async function scan(){
  show('processing');
  $('[data-testid="processing.longWaitAck"]').style.display='none';
  $('[data-testid="processing.failureState"]').style.display='none';
  $('[data-testid="processing.orb"]').setAttribute('data-state','thinking');
  const r=await fetch('/api/v1/threads',{method:'POST',headers:authHdr(),body:JSON.stringify({photoUrl:'obj:'+scanObj,title:'Capture · '+scanObj})});
  if(r.status===402){show('paywall');return;}
  const {threadId}=await r.json();lastThreadId=threadId;
  $('[data-testid="reveal.card"]').setAttribute('data-thread.id',threadId);
  // long-wait watchdog (compressed): if no settle within 600ms, acknowledge in-persona.
  const watch=setTimeout(()=>{$('[data-testid="processing.longWaitAck"]').style.display='block';},600);
  let settled=false;
  try{
    const s=await fetch('/api/v1/threads/'+threadId+'/stream',{headers:{'authorization':'Bearer '+token}});
    const reader=s.body.getReader();const dec=new TextDecoder();let buf='';
    for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value);let i;
      while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;const e=JSON.parse(line);
        if(e.type==='token')$('[data-testid="reveal.whatItIs"]').textContent=e.text;
        if(e.type==='confidence_band'){settled=true;applyBand(e);}
        if(e.type==='error'){settled=true;clearTimeout(watch);
          if(e.code==='safety_refusal'){renderSafetyRefusal(e.message);return;}
          $('[data-testid="processing.failureState"]').style.display='block';
          $('[data-testid="processing.orb"]').setAttribute('data-state','uncertain');return;}
      }}
  }catch(err){clearTimeout(watch);$('[data-testid="processing.failureState"]').style.display='block';return;}
  clearTimeout(watch);
  if(!settled){$('[data-testid="processing.failureState"]').style.display='block';return;}
}
function applyBand(e){
  lastBand=e.band;
  const reg=REGISTER[e.band];
  // INTERVIEW route: UNKNOWN settles into the interview, not a reveal card.
  if(e.band==='UNKNOWN'){openInterview();return;}
  $('[data-testid="reveal.title"]').textContent=e.title;
  const c=$('[data-testid="reveal.confidenceChip"]');c.textContent=reg.chipLabel;c.setAttribute('data-band',e.band);
  $('[data-testid="reveal.quip"]').textContent=reg.hedge?'…or thereabouts. I will commit if you confirm.':'Identified.';
  // candidates (real disagreement → multiple options)
  const cand=$('[data-testid="reveal.candidateOption"]');cand.innerHTML='';cand.setAttribute('data-count',String(e.candidates.length));
  e.candidates.forEach(name=>{const b=document.createElement('button');b.className='candidate';b.setAttribute('data-testid','reveal.candidateOption');b.textContent=name;cand.appendChild(b);});
  if(e.candidates.length===0)cand.style.display='none';else cand.style.display='block';
  // "How sure?" hidden when CONFIDENT; auto-elevated otherwise.
  $('[data-testid="reveal.howSure"]').style.display=(e.band==='CONFIDENT')?'none':'inline-block';
  $('[data-testid="reveal.evidencePanel"]').style.display='none';
  show('reveal');
}
function renderSafetyRefusal(msg){
  // distinct from the confidence chip (caution red border, never the gold chip).
  $('[data-testid="reveal.title"]').textContent='I can describe the category — not identify it.';
  const chip=$('[data-testid="reveal.confidenceChip"]');chip.textContent='';chip.removeAttribute('data-band');chip.style.display='none';
  let r=$('[data-testid="global.safetyRefusal"]');
  if(!r){r=document.createElement('div');r.setAttribute('data-testid','global.safetyRefusal');$('#reveal').prepend(r);}
  r.textContent=msg;r.style.display='block';
  $('[data-testid="reveal.candidateOption"]').style.display='none';
  $('[data-testid="reveal.howSure"]').style.display='none';
  show('reveal');
}
$('[data-testid="camera.shutter"]').onclick=scan;
$('[data-testid="processing.retryBtn"]').onclick=scan;
$('[data-testid="reveal.howSure"]').onclick=()=>{$('[data-testid="reveal.evidencePanel"]').style.display='block';};
$('[data-testid="reveal.correctId"]').onclick=()=>route('contribute');

// ---- threads / collection ----
async function loadThreads(){
  const r=await fetch('/api/v1/threads',{headers:authHdr()});const {threads}=await r.json();
  const grid=$('[data-testid="threads.grid"]');grid.innerHTML='';
  if(!threads.length){$('[data-testid="threads.emptyState"]').style.display='block';grid.style.display='none';return;}
  $('[data-testid="threads.emptyState"]').style.display='none';grid.style.display='grid';
  threads.forEach(t=>{const d=document.createElement('button');d.className='item';d.setAttribute('data-testid','threads.item');d.setAttribute('data-thread.id',t.threadId);d.textContent=t.title;d.onclick=()=>revisit(t.threadId);grid.appendChild(d);});
}
async function revisit(id){
  const r=await fetch('/api/v1/threads/'+id,{headers:authHdr()});
  if(r.status!==200)return;const t=await r.json();
  $('[data-testid="reveal.title"]').textContent=t.title;
  $('[data-testid="reveal.card"]').setAttribute('data-thread.id',t.threadId);
  $('[data-testid="reveal.card"]').setAttribute('data-resumes',String(t.resumes));
  lastThreadId=id;show('reveal');
}
$('[data-testid="nav.threadsTab"]').onclick=()=>{loadThreads();show('threads');};

// ---- podcast ----
async function openPodcast(){
  show('podcast');
  $('[data-testid="podcast.composingState"]').style.display='block';
  $('[data-testid="podcast.playPause"]').disabled=true;$('[data-testid="podcast.playPause"]').textContent='▶︎ play';
  $('#transcript').innerHTML='';
  // 1) gate the paid generation (real atomic decrement + idempotent token)
  const g=await fetch('/api/v1/podcast',{method:'POST',headers:authHdr(),body:JSON.stringify({catalogItemId:lastThreadId||'c1',version:1})});
  if(g.status===402){show('paywall');return;}
  genToken=(await g.json()).token;
  // 2) poll the worker status until ready (composing → ready) — honest wait, BFF never fabricates ready.
  for(let i=0;i<6;i++){
    const s=await fetch('/api/v1/podcast/'+genToken,{headers:authHdr()});const st=await s.json();
    if(st.state==='ready'){renderEpisode(st.audioUrl);return;}
    await new Promise(r=>setTimeout(r,120));
  }
}
function renderEpisode(audioUrl){
  $('[data-testid="podcast.composingState"]').style.display='none';
  $('[data-testid="podcast.playPause"]').disabled=false;
  const lines=[['ARLO','So — a Cannondale SuperSix, circa 2008.'],['MAVE','A confident maybe on the year. The frame is carbon, that part we can ground.'],['ARLO','We will not pin a spec we cannot cite.']];
  const t=$('#transcript');t.innerHTML='';
  lines.forEach((l,idx)=>{const p=document.createElement('p');p.className='transcriptLine';p.setAttribute('data-testid','podcast.transcriptLine');p.setAttribute('data-speaker',l[0]);p.textContent=l[0]+': '+l[1];t.appendChild(p);});
  // real, advancing audio so expect.playing() (currentTime increases) can pass: a tiny silent WAV data URI.
  const a=$('[data-testid="podcast.audio"]');a.src=SILENT_WAV;
  $('[data-testid="podcast.playPause"]').onclick=()=>{const a=$('[data-testid="podcast.audio"]');if(a.paused){a.play();$('[data-testid="podcast.playPause"]').textContent='⏸ pause';}else{a.pause();$('[data-testid="podcast.playPause"]').textContent='▶︎ play';}};
}
$('[data-testid="reveal.primaryAction"]').onclick=openPodcast;
$('[data-testid="podcast.reportEpisode"]').onclick=async()=>{await fetch('/api/v1/reports',{method:'POST',headers:authHdr(),body:JSON.stringify({targetId:genToken||'ep1',kind:'episode'})});$('[data-testid="podcast.composingState"]').textContent='Episode reported — pulled pending review.';$('[data-testid="podcast.composingState"]').style.display='block';};

// ---- conversation ----
$('[data-testid="reveal.askVoxi"]')&&($('[data-testid="reveal.askVoxi"]').onclick=()=>route('conversation'));
function openConversation(){
  show('conversation');
  $('[data-testid="conversation.voxiTurn"]').textContent='';
  $('[data-testid="conversation.transcriptText"]').textContent='';
}
$('[data-testid="conversation.keyboardToggle"]').onclick=()=>{
  const ti=$('[data-testid="conversation.textInput"]');const sb=$('[data-testid="conversation.sendBtn"]');
  const on=ti.style.display==='none';ti.style.display=on?'block':'none';sb.style.display=on?'inline-block':'none';
  $('[data-testid="conversation.micButton"]').style.display=on?'none':'inline-block';
};
$('[data-testid="conversation.micButton"]').onmousedown=()=>{$('[data-testid="conversation.liveMicIndicator"]').style.display='inline';$('[data-testid="conversation.orbVisual"]').setAttribute('data-state','listening');};
$('[data-testid="conversation.micButton"]').onmouseup=()=>{$('[data-testid="conversation.liveMicIndicator"]').style.display='none';$('[data-testid="conversation.orbVisual"]').setAttribute('data-state','speaking');voxiReply('You held the mic; on iOS this round-trips real voice.');};
$('[data-testid="conversation.sendBtn"]').onclick=()=>{const v=$('[data-testid="conversation.textInput"]').value;voxiReply('You said: '+v);};
function voxiReply(text){
  // every spoken turn ALSO writes a text transcript (a11y/caption path).
  $('[data-testid="conversation.voxiTurn"]').textContent='Voxi: a grounded reply.';
  $('[data-testid="conversation.transcriptText"]').textContent=text;
}
$('[data-testid="conversation.toPaywall"]').onclick=()=>show('paywall');

// ---- interview ----
let interviewId=null,questions=[],qi=0;
async function openInterview(){
  const r=await fetch('/api/v1/interview',{method:'POST',headers:authHdr(),body:JSON.stringify({threadId:lastThreadId})});
  const data=await r.json();interviewId=data.interviewId;questions=data.questions;qi=0;
  // visibility DEFAULTS to private.
  $('[data-testid="interview.visibilityToggle"]').checked=(data.visibility==='global');
  renderQuestion();show('interview');
}
function renderQuestion(){
  const q=questions[qi];if(!q){route('threads');return;}
  $('[data-testid="interview.question"]').textContent=q.prompt;
  $('[data-testid="interview.whyAsked"]').textContent='Why I ask: '+q.whyAsked;
  $('[data-testid="interview.answerInput"]').value='';
}
$('[data-testid="interview.visibilityToggle"]').onchange=e=>{$('#visLabel').textContent=e.target.checked?'Global (shared exemplar)':'Private (only you)';};
async function advance(answer){
  const q=questions[qi];await fetch('/api/v1/interview/'+interviewId+'/answer',{method:'POST',headers:authHdr(),body:JSON.stringify({questionId:q.id,answer})});
  qi++;renderQuestion();
}
$('#interviewNext').onclick=()=>advance($('[data-testid="interview.answerInput"]').value);
$('[data-testid="interview.skip"]').onclick=()=>advance(null);

// ---- contribute ----
function openContribute(){show('contribute');$('[data-testid="contribute.statusBanner"]').textContent='';}
$('[data-testid="reveal.addTip"]').onclick=openContribute;
$('[data-testid="contribute.submit"]').onclick=async()=>{
  const text=$('[data-testid="contribute.tipInput"]').value;
  const r=await fetch('/api/v1/tips',{method:'POST',headers:authHdr(),body:JSON.stringify({catalogItemId:lastThreadId||'c1',text})});
  const d=await r.json();
  const banner=$('[data-testid="contribute.statusBanner"]');
  banner.setAttribute('data-status',d.status);banner.setAttribute('data-trust',String(d.trustLevel));
  banner.textContent=d.status==='live'?'Live now — thanks for the tip.':'A moderator will review this before it goes live.';
};
$('[data-testid="contribute.reportBtn"]').onclick=async()=>{await fetch('/api/v1/reports',{method:'POST',headers:authHdr(),body:JSON.stringify({targetId:lastThreadId||'c1',kind:'tip'})});$('[data-testid="contribute.statusBanner"]').textContent='Reported — hidden pending review.';};

// ---- settings ----
async function openSettings(){
  const r=await fetch('/api/v1/me',{headers:authHdr()});const me=await r.json();
  $('[data-testid="settings.subscriptionStatus"]').textContent='Plan: '+me.plan+' · scans left: '+me.remaining.scan+' · voice min: '+me.remaining.voiceMin;
  $('[data-testid="settings.subscriptionStatus"]').setAttribute('data-plan',me.plan);
  show('settings');
}
$('[data-testid="nav.settingsTab"]').onclick=openSettings;
$('[data-testid="settings.reduceMotion"]').onchange=e=>{document.body.setAttribute('data-reduce-motion',String(e.target.checked));};
$('[data-testid="settings.deleteAccount"]').onclick=async()=>{await fetch('/api/v1/account',{method:'DELETE',headers:authHdr()});token=null;show('welcome');};
$('[data-testid="threads.captureCta"]').onclick=()=>show('camera');

// offline banner reflects real connectivity (driver.setNetwork toggles navigator.onLine).
function reflectNet(){$('[data-testid="global.offlineBanner"]').style.display=navigator.onLine?'none':'block';}
window.addEventListener('online',reflectNet);window.addEventListener('offline',reflectNet);reflectNet();

// hash router for direct navigation to any screen (post-auth).
function route(name){
  if(name==='podcast')return openPodcast();
  if(name==='conversation')return openConversation();
  if(name==='contribute')return openContribute();
  if(name==='interview')return openInterview();
  if(name==='settings')return openSettings();
  if(name==='threads'){loadThreads();return show('threads');}
  if(name==='camera')return show('camera');
  show(name);
}

// a tiny valid silent WAV (44 bytes header + a few samples) so the <audio> element can actually advance.
const SILENT_WAV='data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgIA=';
</script></body></html>`

// ---------------------------------------------------------------------------
// Harness wiring — real BFF + deterministic collaborators.
// ---------------------------------------------------------------------------
export interface HarnessOpts {
  /** per-user entitlements (defaults: qa = 1 scan, 1 podcast, 10 voice min). */
  seed?: Record<string, Entitlements>
  /** per-user trust level for the contribution gate (defaults to 0). */
  trust?: Record<string, number>
  /** per-user plan label for the settings surface. */
  plans?: Record<string, 'free' | 'explorer' | 'voyager'>
  /** wire the spoken-reveal /speech route with a deterministic FakeTts (default true; set false for the negative control). */
  speech?: boolean
  /** opt in to the Sentry envelope sink + same-origin DSN injection (standUp). Off for every other runner. */
  sentry?: boolean
}

/**
 * A genuinely valid, tiny MP3 (≈1s of silence: MPEG-1 Layer III, 128 kbps, 44.1 kHz frames) so the FakeTts emits
 * the SAME `audio/mpeg` content-type the real ElevenLabs route returns — the deterministic E2E asserts real
 * playback (the browser decodes it and `currentTime` advances), not a stubbed WAV that would diverge from prod.
 */
function tinyMp3(): Uint8Array<ArrayBuffer> {
  const FRAME = 417 // 144 * 128000 / 44100, no padding
  const frames = 40 // ~1.0s (40 × 26.12 ms)
  const buf = new Uint8Array(FRAME * frames)
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME
    buf[o] = 0xff // frame sync
    buf[o + 1] = 0xfb // MPEG-1, Layer III, no CRC
    buf[o + 2] = 0x90 // 128 kbps, 44.1 kHz, no padding
    buf[o + 3] = 0x00 // stereo, no emphasis — remaining bytes stay 0 (silence)
  }
  return buf as Uint8Array<ArrayBuffer>
}

export function createWebHarness(
  seedOrOpts?: Record<string, Entitlements> | HarnessOpts,
): {
  fetch: (req: Request) => Promise<Response>
  store: Store
  sessionOwner: Map<string, string>
  evict: (threadId: string) => void
  /** Raw Sentry envelope bodies the app's SDK POSTed to the same-origin DSN (the local sink). */
  sentryEnvelopes: () => string[]
  resetSentry: () => void
} {
  process.env.VOXI_TEST_MODE = '1'
  // Local Sentry ingest sink: the app's @sentry/browser POSTs envelopes to /api/<projectId>/envelope/ (derived
  // from the injected same-origin DSN). We record the raw text so a runner can assert capture + redaction — no
  // network, no real project. This MUST be intercepted before the /api-strip-and-forward below or it hits the BFF.
  const sentryEnvelopeStore: string[] = []
  const opts: HarnessOpts =
    seedOrOpts &&
    ('seed' in seedOrOpts ||
      'trust' in seedOrOpts ||
      'plans' in seedOrOpts ||
      'speech' in seedOrOpts ||
      'sentry' in seedOrOpts)
      ? (seedOrOpts as HarnessOpts)
      : { seed: seedOrOpts as Record<string, Entitlements> | undefined }

  const store = memoryStore(opts.seed ?? { qa: { scan: 1, podcast: 1, voiceMin: 10 } })
  let sessionSeq = 0
  const podcast = memPodcastStatus()
  const trust = new Map<string, number>(Object.entries(opts.trust ?? {}))
  const plans = new Map<string, 'free' | 'explorer' | 'voyager'>(Object.entries(opts.plans ?? {}))
  const narrations = new NarrationStore() // server-owned reveal narration for /speech (idempotent capture)
  // Deterministic spoken-reveal seam: a FakeTts returning a real tiny MP3 + an in-memory content-hash cache.
  const audioStore = new Map<string, Uint8Array<ArrayBuffer>>()
  const speechCache: NarrationAudioCache = {
    async get(k) { return audioStore.get(k) ?? null },
    async put(k, b) { audioStore.set(k, b) },
  }
  const speech = opts.speech === false ? undefined : { tts: { async synthesize(_t: string) { return tinyMp3() } }, cache: speechCache }

  // Ownership map + LIVE-session set. A "restart" (evict, below) drops both for a thread, exactly like the
  // assembled server: the durable rows (threads/reveals) survive, the in-memory session/photo does not.
  const sessionOwner = new Map<string, string>()
  const liveSessions = new Set<string>()
  // Durable reveal + once-ever refund stores (in-memory here; PGlite-backed in services/voxi-api/src/server.ts).
  const revealRows = new Map<string, RevealRecord>()
  const reveals: RevealStore = {
    async put(rec) {
      if (revealRows.has(rec.threadId)) return { inserted: false } // first-write-wins (pinned)
      revealRows.set(rec.threadId, rec)
      return { inserted: true }
    },
    async get(id) {
      return revealRows.get(id) ?? null
    },
    async delete(id) { revealRows.delete(id) }, // item-delete / regenerate (unblocks first-write-wins re-pin)
  }
  const refundedSet = new Set<string>()
  const refunds: RefundStore = {
    async markRefunded(id) { if (refundedSet.has(id)) return false; refundedSet.add(id); return true },
    async delete(id) { refundedSet.delete(id) },
  }
  // Durable photo/podcast/conversation stores (in-memory here; PGlite-backed in the assembled server). Harmless
  // for the deterministic runners: they send `obj:<x>` (not data: URIs) so no photo is stored, and they never
  // touch the messages routes; the podcast gate/poll transitions are unchanged (composing → ready).
  const photoRows = new Map<string, { ownerUserId: string; mime: string; bytes: Uint8Array }>()
  const photos: PhotoStore = {
    async put(rec) { photoRows.set(rec.threadId, { ownerUserId: rec.ownerUserId, mime: rec.mime, bytes: rec.bytes }) },
    async get(id) { return photoRows.get(id) ?? null },
    async has(id) { return photoRows.has(id) },
    async delete(id) { photoRows.delete(id) },
  }
  const podcastRows = new Map<string, PodcastAssetRecord>()
  const podcasts: PodcastAssetStore = {
    async upsert(rec) { podcastRows.set(rec.token, rec) },
    async getByToken(t, u) { const a = podcastRows.get(t); return a && a.userId === u ? a : null },
    async getByItem(item, v, u) { return [...podcastRows.values()].find((a) => a.catalogItemId === item && a.version === v && a.userId === u) ?? null },
    async deleteByItem(item, u) { for (const [k, a] of podcastRows) if (a.catalogItemId === item && a.userId === u) podcastRows.delete(k) },
  }
  const messageRows: MessageRecord[] = []
  const messages: MessageStore = {
    async append(rec) {
      if (rec.clientKey != null) {
        const ex = messageRows.find((m) => m.threadId === rec.threadId && m.clientKey === rec.clientKey)
        if (ex) return { id: ex.id, duplicate: true }
      }
      const id = `msg_${messageRows.length + 1}`
      messageRows.push({ id, threadId: rec.threadId, userId: rec.userId, role: rec.role, text: rec.text, source: rec.source ?? 'text', clientKey: rec.clientKey ?? null, createdAt: Date.now() + messageRows.length })
      return { id, duplicate: false }
    },
    async listByThread(id) { return messageRows.filter((m) => m.threadId === id).sort((a, b) => a.createdAt - b.createdAt) },
    async deleteByThread(id) { for (let i = messageRows.length - 1; i >= 0; i--) if (messageRows[i]!.threadId === id) messageRows.splice(i, 1) },
  }

  const deps: Deps = {
    verifier: testVerifier,
    store,
    eve: {
      async createSession({ userId, photoUrl }) {
        // The terminal outcome is fixed at session creation by the seeded object (carried in photoUrl).
        // A monotonic suffix guarantees uniqueness even for two captures within the same millisecond.
        const scan = scanOf(photoUrl)
        const sessionId = `sess_${userId}_${scan}_${(sessionSeq++).toString(36)}`
        liveSessions.add(sessionId) // the live in-memory session/photo — dropped by evict() to model a restart
        return { sessionId, continuationToken: 'ct' }
      },
      async *stream(sessionId) {
        // A restart evicted the live session/photo: with no persisted reveal to replay, this is the honest
        // "session expired" degradation the route surfaces in-persona — NEVER a 403 (that was the bug).
        if (!liveSessions.has(sessionId)) {
          yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'session expired — capture again' })
          yield JSON.stringify({ type: 'done', index: 1, sessionId })
          return
        }
        // Recover the seeded object from the sessionId so the stream is deterministic + replayable.
        const scan = (/_([a-z]+)_[a-z0-9]+$/.exec(sessionId)?.[1] as Scan) ?? 'probable'
        // Capture the per-BUCKET narration server-side (same idempotent NarrationStore the prod client uses), tapped
        // off the stream as it passes, so /speech/:bucket voices exactly what each reveal bucket showed (ANALYSIS-UX).
        const captured: string[] = []
        const factTexts: string[] = []
        for await (const line of eveStreamFor(scan, sessionId)) {
          try {
            const ev = JSON.parse(line) as { type?: string; text?: string; bucket?: string }
            if (ev.type === 'token' && typeof ev.text === 'string') captured.push(ev.text)
            if (ev.type === 'section' && ev.text && (ev.bucket === 'purpose' || ev.bucket === 'maker')) narrations.capture(sessionId, ev.bucket, ev.text)
            if (ev.type === 'fact' && typeof ev.text === 'string') factTexts.push(ev.text)
            if (ev.type === 'done' && factTexts.length) narrations.capture(sessionId, 'facts', factTexts.join(' '))
          } catch {
            /* non-JSON line — pass through */
          }
          yield line
        }
        narrations.capture(sessionId, 'what', captured.join(' '))
      },
      async narrationText(sessionId, userId, bucket) {
        return narrations.get(sessionId, userId, bucket ?? 'what')
      },
      // Item-delete: drop the live session (models purging the in-process photo) + its pinned narration.
      purgeSession(sessionId) { liveSessions.delete(sessionId); narrations.purgeSession(sessionId) },
      // Regenerate: RE-ADD the live session (models re-seeding the photo so a cold re-stream re-settles instead of
      // "session expired") + clear the pinned narration so the fresh run re-pins. (photoUrl unused — the harness
      // recovers the seeded object from the sessionId, so re-adding the session is the analog of re-seeding bytes.)
      primeSession(sessionId) { liveSessions.add(sessionId); narrations.purgeSession(sessionId) },
    },
    deletion: {
      async cascade(userId) {
        return { deleted: [`photos:${userId}`, `embeddings:${userId}`, `sessions:${userId}`, `contributions:${userId}`] }
      },
    },
    bucket: 'voxi-photos',
    sessionOwner,
    threads: memThreadStore(),
    reveals, // durable reveal projection → GET /stream replays it after a restart (COLLECTION-PERSISTENCE)
    refunds, // once-ever scan refund guard (survives the "restart")
    photos, // captured-photo bytes → served via the signed /media route (thumbnails on the collection grid)
    podcasts, // the item's durable podcast episode (owner-scoped)
    messages, // durable conversation history (idempotent single writer)
    contributions: memContributions(trust),
    interviews: memInterviews(),
    planFor: async (userId) => plans.get(userId) ?? 'free',
    podcastStatus: {
      async status(token, userId) {
        // first gate ever seen for this token registers it as composing for the owner.
        podcast.markComposing(token, userId)
        return podcast.svc.status(token, userId)
      },
    },
    speech, // spoken reveal: FakeTts + content-hash cache (undefined when opts.speech === false → route 503s)
  }

  // Wrap /v1/podcast so a freshly gated token is registered with the worker-status service for the owner.
  const app = createApp(deps)

  return {
    store,
    sessionOwner,
    /** Simulate a BFF restart for ONE thread: drop the in-memory ownership + live session; durable rows remain. */
    evict(threadId: string) {
      liveSessions.delete(threadId)
      sessionOwner.delete(threadId)
    },
    sentryEnvelopes: () => sentryEnvelopeStore,
    resetSentry: () => {
      sentryEnvelopeStore.length = 0
    },
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      if (url.pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html' } })
      // Sentry envelope sink — FIRST, before the /api strip-and-forward, so envelopes are captured here instead of
      // 404ing against the BFF (a mis-order would leave the sink empty = a false "no error captured" green).
      if (/^\/api\/[^/]+\/envelope\/?$/.test(url.pathname)) {
        sentryEnvelopeStore.push(await req.text())
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.startsWith('/api/')) {
        let forward = req
        // Band-steering for the REAL camera: a shutter tap POSTs a signed-URL photoUrl (no `obj:` marker); if the
        // page was opened with `?scan=<object>` (carried on the Referer), seed that object so a genuine capture can
        // reach any band/refusal. Untouched for the mock shell + data-URI captures (they already carry `obj:`/bytes).
        if (url.pathname === '/api/v1/threads' && req.method === 'POST' && (req.headers.get('content-type') ?? '').includes('application/json')) {
          const scan = scanFromReferer(req.headers.get('referer')) ?? scanFromHeader(req.headers.get('x-voxi-test-seed'))
          if (scan) {
            const raw = await req.text()
            let body: { photoUrl?: unknown } | null = null
            try {
              body = JSON.parse(raw) as { photoUrl?: unknown }
            } catch {
              body = null
            }
            if (body && typeof body.photoUrl === 'string' && !/obj:/.test(body.photoUrl)) {
              body.photoUrl = `obj:${scan}`
              forward = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body) })
            } else {
              forward = new Request(req.url, { method: 'POST', headers: req.headers, body: raw })
            }
          }
        }
        const stripped = new Request(url.origin + url.pathname.slice('/api'.length) + url.search, forward)
        const res = await app.fetch(stripped)
        // Mirror a successful podcast gate into the status service so the next poll can transition.
        if (url.pathname === '/api/v1/podcast' && res.status === 200) {
          const clone = res.clone()
          const body = await clone.json().catch(() => null)
          const userId = req.headers.get('authorization')?.replace(/^Bearer test:/, '') ?? ''
          if (body?.token && userId) podcast.markComposing(body.token, userId)
        }
        return res
      }
      return new Response('not found', { status: 404 })
    },
  }
}
