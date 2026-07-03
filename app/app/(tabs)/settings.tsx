/**
 * Settings / account (PLAN §10.2 screen 12) — subscription status (GET /v1/me), the privacy line, reduce-motion
 * toggle (PLAN §10.3), Apple-required account deletion (DELETE /v1/account), and sign-out. ids: settings.*.
 */
import React, { useState } from 'react'
import { View, Pressable, StyleSheet, Alert, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { Screen, Title, Body, Muted, Button, Toggle, LoadingLine } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { OfflineBanner } from '../../src/components/Banners'
import { ids, tid } from '../../src/lib/testid'
import { space, radius } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useAuth } from '../../src/lib/clerk'
import { useApi } from '../../src/lib/api'
import { useOffline, isOfflineError } from '../../src/lib/useOffline'

export default function Settings(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { signOut } = useAuth()
  const { surface, reduceMotion, setReduceMotion, speakAloud, setSpeakAloud } = useTheme()

  const { data: me, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['me'], queryFn: () => api.me() })

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const meIsOffline = isError && isOfflineError(error)
  const offline = useOffline(meIsOffline)

  async function confirmDelete(): Promise<void> {
    const doDelete = async (): Promise<void> => {
      setDeleting(true)
      setDeleteError(null)
      try {
        await api.deleteAccount()
        await signOut()
        router.replace('/welcome')
      } catch (e) {
        setDeleteError(isOfflineError(e) ? "We're offline — deletion needs a connection. Try again when you're back." : "Deletion didn't complete. Nothing was removed; please try again.")
      } finally {
        setDeleting(false)
      }
    }
    if (Platform.OS === 'web') {
      await doDelete()
      return
    }
    Alert.alert('Delete account', 'This permanently erases your collection, photos, and data. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void doDelete() },
    ])
  }

  // Settings is a top-level drawer destination (a peer of Capture) → the header shows the menu hamburger that
  // opens the drawer, not a back chevron.
  return (
    <Screen id={ids.settings.screen} header={<AppHeader leading="menu" />}>
      <OfflineBanner visible={offline} />
      <Title>Settings</Title>

      {/* subscription / entitlements — loading / error / loaded */}
      <View {...tid(ids.settings.subscriptionStatus)} style={[styles.row, { borderColor: surface.border }]}>
        <Body>Plan</Body>
        {isLoading ? (
          <LoadingLine label="Checking your plan…" />
        ) : isError ? (
          <View>
            <Muted>{meIsOffline ? "Offline — we'll refresh your plan when you reconnect." : "Couldn't load your plan just now."}</Muted>
            {/* plain link (no contract testID — settings owns only settings.* ids; this isn't a contract element) */}
            <Pressable accessibilityRole="button" onPress={() => void refetch()} disabled={isFetching} style={styles.link}>
              <Muted style={{ color: surface.accentSecondary }}>{isFetching ? 'Retrying…' : 'Retry'}</Muted>
            </Pressable>
          </View>
        ) : (
          <View>
            <Muted>{me ? `${me.plan} · ${me.remaining.scan} scans · ${me.remaining.podcast} podcasts · ${me.remaining.voiceMin} voice min` : '…'}</Muted>
            {me && me.plan === 'free' ? (
              <Pressable accessibilityRole="button" onPress={() => router.push('/paywall')} style={styles.link}>
                <Muted style={{ color: surface.accentSecondary }}>Upgrade your plan</Muted>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      <View {...tid(ids.settings.privacyNoFaceRecognition)} style={[styles.row, { borderColor: surface.border }]}>
        <Body>Privacy</Body>
        <Muted>The Guide never performs facial recognition. Faces and plates are redacted before storage.</Muted>
      </View>

      <Toggle id={ids.settings.reduceMotion} value={reduceMotion} onValueChange={setReduceMotion} label="Reduce motion (calmer orb, no particles)" />
      <Toggle id={ids.settings.speakAloud} value={speakAloud} onValueChange={setSpeakAloud} label="Speak results aloud (hear each reveal in Voxi's voice)" />

      <Button id={ids.settings.signOut} label="Sign out" variant="secondary" onPress={() => void signOut().then(() => router.replace('/welcome'))} style={{ marginTop: space.xl }} />
      <Button id={ids.settings.deleteAccount} label={deleting ? 'Deleting…' : 'Delete account'} variant="danger" disabled={deleting} onPress={() => void confirmDelete()} />
      {deleteError ? <Muted style={{ color: surface.danger, marginTop: space.sm }}>{deleteError}</Muted> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: 1, paddingVertical: space.md, gap: space.xs, borderRadius: radius.sm },
  link: { minHeight: 44, justifyContent: 'center' },
})
