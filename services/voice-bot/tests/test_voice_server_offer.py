"""
F2 protocol-handler proof for voice_server's /offer routes (B2 trickle-ICE PATCH + B2b restart_pc).

There is NO existing FastAPI TestClient in the suite (the factory drives the transport-agnostic
VoicePipeline core, not the FastAPI app). This is net-new coverage. It exercises the REAL route
dispatch on the real `voice_server.app` via FastAPI's TestClient and asserts the two protocol
guarantees that are checkable headlessly:

  1. POST /offer with restart_pc=true against an existing pc_id forwards restart_pc to
     SmallWebRTCConnection.renegotiate (connection.py:436) — the ICE-restart path. Without this the
     client recreates its PC while the server keeps the stale one (B2b).
  2. PATCH /offer with {pc_id, candidates:[...]} — the EXACT transport wire shape (transport.js
     flushIceCandidates) — is accepted (200, not 405/422) and each candidate reaches
     SmallWebRTCConnection.add_ice_candidate (connection.py:808). An unknown pc_id soft-fails.

The connection object in _connections is a Fake whose methods mirror the REAL connection.py
signatures (verified: renegotiate(self, sdp, type, restart_pc=False) + add_ice_candidate(candidate)).
That is the same sanction the rest of the suite uses (FakeLLM/FakeSTT stand in for credentialed
vendors); a real SmallWebRTCConnection needs the full media stack + creds. The new-connection POST
path (which calls build_pipeline_for_connection) is OUT of scope here — it is device/cred-gated.

A test that POSTs {sdp,type} on PATCH (the wrong wire shape) is forbidden — it would fake-green.
"""

from __future__ import annotations

from typing import Any

import pytest

# voice_server lives at the service root; conftest puts the service dir on sys.path.
import voice_server
from voice_server import app


class FakeConnection:
    """Mirrors the real SmallWebRTCConnection's renegotiate/add_ice_candidate signatures
    (connection.py:436,808). add_ice_candidate receives an aiortc RTCIceCandidate OBJECT (the dict the transport
    sends is converted by the handler via candidate_from_sdp + .sdpMid/.sdpMLineIndex assignment — the reference
    SmallWebRTCRequestHandler.handle_patch_request contract), so the Fake records the attributes aiortc reads."""

    def __init__(self, pc_id: str = "pc_test") -> None:
        self.pc_id = pc_id
        self.renegotiate_calls: list[dict[str, Any]] = []
        self.added_candidates: list[dict[str, Any]] = []

    async def renegotiate(self, sdp: str, type: str, restart_pc: bool = False) -> None:  # noqa: A002 (mirror)
        self.renegotiate_calls.append({"sdp": sdp, "type": type, "restart_pc": restart_pc})

    async def add_ice_candidate(self, candidate: Any) -> None:
        # The real connection.py:808 does `self.pc.addIceCandidate(candidate)`; aiortc reads candidate.sdpMid /
        # .sdpMLineIndex. Capture exactly those attributes + that it is NOT a dict (the prior regression).
        self.added_candidates.append({
            "is_dict": isinstance(candidate, dict),
            "sdpMid": getattr(candidate, "sdpMid", None),
            "sdpMLineIndex": getattr(candidate, "sdpMLineIndex", None),
            "foundation": getattr(candidate, "foundation", None),
        })

    def get_answer(self) -> dict[str, str]:
        return {"pc_id": self.pc_id}


@pytest.fixture()
def installed_connection(monkeypatch: pytest.MonkeyPatch) -> FakeConnection:
    """Seed _connections with a Fake so the existing-connection branches (POST renegotiate + PATCH) run
    without the new-connection POST path (which needs creds)."""
    fake = FakeConnection("pc_test")
    monkeypatch.setitem(voice_server._connections, "pc_test", fake)
    return fake


def test_patch_offer_with_real_transport_shape_forwards_candidates(installed_connection: FakeConnection) -> None:
    """B2: the RN transport PATCHes /offer with {pc_id, candidates} (transport.js flushIceCandidates). The
    server MUST accept it (not 405) and forward each candidate to add_ice_candidate."""
    from fastapi.testclient import TestClient

    candidates = [
        {"candidate": "candidate:842163049 1 udp 1677729535 192.0.2.3 64737 typ srflx", "sdp_mid": "0", "sdp_mline_index": 0},
        {"candidate": "candidate:842163049 2 udp 1677729535 192.0.2.3 64738 typ relay", "sdp_mid": "0", "sdp_mline_index": 0},
    ]
    with TestClient(app) as client:
        resp = client.patch("/offer", json={"pc_id": "pc_test", "candidates": candidates})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    # Both candidates reached add_ice_candidate as PARSED RTCIceCandidate objects (NOT dicts — the silent
    # regression that dropped every relay candidate), with .sdpMid mapped from the transport's snake_case
    # sdp_mid. A relay candidate (typ relay) is the whole point of TURN; without correct conversion it never
    # reaches aiortc.
    assert len(installed_connection.added_candidates) == 2
    assert [c["is_dict"] for c in installed_connection.added_candidates] == [False, False]
    assert [c["sdpMid"] for c in installed_connection.added_candidates] == ["0", "0"]
    assert [c["sdpMLineIndex"] for c in installed_connection.added_candidates] == [0, 0]


def test_patch_offer_unknown_pc_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """A PATCH for a closed/unknown peer is a soft-fail ({ok:false}), never a 5xx — the client has already
    moved on or will reconnect."""
    from fastapi.testclient import TestClient

    monkeypatch.setattr(voice_server, "_connections", {})
    with TestClient(app) as client:
        resp = client.patch("/offer", json={"pc_id": "pc_gone", "candidates": []})
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "error": "unknown_pc"}


def test_post_offer_restart_pc_is_forwarded_to_renegotiate(installed_connection: FakeConnection) -> None:
    """B2b: the renegotiation POST carries restart_pc (transport.js negotiate→recreatePeerConnection). The
    server forwards it to renegotiate(restart_pc=…) so the aiortc PC restarts in lockstep with the client's."""
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        resp = client.post(
            "/offer",
            json={"sdp": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n", "type": "offer", "pc_id": "pc_test", "restart_pc": True},
        )
    assert resp.status_code == 200, resp.text
    # The existing-connection branch forwarded restart_pc=True (the B2b fix); without the fix it would be False.
    assert installed_connection.renegotiate_calls == [
        {"sdp": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n", "type": "offer", "restart_pc": True}
    ]


def test_ice_server_config_reads_turn_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """F1 (server): STUN + env-driven TURN. Default-off (unset → STUN-only); comma-separated → N entries."""
    monkeypatch.delenv("TURN_URL", raising=False)
    monkeypatch.delenv("TURN_USER", raising=False)
    monkeypatch.delenv("TURN_PASS", raising=False)
    assert voice_server._ice_server_config() == [{"urls": "stun:stun.l.google.com:19302"}]

    monkeypatch.setenv("TURN_URL", "turn:turn-a.example.com:3478, turn:turn-b.example.com:5349")
    monkeypatch.setenv("TURN_USER", "voxi")
    monkeypatch.setenv("TURN_PASS", "s3cret")
    servers = voice_server._ice_server_config()
    assert servers[0] == {"urls": "stun:stun.l.google.com:19302"}
    assert servers[1:] == [
        {"urls": "turn:turn-a.example.com:3478", "username": "voxi", "credential": "s3cret"},
        {"urls": "turn:turn-b.example.com:5349", "username": "voxi", "credential": "s3cret"},
    ]
