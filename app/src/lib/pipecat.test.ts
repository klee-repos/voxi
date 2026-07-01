/**
 * Guard test for the "Ask Voxi" voice fix (Bug A). The real SmallWebRTC transport is native-only and can only be
 * validated on device, so this locks in the two things that ARE checkable off-device:
 *   1. the CONFIG that caused the silent-stub regression never comes back (the cross-fork Metro alias is gone,
 *      the app depends on the Daily fork the transport actually requires, community fork is gone, ATS is kept), and
 *   2. the fail-safe seam still degrades to the deterministic stub (voice must NEVER crash the conversation screen).
 * On-device validation (mic acquire + real connect, no LogBox "undefined is not a function") is the user's step.
 */
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVoiceSession, createStubVoiceSession, setVoiceMediaManagerFactory, type OrbState } from './pipecat'

const appRoot = resolve(import.meta.dir, '../..') // app/
const read = (p: string) => readFileSync(resolve(appRoot, p), 'utf8')

describe('voice fork config (Bug A regression guard)', () => {
  test('metro.config.js no longer aliases @daily-co/react-native-webrtc to the community fork', () => {
    const metro = read('metro.config.js')
    // The alias was the load-bearing hack: it pointed the transport at a DIFFERENT webrtc fork. It must stay gone.
    expect(metro).not.toMatch(/extraNodeModules[\s\S]*@daily-co\/react-native-webrtc/)
  })

  test('the app depends on the Daily fork the transport requires — not the community fork', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }
    const deps = pkg.dependencies ?? {}
    expect(deps['@daily-co/react-native-webrtc']).toBeDefined() // the fork @pipecat-ai transport peer-depends on
    expect(deps['react-native-webrtc']).toBeUndefined() // the community fork must not be shipped alongside it
  })

  test('the native MediaManager imports from the SAME @daily-co fork as the transport', () => {
    const mm = read('src/lib/voiceMediaManager.native.ts')
    expect(mm).toMatch(/from ['"]@daily-co\/react-native-webrtc['"]/)
    expect(mm).not.toMatch(/from ['"]react-native-webrtc['"]/) // never the community fork
  })

  test('app.json keeps NSAllowsLocalNetworking so a --clean prebuild does not break the LAN dev loop', () => {
    const appJson = JSON.parse(read('app.json')) as { expo: { ios: { infoPlist: Record<string, unknown> } } }
    expect(appJson.expo.ios.infoPlist.NSAllowsLocalNetworking).toBe(true)
  })
})

describe('voice session fail-safe seam (never crash the conversation screen)', () => {
  test('with no native MediaManager wired (web/off-device), createVoiceSession returns the deterministic stub', async () => {
    setVoiceMediaManagerFactory(null) // simulate the web/E2E bundle — real transport unavailable
    const states: OrbState[] = []
    const session = createVoiceSession({
      connectUrl: 'https://example.test/voice',
      threadId: 't1',
      mode: 'pushToTalk',
      events: { onOrbState: (s) => states.push(s) },
    })
    await session.connect()
    expect(session.connected).toBe(true) // the stub connects — the screen renders + push-to-talk works
    session.startTalking()
    session.stopTalking()
    expect(states).toContain('listening')
  })

  test('the stub produces a finalized two-turn exchange on push-to-talk (caption path is load-bearing)', async () => {
    const turns: { role: string; final: boolean }[] = []
    const stub = createStubVoiceSession({ connectUrl: '', threadId: 't2', events: { onTranscript: (t) => turns.push(t) } })
    await stub.connect()
    stub.startTalking()
    stub.stopTalking()
    expect(turns.filter((t) => t.final).length).toBeGreaterThanOrEqual(2) // a user turn + a Voxi reply, both final
    expect(turns.some((t) => t.role === 'voxi')).toBe(true)
  })
})
