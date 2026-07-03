/**
 * Camera permission seam (PLAN §10.2 screen 3 — permission-denied is a first-class state, §10.2 state matrix).
 *
 * vision-camera's `Camera.getCameraPermissionStatus()` / `requestCameraPermission()` are native-only and the
 * module isn't present in the E2E web harness. This seam exposes the same three-state contract the camera
 * screen renders against (`undetermined → granted | denied`) and is PLUGGABLE so the denied/loading paths are
 * reachable without a device:
 *   - native build: lazily wires react-native-vision-camera's real permission API.
 *   - web / harness: a deterministic provider whose initial status is driven by `EXPO_PUBLIC_CAMERA_PERMISSION`
 *     (granted | denied | undetermined) so an E2E scenario can render the permission-denied banner + Open
 *     Settings deterministically, and `request()` flips undetermined→granted (the happy path) unless the env
 *     pins `denied` (the user tapped "Don't Allow").
 *
 * `openSettings()` routes to the OS app settings (expo-linking) on device; it's a no-op on web. Kept here so
 * the screen imports ONE seam and stays free of platform branches.
 */
import { Platform } from 'react-native'

export type CameraPermissionStatus = 'undetermined' | 'granted' | 'denied'

export interface CameraPermissionApi {
  /** Synchronous best-known status (vision-camera exposes this synchronously; the stub mirrors it). */
  getStatus(): CameraPermissionStatus
  /** Prompt the OS (or resolve deterministically in the harness). Returns the resolved status. */
  request(): Promise<CameraPermissionStatus>
  /** Deep-link to the OS app settings so a denied user can re-grant (no-op on web). */
  openSettings(): Promise<void>
}

/** Env-pinned initial status for the harness so the denied/undetermined states are reachable in E2E. */
function envInitialStatus(): CameraPermissionStatus {
  const v = (process.env.EXPO_PUBLIC_CAMERA_PERMISSION ?? '').toLowerCase()
  if (v === 'denied') return 'denied'
  if (v === 'undetermined') return 'undetermined'
  if (v === 'granted') return 'granted'
  // Default: undetermined on web (so the priming/request path runs), granted elsewhere if no native module.
  return Platform.OS === 'web' ? 'undetermined' : 'granted'
}

/** Deterministic stub used in the web harness / when vision-camera is unavailable. */
export function createStubCameraPermission(): CameraPermissionApi {
  let status = envInitialStatus()
  return {
    getStatus() {
      return status
    },
    async request() {
      // A pinned `denied` env models "the user previously chose Don't Allow" — request can't re-grant; it must
      // route to Settings. Otherwise an undetermined prompt resolves to granted (the happy path).
      if (status === 'undetermined') status = 'granted'
      return status
    },
    async openSettings() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Linking = require('expo-linking') as typeof import('expo-linking')
        await Linking.openSettings?.()
      } catch {
        /* no-op on web / when expo-linking is absent */
      }
    },
  }
}

/**
 * Returns vision-camera's real permission API when the native module is present, else the deterministic stub.
 * Lazy require so the web bundle never needs react-native-vision-camera.
 */
export function createCameraPermission(): CameraPermissionApi {
  // E2E (maestro build): the camera is fed a bundled fixture, so never touch vision-camera's REAL permission API
  // (its OS prompt occludes the shutter and flakes Maestro). The deterministic stub reports granted (native
  // default) — no prompt. Gated on EXPO_PUBLIC_TEST_MODE, which is pinned OFF in the prod/preview EAS profiles.
  if (process.env.EXPO_PUBLIC_TEST_MODE === '1') return createStubCameraPermission()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vc = require('react-native-vision-camera') as typeof import('react-native-vision-camera')
    const Camera = vc.Camera
    const map = (s: string): CameraPermissionStatus =>
      s === 'granted' ? 'granted' : s === 'not-determined' ? 'undetermined' : 'denied'
    return {
      getStatus() {
        return map(Camera.getCameraPermissionStatus())
      },
      async request() {
        return map(await Camera.requestCameraPermission())
      },
      async openSettings() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Linking = require('expo-linking') as typeof import('expo-linking')
        await Linking.openSettings()
      },
    }
  } catch {
    return createStubCameraPermission()
  }
}
