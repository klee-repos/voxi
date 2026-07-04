/**
 * Voxi root agent — model config + workflow world (PLAN §4.2, §4.4, §22.3).
 *
 * This is the SINGLE root eve agent ("Voxi"), filesystem-first. It declares:
 *   - the brain (model) default: GLM-5-Turbo via `@ai-sdk/openai-compatible`, with compaction on;
 *   - the workflow WORLD = postgres (`@workflow/world-postgres`) — the durable seam that the G3 spike proves
 *     can be self-hosted off Vercel (split front/poller topology, §4.4);
 *   - the registry of tools / subagents / skills / schedules / channel the runtime wires up.
 *
 * HONESTY (PLAN §22.3): self-hosting the eve agent layer off Vercel is *unproven on the public record*; G3 is
 * the existence proof. So this file is written as a **thin adapter** (PLAN §4.5): the concrete `eve` /
 * `@workflow/*` imports are loaded LAZILY through `loadEveRuntime()` and contained to one module, so an API
 * break (or the framework simply not being installable here) is a one-file blast radius and the rest of the
 * agent layer (tools, subagents, schedules — all pure TS) keeps compiling and testing with no creds.
 *
 * Nothing here forces a green: the config is REAL (it is exactly what the runtime would consume); the only
 * thing deferred is binding it to a live eve process, which needs the pinned toolchain + a Postgres world.
 */
import { z } from 'zod'

/** The brain default for the root agent (PLAN §4.2). */
export const MODEL = {
  /** kept as a string so this file imports nothing live. */
  provider: '@ai-sdk/openai-compatible',
  id: 'glm-5-turbo',
  /** compaction on — long durable threads must not blow the context window (PLAN §4.2). */
  compaction: true,
} as const

/**
 * Workflow world = postgres (PLAN §4.2/§4.4). The durable session/checkpoint store is `@workflow/world-postgres`,
 * which is NOT serverless-compatible (needs a long-lived poller + LISTEN/NOTIFY) — hence the split topology.
 * `WORLD_DATABASE_URL` points at Cloud SQL in prod / the local pgvector container in the spike.
 */
export const WORLD = {
  kind: 'postgres',
  pkg: '@workflow/world-postgres',
  /** env var the runtime reads for the world DSN (never hardcode a DSN). */
  dsnEnv: 'WORLD_DATABASE_URL',
} as const

/** A process plays exactly one role in the split topology (§4.4). The front streams; the poller advances runs. */
export type WorkflowRole = 'front' | 'poller'

/** Read the role from the environment, defaulting to `front` (the stateless HTTP/streaming half). */
export function roleFromEnv(env: Record<string, string | undefined> = process.env): WorkflowRole {
  return env.WORKFLOW_ROLE === 'poller' ? 'poller' : 'front'
}

/**
 * The agent registry — the inventory the eve runtime mounts. Pure data (no live imports) so it is unit-testable
 * and the G3 boot spike can assert the wiring without a running framework. Paths are relative to `agent/`.
 */
export const AGENT = {
  name: 'voxi',
  instructions: 'instructions.md',
  channel: 'channels/eve.ts',
  model: MODEL,
  world: WORLD,
  tools: [
    'tools/identify_object.ts',
    'tools/catalog_search.ts',
    'tools/safety_gate.ts',
    'tools/web_research.ts',
  ],
  subagents: ['subagents/storyteller', 'subagents/interviewer', 'subagents/researcher'],
  skills: [
    'skills/voice.md',
    'skills/interview-unknown-item/SKILL.md',
    'skills/contribute-tip.md',
  ],
  schedules: ['schedules/dedup.ts', 'schedules/promote.ts'],
} as const

/** Zod schema validating the registry shape — used by the boot spike to fail loudly on a malformed config. */
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().endsWith('.md'),
  channel: z.string().endsWith('.ts'),
  model: z.object({ provider: z.string(), id: z.string(), compaction: z.boolean() }),
  world: z.object({ kind: z.literal('postgres'), pkg: z.string(), dsnEnv: z.string() }),
  tools: z.array(z.string()).min(1),
  subagents: z.array(z.string()),
  skills: z.array(z.string()),
  schedules: z.array(z.string()),
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>

/**
 * Lazily load the live eve runtime. THIS is the contained `@workflow/*` adapter (PLAN §4.5): the only place
 * that touches the (pre-GA, churn-prone) framework. It is dynamic so the rest of the module — and the whole
 * agent layer — imports and tests with the framework ABSENT (the sandbox reality). The G3 boot spike calls
 * this and records the EXACT outcome (boots / which import breaks).
 */
export async function loadEveRuntime(): Promise<{
  ok: true
  Agent: unknown
  world: unknown
  model: unknown
} | { ok: false; error: string; stage: 'eve' | 'world' | 'model' }> {
  let eveMod: unknown
  try {
    // @ts-expect-error — resolved at runtime only when the pinned toolchain is installed (absent in sandbox).
    eveMod = await import('eve')
  } catch (e) {
    return { ok: false, error: (e as Error).message, stage: 'eve' }
  }
  let worldMod: unknown
  try {
    // @ts-expect-error — resolved at runtime only when installed.
    worldMod = await import('@workflow/world-postgres')
  } catch (e) {
    return { ok: false, error: (e as Error).message, stage: 'world' }
  }
  let modelMod: unknown
  try {
    // @ts-expect-error — resolved at runtime only when the pinned toolchain is installed.
    modelMod = await import('@ai-sdk/openai-compatible')
  } catch (e) {
    return { ok: false, error: (e as Error).message, stage: 'model' }
  }
  // GLM (z.ai) speaks the OpenAI-compatible protocol; the provider must be CONSTRUCTED with baseURL + apiKey (unlike
  // @ai-sdk/anthropic's ready `anthropic` factory). Fail loud on a missing key — never a fake model handle.
  const glmKey = process.env.GLM_API_KEY
  if (!glmKey) return { ok: false, error: 'GLM_API_KEY is not set', stage: 'model' }
  const createOic = (modelMod as {
    createOpenAICompatible: (o: { baseURL: string; apiKey: string; name: string }) => unknown
  }).createOpenAICompatible
  if (!createOic) return { ok: false, error: 'createOpenAICompatible export not found', stage: 'model' }
  const provider = createOic({
    baseURL: process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/paas/v4/',
    apiKey: glmKey,
    name: 'glm',
  })
  return {
    ok: true,
    Agent: (eveMod as { Agent?: unknown }).Agent,
    world: (worldMod as { world?: unknown }).world ?? worldMod,
    model: provider,
  }
}

/** Validate the static registry (the boot spike's first, creds-free check). Throws on a malformed config. */
export function validateAgentConfig(cfg: unknown = AGENT): AgentConfig {
  // AGENT is `as const` (readonly tuples); parse through Zod, which returns a fresh mutable AgentConfig.
  return AgentConfigSchema.parse(cfg)
}
