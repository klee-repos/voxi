/**
 * Processing — the thin `/processing` ALIAS (LOADING-EXPERIENCE-PLAN §3.7). Fresh captures now load on the
 * reveal surface itself; this route survives only for the two paths that need a pre-reveal band decision when
 * reveal isn't mounted: the unavailable-bucket RETRY (`openDock` → replace('/processing')) and a `?startIndex=`
 * deep-link reconnect. It drives the SAME `useThreadStreamRun` engine + `LoadingOverlay` as the reveal, then
 * hands off: CONFIDENT/PROBABLE → /reveal (stream kept alive), UNKNOWN → /interview. Every `processing.*` id +
 * the reconnect contract are UNCHANGED.
 */
import React from 'react'
import { View, StyleSheet, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Screen } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { LoadingOverlay } from '../src/components/LoadingOverlay'
import { ids } from '../src/lib/testid'
import { scrim } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'
import { useApi } from '../src/lib/api'
import { useCaptureStore } from '../src/state/captureStore'
import { useThreadStreamRun } from '../src/lib/useThreadStreamRun'

export default function Processing(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion } = useTheme()
  const { height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const threadId = useCaptureStore((s) => s.threadId)
  const photoUri = useCaptureStore((s) => s.photoUri)
  const isRevisit = useCaptureStore((s) => s.isRevisit)
  const kind = isRevisit ? 'revisit' : 'analyze'

  const run = useThreadStreamRun({
    threadId,
    isRevisit,
    api,
    reduceMotion,
    // The alias route-replaces on settle; keep the stream alive across the hop to /reveal so the async facts keep
    // flowing into the shared store (reveal renders reactively).
    onOutcome: (dest) => router.replace(dest === 'interview' ? '/interview' : '/reveal'),
    keepAliveAcrossUnmount: true,
    onCancel: () => router.replace('/(tabs)/camera'),
  })

  const onImage = !!photoUri

  return (
    <Screen id={ids.processing.screen} padded={false} style={{ minHeight: winH }}>
      {/* full-bleed captured image — same framing as the viewfinder + reveal */}
      <View style={StyleSheet.absoluteFill}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: surface.card }]}>
            <Orb id={ids.processing.orb} state={run.orb} size={96} />
          </View>
        )}
      </View>

      <LoadingOverlay
        run={run}
        kind={kind}
        isRevisit={isRevisit}
        reduceMotion={reduceMotion}
        onImage={onImage}
        winH={winH}
        bottomInset={insets.bottom}
        scrimColor={scrim}
        accentColor={surface.accent}
      />

      {/* Back chevron over the photo that ABORTS the scan and returns to camera. */}
      <View style={styles.headerOverlay} pointerEvents="box-none">
        <AppHeader leading="back" onMedia onLeadingPress={run.cancel} />
      </View>
      <OfflineBanner visible={run.offline} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 },
})
