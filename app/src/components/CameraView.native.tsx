/**
 * Live camera viewfinder (device only) — the real `react-native-vision-camera` feed behind the reticle. Metro
 * resolves THIS on native; the web/converge bundle resolves the no-op `CameraView.tsx`, so vision-camera never
 * enters a non-native bundle. Exposes `takePhoto()` imperatively so the shutter captures a real JPEG file.
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { Camera, useCameraDevice } from 'react-native-vision-camera'

export interface CameraViewHandle {
  /** Capture a photo; returns a `file://` uri, or null if the camera isn't ready. */
  takePhoto: () => Promise<string | null>
}

export const CameraView = forwardRef<CameraViewHandle, { active?: boolean }>(function CameraView({ active = true }, ref) {
  const device = useCameraDevice('back')
  const cam = useRef<Camera>(null)

  useImperativeHandle(
    ref,
    () => ({
      async takePhoto() {
        if (!cam.current) return null
        const photo = await cam.current.takePhoto({ enableShutterSound: false })
        return photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`
      },
    }),
    [],
  )

  if (!device) return <View style={StyleSheet.absoluteFill} />
  return <Camera ref={cam} style={StyleSheet.absoluteFill} device={device} isActive={active} photo />
})
