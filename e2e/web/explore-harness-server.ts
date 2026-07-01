/**
 * Standalone harness-server entrypoint for the agent-browser explore runner.
 *
 * WHY A SEPARATE PROCESS: agent-browser's persistent daemon inherits the open file descriptors of whatever
 * process spawns it (a detached fork that does not set close-on-exec on inherited fds). If the SAME process
 * that drives agent-browser also holds an in-process `Bun.serve` LISTENING SOCKET, the daemon inherits and
 * holds that socket fd open, and the launching `spawnSync` blocks on the daemon handshake forever — this is
 * the documented "in-process spawnSync hangs on its persistent daemon." Redirecting stdout does NOT fix it,
 * because the inherited resource is the listening socket, not stdout. Running the harness HERE, in its own
 * process, means the agent-browser-driving process holds no long-lived listening socket for the daemon to
 * inherit — so every command returns in tens of ms. (run-explore-mcp.web.ts spawns this and reads the port.)
 *
 * Same real BFF + web shell as every other web runner (createWebHarness): the only fakes are the seeded,
 * deterministic vendor collaborators — never a stub that forces green.
 */
import { createWebHarness } from './server'

// The web shell signs in as `test:<email-localpart>`, and BFF metering is per-user. The explore sweep uses a
// DISTINCT seeded user per round (its localpart is the key) so each round has its own entitlements + its own
// (initially empty) collection — e.g. the empty-state round signs in as a user that never captures.
// One scan each is enough; rounds that don't capture (empty-state, settings) simply leave their scan unused.
const seed = Object.fromEntries(
  ['expa', 'expb', 'expc', 'expd', 'expe', 'expf'].map((u) => [u, { scan: 1, podcast: 1, voiceMin: 10 }]),
)

const { fetch } = createWebHarness({ seed })
const server = Bun.serve({ port: 0, fetch })

// Announce the chosen ephemeral port on stdout so the parent can read it, then stay alive until killed.
process.stdout.write(JSON.stringify({ port: server.port }) + '\n')

const shutdown = () => {
  server.stop()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Keep the event loop alive; the parent terminates us when the sweep finishes.
await new Promise<void>(() => {})
