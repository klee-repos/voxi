"""The voice-bot structured logger — stdout NDJSON shape + redaction. No creds, no network."""

from __future__ import annotations

import json

from voxi_voice.telemetry import Logger, _redact_value, get_logger


def _capture(capsys, fn) -> dict:
    fn()
    out = capsys.readouterr().out.strip()
    assert out, "expected one NDJSON line on stdout"
    return json.loads(out.splitlines()[-1])


def test_info_emits_ndjson_with_core_fields(capsys) -> None:
    log = get_logger("voxi-voice", role="voice")
    rec = _capture(capsys, lambda: log.info("offer accepted", pc_id="pc_1", live_connections=2))
    assert rec["level"] == "info"
    assert rec["service"] == "voxi-voice"
    assert rec["role"] == "voice"
    assert rec["msg"] == "offer accepted"
    assert rec["pc_id"] == "pc_1"
    assert rec["live_connections"] == 2
    assert "time" in rec


def test_error_captures_exception_type_and_message(capsys) -> None:
    log = get_logger("voxi-voice")
    rec = _capture(capsys, lambda: log.error("pipeline failed", err=ValueError("boom")))
    assert rec["level"] == "error"
    assert rec["err"]["type"] == "ValueError"
    assert rec["err"]["message"] == "boom"


def test_bind_carries_fields(capsys) -> None:
    log = get_logger("voxi-voice").bind(session_id="sess_1")
    rec = _capture(capsys, lambda: log.info("turn"))
    assert rec["session_id"] == "sess_1"


def test_redaction_strips_secrets_and_data_uris() -> None:
    out = _redact_value({"authorization": "Bearer x", "photo": "data:image/jpeg;base64," + "A" * 5000})
    assert out["authorization"] == "[redacted]"
    assert out["photo"].startswith("[data-uri ")


def test_isinstance_logger() -> None:
    assert isinstance(get_logger(), Logger)
