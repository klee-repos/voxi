/**
 * Guard test for the "Ask Voxi" voice seam (LiveKit edition). The real LiveKit Room is native-only + validated
 * end-to-end (the livekit-agents audio-plane test in services/voice-bot/tests/ + the converge harness); this locks
 * in the off-device-checkable invariants:
 *   1. the fail-safe seam degrades to the deterministic stub when @livekit/react-native is absent (the web/E2E
 *      path — the stub is load-bearing for the harness), and
 *   2. the stub produces a finalized two-turn exchange on push-to-talk (the caption path is load-bearing).
 */
import { test, expect, describe } from 'bun:test'
import { createVoiceSession, createStubVoiceSession, type OrbState } from './pipecat'

describe('voice session fail-safe seam (never crash the conversation screen)', () => {
  test('with no native LiveKit transport (web/off-device bun), createVoiceSession returns the deterministic stub', async () => {
    const states: OrbState[] = []
    const session = createVoiceSession({
      url: 'ws://example.test:7880',
      token: 'fake.jwt',
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
    const stub = createStubVoiceSession({ url: '', token: '', threadId: 't2', events: { onTranscript: (t) => turns.push(t) } })
    await stub.connect()
    stub.startTalking()
    stub.stopTalking()
    expect(turns.filter((t) => t.final).length).toBeGreaterThanOrEqual(2) // a user turn + a Voxi reply, both final
    expect(turns.some((t) => t.role === 'voxi')).toBe(true)
  })
})
