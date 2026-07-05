/**
 * Settings (PLAN §10.2 screen 12). The plan/subscription + privacy sections were removed (the plan is the
 * single static "Unlimited" label shown in the drawer greeting; the metering/upgrade concept no longer surfaces
 * here). What remains: the two Preferences toggles (reduce-motion, speak-aloud) in a grouped card, and the
 * account actions (Sign out, Apple-required Delete account) bottom-anchored like a normal settings screen.
 * The body scrolls so the bottom actions stay reachable at the largest Dynamic Type size. ids: settings.*.
 */
import React, { useState } from 'react'
import { View, Text, ScrollView, StyleSheet, Alert, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Muted, Button, Toggle } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { ids } from '../../src/lib/testid'
import { space, radius, typeStyles } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useAuth } from '../../src/lib/clerk'
import { useApi } from '../../src/lib/api'
import { isOfflineError } from '../../src/lib/useOffline'

export default function Settings(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { signOut } = useAuth()
  const { surface, reduceMotion, setReduceMotion, speakAloud, setSpeakAloud } = useTheme()

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

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
      <ScrollView contentContainerStyle={styles.scrollBody}>
        <Title>Settings</Title>

        <Text style={[typeStyles.sectionLabel, { color: surface.textMuted, marginTop: space.xl }]}>Preferences</Text>
        <View style={[styles.card, { backgroundColor: surface.card, borderColor: surface.border }]}>
          <Toggle id={ids.settings.reduceMotion} value={reduceMotion} onValueChange={setReduceMotion} label="Reduce motion (calmer orb, no particles)" style={styles.toggleRow} />
          <View style={[styles.divider, { backgroundColor: surface.border }]} />
          <Toggle id={ids.settings.speakAloud} value={speakAloud} onValueChange={setSpeakAloud} label="Speak results aloud (hear each reveal in Voxi's voice)" style={styles.toggleRow} />
        </View>

        {/* flexGrow spacer bottom-anchors the account actions when content fits; the ScrollView scrolls when it doesn't. */}
        <View style={{ flexGrow: 1 }} />

        <Button id={ids.settings.signOut} label="Sign out" variant="secondary" onPress={() => void signOut().then(() => router.replace('/welcome'))} />
        <Button id={ids.settings.deleteAccount} label={deleting ? 'Deleting…' : 'Delete account'} variant="danger" disabled={deleting} onPress={() => void confirmDelete()} style={{ marginTop: space.sm }} />
        {deleteError ? <Muted style={{ color: surface.danger, marginTop: space.sm }}>{deleteError}</Muted> : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scrollBody: { flexGrow: 1 },
  card: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.xs, marginTop: space.sm },
  // Override the Toggle's baked-in `marginVertical: space.sm` so the two rows sit flush in the card (the card's
  // own padding + the toggle's minHeight:44 hit target carry the vertical rhythm).
  toggleRow: { marginVertical: space.xs },
  divider: { height: 1, marginVertical: space.xs },
})
