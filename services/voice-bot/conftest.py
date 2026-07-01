"""
pytest bootstrap: ensure the package is importable when running from the service dir, and configure
pytest-asyncio's auto mode so `async def test_*` functions run without a per-test decorator.
"""

import os
import sys

# Make `import voxi_voice` work whether pytest is invoked from the repo root or this service dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# HARD-FAIL (never silently skip) if pytest-asyncio is absent. asyncio_mode=auto means the 13 load-bearing
# async tests (metering hard-cutoff, persona/voice consistency, transcript-writeback idempotency, cross-session
# denial, tool-bridge scoping) would otherwise be SILENTLY SKIPPED while pytest still exits 0 — a false green.
# A missing plugin is a setup error, not a pass. (Audit finding F1.)
try:
    import pytest_asyncio  # noqa: F401
except ImportError as exc:  # pragma: no cover - environment guard
    raise RuntimeError(
        "pytest-asyncio is required to run the voice-bot suite (asyncio_mode=auto); without it the async "
        "tests are silently skipped. Install it: `pip install pytest-asyncio` (see pyproject [test] extra)."
    ) from exc
