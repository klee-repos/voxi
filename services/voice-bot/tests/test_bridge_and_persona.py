"""
Tool-bridge, persona-content, idempotency-key, and transport-seam tests (PLAN §6.3, §8.1).
"""

from __future__ import annotations

import pytest

from voxi_voice import (
    CANONICAL_VOXI_VOICE_ID,
    FakeBff,
    ScopedToken,
    ToolBridge,
    TransportConfig,
    Turn,
    VOXI_PERSONA,
    build_pipecat_runner,
    pipecat_available,
    turn_idempotency_key,
)


# ---- persona content guardrails (§8.1) ----
def test_persona_is_british_dry_and_clean():
    p = VOXI_PERSONA
    assert "British" in p
    # Banned in Voxi's own copy: emoji + Adams trademark phrasing.
    assert "Hitchhiker" in p  # only as the BANNED reference, phrased as a prohibition
    assert "trademarked Hitchhiker" in p or "Hitchhiker's Guide phrasing" in p
    # No emoji characters in the persona block itself.
    assert all(ord(ch) < 0x1F000 for ch in p)
    # Honesty rules present.
    assert "unsupported" in p
    assert "confidence band" in p.lower()


# ---- tool bridge auth (per-session scoped token) ----
async def test_tool_bridge_routes_through_bff_with_scoped_token():
    bff = FakeBff(tool_results={"catalog_search": {"ok": True, "result": ["2008 SuperSix EVO"]}})
    token = ScopedToken("scoped_tok", "user_alice", "sess_123")
    bridge = ToolBridge(bff, token)

    out = await bridge.call("catalog_search", {"q": "bike"})
    assert out["result"] == ["2008 SuperSix EVO"]
    assert bff.tool_calls == [("catalog_search", {"q": "bike"})]


# ---- idempotency key determinism ----
def test_idempotency_key_is_deterministic_and_content_sensitive():
    k1 = turn_idempotency_key("sess_1", 0, "user", "hello")
    k2 = turn_idempotency_key("sess_1", 0, "user", "hello")
    k3 = turn_idempotency_key("sess_1", 0, "user", "HELLO")  # different content
    k4 = turn_idempotency_key("sess_1", 1, "user", "hello")  # different index
    assert k1 == k2
    assert k1 != k3
    assert k1 != k4
    assert k1.startswith("sess_1:t0:user:")


async def test_interrupted_turn_recorded_as_interrupted_not_complete():
    from voxi_voice import TranscriptWriter

    bff = FakeBff()
    token = ScopedToken("tok", "u", "s")
    writer = TranscriptWriter(bff, token)
    await writer.write_turn(0, Turn(role="assistant", text="Ah. You are", interrupted=True))

    assert bff.appended[0]["interrupted"] is True
    assert bff.appended[0]["text"] == "Ah. You are"


# ---- transport seam: optional, import-safe ----
def test_transport_config_defaults_match_plan():
    cfg = TransportConfig()
    assert cfg.kind == "smallwebrtc"  # P2P self-host default (best GCP fit for 1:1)
    assert cfg.smart_turn_detection is True
    assert cfg.mic_mode == "push_to_hold"  # resolves D6


def test_build_pipecat_runner_is_honest_when_pipecat_absent():
    if pipecat_available():
        pytest.skip("Pipecat is installed; the no-cred honesty path is not exercised")
    # With no Pipecat, the seam raises a CLEAR error instead of crashing at import — and never forces green.
    with pytest.raises(RuntimeError) as ei:
        build_pipecat_runner()
    assert "Pipecat is not installed" in str(ei.value)


def test_build_pipecat_runner_validates_config_when_pipecat_present():
    # When Pipecat IS installed (the real live tier), build_pipecat_runner is the config validator/probe and
    # returns the resolved TransportConfig; the per-connection pipeline builder is a separate, importable seam.
    if not pipecat_available():
        pytest.skip("Pipecat not installed; the live-transport path is not exercised here")
    from voxi_voice.transport import build_pipeline_for_connection  # noqa: F401 — importable seam

    cfg = build_pipecat_runner(TransportConfig())
    assert cfg.kind == "smallwebrtc"
    assert callable(build_pipeline_for_connection)
