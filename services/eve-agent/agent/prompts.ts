/**
 * Prompt loader for the eve agent (PLAN §4). Every model-facing prompt lives in `agent/prompts/*.md`; this is
 * the ONLY place code reads them. Loading is SYNC (readFileSync) on purpose: callers like `researchPrompt()`
 * are synchronous and unit-tested that way, so introducing an `await` here would ripple through the cascade.
 *
 * Paths resolve relative to THIS module's directory, so a prompt is found no matter which service imports the
 * provider (the BFF pulls in `LiveNarrator`, the worker pulls in the vision lib, …). Templates are cached after
 * first read — prompts are static assets, not hot-reloaded state.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTemplate, type PromptScope } from '../../../packages/shared/src/prompt-template'

const DIR = join(import.meta.dir, 'prompts')
const cache = new Map<string, string>()

/** Read a prompt template verbatim (cached). Use for static prompts with no placeholders. */
export function loadPrompt(name: string): string {
  let t = cache.get(name)
  if (t === undefined) {
    t = readFileSync(join(DIR, name), 'utf8')
    cache.set(name, t)
  }
  return t
}

/** Load a prompt template and render it against `scope`. Use for prompts with `{{placeholders}}`/sections. */
export function renderPrompt(name: string, scope: PromptScope = {}): string {
  return renderTemplate(loadPrompt(name), scope)
}
