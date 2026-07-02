/**
 * The (tabs) group is the LEFT PUSH-DRAWER's collection/settings shell (design.md nav), not a bottom tab bar —
 * `DrawerHost` lives at the ROOT layout, so this group is just a plain `Stack`. The folder name stays `(tabs)`
 * so every `router.*('/(tabs)/camera'|'/threads'|'/settings')` call across app + E2E keeps resolving.
 *
 * `initialRouteName: 'camera'` anchors the Stack: without it a deep-link/replace/web-reload onto threads|settings
 * would leave no camera beneath it and undefined Back behavior. This keeps camera as the always-present back target.
 */
import React from 'react'
import { Stack } from 'expo-router'
import { parchment } from '../../src/lib/theme'

export const unstable_settings = { initialRouteName: 'camera' }

export default function TabsLayout(): React.ReactElement {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: parchment.bg },
        animation: 'fade',
      }}
    >
      <Stack.Screen name="camera" />
      <Stack.Screen name="threads" />
      <Stack.Screen name="settings" />
    </Stack>
  )
}
