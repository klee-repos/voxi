/**
 * Onboarding / consent preferences (Zustand) — the durable-intent the first-run flow collects.
 *
 * Holds the photo→public SHARE consent (defaults OFF — global exemplars require explicit opt-in, PLAN §7.4) and
 * the coarse camera/mic permission outcomes captured during priming, so the camera screen and Settings can read
 * the user's choices without re-prompting. This is UI/session intent; the authoritative consent record lives
 * server-side (PLAN §11 `photo_sharing_consent`). Kept tiny and dependency-light to mirror captureStore.
 */
import { create } from 'zustand'
import type { CameraPermissionStatus } from '../lib/cameraPermission'
import type { MicPermissionStatus } from '../lib/permissions'

export interface OnboardingState {
  completed: boolean
  /** photo→public exemplar consent; OFF by default (no silent globalization, PLAN §7.4). */
  shareConsent: boolean
  cameraPermission: CameraPermissionStatus | null
  micPermission: MicPermissionStatus | null

  setShareConsent(v: boolean): void
  setCameraPermission(s: CameraPermissionStatus): void
  setMicPermission(s: MicPermissionStatus): void
  complete(): void
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  completed: false,
  shareConsent: false,
  cameraPermission: null,
  micPermission: null,
  setShareConsent: (shareConsent) => set({ shareConsent }),
  setCameraPermission: (cameraPermission) => set({ cameraPermission }),
  setMicPermission: (micPermission) => set({ micPermission }),
  complete: () => set({ completed: true }),
}))
