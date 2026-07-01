/**
 * Web / converge no-op for the live camera viewfinder. Keeps `react-native-vision-camera` (native-only) out of
 * the web/esbuild bundle — Metro overrides this with `CameraView.native.tsx` on device. Renders nothing (the
 * screen's placeholder reticle stands in) and `takePhoto` resolves null.
 */
import React, { forwardRef, useImperativeHandle } from 'react'

export interface CameraViewHandle {
  takePhoto: () => Promise<string | null>
}

export const CameraView = forwardRef<CameraViewHandle, { active?: boolean }>(function CameraView(_props, ref) {
  useImperativeHandle(ref, () => ({ async takePhoto() { return null } }), [])
  return null
})
