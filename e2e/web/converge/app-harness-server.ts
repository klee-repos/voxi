/**
 * app-harness-server.ts — standalone-process server that serves the SHARED full-app converge bundle (app-client)
 * over the REAL voxi-api BFF, for the agent-browser explore runner (agentic-explore-ab).
 *
 * WHY A SEPARATE PROCESS: agent-browser's persistent daemon inherits the spawning process's open fds. If the same
 * process that drives agent-browser also held an in-process `Bun.serve` LISTENING SOCKET, the daemon would inherit
 * and hold it and the launch handshake would block forever. Running the server HERE, in its own process, means the
 * agent-browser-driving process (agentic-explore-ab.web.ts) holds no listening socket to leak.
 *
 * Same REAL screens + REAL BFF as the Playwright agentic runners (the app-client bundle under react-native-web);
 * the only difference is the perception/action backend. The RNW press-readiness shim (a plain-function window.fetch
 * at bundle load — see converge/harness.ts) is inlined into the HOST here so a real click fires onPress under
 * agent-browser too, exactly as page.addInitScript provides it for Playwright.
 */
import { buildConvergeBundle } from './harness'
import { createWebHarness } from '../server'

const bundleJs = await buildConvergeBundle('app-client.tsx')

// #root fills the viewport (a full-bleed screen's flex chain needs a concrete height) + the RNW press shim, inline
// so any browser (Playwright OR agent-browser) gets it before the bundle loads.
const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>voxi app</title><style>
html,body{height:100%;margin:0;padding:0}
#root{height:100vh;display:flex;flex-direction:column}
#root>*{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
</style><script>(function(){var f=window.fetch.bind(window);window.fetch=function(){return f.apply(null,arguments)};})();</script></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>`

const harness = createWebHarness({
  seed: Object.fromEntries(['abx', 'aby'].map((u) => [u, { scan: 5, podcast: 1, voiceMin: 10 }])),
})

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') return new Response(HOST, { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/bundle.js') return new Response(bundleJs, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname.startsWith('/api/')) return harness.fetch(req)
    return new Response('not found', { status: 404 })
  },
})

// Announce the chosen ephemeral port on stdout so the parent can read it, then stay alive until killed.
process.stdout.write(JSON.stringify({ port: server.port }) + '\n')
