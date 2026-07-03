// Preview for RecentCard — the camera-home "Recently catalogued" OVERLAY: a
// floating card that morphs up from the bottom, clearing the capture bar, over the
// live viewfinder. Composes CatalogTile in a horizontal carousel. Three states
// (each must never lie to a returning collector): POPULATED, LOADING skeletons,
// EMPTY ghost. Reads surface + reduceMotion from context (wrapped dark — it floats
// over the dark viewfinder). It's an absolute-fill overlay, so each cell is a
// FIXED-SIZE dark stage rendered OPEN.
//   Orchestrator: add cfg.overrides.RecentCard = {"cardMode":"single","viewport":"390x520"}
import { View } from 'react-native'
import { RecentCard, SurfaceProvider } from 'voxi'

// The overlay fills its parent; stage it over a viewfinder-dark frame at phone size.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <SurfaceProvider surface="dark">
    <View style={{ width: 390, height: 520, backgroundColor: '#17181A', overflow: 'hidden' }}>{children}</View>
  </SurfaceProvider>
)

const noop = () => {}

// Warm-toned inline photo stand-ins (no network in the bundle sandbox).
const photo = (a: string, b: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/></svg>`,
  )

const threads = [
  { threadId: 't1', title: 'Untitled capture', revealTitle: 'Eames Lounge Chair', band: 'CONFIDENT', createdAt: new Date('2026-06-30').getTime(), photoUrl: photo('#8a6f4a', '#2e2416') },
  { threadId: 't2', title: 'Untitled capture', revealTitle: '1976 Canon AE-1', band: 'CONFIDENT', createdAt: new Date('2026-06-28').getTime(), photoUrl: photo('#4a5a6f', '#161d2e') },
  { threadId: 't3', title: 'Ceramic mug', revealTitle: 'Hasami Porcelain Mug', band: 'PROBABLE', createdAt: new Date('2026-06-25').getTime(), photoUrl: photo('#6f5a4a', '#2e2016') },
  { threadId: 't4', title: 'Brass desk lamp', revealTitle: 'Anglepoise 1227', band: 'PROBABLE', createdAt: new Date('2026-06-21').getTime(), photoUrl: null },
] as any

// Populated — open card, 4 tiles in the horizontal recent row, "See all" link.
export const Populated = () => (
  <Stage>
    <RecentCard
      open
      onClose={noop}
      threads={threads}
      isLoading={false}
      isError={false}
      onRetry={noop}
      onOpen={noop}
      onSeeAll={noop}
    />
  </Stage>
)

// Loading — three shimmering skeleton tiles (never collapses to the empty ghost).
export const Loading = () => (
  <Stage>
    <RecentCard
      open
      onClose={noop}
      threads={[] as any}
      isLoading
      isError={false}
      onRetry={noop}
      onOpen={noop}
      onSeeAll={noop}
    />
  </Stage>
)

// Empty — the dashed ghost prompting a first capture (settled, not loading/errored).
export const Empty = () => (
  <Stage>
    <RecentCard
      open
      onClose={noop}
      threads={[] as any}
      isLoading={false}
      isError={false}
      onRetry={noop}
      onOpen={noop}
      onSeeAll={noop}
    />
  </Stage>
)
