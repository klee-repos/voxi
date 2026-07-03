// Preview for CatalogTile — the ONE catalog capture tile (Collection grid + the
// camera-home "Recently catalogued" carousel). A durable photo thumbnail under a
// legibility scrim, with the identified label + capture date. `variant` switches
// ONLY sizing: `grid` (square, photo-book) vs `carousel` (fixed-width card). The
// no-photo path renders a cream card with dark label. Rendered on parchment.
import { View } from 'react-native'
import { CatalogTile } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, alignItems: 'flex-start', gap: 16 }}>{children}</View>
)

// A tiny embedded warm-toned image so expo-image always has something to draw in
// the capture (no network in the bundle sandbox). 2x2 sepia gradient stand-in.
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6f4a"/><stop offset="1" stop-color="#2e2416"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/></svg>`,
  )

const withPhoto = {
  threadId: 't-canon',
  title: 'Untitled capture',
  revealTitle: '1976 Canon AE-1',
  band: 'CONFIDENT',
  createdAt: new Date('2026-06-30').getTime(),
  photoUrl: PHOTO,
} as any

const noPhoto = {
  threadId: 't-eames',
  title: 'Moulded plywood lounge chair',
  revealTitle: 'Eames Lounge Chair',
  band: 'PROBABLE',
  createdAt: new Date('2026-05-14').getTime(),
  photoUrl: null,
} as any

// grid: 47% width in-app — give it a fixed 180 square so the cell reads on its own.
export const Grid = () => (
  <Cream>
    <View style={{ width: 180, height: 180 }}>
      <CatalogTile item={withPhoto} variant="grid" onPress={() => {}} />
    </View>
  </Cream>
)

export const GridNoPhoto = () => (
  <Cream>
    <View style={{ width: 180, height: 180 }}>
      <CatalogTile item={noPhoto} variant="grid" onPress={() => {}} />
    </View>
  </Cream>
)

export const Carousel = () => (
  <Cream>
    <CatalogTile item={withPhoto} variant="carousel" onPress={() => {}} />
  </Cream>
)

export const CarouselNoPhoto = () => (
  <Cream>
    <CatalogTile item={noPhoto} variant="carousel" onPress={() => {}} />
  </Cream>
)
