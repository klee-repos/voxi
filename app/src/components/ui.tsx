/**
 * Shared UI primitives wired to the theme + selector contract.
 *
 * `Screen` paints the active surface and provides safe-area padding. `Button` / `PressableTile` enforce the
 * 44pt min touch target (PLAN §10.3) and spread `tid(id)` so every interactive element satisfies the contract
 * (testID + accessibilityLabel). `TextField` / `Toggle` do the same for inputs. Text helpers (`Title`, `Body`,
 * `Muted`) apply the serif/sans + AA-contrast tokens for the current surface.
 */
import React from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
  type AccessibilityState,
} from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import { ids, tid, tidWith } from '../lib/testid'
import { hit, radius, space, type as typeTokens, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

export function Screen({
  id,
  children,
  style,
  center,
  padded = true,
  edges,
  header,
}: {
  id?: string
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  center?: boolean
  /** Full-bleed screens (camera/processing/reveal hero) set `padded={false}` to render edge-to-edge. */
  padded?: boolean
  /**
   * Which edges get safe-area inset padding (defaults to all). Full-bleed screens that handle the bottom inset
   * themselves pass `['top','left','right']` so the bottom is NOT padded twice — otherwise the safe-area strip
   * clips content above the home indicator and the photo shows through beneath the sheet.
   */
  edges?: readonly Edge[]
  /**
   * The universal <AppHeader/>. When present it renders pinned at the top (outside the padded/centered body) and
   * OWNS the top safe-area inset, so 'top' is dropped from the SafeAreaView edges — a single inset owner, no
   * double-inset, and a body that flows/centres beneath the bar without per-screen hand-padding.
   */
  header?: React.ReactNode
}): React.ReactElement {
  const { surface } = useTheme()
  if (header) {
    const bodyEdges = ((edges ?? (['top', 'bottom', 'left', 'right'] as const)).filter((e) => e !== 'top')) as Edge[]
    return (
      <SafeAreaView {...(id ? tid(id) : {})} edges={bodyEdges} style={[styles.screen, { backgroundColor: surface.bg }, style]}>
        {header}
        <View style={[styles.body, padded && styles.screenPad, center && styles.center]}>{children}</View>
      </SafeAreaView>
    )
  }
  return (
    <SafeAreaView
      {...(id ? tid(id) : {})}
      edges={edges}
      style={[styles.screen, padded && styles.screenPad, { backgroundColor: surface.bg }, center && styles.center, style]}
    >
      {children}
    </SafeAreaView>
  )
}

// Text-prop passthrough so testID/accessibilityLabel from tid() actually reach the DOM (data-testid on web).
type TextPassthrough = { children: React.ReactNode; style?: StyleProp<TextStyle>; testID?: string; accessibilityLabel?: string }

export function Title({ children, style, ...rest }: TextPassthrough): React.ReactElement {
  const { surface } = useTheme()
  // SANS, per design.md "the serif is the logo, and ONLY the logo" — the serif voxi mark is <Wordmark/>.
  // typeStyles.heading = Nunito 700 / 24 (design.md heading; NOT theme.size.xl=26, which would drift +2px).
  // accessibilityRole="header" makes this the screen's navigable heading for VoiceOver's rotor — the universal
  // AppHeader keeps its own center empty on large-title screens, so the in-body <Title> carries the role.
  return (
    <Text accessibilityRole="header" {...rest} style={[{ color: surface.text }, typeStyles.heading, style]}>
      {children}
    </Text>
  )
}

/** The ONLY serif in the product — the "voxi" wordmark (design.md logo). Never used for titles or body. */
export function Wordmark({ style }: { style?: TextStyle }): React.ReactElement {
  const { surface } = useTheme()
  return (
    <Text accessibilityRole="header" style={[{ color: surface.text }, typeStyles.logo, style]}>
      voxi
    </Text>
  )
}

/**
 * Blue secondary-lane link (design.md: green = primary/audio, blue = links/secondary). Use this for reveal
 * secondary actions + evidence links — NOT `Button variant="secondary"` (near-black on a hairline pill).
 */
export function Link({
  id,
  label,
  onPress,
  style,
  accessibilityLabel,
}: {
  id: string
  label: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
}): React.ReactElement {
  const { surface } = useTheme()
  return (
    <Pressable
      {...tid(id, accessibilityLabel ?? label)}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }, style]}
    >
      <Text style={[{ color: surface.accentSecondary }, typeStyles.headline]}>{label}</Text>
    </Pressable>
  )
}

export function Body({ children, style, numberOfLines, ...rest }: TextPassthrough & { numberOfLines?: number }): React.ReactElement {
  const { surface } = useTheme()
  return (
    <Text
      {...rest}
      numberOfLines={numberOfLines}
      style={[{ color: surface.text, fontFamily: typeTokens.sans, fontSize: typeTokens.size.base, lineHeight: typeTokens.size.base * typeTokens.leading.body }, style]}
    >
      {children}
    </Text>
  )
}

export function Muted({ children, style, ...rest }: TextPassthrough): React.ReactElement {
  const { surface } = useTheme()
  return (
    <Text {...rest} style={[{ color: surface.textMuted, fontFamily: typeTokens.sans, fontSize: typeTokens.size.sm }, style]}>
      {children}
    </Text>
  )
}

export function Button({
  id,
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
}: {
  id: string
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const { surface } = useTheme()
  const bg =
    variant === 'primary' ? surface.accent : variant === 'danger' ? surface.danger : 'transparent'
  const fg = variant === 'secondary' ? surface.text : surface.onAccent
  const border = variant === 'secondary' ? surface.border : 'transparent'
  return (
    <Pressable
      {...tid(id)}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      <Text style={{ color: fg, fontFamily: typeTokens.family.sans['600'], fontSize: typeTokens.size.base }}>
        {label}
      </Text>
    </Pressable>
  )
}

// No NavClose primitive: the top-left chevron / top-right X behavior lives in the universal <AppHeader/>
// (leading="back" | onClose), which keeps nav.close (modal X) distinct from nav.back (the back chevron) and
// applies the safe-area inset consistently.

export function PressableTile({
  id,
  onPress,
  onLongPress,
  delayLongPress,
  children,
  style,
  dataSet,
  accessibilityState,
}: {
  id: string
  onPress: () => void
  /** Optional long-press (the collection-grid tile enters multi-select on long-press). undefined → RN omits the
   *  handler (onPress-only behavior on every other PressableTile call site is byte-unchanged). */
  onLongPress?: () => void
  /** Optional long-press delay (ms). undefined → RN's stock 500ms default. */
  delayLongPress?: number
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  /** Optional carried state → rendered as `data-*` on web (E2E reads via `[data-selected="true"]`) and
   *  `accessibilityValue.text` on native. When present, switches the contract spread from `tid` to `tidWith`. */
  dataSet?: Record<string, string>
  /** Optional a11y state (e.g. `{ selected: true }` so VoiceOver announces "selected" — distinct from the
   *  web-E2E `dataSet`, which is for test observability). */
  accessibilityState?: AccessibilityState
}): React.ReactElement {
  const tidProps = dataSet ? tidWith(id, dataSet) : tid(id)
  return (
    <Pressable {...tidProps} accessibilityRole="button" accessibilityState={accessibilityState} onPress={onPress} onLongPress={onLongPress} delayLongPress={delayLongPress} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }, style]}>
      {children}
    </Pressable>
  )
}

export function TextField({
  id,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  multiline,
  style,
  textContentType,
  autoComplete,
  returnKeyType,
  onSubmitEditing,
  autoFocus,
  maxLength,
  accessibilityLabel,
}: {
  id: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  secureTextEntry?: boolean
  keyboardType?: 'default' | 'email-address' | 'number-pad'
  multiline?: boolean
  style?: StyleProp<TextStyle>
  // Form-a11y passthroughs (autofill + focus flow) — used by the login OTP/email fields (§3.1).
  textContentType?: 'none' | 'emailAddress' | 'oneTimeCode'
  autoComplete?: 'off' | 'email' | 'one-time-code'
  returnKeyType?: 'next' | 'done' | 'go'
  onSubmitEditing?: () => void
  autoFocus?: boolean
  maxLength?: number
  accessibilityLabel?: string
}): React.ReactElement {
  const { surface } = useTheme()
  return (
    <TextInput
      {...tid(id, accessibilityLabel)}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={surface.textMuted}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      multiline={multiline}
      autoCapitalize="none"
      textContentType={textContentType}
      autoComplete={autoComplete}
      returnKeyType={returnKeyType}
      onSubmitEditing={onSubmitEditing}
      autoFocus={autoFocus}
      maxLength={maxLength}
      style={[
        styles.input,
        { backgroundColor: surface.card, color: surface.text, borderColor: surface.border, minHeight: multiline ? hit.min * 2 : hit.min },
        style,
      ]}
    />
  )
}

export function Toggle({
  id,
  value,
  onValueChange,
  label,
  style,
}: {
  id: string
  value: boolean
  onValueChange: (v: boolean) => void
  label: string
  /** Merged AFTER `toggleRow` so callers can override the baked-in vertical margin when grouping toggles in a
   *  card (e.g. the Settings "Preferences" card wants flush rows, not the standalone per-toggle gap). */
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const { surface } = useTheme()
  return (
    <Pressable
      {...tid(id)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={[styles.toggleRow, style]}
    >
      <View style={[styles.checkbox, { borderColor: surface.border, backgroundColor: value ? surface.accentSoft : 'transparent' }]}>
        {value ? <Text style={{ color: surface.onAccent }}>✓</Text> : null}
      </View>
      <Text style={{ color: surface.text, fontFamily: typeTokens.sans, fontSize: typeTokens.size.base, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  )
}

/**
 * In-line loading affordance. Reduce-motion swaps the spinner for a static "…" line (the orb/particle motion
 * lives on the immersive screens; here a non-animated cue is the calmer a11y path — PLAN §10.3).
 */
export function LoadingLine({ label }: { label?: string }): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  return (
    <View style={styles.stateRow}>
      {reduceMotion ? (
        <Text style={{ color: surface.textMuted, fontSize: typeTokens.size.lg }}>…</Text>
      ) : (
        <ActivityIndicator color={surface.accent} />
      )}
      <Muted>{label ?? 'One moment…'}</Muted>
    </View>
  )
}

/**
 * In-persona error block with a retry. Spreads the caller's contract id (e.g. a screen's failure surface) so
 * the error state is locatable, and keeps the retry as a real Button (44pt target + its own id).
 */
export function ErrorState({
  id,
  retryId,
  message,
  onRetry,
}: {
  id?: string
  retryId?: string
  message: string
  onRetry?: () => void
}): React.ReactElement {
  const { surface } = useTheme()
  return (
    <View {...(id ? tid(id) : {})} accessibilityRole="alert" style={[styles.errorBlock, { borderColor: surface.border, backgroundColor: surface.surface }]}>
      <Body>{message}</Body>
      {onRetry && retryId ? <Button id={retryId} label="Try again" variant="secondary" onPress={onRetry} style={{ marginTop: space.md }} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenPad: { padding: space.xl },
  body: { flex: 1 }, // the content region beneath a Screen `header` (padded/centered independently of the bar)
  center: { alignItems: 'center', justifyContent: 'center' },
  link: { minHeight: hit.min, justifyContent: 'center' },
  btn: {
    minHeight: hit.min,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill, // design.md: buttons are fully-rounded pills
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.sm,
  },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md, marginVertical: space.sm },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: hit.min, marginVertical: space.sm },
  checkbox: { width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.lg },
  errorBlock: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, marginVertical: space.lg },
})
