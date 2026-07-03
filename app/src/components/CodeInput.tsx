/**
 * CodeInput — the 6-digit email-code field for /sign-up and /sign-in.
 *
 * ONE real, visible, focusable `TextInput` carries the id (`auth.codeInput`) and holds the whole value, so it is
 * DIRECTLY driveable the same way the old single OTP field was: web E2E `type(id, '424242')` sets the input;
 * Maestro `tapOn auth.codeInput` + `inputText '424242'` focuses and fills it. The six cell Views are a purely
 * visual overlay BEHIND the (transparent-text, caret-hidden) input — decorative, hidden from the a11y tree — so
 * VoiceOver announces exactly one "Verification code" field, not six. This deliberately avoids the zero-size
 * hidden-input pattern that isn't reliably targetable on the iOS Release sim.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [4] [2] [4] [2] [4] [_]   ← cells (visual)    │
 *   │ «─────── one transparent TextInput ───────»   │  (real focus target, carries the id)
 *   └──────────────────────────────────────────────┘
 */
import React from 'react'
import { View, Text, TextInput, StyleSheet, Platform } from 'react-native'
import { tid } from '../lib/testid'
import { radius, space, hit, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

export function CodeInput({
  id,
  value,
  onChangeText,
  onComplete,
  length = 6,
  autoFocus = true,
}: {
  id: string
  value: string
  onChangeText: (v: string) => void
  onComplete?: (code: string) => void
  length?: number
  autoFocus?: boolean
}): React.ReactElement {
  const { surface } = useTheme()
  const cells = Array.from({ length })
  const focusedIndex = Math.min(value.length, length - 1)

  const handleChange = (next: string): void => {
    const digits = next.replace(/\D/g, '').slice(0, length)
    onChangeText(digits)
    if (digits.length === length) onComplete?.(digits)
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {cells.map((_, i) => {
          const filled = i < value.length
          const active = i === focusedIndex && value.length < length
          return (
            <View
              key={i}
              style={[
                styles.cell,
                { backgroundColor: surface.sunken, borderColor: active ? surface.accent : surface.border },
              ]}
            >
              <Text style={[typeStyles.heading, { color: surface.text }]}>{filled ? value[i] : ''}</Text>
            </View>
          )
        })}
      </View>
      <TextInput
        {...tid(id, 'Verification code')}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        autoFocus={autoFocus}
        caretHidden
        // Full-bleed over the cells so a tap anywhere focuses it; transparent text (the cells render the digits).
        style={styles.hiddenInput}
        // rn-web: keep the caret/selection invisible without hiding the element from Playwright's data-testid.
        selectionColor="transparent"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', marginVertical: space.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  cell: {
    flex: 1,
    height: 56,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: hit.min,
    color: 'transparent',
    // Keep the OS keyboard-assist chip anchored to the field on iOS.
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as unknown as undefined } : {}),
  },
})
