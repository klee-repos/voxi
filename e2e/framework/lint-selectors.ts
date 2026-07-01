/**
 * Selector lint (PLAN testing brief: "no brittle/cheating selectors").
 *
 * Committed scenarios may locate elements ONLY by ids from the testid registry. This guard fails CI if a
 * scenario uses raw coordinate taps, raw CSS/XPath, or string-literal selectors instead of `ids.*`. Run via
 * `bun run lint:selectors`.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { allIds } from './testids'

const BANNED: { re: RegExp; why: string }[] = [
  { re: /\btapAt\s*\(|\bclick\s*\(\s*\d+\s*,\s*\d+/, why: 'coordinate tap (brittle)' },
  // page.locator(...) is allowed ONLY for a registry-bound [data-testid="..."] selector; raw CSS/id/class is banned.
  { re: /\b(?:page|frame)\.locator\s*\(\s*['"`](?!\[data-testid)/, why: 'raw locator string — only [data-testid="..."] allowed (use ids.*)' },
  { re: /\bxpath\s*=|\/\/\*\[@/, why: 'XPath selector (use ids.*)' },
  { re: /\bgetByText\s*\(/, why: 'text selector for an interactive element (use ids.*)' },
]

// Literal testid references (NOT `${ids…}` interpolations) — these must exist in the registry or they're typos
// that would silently never match. Covers TS (`data-testid="x"`, `find testid x`) and Maestro yaml (`id: "x"`).
const LITERAL_REFS: RegExp[] = [
  /data-testid=["'`]([a-zA-Z][\w.]*)["'`]/g,
  /\bfind\s+testid\s+([a-zA-Z][\w.]*)/g,
  /\bid:\s*["']([a-zA-Z][\w.]*)["']/g,
]

/** Files whose selectors are governed by the contract: scenarios, the executed web runners, and Maestro flows. */
function isGoverned(f: string): boolean {
  return (
    f.endsWith('.scenario.ts') ||
    f.endsWith('.spec.ts') ||
    /(?:^|\/)run-[\w-]+\.web\.ts$/.test(f) ||
    /(?:^|\/)converge\/[\w-]+\.web\.ts$/.test(f) ||
    /(?:^|\/)flows\/[\w-]+\.yaml$/.test(f)
  )
}

export async function lintSelectors(dir: string): Promise<{ ok: boolean; violations: string[] }> {
  const violations: string[] = []
  const registry = allIds()
  const files = (await readdir(dir, { recursive: true } as { recursive: true }))
    .filter((f) => typeof f === 'string' && isGoverned(f))

  for (const f of files) {
    const path = join(dir, f as string)
    const src = await Bun.file(path).text()
    src.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#')) return
      for (const b of BANNED) {
        if (b.re.test(line)) violations.push(`${f}:${i + 1} — ${b.why}: ${line.trim().slice(0, 80)}`)
      }
      // registry-membership: a literal testid that isn't in testids.ts is a typo and a silent no-match.
      for (const re of LITERAL_REFS) {
        for (const m of line.matchAll(re)) {
          const id = m[1]
          if (id.includes('.') && !registry.has(id)) {
            violations.push(`${f}:${i + 1} — testid "${id}" is not in the registry (typo?): ${line.trim().slice(0, 80)}`)
          }
        }
      }
    })
  }
  return { ok: violations.length === 0, violations }
}

if (import.meta.main) {
  // default: the whole e2e/ tree (covers e2e/scenarios/*.scenario.ts AND e2e/web/run-*.web.ts — the real CI backbone).
  const target = process.argv[2] ?? join(import.meta.dir, '..')
  const { ok, violations } = await lintSelectors(target)
  if (!ok) {
    console.error('selector lint failed:\n' + violations.join('\n'))
    process.exit(1)
  }
  console.log('selector lint passed')
}
