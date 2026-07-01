"""
The bot<->BFF<->eve bridge (PLAN §6.3 "Persona+context" tool calls, "Transcript write-back" eng-F5).

Two responsibilities, both auth'd by a per-session SCOPED TOKEN the BFF mints (it carries the same
userId<->sessionId ACL as every other surface — the bot never holds a broad credential):

1. Tool bridge: the live LLM calls eve tools (e.g. catalog_search) THROUGH the BFF, never directly. The
   scoped token is presented as the bearer; the BFF re-checks the ACL and proxies to eve.

2. Transcript write-back: finalized turns are appended via the eve session follow-up endpoint
   `POST /eve/v1/session/:id`. eve stays the SINGLE WRITER (no dual-write to app.messages). Each turn
   carries a per-turn idempotency key, so a reconnect that replays the tail does NOT create duplicate
   turns (TEST-PLAN conv-06). Barge-in partials are committed-as-interrupted or dropped explicitly —
   never written as if complete.

The transport to the BFF is itself an interface (`BffTransport`) so this is testable with no network: the
fake records calls and de-dups on the idempotency key exactly as the real eve endpoint must.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Protocol

from .providers import Turn


@dataclass(frozen=True)
class ScopedToken:
    """A per-session token minted by the BFF. Binds the bot's calls to one (userId, sessionId)."""

    value: str
    user_id: str
    session_id: str


def turn_idempotency_key(session_id: str, turn_index: int, role: str, text: str) -> str:
    """
    Deterministic per-turn key. Includes the turn index AND a content hash so:
      - a reconnect replaying the same (index, role, text) collapses to one write (dedup), and
      - a genuinely new turn at a fresh index is never mistaken for a replay.
    The content hash guards against an index reused with different content (defensive; eve is single-writer).
    """
    digest = hashlib.sha256(f"{role}\n{text}".encode("utf-8")).hexdigest()[:16]
    return f"{session_id}:t{turn_index}:{role}:{digest}"


class BffTransport(Protocol):
    """Network seam to the BFF. Real impl is httpx against the BFF base URL with the scoped token bearer."""

    async def call_tool(self, token: ScopedToken, tool: str, args: dict[str, Any]) -> dict[str, Any]: ...

    async def append_turn(
        self, token: ScopedToken, session_id: str, idempotency_key: str, turn: dict[str, Any]
    ) -> dict[str, Any]: ...


@dataclass
class FakeBff:
    """
    Deterministic in-memory BFF/eve. Models the two invariants the real backend must hold:
      - the scoped token's session_id must match the call's session_id (cross-session denied), and
      - append_turn is idempotent on idempotency_key (the eve single-writer contract).
    `appended` is the canonical turn log a reopened thread would replay (conv-06).
    """

    # tool name -> canned result
    tool_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    appended: list[dict[str, Any]] = field(default_factory=list)
    _seen_keys: set[str] = field(default_factory=set)
    tool_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    rejected_cross_session: int = 0

    async def call_tool(self, token: ScopedToken, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        self.tool_calls.append((tool, args))
        return self.tool_results.get(tool, {"ok": True, "tool": tool, "result": None})

    async def append_turn(
        self, token: ScopedToken, session_id: str, idempotency_key: str, turn: dict[str, Any]
    ) -> dict[str, Any]:
        if token.session_id != session_id:
            # ACL: a token minted for session A cannot write to session B.
            self.rejected_cross_session += 1
            return {"ok": False, "reason": "cross_session_denied"}
        if idempotency_key in self._seen_keys:
            # Idempotent replay (reconnect): acknowledged, but NOT re-appended. No duplicate turn.
            return {"ok": True, "duplicate": True, "idempotency_key": idempotency_key}
        self._seen_keys.add(idempotency_key)
        self.appended.append({"idempotency_key": idempotency_key, "session_id": session_id, **turn})
        return {"ok": True, "duplicate": False, "idempotency_key": idempotency_key}


class TranscriptWriter:
    """
    The SINGLE writer of finalized turns for a session (eng-F5). Owns the per-turn idempotency keying so the
    pipeline just hands it finalized turns; on reconnect it can replay the same turns safely.

    A turn marked `interrupted` (barge-in) is still written — but flagged committed-as-interrupted, never as
    a complete turn — so the transcript honestly reflects what was actually said (conv-06 / §6.3).
    """

    def __init__(self, bff: BffTransport, token: ScopedToken) -> None:
        self._bff = bff
        self._token = token
        self._session_id = token.session_id

    async def write_turn(self, turn_index: int, turn: Turn) -> dict[str, Any]:
        key = turn_idempotency_key(self._session_id, turn_index, turn.role, turn.text)
        payload = {
            "turn_index": turn_index,
            "role": turn.role,
            "text": turn.text,
            "interrupted": turn.interrupted,
        }
        return await self._bff.append_turn(self._token, self._session_id, key, payload)


class ToolBridge:
    """Routes the live LLM's tool calls through the BFF with the scoped token (never a direct eve credential)."""

    def __init__(self, bff: BffTransport, token: ScopedToken) -> None:
        self._bff = bff
        self._token = token

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        return await self._bff.call_tool(self._token, tool, args)
