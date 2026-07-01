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
  welcome: {
    screen: 'welcome.screen',
    emailInput: 'welcome.emailInput',
    continueBtn: 'welcome.continueBtn',
    otpInput: 'welcome.otpInput',
    eulaAccept: 'welcome.eulaAccept',
    ageConfirm: 'welcome.ageConfirm',
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
    recent: 'camera.recent', // "Recently catalogued" carousel container (inside the tray)
    recentItem: 'camera.recentItem', // a single recent-thread card
    recentToggle: 'camera.recentToggle', // icon button that opens the Recently-catalogued tray
    recentClose: 'camera.recentClose', // scrim behind the Recently tray (tap to close)
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
    fact: 'reveal.fact', // one verified fact chip (multiple; appears progressively)
    factSource: 'reveal.factSource', // per-fact source-proof affordance (tap → sourceTitle + quote + link)
  },
  podcast: {
    player: 'podcast.player',
    cover: 'podcast.cover',
    audio: 'podcast.audio', // the <audio> element — `expect.playing()` asserts currentTime advances
    playPause: 'podcast.playPause',
    transcriptLine: 'podcast.transcriptLine', // carries speaker: ARLO|MAVE
    composingState: 'podcast.composingState',
    reportEpisode: 'podcast.reportEpisode',
    skip15: 'podcast.skip15',
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
    grid: 'threads.grid',
    item: 'threads.item',
    itemPhoto: 'threads.itemPhoto', // the durable capture thumbnail on a collection tile (persisted photo)
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
    menuButton: 'nav.menuButton', // hamburger, top-left of camera, opens the drawer
    close: 'nav.close', // modal-dismiss X (podcast/conversation/contribute/paywall), top-right → guarded dismiss
    back: 'nav.back', // back chevron, top-left (processing/reveal/threads/settings/interview) → guarded dismiss
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
