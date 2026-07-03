/**
 * AppHeader — the app's ONE universal top bar (design.md nav). Constant height (`space.sm + insets.top +
 * BAR_H`) regardless of which controls it holds — only the glyphs swap, never the bar (validated against iOS
 * patterns in Mobbin; see docs/UNIVERSAL-HEADER-PLAN.md). Three regions:
 *   • LEFT   — `leading`: 'back' (lucide ChevronLeft) · 'menu' (hamburger, opens the drawer) · 'none'.
 *              Camera root + reveal-refusal card pair 'menu' with the left-aligned serif `voxi` wordmark
 *              (design.md nav-home). The large-title drawer SECTIONS (Collection/Settings) use 'menu' with NO
 *              wordmark (empty center; the in-body <Title> carries the screen name) — those get a small optical
 *              nudge (`menuNudge`) so the hamburger's ink aligns to the body content gutter.
 *   • CENTER — optional `title` (Nunito 600 / headline — NEVER serif), truly centered when there's no wordmark
 *              (design.md nav-modal). Empty on the large-title screens (they keep their in-body <Title>).
 *   • RIGHT  — optional close X (`showClose`/`onClose`) — the modal dismiss, kept top-right by convention.
 *
 * The bar ALWAYS owns its own top inset. Full-bleed screens (camera viewfinder, processing/reveal photo) render
 * it inside their absolute overlay with `onMedia` (white glyphs in a scrim circle). Every other screen mounts it
 * via `<Screen header={<AppHeader/>}>`, which drops the top safe-area edge so the header is the SINGLE inset owner
 * (no double-inset).
 *
 * Leading/close default to a GUARDED dismiss: `router.canGoBack() ? router.back() : router.replace(fallback)`,
 * so a deep-linked / web-reloaded screen never dead-clicks. Screens override via `onLeadingPress`/`onClose` to
 * run a side effect first (reveal resets capture state, processing aborts the scan). `useDrawer()` no-ops with
 * no DrawerHost (modals), so `leading='none'` there is safe.
 */
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, X, Menu, MoreHorizontal } from 'lucide-react-native'
import { Wordmark } from './ui'
import { GlassFill } from './GlassFill'
import { ids, tid } from '../lib/testid'
import { space, hit, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { useDrawer } from '../lib/drawerContext'

const BAR_H = 44 // content height below the status-bar inset — constant, never varies with the controls

export function AppHeader({
  leading = 'back',
  showClose = false,
  onClose,
  onLeadingPress,
  title,
  titleNode,
  showWordmark = false,
  onMedia = false,
  fallback = '/(tabs)/camera',
  showMore = false,
  onMore,
}: {
  leading?: 'back' | 'menu' | 'none'
  /** render the dismiss X in the right slot (modals). */
  showClose?: boolean
  /** override the X handler (implies a close X). Defaults to the guarded dismiss. */
  onClose?: () => void
  /** override the leading (back/menu) handler. */
  onLeadingPress?: () => void
  title?: string
  /** A custom centered title node (the reveal supplies its own tappable, 2-line, over-photo title). Wins over `title`. */
  titleNode?: React.ReactNode
  showWordmark?: boolean
  /** true over the camera viewfinder / a captured photo → white glyphs in a scrim circle. */
  onMedia?: boolean
  /** guarded-dismiss target when there's no back-stack (deep-link / web reload). */
  fallback?: string
  /** render the ⋯ overflow in the right slot (the reveal item header → opens the MORE action sheet). Mutually
   *  exclusive with the close X in practice (a media/back header has no X). */
  showMore?: boolean
  onMore?: () => void
}): React.ReactElement {
  const { surface } = useTheme()
  const { open, isOpen } = useDrawer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const tint = onMedia ? '#FFFFFF' : surface.text

  const dismiss = (): void => {
    if (router.canGoBack()) router.back()
    else router.replace(fallback as never)
  }
  const leadingHandler = onLeadingPress ?? (leading === 'menu' ? open : dismiss)
  const closeHandler = onClose ?? dismiss
  const showX = showClose || !!onClose

  const ctrlStyle = [styles.ctrl, onMedia && styles.scrim]

  return (
    <View {...tid(ids.nav.header)} style={[styles.bar, { paddingTop: space.sm + insets.top }]}>
      <View style={styles.leftRow}>
        {leading === 'back' ? (
          <Pressable {...tid(ids.nav.back, 'Back')} accessibilityRole="button" onPress={leadingHandler} hitSlop={12} style={ctrlStyle}>
            {onMedia ? <GlassFill radiusStyle={styles.discRadius} /> : null}
            <ChevronLeft size={26} color={tint} strokeWidth={2.5} />
          </Pressable>
        ) : leading === 'menu' ? (
          <Pressable
            {...tid(ids.nav.menuButton, 'Open menu')}
            accessibilityRole="button"
            accessibilityState={{ expanded: isOpen }}
            onPress={leadingHandler}
            hitSlop={12}
            style={[ctrlStyle, !onMedia && !showWordmark && styles.menuNudge]}
          >
            {onMedia ? <GlassFill radiusStyle={styles.discRadius} /> : null}
            <Menu size={26} color={tint} strokeWidth={2} />
          </Pressable>
        ) : (
          <View style={styles.ctrl} />
        )}
        {showWordmark ? <Wordmark style={onMedia ? { color: '#FFFFFF' } : undefined} /> : null}
      </View>

      {titleNode && !showWordmark ? (
        <View style={styles.titleSlot}>{titleNode}</View>
      ) : title && !showWordmark ? (
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, typeStyles.headline, { color: tint }]}>
          {title}
        </Text>
      ) : (
        <View style={styles.center} />
      )}

      <View style={styles.rightSlot}>
        {showX ? (
          <Pressable {...tid(ids.nav.close, 'Close')} accessibilityRole="button" onPress={closeHandler} hitSlop={12} style={ctrlStyle}>
            {onMedia ? <GlassFill radiusStyle={styles.discRadius} /> : null}
            <X size={24} color={tint} strokeWidth={2.5} />
          </Pressable>
        ) : showMore ? (
          <Pressable {...tid(ids.nav.more, 'More actions')} accessibilityRole="button" onPress={onMore} hitSlop={12} style={ctrlStyle}>
            {onMedia ? <GlassFill radiusStyle={styles.discRadius} /> : null}
            <MoreHorizontal size={24} color={tint} strokeWidth={2.5} />
          </Pressable>
        ) : (
          <View style={styles.ctrl} />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg },
  leftRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  center: { flex: 1 },
  title: { flex: 1, textAlign: 'center' },
  // Centered slot for a custom title node (reveal): fills the space between the leading + trailing controls. Default
  // cross-axis stretch lets the node take the full width so a long title WRAPS (centered via its own textAlign)
  // rather than sizing to content and overflowing; justifyContent centers the (1- or 2-line) block vertically.
  titleSlot: { flex: 1, justifyContent: 'center', paddingHorizontal: space.sm },
  rightSlot: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  ctrl: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  // Over-media controls are Liquid-Glass discs (the dock's material) — GlassFill absolute-fills this rounded host,
  // so it must clip (overflow) and keep a backgroundColor as the no-blur/no-module fallback.
  scrim: { width: 42, height: 42, borderRadius: 9999, overflow: 'hidden', backgroundColor: 'rgba(20,18,14,0.6)' },
  discRadius: { borderRadius: 9999 },
  // Optical alignment (large-title section screens only — a wordmark-less menu header over a padded body, i.e.
  // Collection/Settings): the hamburger is centered in a 44pt hit box, so its ink sits ~4pt right of the body
  // content gutter (space.xl). Pull it back by space.xs so the glyph's left edge lines up with the <Title> below.
  menuNudge: { marginLeft: -space.xs },
})
