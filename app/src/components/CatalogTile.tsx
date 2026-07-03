/**
 * CatalogTile — the ONE catalog capture tile, shared by the Collection grid (`threads.tsx`) and the camera-home
 * "Recently catalogued" carousel (`RecentCard.tsx`), so the two can't drift off the same `['threads']` data. A
 * durable capture thumbnail (`expo-image`, the persisted signed `/media` URL) under a legibility scrim, with the
 * identified label (`revealTitle || title`) + capture date.
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
import { radius, space, photoLabelScrim } from '../lib/theme'
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
      {/* Legibility scrim under the WHITE label. grid (photo-book) = a flat FOOT band (photoLabelScrim, AA-guarded
          in theme.test.ts) covering the whole label block; carousel keeps its lighter full-tile scrim unchanged. */}
      {onPhoto ? (
        <View
          pointerEvents="none"
          style={variant === 'grid' ? [styles.footScrim, { backgroundColor: photoLabelScrim }] : [StyleSheet.absoluteFill, styles.scrim]}
        />
      ) : null}
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
  // grid: the photo-book Collection tile — a square, photo-forward cell that flexes to fill its grid column (the
  // screen lays out two per row). No border: the photo defines its own edge; label sits on the foot scrim.
  grid: { flex: 1, aspectRatio: 1, borderRadius: radius.md, padding: space.md, justifyContent: 'flex-end' },
  // carousel: a fixed-width photo card for the horizontal recent row (no border — it floats inside the cream card).
  carousel: { width: 140, minHeight: 116, borderRadius: radius.lg, padding: space.md, justifyContent: 'flex-end' },
  // grid foot scrim: a flat warm-dark band over the LOWER tile so the white label clears AA over any photo
  // (photoLabelScrim, guarded in theme.test.ts). Taller than a 2-line title + date so the whole label sits on it.
  footScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' },
  scrim: { backgroundColor: 'rgba(20,18,14,0.42)' }, // carousel: lighter full-tile scrim (unchanged)
  textOnPhoto: { color: '#FFFFFF' },
})
