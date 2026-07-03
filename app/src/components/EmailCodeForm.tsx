/**
 * EmailCodeForm — the shared body for /sign-up and /sign-in. Two zones (matching the landing, and N26 / Trip /
 * DoorDash / Careem): the CONTENT (title + subhead + the one input) sits CENTERED in the space above, and the
 * primary CTA is PINNED to the bottom, with the secondary link + legal beneath it.
 *
 * Keyboard handling: we track the REAL keyboard height off the Keyboard events and lift the action footer by
 * exactly that (minus the bottom safe-area the Screen already reserves), rather than trusting KeyboardAvoidingView
 * — which under-lifts here because the footer sits below a custom header, leaving the CTA behind the keyboard
 * (the untappable-button bug the on-device run caught). On web (converge) no keyboard events fire → lift stays 0.
 */
import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Body, Muted, Button, TextField, Link, ErrorState, LoadingLine } from './ui'
import { CodeInput } from './CodeInput'
import { LegalNote } from './LegalNote'
import { OfflineBanner } from './Banners'
import { ids } from '../lib/testid'
import { space, type as typeTokens } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { EmailCodeAuth } from '../lib/useEmailCodeAuth'

export interface AuthCopy {
  emailTitle: string
  emailBody: string
  emailCta: string
  switchPrompt: string
  switchCta: string
  /** navigate to the OTHER auth screen, carrying the typed email for prefill. */
  onSwitch: (email: string) => void
}

/** The live keyboard height (0 when hidden). iOS fires the smoother `Will` events; Android only `Did`. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const show = Keyboard.addListener(showEvt, (e) => setHeight(e.endCoordinates?.height ?? 0))
    const hide = Keyboard.addListener(hideEvt, () => setHeight(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return height
}

export function EmailCodeForm({ auth, copy }: { auth: EmailCodeAuth; copy: AuthCopy }): React.ReactElement {
  const { surface } = useTheme()
  const insets = useSafeAreaInsets()
  const kb = useKeyboardHeight()
  // The Screen already reserves the bottom safe-area inset, so lift by the keyboard height minus that.
  const lift = Math.max(0, kb - insets.bottom)
  const {
    email,
    setEmail,
    code,
    setCode,
    phase,
    busy,
    error,
    offline,
    cooldown,
    canSubmitEmail,
    canSubmitCode,
    submitEmail,
    submitCode,
    resend,
    changeEmail,
  } = auth

  const isEmail = phase === 'email'
  const title = isEmail ? copy.emailTitle : 'Check your inbox.'

  return (
    <View style={styles.flex}>
      <OfflineBanner visible={offline} />
      {/* CONTENT scrolls + centers; the ACTION footer is lifted above the keyboard by `lift`. */}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: surface.text }]}>{title}</Text>
        {isEmail ? (
          <>
            <Body style={[styles.subhead, { color: surface.textMuted }]}>{copy.emailBody}</Body>
            <TextField
              id={ids.auth.emailInput}
              value={email}
              onChangeText={setEmail}
              placeholder="you@email.com"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="go"
              onSubmitEditing={() => void submitEmail()}
              accessibilityLabel="Email address"
              style={styles.field}
            />
          </>
        ) : (
          <>
            <Body style={[styles.subhead, { color: surface.textMuted }]}>
              Enter the 6-digit code I sent to <Text style={styles.email}>{email.trim()}</Text>.
            </Body>
            <CodeInput id={ids.auth.codeInput} value={code} onChangeText={setCode} onComplete={() => void submitCode()} />
          </>
        )}

        {error ? (
          <>
            <ErrorState id={ids.auth.error} message={error.message} />
            {error.showSwitch ? (
              <View style={styles.centerRow}>
                <Link id={ids.auth.switchLink} label={copy.switchCta} onPress={() => copy.onSwitch(email.trim())} />
              </View>
            ) : null}
          </>
        ) : null}

        {busy ? <LoadingLine label={busy === 'sending' ? 'Sending your code…' : 'Letting you in…'} /> : null}
      </ScrollView>

      {/* ACTION FOOTER — pinned above the keyboard (or the bottom when it's down). */}
      <View style={[styles.actions, { marginBottom: lift }]}>
        {isEmail ? <LegalNote /> : null}
        <Button
          id={ids.auth.continue}
          label={isEmail ? copy.emailCta : 'Verify and enter'}
          onPress={() => void (isEmail ? submitEmail() : submitCode())}
          disabled={isEmail ? !canSubmitEmail : !canSubmitCode}
          style={styles.cta}
        />
        {isEmail ? (
          <View style={styles.switchRow}>
            <Muted>{copy.switchPrompt} </Muted>
            <Link id={ids.auth.switchLink} label={copy.switchCta} onPress={() => copy.onSwitch(email.trim())} />
          </View>
        ) : (
          <View style={styles.codeActions}>
            {cooldown > 0 ? (
              <Muted>Resend in {cooldown}s</Muted>
            ) : (
              <Link id={ids.auth.resend} label="Resend code" onPress={() => void resend()} />
            )}
            <Link id={ids.auth.changeEmail} label="Change email" onPress={changeEmail} />
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.xl, paddingTop: space.md },
  title: {
    fontFamily: typeTokens.family.sans['800'],
    fontSize: 28,
    lineHeight: 33,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  subhead: {
    fontFamily: typeTokens.sans,
    fontSize: typeTokens.size.base,
    lineHeight: typeTokens.size.base * typeTokens.leading.body,
    textAlign: 'center',
    marginTop: space.sm,
    marginBottom: space.lg,
  },
  field: { height: 52 },
  email: { fontFamily: typeTokens.family.sans['700'] },
  actions: { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.sm },
  cta: { height: 52 },
  centerRow: { alignItems: 'center', marginTop: space.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: space.md },
  codeActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.md },
})
