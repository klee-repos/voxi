/**
 * Haptics seam — the ONE place `expo-haptics` is touched.
 *
 * Native-only: every method is guarded on `Platform.OS !== 'web'` so the web/harness build never fires a haptic,
 * and the converge/web bundle aliases `expo-haptics` to a no-op shim (see `e2e/web/converge/harness.ts` +
 * `shims/expo-haptics.tsx`). Calls are fire-and-forget and swallow errors, so a device without a haptic engine
 * (or a denied Taptic permission) can never throw into a UI press handler.
 *
 * Device verification is toolchain-gated (needs a Mac + iOS hardware); the web path is a verified no-op.
 */
import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

const enabled = Platform.OS !== 'web'
const run = (p: () => Promise<void>): void => {
  if (enabled) p().catch(() => {})
}

export const haptics = {
  /** Shutter press — a solid confirm. */
  capture: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Light tick — drawer snap, subordinate taps. */
  tick: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** CONFIDENT / PROBABLE settle — the "catch". */
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** UNKNOWN → interview. */
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** Failure / offline. */
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
}
