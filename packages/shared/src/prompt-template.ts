/**
 * Minimal, zero-dependency prompt-template renderer — a tiny Mustache subset (PLAN §4, §6, §8).
 *
 * This is the mechanism that lets EVERY model-facing prompt live in its own `.md` file instead of being
 * inlined in code. The rule the repo now holds: prompts are English and live in `prompts/*.md`; code supplies
 * only DATA. A prompt file holds the full text with `{{placeholders}}` and conditional / list sections; a
 * caller passes a plain data scope and gets the finished prompt string back — byte-for-byte what used to be
 * assembled inline (the extraction is proven faithful by golden tests next to each prompt).
 *
 * Supported syntax (deliberately small — only what the Voxi prompts need):
 *   {{key}}             — substitute `scope[key]` (String()'d; a missing / null / undefined value → '').
 *   {{#key}}…{{/key}}   — section: render the body IF `key` is truthy. If `key` is an ARRAY, render the body
 *                         once per element with the element's own fields layered over the scope (list section).
 *   {{^key}}…{{/key}}   — inverted section: render the body IF `key` is falsy OR an empty array.
 *
 * Sections may nest and sit side-by-side; a body is matched to its OWN name-tagged close, so
 * `{{#a}}…{{/a}}{{^a}}…{{/a}}` is two independent sections. There is no HTML escaping (prompts are plain text,
 * never HTML), no partials, no lambdas. Rendering is deterministic and pure — same input, same bytes out.
 */

export type PromptScope = Record<string, unknown>

// A section: `{{#name}}body{{/name}}` or `{{^name}}body{{/name}}`. The `\2` backreference ties the close to
// the matching open by name; the lazy body stops at that name's first close, so siblings don't swallow siblings.
const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/
const VAR = /\{\{\s*([\w.]+)\s*\}\}/g

/** A value is "present" for a section if it is a non-empty array, or otherwise plain-truthy. */
const present = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v))

/**
 * Render `template` against `scope`. Sections are resolved first (left-to-right, each body rendered
 * recursively so nesting and list items work), then the remaining `{{var}}` placeholders are substituted.
 */
export function renderTemplate(template: string, scope: PromptScope = {}): string {
  let out = template
  for (let m = SECTION.exec(out); m; m = SECTION.exec(out)) {
    const kind = m[1]!
    const key = m[2]!
    const body = m[3]!
    const val = scope[key]
    let rendered = ''
    if (kind === '#') {
      if (Array.isArray(val)) {
        // List section: render the body once per element, layering the element (if an object) over the scope.
        rendered = val
          .map((item) =>
            renderTemplate(body, item && typeof item === 'object' ? { ...scope, ...(item as PromptScope) } : { ...scope, '.': item }),
          )
          .join('')
      } else if (present(val)) {
        rendered = renderTemplate(body, scope)
      }
    } else if (!present(val)) {
      rendered = renderTemplate(body, scope)
    }
    out = out.slice(0, m.index) + rendered + out.slice(m.index + m[0]!.length)
  }
  return out.replace(VAR, (_full, key: string) => {
    const v = scope[key]
    return v === undefined || v === null ? '' : String(v)
  })
}
