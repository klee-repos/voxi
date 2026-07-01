"""
Pipeline behaviour tests (PLAN §6.3 / TEST-PLAN conv-03, conv-05, conv-06).

Each test drives the real VoicePipeline with deterministic fakes — no creds, no Pipecat, no stub that
forces green. Assertions cover the five required guarantees:
  1. persona injected exactly once (incl. across a reconnect),
  2. barge-in discards the partial assistant turn,
  3. transcript write-back is idempotent on reconnect (no dup turns),
  4. the same canonical Voxi voice_id is used for every spoken chunk (consistency),
  5. metering hard-cutoff disconnects at the minute cap.
"""

from __future__ import annotations

import pytest

from voxi_voice import (
    CANONICAL_VOXI_VOICE_ID,
    FakeBff,
    FakeTTS,
    MeterEvent,
    PersonaInjector,
    ScopedToken,
    TranscriptWriter,
    VoiceConsistencyError,
    VoiceMeter,
    VoicePipeline,
    Turn,
    frames_from,
)

from .factory import Clock, build_harness


def one_utterance(frames: list[bytes] | None = None, barge=None):
    return (frames_from(frames or [b"\x00\x01", b"\x02\x03"]), barge)


# ---------------------------------------------------------------------------
# 1. Persona injected exactly once
# ---------------------------------------------------------------------------
async def test_persona_injected_once_in_a_session():
    h = build_harness(scripted_stt=["a bicycle", "and the frame"])
    result = await h.pipeline.run([one_utterance(), one_utterance()])

    assert result.persona_injections == 1
    assert h.persona.injected_count == 1
    # The brain received the canonical persona text on its turns.
    assert all("You are Voxi" in p for p in h.llm.seen_personas)
    assert len(h.llm.seen_personas) == 2  # two user turns, persona reused, not re-injected


async def test_persona_injected_once_across_reconnect():
    # Same session reconnects: a NEW pipeline is built against the SAME PersonaInjector.
    persona = PersonaInjector()
    bff = FakeBff()

    h1 = build_harness(persona=persona, bff=bff, scripted_stt=["a watch"])
    await h1.pipeline.run([one_utterance()])

    # Reconnect — fresh pipeline, same injector + bff, turn index continues.
    h2 = build_harness(persona=persona, bff=bff, scripted_stt=["the strap"], start_turn_index=2)
    r2 = await h2.pipeline.run([one_utterance()])

    # The reconnect did NOT re-inject the persona.
    assert r2.persona_injections == 1
    assert persona.injected_count == 1


# ---------------------------------------------------------------------------
# 2. Barge-in discards the partial assistant turn
# ---------------------------------------------------------------------------
async def test_barge_in_discards_partial_turn():
    h = build_harness(scripted_stt=["a teapot"])

    # Fire barge-in after the pipeline has spoken a few tokens.
    fired = {"n": 0}

    def barge() -> bool:
        fired["n"] += 1
        # Interrupt once a couple of tokens have streamed (SmartTurnDetection: user started a new turn).
        return fired["n"] >= 3

    result = await h.pipeline.run([one_utterance(barge=barge)])

    assistant_turns = [t for t in result.turns if t.role == "assistant"]
    assert len(assistant_turns) == 1
    a = assistant_turns[0]
    assert a.interrupted is True
    assert result.interrupted_turns == 1

    # The partial is SHORTER than the full reply the LLM would have produced (the rest was discarded).
    full_reply = "".join(h.llm.delivered)
    assert a.text != ""  # something was spoken
    assert len(a.text) < len(full_reply)
    # The discarded tokens were never sent to TTS (the audio stops at the interruption point).
    spoken_via_tts = "".join(h.tts.synth_calls)
    assert full_reply not in spoken_via_tts


async def test_no_barge_in_keeps_full_turn():
    h = build_harness(scripted_stt=["a lamp"])
    result = await h.pipeline.run([one_utterance(barge=None)])
    a = [t for t in result.turns if t.role == "assistant"][0]
    assert a.interrupted is False
    assert a.text == "".join(h.llm.delivered)


# ---------------------------------------------------------------------------
# 3. Transcript write-back is idempotent on reconnect (no dup turns)
# ---------------------------------------------------------------------------
async def test_transcript_writeback_idempotent_on_reconnect():
    bff = FakeBff()
    persona = PersonaInjector()

    # Initial session: one user turn + one assistant turn -> 2 appended turns at indices 0,1.
    h1 = build_harness(persona=persona, bff=bff, scripted_stt=["a kettle"])
    await h1.pipeline.run([one_utterance()])
    assert len(bff.appended) == 2
    first_keys = [a["idempotency_key"] for a in bff.appended]

    # Reconnect replays the SAME tail (a flaky network re-sends the last turns). A new pipeline writes the
    # same (index, role, text) -> same idempotency keys -> the BFF must NOT create duplicates.
    writer = TranscriptWriter(bff, ScopedToken("tok", "user_alice", "sess_123"))
    replay_turns = [Turn(role=t["role"], text=t["text"]) for t in bff.appended]
    for i, t in enumerate(replay_turns):
        res = await writer.write_turn(i, t)
        assert res["ok"] is True
        assert res["duplicate"] is True  # acknowledged as a replay, not re-appended

    # Still exactly 2 turns; no dupes.
    assert len(bff.appended) == 2
    assert [a["idempotency_key"] for a in bff.appended] == first_keys


async def test_new_turn_at_fresh_index_is_not_a_replay():
    bff = FakeBff()
    h = build_harness(bff=bff, scripted_stt=["a chair", "the legs"])
    await h.pipeline.run([one_utterance(), one_utterance()])
    # 2 user + 2 assistant = 4 distinct turns at 4 distinct indices, all appended once.
    assert len(bff.appended) == 4
    assert len({a["idempotency_key"] for a in bff.appended}) == 4


async def test_writeback_cross_session_denied():
    bff = FakeBff()
    # A token minted for session A cannot write turns into session B.
    writer = TranscriptWriter(bff, ScopedToken("tok", "user_alice", "sess_A"))
    # Force a mismatch by writing to a different session via a hand-rolled call.
    res = await bff.append_turn(writer._token, "sess_B", "sess_B:t0:user:deadbeef", {"role": "user", "text": "hi"})
    assert res["ok"] is False
    assert res["reason"] == "cross_session_denied"
    assert bff.rejected_cross_session == 1
    assert bff.appended == []


# ---------------------------------------------------------------------------
# 4. The same canonical Voxi voice_id is used (consistency)
# ---------------------------------------------------------------------------
async def test_same_voice_id_for_every_spoken_chunk():
    h = build_harness(scripted_stt=["a globe", "the stand"])
    result = await h.pipeline.run([one_utterance(), one_utterance()])

    assert result.audio_voice_ids, "expected audio to have been synthesized"
    assert set(result.audio_voice_ids) == {CANONICAL_VOXI_VOICE_ID}
    # The TTS provider is bound to the canonical id (the persona's voice_id), not an arbitrary one.
    assert h.tts.voice_id == CANONICAL_VOXI_VOICE_ID
    assert h.persona.persona.voice_id == CANONICAL_VOXI_VOICE_ID


async def test_wrong_voice_id_is_rejected_no_silent_drift():
    # A degraded/misconfigured TTS that returns a DIFFERENT timbre must be caught, not played silently.
    clock = Clock()
    persona = PersonaInjector()  # canonical voice_id
    bff = FakeBff()
    token = ScopedToken("tok", "user_alice", "sess_123")
    from voxi_voice import FakeSTT, FakeLLM, ToolBridge

    bad_tts = FakeTTS(voice_id="some-other-voice-xyz")  # NOT the canonical Voxi voice
    pipeline = VoicePipeline(
        stt=FakeSTT(scripted=["a mug"]),
        llm=FakeLLM(),
        tts=bad_tts,
        persona_injector=persona,
        meter=VoiceMeter(300.0, now=clock.now),
        transcript=TranscriptWriter(bff, token),
        tools=ToolBridge(bff, token),
    )

    with pytest.raises(VoiceConsistencyError):
        await pipeline.run([one_utterance()])


# ---------------------------------------------------------------------------
# 5. Metering hard-cutoff disconnects at the minute cap
# ---------------------------------------------------------------------------
async def test_metering_hard_cutoff_disconnects_at_cap():
    clock = Clock()
    # 60s cap over four queued utterances. We age the clock 35s per turn inside STT collection so:
    # turn 1 boundary at 0s -> ok; turn 1 ages to 35s; turn 2 boundary at 70s > 60s cap -> hard cutoff.
    h = build_harness(cap_seconds=60.0, clock=clock, scripted_stt=["one", "two", "three", "four"])
    utterances = [one_utterance() for _ in range(4)]

    # Advance elapsed voice time as each utterance is consumed (simulates real talk time accruing).
    orig_collect = h.pipeline._collect_final

    async def collect_and_age(frames):
        clock.advance(35.0)
        return await orig_collect(frames)

    h.pipeline._collect_final = collect_and_age  # type: ignore[assignment]
    result = await h.pipeline.run(utterances)

    assert result.disconnected_by_meter is True
    assert MeterEvent.HARD_CUTOFF in result.meter_events
    assert h.meter.cut_off is True
    # The cutoff line was spoken in-persona and committed to the transcript.
    cutoff_turns = [t for t in result.turns if t.role == "assistant" and "minute" in t.text.lower()]
    assert cutoff_turns, "expected an in-persona cutoff message turn"
    # We did NOT keep serving turns after the cap — fewer than the 4 user turns completed.
    user_turns = [t for t in result.turns if t.role == "user"]
    assert len(user_turns) < 4


async def test_meter_soft_warnings_fire_once_each():
    clock = Clock()
    meter = VoiceMeter(100.0, now=clock.now)
    meter.start()

    assert meter.tick().event == MeterEvent.OK
    clock.advance(80.0)  # 80%
    assert meter.tick().event == MeterEvent.SOFT_80
    assert meter.tick().event == MeterEvent.OK  # does not re-fire
    clock.advance(10.0)  # 90%
    assert meter.tick().event == MeterEvent.SOFT_90
    assert meter.tick().event == MeterEvent.OK  # does not re-fire
    clock.advance(15.0)  # past cap
    d = meter.tick()
    assert d.event == MeterEvent.HARD_CUTOFF
    assert d.should_disconnect is True
    # Latched: stays cut off.
    assert meter.tick().event == MeterEvent.HARD_CUTOFF
