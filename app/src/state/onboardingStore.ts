/**
 * Onboarding / consent preferences (Zustand) — intent the first-run flow collects: photo→public share consent
 * and the coarse camera/mic permission outcomes. This is UI/session intent only; the authoritative consent
 * record lives server-side (PLAN §11 `photo_sharing_consent`).
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
