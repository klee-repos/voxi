/**
 * CatalogTile — the ONE catalog capture tile, shared by the Collection grid (`threads.tsx`) and the camera-home
 * "Recently catalogued" carousel (`RecentCard.tsx`). Before this, the Collection rendered rich photo tiles while
 * the camera-home tray rendered stale title-only cards off the SAME `['threads']` data — a DRY split that let the
 * two drift. This is the single source of truth: a durable capture thumbnail (`expo-image`, the persisted signed
 * `/media` URL) under a legibility scrim, with the identified label (`revealTitle || title`) + capture date.
 *
 *   ┌─────────────┐   photoUrl → <Image> fills the tile, scrim darkens the bottom for white label legibility
 *   │  [ photo ]  │   no photoUrl → cream card, dark label (older/no-capture threads never show a broken image)
 *   │             │
 *   │ 1976 Canon  │ ← revealTitle || title (2 lines)
 *   │ 6/30/2026   │ ← createdAt (local date)
 *   └─────────────┘
 *
 * `variant` switches ONLY sizing: `grid` reproduces the Collection tile byte-for-byte (47% width, radius.md,
 * hairline border); `carousel` is a fixed-width card for the horizontal recent row (radius.lg, no border — it
 * sits inside the cream RecentCard). testIDs default per variant (grid → threads.item/itemPhoto; carousel →
 * camera.recentItem/recentItemPhoto) so each surface keeps its own selector namespace without a copy.
 */
import React from 'react'
import { View, StyleSheet, type ViewStyle, type StyleProp } from 'react-native'
import { Image } from 'expo-image'
import { PressableTile, Body, Muted } from './ui'
import { ids, tid } from '../lib/testid'
import { radius, space } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { ThreadSummary } from '../lib/apiClient'

export type CatalogTileVariant = 'grid' | 'carousel'

const DEFAULT_IDS: Record<CatalogTileVariant, { tile: string; photo: string }> = {
  grid: { tile: ids.threads.item, photo: ids.threads.itemPhoto },
  carousel: { tile: ids.camera.recentItem, photo: ids.camera.recentItemPhoto },
}

export function CatalogTile({
  item,
  onPress,
  variant = 'grid',
  testID,
  photoTestID,
  style,
}: {
  item: ThreadSummary
  onPress: () => void
  variant?: CatalogTileVariant
  testID?: string
  photoTestID?: string
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const { surface } = useTheme()
  const tileId = testID ?? DEFAULT_IDS[variant].tile
  const photoId = photoTestID ?? DEFAULT_IDS[variant].photo
  const onPhoto = !!item.photoUrl

  return (
    <PressableTile
      id={tileId}
      onPress={onPress}
      style={[
        variant === 'grid' ? styles.grid : styles.carousel,
        { backgroundColor: surface.card, borderColor: surface.border, overflow: 'hidden' },
        style,
      ]}
    >
      {/* durable capture thumbnail — the persisted photo, loaded via its signed /media URL. */}
      {onPhoto ? (
        <Image {...tid(photoId)} source={{ uri: item.photoUrl as string }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : null}
      {onPhoto ? <View style={[StyleSheet.absoluteFill, styles.scrim]} pointerEvents="none" /> : null}
      {/* the identified label (falls back to the auto-title until the reveal settles). */}
      <Body numberOfLines={2} style={onPhoto ? styles.textOnPhoto : undefined}>
        {item.revealTitle || item.title}
      </Body>
      <Muted style={[{ marginTop: space.xs }, onPhoto ? styles.textOnPhoto : undefined]}>
        {new Date(item.createdAt).toLocaleDateString()}
      </Muted>
    </PressableTile>
  )
}

const styles = StyleSheet.create({
  // grid: byte-for-byte the Collection tile (threads.tsx styles.tile) so the extraction changes zero pixels there.
  grid: { minHeight: 120, width: '47%', borderWidth: 1, borderRadius: radius.md, padding: space.md, justifyContent: 'flex-end' },
  // carousel: a fixed-width photo card for the horizontal recent row (no border — it floats inside the cream card).
  carousel: { width: 140, minHeight: 116, borderRadius: radius.lg, padding: space.md, justifyContent: 'flex-end' },
  scrim: { backgroundColor: 'rgba(20,18,14,0.42)' }, // legibility under the white label (matches the Collection scrim)
  textOnPhoto: { color: '#FFFFFF' },
})
