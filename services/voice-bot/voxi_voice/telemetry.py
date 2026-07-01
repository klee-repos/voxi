"""Structured logging + optional OTLP export for the voice-bot — the Python twin of @voxi/telemetry.

Stdlib only (no third-party deps), so it stays import-safe in the no-cred sandbox where the voice-bot's core
`dependencies = []` invariant holds. Every call writes ONE line of NDJSON to stdout (the always-on local
capture); when OTEL_EXPORTER_OTLP_ENDPOINT is set it ALSO ships an OTLP/HTTP log record to the collector /
Grafana Cloud, on a daemon thread so a slow or down endpoint never blocks the media loop.

    from voxi_voice.telemetry import get_logger
    log = get_logger("voxi-voice", role="voice")
    log.info("offer accepted", pc_id=pc_id, has_item_context=bool(item_context))
    log.error("pipeline failed", err=exc)
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
_SERVICE = os.getenv("OTEL_SERVICE_NAME", "voxi-voice")
_ENV = os.getenv("VOXI_ENV") or os.getenv("NODE_ENV") or "development"
_VERSION = os.getenv("VOXI_VERSION")

_LEVEL_RANK = {"debug": 10, "info": 20, "warn": 30, "error": 40, "fatal": 50}
_SEVERITY = {"debug": 5, "info": 9, "warn": 13, "error": 17, "fatal": 21}
_MIN_RANK = _LEVEL_RANK.get(os.getenv("LOG_LEVEL", "info").lower(), 20)

_SENSITIVE = {
    "authorization", "cookie", "set-cookie", "x-worker-secret", "password", "passwd",
    "secret", "token", "api_key", "apikey", "api-key", "jwt", "bearer", "signing_key",
    "continuation_token",
}


def _parse_headers(raw: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for pair in (raw or "").split(","):
        if "=" in pair:
            k, _, v = pair.partition("=")
            k = k.strip()
            if k:
                out[k] = v.strip()
    return out


_HEADERS = {"content-type": "application/json", **_parse_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS"))}

_RESOURCE_ATTRS = [
    {"key": "service.name", "value": {"stringValue": _SERVICE}},
    {"key": "service.namespace", "value": {"stringValue": "voxi"}},
    {"key": "deployment.environment", "value": {"stringValue": _ENV}},
]
if _VERSION:
    _RESOURCE_ATTRS.append({"key": "service.version", "value": {"stringValue": _VERSION}})

_otlp_failures = 0


def _redact_value(v: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "[deep]"
    if isinstance(v, str):
        if v.startswith("data:"):
            return f"[data-uri {len(v)}b]"
        return v if len(v) <= 2048 else v[:256] + f"…[+{len(v) - 256}b]"
    if isinstance(v, dict):
        return {k: ("[redacted]" if k.lower() in _SENSITIVE else _redact_value(val, depth + 1)) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_redact_value(x, depth + 1) for x in v]
    return v


def _any_value(v: Any) -> dict:
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    return {"stringValue": json.dumps(v, default=str)}


def _post_otlp(record: dict, ts_ns: int, level: str) -> None:
    """Fire-and-forget OTLP/HTTP logs export on a daemon thread. Best-effort; never raises into the caller."""
    payload = {
        "resourceLogs": [
            {
                "resource": {"attributes": _RESOURCE_ATTRS},
                "scopeLogs": [
                    {
                        "scope": {"name": "voxi.telemetry"},
                        "logRecords": [
                            {
                                "timeUnixNano": str(ts_ns),
                                "severityNumber": _SEVERITY[level],
                                "severityText": level.upper(),
                                "body": {"stringValue": record.get("msg", "")},
                                "attributes": [
                                    {"key": k, "value": _any_value(val)}
                                    for k, val in record.items()
                                    if k not in ("msg", "time", "level", "service", "env", "role")
                                ],
                            }
                        ],
                    }
                ],
            }
        ]
    }

    def _send() -> None:
        global _otlp_failures
        try:
            req = urllib.request.Request(
                _ENDPOINT + "/v1/logs",
                data=json.dumps(payload).encode("utf-8"),
                headers=_HEADERS,
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5).close()
        except Exception as e:  # noqa: BLE001 — telemetry must never take down the caller
            _otlp_failures += 1
            if _otlp_failures == 1 or _otlp_failures % 100 == 0:
                sys.stderr.write(f"[telemetry] OTLP /v1/logs failed: {e} (failure #{_otlp_failures})\n")

    threading.Thread(target=_send, daemon=True).start()


class Logger:
    def __init__(self, service: str, role: str | None = None, bound: dict | None = None) -> None:
        self.service = service
        self.role = role
        self.bound = bound or {}

    def bind(self, **fields: Any) -> "Logger":
        return Logger(self.service, self.role, {**self.bound, **fields})

    def _log(self, level: str, msg: str, err: BaseException | None = None, **fields: Any) -> None:
        if _LEVEL_RANK[level] < _MIN_RANK:
            return
        now = time.time()
        record: dict[str, Any] = {
            "time": datetime.fromtimestamp(now, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": level,
            "service": self.service,
            "env": _ENV,
        }
        if self.role:
            record["role"] = self.role
        record["msg"] = msg
        if err is not None:
            record["err"] = {"type": type(err).__name__, "message": str(err)}
        record.update(_redact_value({**self.bound, **fields}))
        sys.stdout.write(json.dumps(record, default=str) + "\n")
        sys.stdout.flush()
        if _ENDPOINT:
            _post_otlp(record, int(now * 1_000_000_000), level)

    def debug(self, msg: str, **f: Any) -> None:
        self._log("debug", msg, **f)

    def info(self, msg: str, **f: Any) -> None:
        self._log("info", msg, **f)

    def warn(self, msg: str, err: BaseException | None = None, **f: Any) -> None:
        self._log("warn", msg, err=err, **f)

    def error(self, msg: str, err: BaseException | None = None, **f: Any) -> None:
        self._log("error", msg, err=err, **f)

    def fatal(self, msg: str, err: BaseException | None = None, **f: Any) -> None:
        self._log("fatal", msg, err=err, **f)


def get_logger(service: str = _SERVICE, role: str | None = None) -> Logger:
    return Logger(service, role)
