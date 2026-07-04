/**
 * assertProdKeys — the boot-time fail-loud for the GLM/Firecrawl secrets the live cascade + worker require.
 *
 * The per-call clients (lib/glm, lib/firecrawl) throw at the seam, but the best-effort retry loops in LiveNarrator /
 * LiveResearcher / the dossier provider SWALLOW throws into honest-empty output — so without this assertion a missing
 * or typo'd secret would boot clean and silently serve blank reveals for hours. On Cloud Run (K_SERVICE) a missing key
 * crash-loops the container loudly BEFORE serve(). A no-op locally + in tests (no K_SERVICE). Mirrors the existing
 * `DATABASE_URL` boot check in the BFF entrypoint.
 */
export const REQUIRED_PROD_KEYS = ['GLM_API_KEY', 'FIRECRAWL_API_KEY'] as const

export function assertProdKeys(
  env: Record<string, string | undefined> = process.env,
  onCloudRun = !!env.K_SERVICE,
): void {
  if (!onCloudRun) return
  const missing = REQUIRED_PROD_KEYS.filter((k) => !env[k]?.trim())
  if (missing.length) {
    throw new Error(
      `missing required prod secrets on Cloud Run: ${missing.join(', ')} — boot aborted`,
    )
  }
}
