// Preview for LoadingPill — the ONE loading pill: a narrator Orb + a status line
// (+ optional footnote ack) in a dark-glass pill. Shared by the processing screen,
// the reveal's transient state, and the camera swipe beat. Reads `useTheme()` for
// text colour, so wrap in SurfaceProvider surface="dark". The pill's own glass tint
// comes from `onImage` (true = dark glass + white text over a photo).
import { View } from 'react-native'
import { LoadingPill, SurfaceProvider } from 'voxi'

const Shell = ({ children }: { children: React.ReactNode }) => (
  <SurfaceProvider surface="dark">
    <View style={{ backgroundColor: '#17181A', padding: 32, alignItems: 'center', gap: 20 }}>{children}</View>
  </SurfaceProvider>
)

// Over-a-photo dark glass, mid-analysis with a long-wait ack.
export const Analysing = () => (
  <Shell>
    <LoadingPill text="Working out what this is…" ack="Cross-checking the catalogue — a moment." orbState="thinking" onImage />
  </Shell>
)

// The speaking beat (result about to land), no footnote.
export const AlmostThere = () => (
  <Shell>
    <LoadingPill text="Almost got it" orbState="speaking" onImage />
  </Shell>
)

// The cream-surface variant (onImage=false): dark text on the light pill.
export const OnCream = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 32, alignItems: 'center' }}>
    <SurfaceProvider surface="parchment">
      <LoadingPill text="Looking closer…" ack="Just a second." orbState="thinking" onImage={false} />
    </SurfaceProvider>
  </View>
)
