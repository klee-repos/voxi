/**
 * test-bff.ts — the deterministic BFF the NATIVE iOS Maestro tier hits at http://localhost:8799/api (the iOS
 * Simulator shares the host network, so localhost resolves to this process). It is the SAME `createWebHarness`
 *
 * The port is 8799 (NOT 8787) ON PURPOSE: 8787 is the LAN dev BFF (`scripts/dev.sh` / `services/voxi-api`), so if
 * the maestro tier shared it, restarting the dev server would silently displace this fake and the maestro build
 * (which bakes /api) would get `Not Found` from the /v1 dev server → a "JSON Parse error" reveal. A dedicated port
 * lets the native tier and a running dev server coexist. Keep this in sync with `app/eas.json` (maestro profile).
 * the web/Playwright tier uses — faked eve stream (eveStreamFor), fake TTS, seeded metering — so reveals are
 * deterministic with zero vendor spend; the only difference from app-harness-server.ts is that the client is the
 * real native binary over HTTP, so there is no app bundle to serve.
 *
 * Boot: `bun e2e/native/test-bff.ts` (or the `e2e:native:bff` script). The maestro build bakes
 * EXPO_PUBLIC_API_BASE_URL=http://localhost:8799/api so `${base}/v1/threads` lands on `/api/v1/threads` here.
 */
import { createWebHarness } from '../web/server'

const port = Number(process.env.VOXI_TEST_BFF_PORT ?? 8799) // 8799, not 8787 (the dev BFF) — see the header note

const harness = createWebHarness({
  // `converge` is the default fake user (email converge@… → bearer test:converge); `paywalluser` drives the
  // metering 402 → paywall path. Entitlements are generous so multi-capture sweeps don't hit the scan cap.
  seed: {
    converge: { scan: 25, podcast: 5, voiceMin: 30 },
    paywalluser: { scan: 0, podcast: 0, voiceMin: 0 },
  },
  plans: { converge: 'explorer' },
})

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) return harness.fetch(req)
    return new Response('voxi test-bff (native maestro tier)', { status: url.pathname === '/' ? 200 : 404 })
  },
})

process.stdout.write(`voxi test-bff listening on http://localhost:${server.port}/api (VOXI_TEST_MODE, deterministic)\n`)
