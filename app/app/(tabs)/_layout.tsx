/**
 * The (tabs) group is the LEFT PUSH-DRAWER's collection/settings shell (design.md nav), not a bottom tab bar.
 * The `DrawerHost` itself now lives at the ROOT layout (`app/_layout.tsx`) so the drawer wraps the pushed
 * capture flow (processing/reveal) too — this group is just a plain `Stack`. The hamburger lives on the camera
 * screen (`AppHeader`) and the drawer re-hosts the collection / settings nav the tab bar used to (the same
 * `nav.threadsTab` / `nav.settingsTab` ids, now in `DrawerMenu`).
 *
 * The folder name stays `(tabs)` so every `router.*('/(tabs)/camera'|'/threads'|'/settings')` call across the
 * app + E2E keeps resolving. `initialRouteName: 'camera'` anchors the Stack: converting `<Tabs>` (whose back
 * default is the first tab) into a `<Stack>` would otherwise leave a deep-link/replace/web-reload on
 * threads|settings with no camera beneath it and undefined Back behavior. This anchor keeps camera as the
 * always-present back target.
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
