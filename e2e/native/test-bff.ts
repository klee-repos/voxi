/**
 * test-bff.ts — the deterministic BFF the NATIVE iOS Maestro tier hits at http://localhost:8787/api (the iOS
 * Simulator shares the host network, so localhost resolves to this process). It is the SAME `createWebHarness`
 * the web/Playwright tier uses — faked eve stream (eveStreamFor), fake TTS, seeded metering — so reveals are
 * deterministic with zero vendor spend; the only difference from app-harness-server.ts is that the client is the
 * real native binary over HTTP, so there is no app bundle to serve.
 *
 * Boot: `bun e2e/native/test-bff.ts` (or the `e2e:native:bff` script). The maestro build bakes
 * EXPO_PUBLIC_API_BASE_URL=http://localhost:8787/api so `${base}/v1/threads` lands on `/api/v1/threads` here.
 */
import { createWebHarness } from '../web/server'

const port = Number(process.env.VOXI_TEST_BFF_PORT ?? 8787)

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
