// Metro config for the Expo app inside the bun workspace monorepo. We watch the repo root so imports from
// ../packages/shared resolve, and let Metro resolve hoisted node_modules at the root.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// NOTE: we deliberately do NOT alias "@daily-co/react-native-webrtc" any more. The transport
// (@pipecat-ai/react-native-small-webrtc-transport) requires the Daily-scoped fork, and this app now depends on
// that SAME fork directly (app/package.json) — so the transport, our VoxiAudioMediaManager, and the compiled
// native pod all share ONE WebRTC module. The old alias pointed the transport at the community fork on the
// unverified "the JS APIs are compatible" assumption; the forks diverge at runtime (voice failed to load and
// silently degraded to the deterministic stub on device). Aligning on the fork the transport targets is the fix.

module.exports = config
