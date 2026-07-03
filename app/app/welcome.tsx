/**
 * Welcome — the LANDING (marketing splash), not a form. Two zones (the Lifesum/Centr/Skip pattern):
 *   • HERO   (flex, centered): the aurora Orb radiating inside PulseRings, the serif `voxi` wordmark, a punchy
 *            value-prop headline, one subhead line.
 *   • ACTION (pinned above the home indicator): green "Get started" → /sign-up · blue "Log in" → /sign-in ·
 *            the LegalNote consent microcopy (agreement is implicit on the tap — NO checkbox, per design + Mobbin).
 *
 * Account creation and login are SEPARATED here; the email→code flow lives on /sign-up and /sign-in.
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Body, Button, Link, Wordmark } from '../src/components/ui'
import { Orb } from '../src/components/Orb'
import { PulseRings } from '../src/components/PulseRings'
import { LegalNote } from '../src/components/LegalNote'
import { ids } from '../src/lib/testid'
import { space, type as typeTokens, orbPalette } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'

export default function Welcome(): React.ReactElement {
  const router = useRouter()
  const { surface, reduceMotion } = useTheme()

  return (
    <Screen id={ids.welcome.screen}>
      <View style={styles.hero}>
        <PulseRings active reduceMotion={reduceMotion} color={orbPalette.green} size={248}>
          <Orb id={ids.processing.orb} state="idle" size={132} />
        </PulseRings>
        <Wordmark style={{ marginTop: space.xl }} />
        <Text style={[styles.headline, { color: surface.text }]}>What is that, exactly?</Text>
        <Body style={[styles.subhead, { color: surface.textMuted }]}>
          Photograph anything human-made and I'll tell you what it is — as precisely as the evidence allows.
        </Body>
      </View>

      <View style={styles.actions}>
        <Button
          id={ids.welcome.getStarted}
          label="Get started"
          onPress={() => router.push('/sign-up')}
          style={styles.cta}
        />
        <View style={styles.switchRow}>
          <Text style={[styles.prompt, { color: surface.textMuted }]}>Already have an account? </Text>
          <Link id={ids.welcome.logIn} label="Log in" onPress={() => router.push('/sign-in')} />
        </View>
        <LegalNote />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headline: {
    fontFamily: typeTokens.family.sans['800'],
    fontSize: 32,
    lineHeight: 37,
    letterSpacing: -0.5,
    textAlign: 'center',
    marginTop: space.lg,
  },
  subhead: {
    fontFamily: typeTokens.sans,
    fontSize: typeTokens.size.base,
    lineHeight: typeTokens.size.base * typeTokens.leading.body,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 320,
  },
  actions: { paddingBottom: space.sm },
  cta: { height: 52 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: space.xs },
  prompt: { fontFamily: typeTokens.sans, fontSize: typeTokens.size.sm },
})
