// Preview for FadeRise — the reduce-motion-aware mount transition for content that
// "rises" into view. A pure WRAPPER: it fades + translates its children up on
// mount. With reduce-motion ON it swaps the rise for a plain cross-fade but always
// shows the content (the flag calms motion, never hides). Takes `reduceMotion`
// (explicit) + optional `delay`/`style`. Pass reduceMotion so the SETTLED end
// state renders. Shown wrapping real content on a cream backdrop.
import { View } from 'react-native'
import { FadeRise, CatalogTile, Body, Title } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, alignItems: 'flex-start', gap: 16 }}>{children}</View>
)

const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6f4a"/><stop offset="1" stop-color="#2e2416"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/></svg>`,
  )

const item = {
  threadId: 't-canon',
  title: 'Untitled capture',
  revealTitle: '1976 Canon AE-1',
  band: 'CONFIDENT',
  createdAt: new Date('2026-06-30').getTime(),
  photoUrl: PHOTO,
} as any

// NOTE: the capture harness FREEZES the page clock, so FadeRise's opacity-0→1
// mount tween never advances → content would be invisible in the still. We pass a
// `style={{opacity:1}}` override (a later style entry wins the opacity key) +
// `reduceMotion` (translateY→0) to render the SETTLED end state honestly. On a real
// clock the tween runs on its own; this only pins the captured frame.
const settled = { opacity: 1 } as any

// Wrapping a text block — settled state: content fully opaque, no offset.
export const Text = () => (
  <Cream>
    <FadeRise reduceMotion style={settled}>
      <View style={{ gap: 6 }}>
        <Title>Rises into view</Title>
        <Body>A mount transition wrapper: fades + lifts its children in.</Body>
      </View>
    </FadeRise>
  </Cream>
)

// Wrapping a real capture tile — proves it wraps arbitrary content with no layout
// change once settled.
export const WrapsTile = () => (
  <Cream>
    <FadeRise reduceMotion style={settled}>
      <CatalogTile item={item} variant="carousel" onPress={() => {}} />
    </FadeRise>
  </Cream>
)
