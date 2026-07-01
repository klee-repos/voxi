# services/voice-bot — Voxi realtime voice pipeline (Pipecat)

The sub-second **voice loop** for Voxi: a separate, stateless Python service that joins a thread's durable
eve session and runs a streaming **STT → LLM → ElevenLabs-Voxi-voice** cascade with **SmartTurnDetection**
barge-in. eve is wrong for a sub-second loop, so this sidecar shares thread state but owns the realtime
graph (PLAN §6.3).

It is built **transport-agnostic and credential-free**: the whole pipeline runs and is fully tested here
with deterministic fakes — **no creds, no media stack, no Pipecat install required**. The Pipecat
SmallWebRTC transport and the real vendors swap in behind the same interfaces on a real deploy.

## What it implements (PLAN §6.3)

- **Cascade with a pluggable provider seam** — `STTProvider`, `LLMProvider`, `TtsProvider` protocols
  (`voxi_voice/providers.py`). Fakes implement real streaming behaviour (partials→final, cancellable token
  streaming, voice_id-tagged audio). Real vendors (Deepgram/Gemini STT, Gemini 3.5 Flash / Claude LLM,
  ElevenLabs Flash v2.5 TTS) drop in by config, not a rewrite. Vendor fallbacks (§6.4) are just other
  implementations of the same protocols.
- **Canonical Voxi persona, injected once** — `voxi_voice/persona.py`. The same dry-British persona the eve
  root agent uses (`services/eve-agent/agent/instructions.md`), loaded as session instructions at connect.
  `PersonaInjector` enforces the once-only contract: a reconnect re-uses the same injector and does **not**
  re-prime the LLM, so context never drifts.
- **Voice consistency** — one canonical `voice_id` (`CANONICAL_VOXI_VOICE_ID`). The pipeline **refuses to
  play** any TTS chunk whose `voice_id` is not the session's canonical id, so a degraded/misconfigured TTS
  can never silently drift the timbre (PLAN §6.1, TEST-PLAN conv-03).
- **SmartTurnDetection barge-in** — when the end-of-turn classifier says the user started a new turn, the
  in-flight LLM generation is **cancelled** (`aclose()`) and the partial assistant turn is **discarded**
  (committed-as-interrupted, only what was actually spoken). The discarded tokens are never sent to TTS.
- **Tool bridge via a per-session scoped token** — `voxi_voice/bff_bridge.py`. The live LLM calls eve tools
  (e.g. `catalog_search`) **through the BFF** with a per-session scoped token carrying the same
  `userId↔sessionId` ACL as every other surface. The bot never holds a broad credential.
- **Transcript write-back, single writer, idempotent** — finalized turns are appended via the eve session
  follow-up endpoint (`POST /eve/v1/session/:id`). eve stays the **single writer** (no dual-write to
  `app.messages`). Each turn carries a **per-turn idempotency key** (session + index + content hash), so a
  reconnect that replays the tail collapses to one write — **no duplicate turns** (eng-F5, TEST-PLAN
  conv-06).
- **Metering hard cutoff** — `voxi_voice/metering.py`. Tracks elapsed voice-seconds against a per-session
  minute cap, emits in-persona soft warnings at 80% / 90%, gives a short grace for the in-flight turn, then
  **hard-disconnects** at the cap with a graceful in-persona line (PLAN §6.4, TEST-PLAN conv-05). Clock is
  injected, so the cutoff is asserted deterministically with no sleeping.

## Layout

```
voxi_voice/
  persona.py      canonical Voxi persona + once-only PersonaInjector + canonical voice_id
  providers.py    STT/LLM/Tts protocols (the seam) + deterministic fakes (no creds)
  metering.py     VoiceMeter — soft warnings + hard cutoff at the minute cap
  bff_bridge.py   ScopedToken, ToolBridge, TranscriptWriter (single-writer, idempotent), FakeBff
  pipeline.py     VoicePipeline — wires the cascade, barge-in, voice-consistency gate, metering, write-back
  transport.py    Pipecat SmallWebRTC seam (OPTIONAL dep; import-safe; raises clearly if Pipecat absent)
tests/            pytest suite (17 tests) — runs with no creds, no Pipecat
```

## Run the tests

```sh
# from services/voice-bot/
python3 -m venv .venv
./.venv/bin/python -m pip install pytest pytest-asyncio
./.venv/bin/python -m pytest -q
```

Or from the repo root:

```sh
python3 -m pytest services/voice-bot/ -q
```

**Verified in this sandbox:** `17 passed` (pytest 9.1.1, pytest-asyncio 1.4.0, Python 3.12). The five
required guarantees are asserted directly:

| Guarantee | Test |
|---|---|
| persona injected once (incl. across reconnect) | `test_persona_injected_once_in_a_session`, `test_persona_injected_once_across_reconnect` |
| barge-in discards the partial turn | `test_barge_in_discards_partial_turn` |
| transcript write-back idempotent on reconnect (no dup turns) | `test_transcript_writeback_idempotent_on_reconnect` |
| same Voxi voice_id (consistency) | `test_same_voice_id_for_every_spoken_chunk`, `test_wrong_voice_id_is_rejected_no_silent_drift` |
| metering hard-cutoff at the minute cap | `test_metering_hard_cutoff_disconnects_at_cap` |

## What is NOT proven here (honest scope)

- **The live Pipecat SmallWebRTC transport** is a seam (`transport.py`). It is import-safe and raises a clear
  error when Pipecat is absent; it is **not** wired to real frames here. Wiring Pipecat's
  `SmallWebRTCTransport` + `SmartTurnAnalyzer` to these provider protocols is the credentialed integration
  (needs `pipecat-ai`, a media stack, and STT/LLM/TTS keys). Install the `live` extra on a real deploy.
- **Real vendor latency / accuracy / timbre** (the §6.1 voice-consistency A/B is gate **G4**) needs creds.
  The test suite proves the *control flow* (once-only persona, barge-in discard, idempotent write-back,
  voice-id consistency, hard cutoff), not vendor behaviour.

Per `docs/IMPLEMENTATION-STATUS.md`, live integration (real ElevenLabs/Deepgram/Gemini) and iOS-native voice
verification require creds and a Mac+Xcode respectively; the logic layer above proceeds without them.
