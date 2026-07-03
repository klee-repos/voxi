/**
 * LegalNote — the consent microcopy under the primary auth CTA. Agreement (Terms + Privacy + the 16+ attestation)
 * is implicit on the primary tap; this line is the clickwrap text that makes that binding, with Terms / Privacy as
 * tappable links (design.md blue secondary lane). No checkbox — the mainstream mobile pattern (Lifesum, Mindvalley,
 * Glovo), and what the user asked for. Shared by the landing + both auth email screens.
 */
import React from 'react'
import { Text, StyleSheet, Linking } from 'react-native'
import { ids, tid } from '../lib/testid'
import { typeStyles, space } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { LEGAL } from '../lib/legal'

export function LegalNote({ verb = 'continuing' }: { verb?: string }): React.ReactElement {
  const { surface } = useTheme()
  const link = { color: surface.accentSecondary }
  return (
    <Text style={[typeStyles.footnote, styles.note, { color: surface.textMuted }]}>
      By {verb} you confirm you're 16 or older and agree to Voxi's{' '}
      <Text
        {...tid(ids.welcome.terms, 'Terms')}
        accessibilityRole="link"
        style={link}
        onPress={() => void Linking.openURL(LEGAL.terms)}
      >
        Terms
      </Text>{' '}
      and{' '}
      <Text
        {...tid(ids.welcome.privacy, 'Privacy Policy')}
        accessibilityRole="link"
        style={link}
        onPress={() => void Linking.openURL(LEGAL.privacy)}
      >
        Privacy Policy
      </Text>
      .
    </Text>
  )
}

const styles = StyleSheet.create({
  note: { textAlign: 'center', marginTop: space.md, paddingHorizontal: space.sm },
})
