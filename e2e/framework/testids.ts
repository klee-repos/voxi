/**
 * Single source of truth for every interactive selector in the app.
 *
 * Both the app (via `accessibilityLabel` / `testID`) and every E2E scenario import these constants, so a
 * rename is one edit and selectors can never silently drift. Committed scenarios may ONLY locate elements
 * by these ids (coordinate taps are lint-banned) — that is the "no brittle/cheating selectors" guarantee.
 *
 * Convention: `screen.element`, lowerCamel, stable across redesigns. New screens append; never renumber.
 */
export const ids = {
  // welcome is now the LANDING (no form): brand + value prop + Get started / Log in + legal microcopy.
  welcome: {
    screen: 'welcome.screen',
    getStarted: 'welcome.getStarted', // green primary → /sign-up
    logIn: 'welcome.logIn', // blue link → /sign-in
    terms: 'welcome.terms', // legal microcopy link
    privacy: 'welcome.privacy',
    // @deprecated — the combined email/OTP/consent controls moved to /sign-up + /sign-in (see `auth`). These ids
    // are RETAINED as vocabulary so the legacy hardware-only Maestro flows + non-CI web scenarios that still
    // reference them stay lint- and tsc-valid; the app renders none of them on the landing.
    emailInput: 'welcome.emailInput',
    continueBtn: 'welcome.continueBtn',
    otpInput: 'welcome.otpInput',
    eulaAccept: 'welcome.eulaAccept',
    ageConfirm: 'welcome.ageConfirm',
  },
  // Separated account creation (/sign-up) vs login (/sign-in). Both are email→code; the shared controls carry the
  // `auth.*` ids (only one screen renders at a time), each screen's root carries its own `signUp`/`signIn` id.
  signUp: { screen: 'signUp.screen' },
  signIn: { screen: 'signIn.screen' },
  auth: {
    emailInput: 'auth.emailInput',
    codeInput: 'auth.codeInput', // the 6-cell code field (one logical value; directly Maestro-driveable)
    continue: 'auth.continue', // green primary — "Continue" (email phase) / "Verify" (code phase)
    resend: 'auth.resend', // "Resend code" (disabled during cooldown)
    changeEmail: 'auth.changeEmail', // back to the email phase (email prefilled)
    switchLink: 'auth.switchLink', // "Already have an account? Log in" / "No account? Create one" cross-link
    error: 'auth.error', // in-line error surface (exists / no-account / bad-code)
  },
  firstRun: {
    meetVoxiNext: 'firstRun.meetVoxiNext',
    cameraPrimeAllow: 'firstRun.cameraPrimeAllow',
    micPrimeAllow: 'firstRun.micPrimeAllow',
    privacyAck: 'firstRun.privacyAck',
    shareConsentToggle: 'firstRun.shareConsentToggle',
  },
  camera: {
    screen: 'camera.screen',
    shutter: 'camera.shutter',
    permissionDeniedBanner: 'camera.permissionDeniedBanner',
    openSettings: 'camera.openSettings',
    retakeHint: 'camera.retakeHint',
    recent: 'camera.recent', // "Recently catalogued" carousel container (inside the floating RecentCard)
    recentItem: 'camera.recentItem', // a single recent-capture tile (shared CatalogTile, carousel variant)
    recentItemPhoto: 'camera.recentItemPhoto', // the persisted capture thumbnail on a recent tile (parity with threads.itemPhoto)
    recentToggle: 'camera.recentToggle', // icon button that opens the Recently-catalogued floating card
    recentClose: 'camera.recentClose', // light tap-away scrim behind the RecentCard (tap to close)
    pager: 'camera.pager', // horizontal pager: swipe left off the viewfinder → the newest catalogued item's reveal
    opening: 'camera.opening', // brief "opening your entry…" loading beat shown as the swipe-left commits
  },
  processing: {
    screen: 'processing.screen',
    orb: 'processing.orb', // also carries orb.state: idle|listening|thinking|speaking|uncertain
    loadingLine: 'processing.loadingLine',
    longWaitAck: 'processing.longWaitAck',
    failureState: 'processing.failureState',
    retryBtn: 'processing.retryBtn',
    rings: 'processing.rings', // concentric pulsing rings around the orb (decorative)
    // (processing.cancel retired — the universal AppHeader back chevron `nav.back` now aborts + returns to camera)
  },
  reveal: {
    card: 'reveal.card',
    title: 'reveal.title',
    confidenceChip: 'reveal.confidenceChip', // carries chip.band: CONFIDENT|PROBABLE|UNKNOWN
    quip: 'reveal.quip',
    whatItIs: 'reveal.whatItIs',
    photoThumb: 'reveal.photoThumb',
    primaryAction: 'reveal.primaryAction',
    generateStory: 'reveal.generateStory',
    askVoxi: 'reveal.askVoxi',
    addTip: 'reveal.addTip',
    howSure: 'reveal.howSure',
    evidencePanel: 'reveal.evidencePanel',
    correctId: 'reveal.correctId',
    candidateOption: 'reveal.candidateOption', // disagreement: multiple
    playNarration: 'reveal.playNarration', // subordinate icon-only narration play/pause orb (NOT the primary pill)
    narrationAudio: 'reveal.narrationAudio', // the <audio> that speaks the reveal in Voxi's British voice
    facts: 'reveal.facts', // "Curious facts" container — grows as async research verifies each fact
    fact: 'reveal.fact', // one verified fact row (fact text + its own source link; multiple, progressive)
    factSource: 'reveal.factSource', // the per-fact source link under a fact (shows the page title; tap → opens it)
    // Research-bucket DOCK (ANALYSIS-UX redesign): four green research icons + a blue conversation icon. Each
    // research icon carries bucket.state: loading|active|empty|unavailable. Tap an active icon → it morphs into
    // `reveal.bucketCard` (the grounded content + per-bucket audio via reveal.playNarration/narrationAudio).
    buckets: 'reveal.buckets', // the dock row container
    bucketWhat: 'reveal.bucketWhat', // "What it is" — active on band-settle
    bucketPurpose: 'reveal.bucketPurpose', // "What it's for"
    bucketWho: 'reveal.bucketWho', // "Who made it" (maker)
    whenMade: 'reveal.whenMade', // "when it was made" — a muted date line inside the Maker card (no dock slot)
    bucketFacts: 'reveal.bucketFacts', // "Curious facts" — carries a count badge
    deepDiveIcon: 'reveal.deepDiveIcon', // green Deep Dive (Sparkles) icon, after Facts in the dock row → /podcast; carries state: active|generating|ready (generating = a compose is in flight; ready = a durable episode exists)
    bucketCard: 'reveal.bucketCard', // the morphed content card (carries card.bucket)
    cardTab: 'reveal.cardTab', // a section-title tab in the morph card header; carries {bucket, selected} via tidWith — tap → switch section IN PLACE (replaces the old bottom tab strip)
    bucketCardScrim: 'reveal.bucketCardScrim', // tap-to-close scrim behind the morph card
    conversationIcon: 'reveal.conversationIcon', // blue "Ask Voxi" icon → /conversation — set off by the divider, the pinned people lane (co-locates reveal.askVoxi)
    // Swipe paging across catalogued items: a horizontal paging FlatList of the revealable collection. Swiping is
    // the native scroll paging; on settle the landed item loads in place (no /processing, no re-bill).
    pager: 'reveal.pager', // the horizontal paging FlatList (scroll container)
    pagerCamera: 'reveal.pagerCamera', // the leading "camera" page — swiping past the newest item opens capture
    position: 'reveal.position', // hidden anchor carrying index/count + openedvia (analyze|revisit) for E2E reads
    // ⋯ MORE menu (item pages only): the header ⋯ (nav.more) opens a bottom action sheet with two actions.
    // Delete is a TWO-STEP destructive flow (menu → confirmation dialog → destructive confirm).
    moreMenu: 'reveal.moreMenu', // the bottom action sheet container
    moreMenuScrim: 'reveal.moreMenuScrim', // tap-away scrim behind the sheet
    menuRegenerate: 'reveal.menuRegenerate', // "Regenerate" row → regen confirm dialog
    menuDelete: 'reveal.menuDelete', // "Delete" row (destructive, last) → delete confirm dialog
    regenConfirm: 'reveal.regenConfirm', // regenerate confirmation dialog container
    regenConfirmCancel: 'reveal.regenConfirmCancel',
    regenConfirmAccept: 'reveal.regenConfirmAccept', // "Regenerate" — re-runs identification in place
    deleteConfirm: 'reveal.deleteConfirm', // delete confirmation dialog container (step 2 of the two-step delete)
    deleteConfirmCancel: 'reveal.deleteConfirmCancel',
    deleteConfirmAccept: 'reveal.deleteConfirmAccept', // destructive "Delete" — the deliberate second tap
  },
  podcast: {
    player: 'podcast.player',
    cover: 'podcast.cover',
    audio: 'podcast.audio', // the <audio> element — `expect.playing()` asserts currentTime advances
    playPause: 'podcast.playPause',
    transcriptLine: 'podcast.transcriptLine', // carries speaker: ARLO|MAVE, and karaoke `active` (true on the spoken word's line)
    composingState: 'podcast.composingState',
    reportEpisode: 'podcast.reportEpisode',
    skip15: 'podcast.skip15', // +15s (forward)
    skipBack: 'podcast.skipBack', // −15s (back)
    scrubber: 'podcast.scrubber', // the seekable progress track (tap-to-seek); carries scrubber.fraction
    scrubberElapsed: 'podcast.scrubberElapsed', // elapsed clock (left of the scrubber)
    scrubberDuration: 'podcast.scrubberDuration', // remaining/total clock (right of the scrubber)
    activeWordIndex: 'podcast.activeWordIndex', // hidden anchor carrying the current karaoke word index (idx) — the COUPLING proof reads it advancing
    playerState: 'podcast.playerState', // hidden anchor carrying transport state (playing, pos) — proves play/pause STICKS + seek moves the playhead (native-transport regression)
    composeElapsed: 'podcast.composeElapsed', // the live "how long" elapsed clock shown while composing
    progressHero: 'podcast.progressHero', // the large animated composing hero (orb + flat progress ring + orbiting disc)
    generate: 'podcast.generate', // the EXPLICIT "Generate a Deep Dive" CTA (idle state) — generation never auto-fires on mount
    regenerate: 'podcast.regenerate', // ready-player header, LEFT of the close X → forces a FRESH deep dive (fresh version) for retesting
    stillComposing: 'podcast.stillComposing', // non-terminal "taking a while" state (poll budget exhausted, worker may still render) — never the "held it back" fail copy
  },
  conversation: {
    orb: 'conversation.orb', // the full-screen voice surface (container)
    orbVisual: 'conversation.orbVisual', // the animated orb itself — carries orb.state
    micButton: 'conversation.micButton', // push-to-talk
    liveMicIndicator: 'conversation.liveMicIndicator',
    keyboardToggle: 'conversation.keyboardToggle',
    textInput: 'conversation.textInput',
    sendBtn: 'conversation.sendBtn',
    minutesExhausted: 'conversation.minutesExhausted',
    toPaywall: 'conversation.toPaywall', // exhausted-minutes → paywall CTA
    voxiTurn: 'conversation.voxiTurn',
    transcriptText: 'conversation.transcriptText',
  },
  threads: {
    screen: 'threads.screen',
    emptyState: 'threads.emptyState',
    captureCta: 'threads.captureCta',
    count: 'threads.count', // the "{n} catalogued" count subtitle (a real number, no ∞)
    grid: 'threads.grid',
    item: 'threads.item',
    itemPhoto: 'threads.itemPhoto', // the durable capture thumbnail on a collection tile (persisted photo)
    loadingMore: 'threads.loadingMore', // footer spinner while the infinite-scroll window has more to reveal
    window: 'threads.window', // hidden anchor carrying the infinite-scroll window (data-shown / data-total) for E2E reads
  },
  interview: {
    screen: 'interview.screen',
    question: 'interview.question',
    answerInput: 'interview.answerInput',
    skip: 'interview.skip',
    visibilityToggle: 'interview.visibilityToggle', // default private
    whyAsked: 'interview.whyAsked',
  },
  contribute: {
    screen: 'contribute.screen',
    tipInput: 'contribute.tipInput',
    submit: 'contribute.submit',
    statusBanner: 'contribute.statusBanner', // "moderator will review" | "live now"
    reportBtn: 'contribute.reportBtn',
  },
  paywall: {
    screen: 'paywall.screen',
    limitMessage: 'paywall.limitMessage',
    subscribeBtn: 'paywall.subscribeBtn',
    restoreBtn: 'paywall.restoreBtn',
  },
  settings: {
    screen: 'settings.screen',
    subscriptionStatus: 'settings.subscriptionStatus',
    privacyNoFaceRecognition: 'settings.privacyNoFaceRecognition',
    deleteAccount: 'settings.deleteAccount',
    reduceMotion: 'settings.reduceMotion',
    speakAloud: 'settings.speakAloud', // "Speak results aloud" — gates the reveal's auto-narration (audio pref)
    signOut: 'settings.signOut',
  },
  global: {
    offlineBanner: 'global.offlineBanner',
    safetyRefusal: 'global.safetyRefusal', // distinct visual from confidence chip
  },
  // Tab bar / cross-screen navigation affordances (the app chrome). Scenarios reach every screen via these
  // instead of coordinate taps; the iOS shell exposes the SAME ids on its TabView/router.
  nav: {
    threadsTab: 'nav.threadsTab',
    settingsTab: 'nav.settingsTab',
    openConversation: 'nav.openConversation', // "Ask Voxi" entry into the full-screen conversation
    openPodcast: 'nav.openPodcast', // "Generate story" → podcast player
    openContribute: 'nav.openContribute', // "Add a tip" → contribute sheet
    menuButton: 'nav.menuButton', // hamburger, top-left of Capture + the Collection/Settings sections → opens the drawer
    more: 'nav.more', // ⋯ overflow, top-right of the reveal item header → opens the reveal MORE action sheet
    close: 'nav.close', // modal-dismiss X (podcast/conversation/contribute/paywall), top-right → guarded dismiss
    back: 'nav.back', // back chevron, top-left (processing/reveal/interview/sign-in/sign-up) → guarded dismiss
    header: 'nav.header', // the universal AppHeader root View (the element measured for constant height)
  },
  // Left slide-out drawer — replaces the bottom tab bar; reachable from the camera shell only.
  drawer: {
    screen: 'drawer.screen',
    scrim: 'drawer.scrim',
    home: 'drawer.home', // Capture/Home row → router.navigate('/(tabs)/camera')
    profile: 'drawer.profile',
    upgrade: 'drawer.upgrade',
    signOut: 'drawer.signOut',
  },
  // E2E-only diagnostic affordances — rendered ONLY when the harness injects a Sentry DSN (never in prod bundles).
  dev: {
    sentryThrow: 'dev.sentryThrow', // taps → captureIfUnexpected(secret-bearing error) → local envelope sink
  },
} as const

export type TestId = string
/** Flattens the registry to validate at runtime that a scenario referenced a known id. */
export function allIds(): Set<TestId> {
  const out = new Set<TestId>()
  const walk = (o: Record<string, unknown>) => {
    for (const v of Object.values(o)) {
      if (typeof v === 'string') out.add(v)
      else if (v && typeof v === 'object') walk(v as Record<string, unknown>)
    }
  }
  walk(ids as unknown as Record<string, unknown>)
  return out
}
