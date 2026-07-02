/**
 * Microphone permission seam (PLAN §10.2 screen 2 / §15 — mic = voice chat; prime BEFORE the OS prompt).
 *
 * vision-camera exposes `Camera.requestMicrophonePermission()` natively; the module is absent in the E2E web
 * harness, so the request is lazy + guarded. The harness pins the resolved status via `EXPO_PUBLIC_MIC_PERMISSION`
 * (granted | denied | undetermined) so the priming/denied paths are reachable without a device.
 */
import { Platform } from 'react-native'

export type MicPermissionStatus = 'undetermined' | 'granted' | 'denied'

/** Env-pinned status for the harness so the denied/undetermined states are reachable in E2E. */
function envStatus(): MicPermissionStatus {
  const v = (process.env.EXPO_PUBLIC_MIC_PERMISSION ?? '').toLowerCase()
  if (v === 'denied') return 'denied'
  if (v === 'undetermined') return 'undetermined'
  if (v === 'granted') return 'granted'
  // Default: granted on web (priming is informational; the real mic prompt happens at first voice session).
  return Platform.OS === 'web' ? 'granted' : 'granted'
}

/** Request microphone access (voice chat). Native → vision-camera; web/harness → env-pinned (granted default). */
export async function requestMicPermission(): Promise<MicPermissionStatus> {
  if (Platform.OS !== 'web') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vc = require('react-native-vision-camera') as typeof import('react-native-vision-camera')
      const res = await vc.Camera.requestMicrophonePermission()
      return res === 'granted' ? 'granted' : 'denied'
    } catch {
      /* no native module — fall through to the env-pinned harness status */
    }
  }
  return envStatus()
}
