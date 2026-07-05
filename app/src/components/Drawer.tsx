/**
 * Left push-drawer (design.md nav) — replaces the bottom tab bar. Opening it slides the whole content shell
 * (the `(tabs)` Stack) to the RIGHT, scales it down, rounds its corners, and dims it under a scrim, revealing
 * the cream drawer beneath-left (Shazam/Forest-style push drawer).
 *
 * Motion is RN `Animated` (JS-driven, `useNativeDriver:false`) so it renders identically web + native and stays
 * off the reanimated/gesture-handler path (which the converge bundle can't take). Edge-swipe-to-open uses core
 * RN `PanResponder` (no gesture-handler, no root view). Reduce-motion: the shell does NOT translate/scale — the
 * drawer + scrim cross-fade in on top instead, nothing hidden.
 *
 * a11y: when open, the content shell is made inert so keyboard/AT focus is trapped in the menu — via the DOM
 * `inert` prop on web (RNW forwards it; the three RN modal props are web no-ops) and `accessibilityViewIsModal`
 * / `accessibilityElementsHidden` on native. The scrim is a SIBLING of the shell (not a descendant) so it stays
 * clickable while the shell is inert. Escape (web) / scrim tap closes.
 *
 * NOT converge-bundled (only `(tabs)/_layout.tsx` mounts this; the converge entries mount screen bodies), so its
 * clerk/api/router imports are fine. Native device polish (edge-swipe, haptics) is toolchain-gated to verify.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, Animated, StyleSheet, PanResponder, Platform, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight } from 'lucide-react-native'
import { Wordmark } from './ui'
import { ids, tid } from '../lib/testid'
import { radius, space, hit, scrim as scrimColor, shadow, motion, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { useAuth } from '../lib/clerk'
import { haptics } from '../lib/haptics'
import { DrawerCtx } from '../lib/drawerContext'

export function DrawerHost({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }): React.ReactElement {
  const { width } = useWindowDimensions()
  const drawerWidth = Math.min(320, Math.round(width * 0.82))
  const { surface, reduceMotion } = useTheme()
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const anim = useRef(new Animated.Value(0)).current // 0 closed → 1 open

  const settle = useCallback(
    (to: 0 | 1) => {
      openRef.current = to === 1
      setOpen(to === 1)
      if (to === 1) haptics.tick()
      if (reduceMotion) {
        Animated.timing(anim, { toValue: to, duration: motion.fast, useNativeDriver: false }).start()
      } else {
        Animated.spring(anim, { toValue: to, useNativeDriver: false, damping: motion.spring.damping, stiffness: motion.spring.stiffness, mass: 1 }).start()
      }
    },
    [anim, reduceMotion],
  )

  const openDrawer = useCallback(() => settle(1), [settle])
  const closeDrawer = useCallback(() => settle(0), [settle])
  const ctx = useMemo(() => ({ open: openDrawer, close: closeDrawer, isOpen: open }), [openDrawer, closeDrawer, open])

  // Web: Escape closes the drawer (WCAG 2.1.2 — modal must be keyboard-dismissible).
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return
    const onKey = (e: { key?: string }) => {
      if (e.key === 'Escape') closeDrawer()
    }
    document.addEventListener('keydown', onKey as EventListener)
    return () => document.removeEventListener('keydown', onKey as EventListener)
  }, [open, closeDrawer])

  // Edge-swipe-to-open (core RN PanResponder — web + native, no gesture-handler). Active only when closed and
  // the gesture starts near the left edge; live-tracks the shell, snaps open/closed on release.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => !openRef.current && g.moveX < 32 && g.dx > 6 && Math.abs(g.dy) < 24,
        onPanResponderMove: (_e, g) => {
          anim.setValue(Math.max(0, Math.min(1, g.dx / drawerWidth)))
        },
        onPanResponderRelease: (_e, g) => settle(g.dx > drawerWidth * 0.35 ? 1 : 0),
        onPanResponderTerminate: () => settle(0),
      }),
    [anim, drawerWidth, settle],
  )

  const translateX = reduceMotion ? 0 : anim.interpolate({ inputRange: [0, 1], outputRange: [0, drawerWidth] })
  const scale = reduceMotion ? 1 : anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] })
  const shellRadius = anim.interpolate({ inputRange: [0, 1], outputRange: [0, radius.xl] })

  // Web → DOM `inert` traps focus in the menu; native → the two props VoiceOver honors. The scrim is a sibling,
  // so it stays clickable while the shell is inert.
  const shellA11y: Record<string, unknown> =
    Platform.OS === 'web'
      ? open
        ? { inert: true }
        : {}
      : { accessibilityElementsHidden: open, importantForAccessibility: open ? 'no-hide-descendants' : 'auto' }

  // Gated off (root-hosted on a pre-auth screen: index/welcome/first-run) → render children with NO drawer
  // machinery and NO `DrawerCtx`, so `useDrawer()` no-ops and a left-edge swipe can't reveal a signed-in menu
  // where there's no hamburger to summon it. Every hook above runs unconditionally, so toggling `enabled` on
  // sign-in/out never changes hook order. (Sign-in/out always navigate, so the one-time remount is a non-issue.)
  if (!enabled) return <>{children}</>

  return (
    <DrawerCtx.Provider value={ctx}>
      <View style={styles.root}>
        {/* layer 0 (or 3 under reduce-motion): the drawer panel, revealed beneath the sliding shell */}
        <Animated.View
          style={[
            styles.menuWrap,
            { width: drawerWidth, zIndex: reduceMotion ? 3 : 0, opacity: reduceMotion ? anim : 1 },
          ]}
          pointerEvents={open ? 'auto' : 'none'}
        >
          <DrawerMenu onNavigate={closeDrawer} width={drawerWidth} />
        </Animated.View>

        {/* layer 1: the content shell (the (tabs) Stack) — slides right, inert when open */}
        <Animated.View
          {...shellA11y}
          style={[styles.shell, { backgroundColor: surface.bg, transform: [{ translateX }, { scale }], borderRadius: shellRadius }]}
        >
          {children}
        </Animated.View>

        {/* layer 2: scrim — SIBLING of the shell (stays clickable while shell is inert), moves with it */}
        <Animated.View
          pointerEvents={open ? 'auto' : 'none'}
          style={[StyleSheet.absoluteFill, styles.scrimWrap, { opacity: anim, transform: [{ translateX }] }]}
        >
          <Pressable
            {...tid(ids.drawer.scrim, 'Close menu')}
            accessibilityRole="button"
            onPress={closeDrawer}
            style={[StyleSheet.absoluteFill, { backgroundColor: scrimColor }]}
          />
        </Animated.View>

        {/* edge-swipe catcher (closed only) */}
        {!open ? <View {...pan.panHandlers} style={styles.edge} pointerEvents="box-only" /> : null}
      </View>
    </DrawerCtx.Provider>
  )
}

function NavRow({ id, label, onPress, color }: { id: string; label: string; onPress: () => void; color: string }): React.ReactElement {
  return (
    <Pressable {...tid(id)} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={[typeStyles.headline, { color }]}>{label}</Text>
    </Pressable>
  )
}

export function DrawerMenu({ onNavigate, width }: { onNavigate: () => void; width: number }): React.ReactElement {
  const router = useRouter()
  const { firstName, email, signOut } = useAuth()
  const { surface } = useTheme()

  const go = (path: string) => {
    onNavigate()
    // navigate (not push) so the back stack never deepens and no surface becomes a dead-end.
    router.navigate(path as never)
  }
  // The greeting falls back gracefully — Clerk firstName if set, else the email, else a neutral word. NEVER a
  // fabricated name (preserves the original no-fake-name invariant; the monogram avatar was removed for this).
  const who = firstName ?? email ?? 'back'

  return (
    <View {...tid(ids.drawer.screen)} accessibilityViewIsModal style={[styles.menu, { width, backgroundColor: surface.bg }]}>
      <Wordmark style={{ marginBottom: space.xl }} />

      {/* profile — the "Welcome, {name}" greeting IS the Settings entry (a row, not an avatar). The plan is the
          single static "Unlimited" label (the metering/upgrade concept no longer surfaces in UI). */}
      <Pressable
        {...tid(ids.nav.settingsTab, 'Open settings')}
        accessibilityRole="button"
        onPress={() => go('/(tabs)/settings')}
        style={({ pressed }) => [styles.profile, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[typeStyles.name, { color: surface.text }]} numberOfLines={1}>Welcome, {who}</Text>
          <Text style={[typeStyles.caption, { color: surface.textMuted }]}>Unlimited</Text>
        </View>
        <ChevronRight size={22} color={surface.textMuted} strokeWidth={2.25} />
      </Pressable>

      <View style={styles.rows}>
        <NavRow id={ids.drawer.home} label="Capture" onPress={() => go('/(tabs)/camera')} color={surface.text} />
        <NavRow id={ids.nav.threadsTab} label="Collection" onPress={() => go('/(tabs)/threads')} color={surface.text} />
      </View>

      <View style={styles.spacer} />

      <Pressable
        {...tid(ids.drawer.signOut, 'Sign out')}
        accessibilityRole="button"
        onPress={() => {
          onNavigate()
          void signOut().then(() => router.replace('/welcome'))
        }}
        style={({ pressed }) => [styles.signOut, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[typeStyles.headline, { color: surface.danger }]}>Sign out</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  menuWrap: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  shell: { flex: 1, overflow: 'hidden', zIndex: 1, ...shadow },
  scrimWrap: { zIndex: 2 },
  edge: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 24, zIndex: 4 },
  menu: { flex: 1, paddingTop: space.xxl + space.lg, paddingHorizontal: space.lg, paddingBottom: space.xl },
  profile: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xl, minHeight: hit.min },
  rows: { gap: space.xs },
  navRow: { minHeight: 48, justifyContent: 'center' },
  spacer: { flex: 1 },
  signOut: { minHeight: 48, justifyContent: 'center' },
})
