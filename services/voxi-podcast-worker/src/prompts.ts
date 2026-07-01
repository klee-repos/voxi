/**
 * Prompt loader for the podcast worker (PLAN §6.2). Mirrors the eve-agent loader: every model-facing prompt
 * lives in `src/prompts/*.md`, read once (cached) relative to THIS module, rendered against a plain data scope.
 * Kept per-service (not in `packages/shared`) so the shared package stays free of `node:fs` and safe to bundle
 * into the RN/web client; only the pure renderer is shared.
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
