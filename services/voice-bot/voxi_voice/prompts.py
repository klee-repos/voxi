"""
Prompt loader + renderer for the voice bot (PLAN §6.3, §8.1) — the Python twin of the TS prompt system.

Every model-facing prompt lives in `voxi_voice/prompts/*.md`; this module is the ONLY place code reads them.
It carries a minimal Mustache subset so a prompt file can hold the full text with `{{placeholders}}` and
conditional / list sections, and code supplies only DATA. Loading is relative to THIS module, cached after
first read; rendering is deterministic and pure. Replacements are inserted verbatim and never re-scanned, so
untrusted item context substituted into a template can never smuggle in template syntax.

Supported syntax (kept identical to `packages/shared/src/prompt-template.ts`):
  {{key}}             substitute scope[key] (str()'d; missing / None -> "").
  {{#key}}...{{/key}} section: render body if key is truthy; if key is a list, render once per item with the
                      item's fields (when a dict) layered over the scope.
  {{^key}}...{{/key}} inverted section: render body if key is falsy or an empty list.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Mapping

_SECTION = re.compile(r"\{\{([#^])\s*([\w.]+)\s*\}\}(.*?)\{\{/\s*\2\s*\}\}", re.DOTALL)
_VAR = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")

_DIR = Path(__file__).parent / "prompts"
_cache: dict[str, str] = {}


def _present(v: Any) -> bool:
    """A value is 'present' for a section if it is a non-empty list/tuple, or otherwise plain-truthy."""
    if isinstance(v, (list, tuple)):
        return len(v) > 0
    return bool(v)


def render_template(template: str, scope: Mapping[str, Any] | None = None) -> str:
    """Render `template` against `scope`: resolve sections (recursively, so nesting/lists work), then vars."""
    scope = scope or {}
    out = template
    while True:
        m = _SECTION.search(out)
        if not m:
            break
        kind, key, body = m.group(1), m.group(2), m.group(3)
        val = scope.get(key)
        if kind == "#":
            if isinstance(val, (list, tuple)):
                parts = []
                for item in val:
                    child = {**scope, **item} if isinstance(item, Mapping) else {**scope, ".": item}
                    parts.append(render_template(body, child))
                rendered = "".join(parts)
            elif _present(val):
                rendered = render_template(body, scope)
            else:
                rendered = ""
        else:  # inverted section
            rendered = render_template(body, scope) if not _present(val) else ""
        out = out[: m.start()] + rendered + out[m.end() :]

    def _sub(mo: re.Match[str]) -> str:
        v = scope.get(mo.group(1))
        return "" if v is None else str(v)

    return _VAR.sub(_sub, out)


def load_prompt(name: str) -> str:
    """Read a prompt template verbatim (cached). Use for static prompts with no placeholders."""
    if name not in _cache:
        _cache[name] = (_DIR / name).read_text(encoding="utf-8")
    return _cache[name]


def render_prompt(name: str, scope: Mapping[str, Any] | None = None) -> str:
    """Load a prompt template and render it against `scope`. Use for prompts with `{{placeholders}}`/sections."""
    return render_template(load_prompt(name), scope)
