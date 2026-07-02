/**
 * Camera capture — the steady-state home (Shazam layout, design.md cream). A FULL-BLEED viewfinder fills the
 * screen; the controls float as an overlay: a top-left hamburger + `voxi` wordmark (`AppHeader`), a bottom bar
 * with the "Recently catalogued" toggle (`camera.recentToggle`, a Lucide icon → the floating `RecentCard`) on the
 * left and ONE central flat-green capture orb (`CaptureOrb`, Lucide aperture, carries `camera.shutter`), and a
 * short instruction line above it (`camera.retakeHint`). On web (no camera) the cream canvas + a faint reticle
 * IS the branded home.
 *
 * The data flow is UNCHANGED: onShutter → api.createThread (charges a scan; 402 → /paywall) → /processing.
 * Permission states (undetermined/denied) keep the centered narrator Orb (`processing.orb`); the granted home no
 * longer docks an orb (removed per design). Offline/capture-error paths preserved.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, StyleSheet, Platform, Pressable, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Images } from 'lucide-react-native'
import { Screen, Title, Body, Muted, Button } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { CaptureOrb } from '../../src/components/CaptureOrb'
import { RecentCard } from '../../src/components/RecentCard'
import { Orb } from '../../src/components/Orb'
import { OfflineBanner } from '../../src/components/Banners'
import { ids, tid } from '../../src/lib/testid'
import { radius, space, hit } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useApi } from '../../src/lib/api'
import { ApiError } from '../../src/lib/apiClient'
import { useCaptureStore } from '../../src/state/captureStore'
import { useRevisitThread } from '../../src/lib/useRevisitThread'
import { threadsKey } from '../../src/lib/queryKeys'
import { createCameraPermission, type CameraPermissionStatus } from '../../src/lib/cameraPermission'
import { CameraView, type CameraViewHandle } from '../../src/components/CameraView'
import { toDataUri } from '../../src/lib/photo'
import { haptics } from '../../src/lib/haptics'

export default function Camera(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface } = useTheme()
  // Full-bleed screens have only absolutely-positioned children, so give the Screen a concrete min height
  // (flex:1 alone collapses when the host root has no height — real Expo web fills 100vh; the harness doesn't).
  const { height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const startCapture = useCaptureStore((s) => s.startCapture)
  const setThread = useCaptureStore((s) => s.setThread)
  const setError = useCaptureStore((s) => s.setError)
  // Revisiting a recent capture resumes its durable thread (photo seeded) — shared 1:1 with the Collection grid.
  const revisit = useRevisitThread()

  const perm = useMemo(() => createCameraPermission(), [])
  const [permission, setPermission] = useState<CameraPermissionStatus>(() => perm.getStatus())
  const [requesting, setRequesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  const mounted = useRef(true)
  const cameraRef = useRef<CameraViewHandle>(null)

  const queryClient = useQueryClient()
  const recent = useQuery({ queryKey: threadsKey, queryFn: () => api.listThreads() })
  const threads = recent.data?.threads ?? []

  useEffect(() => {
    mounted.current = true
    if (perm.getStatus() === 'undetermined') {
      setRequesting(true)
      perm
        .request()
        .then((s) => mounted.current && setPermission(s))
        .finally(() => mounted.current && setRequesting(false))
    }
    return () => {
      mounted.current = false
    }
  }, [perm])

  async function onShutter(): Promise<void> {
    if (busy) return
    setBusy(true)
    setOffline(false)
    try {
      const photoUri = (await cameraRef.current?.takePhoto().catch(() => null)) ?? null
      let photoUrl: string
      let displayUri: string | null
      if (photoUri) {
        // Persist the DATA-URI (not the file:// temp path, which can be cleaned up before reveal) so the exact
        // captured image survives camera → processing → reveal unchanged.
        photoUrl = await toDataUri(photoUri)
        displayUri = photoUrl
      } else {
        // Web/harness: no live camera → no real image to persist.
        const signed = await api.signUpload().catch(() => ({ url: 'capture://local' }) as { url: string })
        photoUrl = signed.url
        displayUri = null
      }
      startCapture(displayUri)
      const { threadId } = await api.createThread({ photoUrl })
      // A new thread now exists server-side — invalidate the collection so Recently catalogued + the Collection
      // refetch and show it. Without this the persistent (never-remounted) camera tab keeps the stale cached list
      // and the newest capture never appears.
      void queryClient.invalidateQueries({ queryKey: threadsKey })
      setThread(threadId)
      router.push('/processing')
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[capture] FAILED :: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      if (e instanceof ApiError && e.status === 402) {
        router.push('/paywall')
        return
      }
      haptics.error()
      setOffline(true)
      setError(e instanceof Error ? e.message : 'capture_failed')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  // ---- permission denied: drawer stays reachable; centered narrator Orb, uncertain ----
  if (permission === 'denied') {
    return (
      <Screen id={ids.camera.screen} padded={false} style={{ minHeight: winH }} header={<AppHeader leading="menu" showWordmark />}>
        <View style={styles.centerStage}>
          <Orb id={ids.processing.orb} state="uncertain" size={96} />
          <View
            {...tid(ids.camera.permissionDeniedBanner)}
            accessibilityRole="alert"
            style={[styles.banner, { borderColor: surface.danger, backgroundColor: surface.surface }]}
          >
            <Title>The Guide can't see.</Title>
            <Body style={{ marginTop: space.sm }}>
              I need the camera to identify what you're showing me. Grant it in Settings and we'll get on with it.
            </Body>
          </View>
          <Button id={ids.camera.openSettings} label="Open settings" onPress={() => void perm.openSettings()} style={{ marginTop: space.md }} />
        </View>
      </Screen>
    )
  }

  // ---- priming (undetermined → requesting): centered narrator Orb, listening ----
  if (permission === 'undetermined' || requesting) {
    return (
      <Screen id={ids.camera.screen} padded={false} style={{ minHeight: winH }} header={<AppHeader leading="menu" showWordmark />}>
        <View style={styles.centerStage}>
          <Orb id={ids.processing.orb} state="listening" size={96} />
          <Body {...tid(ids.camera.retakeHint)} style={{ marginTop: space.lg, textAlign: 'center' }}>
            Waking the lens…
          </Body>
        </View>
      </Screen>
    )
  }

  // ---- granted: full-bleed viewfinder + floating overlay controls ----
  const onFeed = Platform.OS !== 'web'
  const instruction = offline
    ? "We're offline — your last capture will retry when you reconnect."
    : busy
      ? 'Capturing…'
      : threads.length === 0
        ? 'Point at one object to begin.'
        : 'Tap to identify.'
  const overTint = onFeed ? '#FFFFFF' : surface.text

  return (
    <Screen id={ids.camera.screen} padded={false}>
      {/* full-bleed live feed (native) / cream canvas (web) behind everything */}
      <View style={StyleSheet.absoluteFill}>
        <CameraView ref={cameraRef} active={!busy} />
      </View>
      {!onFeed ? <View style={[styles.reticle, { borderColor: surface.border }]} pointerEvents="none" /> : null}

      {/* floating overlay */}
      <View style={styles.overlay} pointerEvents="box-none">
        <AppHeader leading="menu" showWordmark onMedia={onFeed} />
        <OfflineBanner visible={offline} />
        <View style={styles.spacer} pointerEvents="none" />
        {/* Hide the capture hint while the RecentCard is open — it would sit behind the floating card + scrim. */}
        {!trayOpen ? (
          <Muted {...tid(ids.camera.retakeHint)} style={[styles.hint, { color: overTint }]}>
            {instruction}
          </Muted>
        ) : null}
        <View style={[styles.bottomBar, { paddingBottom: space.xl + insets.bottom }]} pointerEvents="box-none">
          <View style={styles.side}>
            <Pressable
              {...tid(ids.camera.recentToggle, 'Recently catalogued')}
              accessibilityRole="button"
              onPress={() => setTrayOpen(true)}
              hitSlop={10}
              style={[styles.iconBtn, { backgroundColor: onFeed ? 'rgba(0,0,0,0.35)' : surface.sunken }]}
            >
              <Images size={22} color={overTint} strokeWidth={2} />
            </Pressable>
          </View>
          <CaptureOrb busy={busy} onPress={() => void onShutter()} size={80} />
          <View style={styles.side} />
        </View>
      </View>

      <RecentCard
        open={trayOpen}
        onClose={() => setTrayOpen(false)}
        threads={threads}
        isLoading={recent.isLoading}
        isError={recent.isError}
        onRetry={() => void recent.refetch()}
        onOpen={revisit}
        onSeeAll={() => {
          setTrayOpen(false)
          router.navigate('/(tabs)/threads')
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  centerStage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  banner: { borderWidth: 1.5, borderRadius: radius.md, padding: space.lg, marginVertical: space.lg, maxWidth: 360 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-start' },
  spacer: { flex: 1 },
  reticle: { position: 'absolute', alignSelf: 'center', top: '28%', width: '66%', height: '40%', borderWidth: 1.5, borderRadius: radius.md },
  hint: { textAlign: 'center', paddingHorizontal: space.lg, marginBottom: space.lg },
  bottomBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xl, paddingBottom: space.xl },
  side: { flex: 1, alignItems: 'flex-start' },
  iconBtn: { width: hit.min, height: hit.min, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
