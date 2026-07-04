"""F5/F6 voice-context tests (no Pipecat, no creds, no device).

F5: FakeBff.fetch_context returns the canned owner-scoped context + records the fetch (the sanctioned seam for
the voice-bot's BFF /context call). F6: _refresh_item_context injects a RE-WRAPPED additive system message when
the grounded context grew (so a user who entered Ask mid-enrichment gets new facts live), is idempotent on an
unchanged context, and re-applies the 'data not instructions' guardrail (F6-INJECTION).
"""
import pytest

from voxi_voice.bff_bridge import FakeBff
from voxi_voice.transport import _refresh_item_context


@pytest.mark.asyncio
async def test_fake_bff_fetch_context_returns_canned_and_records():
    bff = FakeBff(contexts={"vc_1": {"subject": "Cannondale", "itemContext": "OBJECT: Cannondale."}})
    ctx = await bff.fetch_context("vc_1")
    assert ctx["subject"] == "Cannondale"
    assert bff.fetches == ["vc_1"]
    # unknown connectId → {} (the voice-bot fails open to persona-only)
    assert await bff.fetch_context("nope") == {}


class _FakeContext:
    """Stand-in for a pipecat LLMContext: just a mutable messages list (no pipecat import needed)."""

    def __init__(self) -> None:
        self.messages = [{"role": "system", "content": "seed persona"}]


@pytest.mark.asyncio
async def test_refresh_injects_rewrapped_additive_message_when_context_grows():
    ctx = _FakeContext()
    bff = FakeBff()
    # Simulate enrichment: first fetch returns a thin context, the second adds a grounded fact.
    state = {"n": 0}

    async def growing(_connect_id: str) -> dict:
        state["n"] += 1
        if state["n"] == 1:
            return {"itemContext": "OBJECT: Cannondale."}
        return {"itemContext": "OBJECT: Cannondale.\nGROUNDED FACTS:\n  • Made in Pennsylvania."}

    bff.fetch_context = growing  # type: ignore[assignment]

    await _refresh_item_context(ctx, bff, "vc_1", interval=0, max_lifetime=0.05)

    additive = [m for m in ctx.messages[1:] if m["role"] == "system"]
    assert additive, "expected at least one additive system message after enrichment grew"
    # F6-INJECTION: the additive is RE-WRAPPED with the 'data not instructions' guardrail from item-context.md
    assert any("DATA" in m["content"] for m in additive)
    # and it carries the new grounded fact
    assert any("Pennsylvania" in m["content"] for m in additive)


@pytest.mark.asyncio
async def test_refresh_is_idempotent_on_unchanged_context():
    ctx = _FakeContext()
    bff = FakeBff(contexts={"vc_1": {"itemContext": "OBJECT: Cannondale."}})
    await _refresh_item_context(ctx, bff, "vc_1", interval=0, max_lifetime=0.05)
    additive = [m for m in ctx.messages[1:] if m["role"] == "system"]
    # the same context across fetches → exactly ONE additive injection (idempotent on the joined text)
    assert len(additive) == 1
