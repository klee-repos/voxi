// Preview for PulseRings — three staggered concentric hairline rings that expand
// and fade around the narrator Orb (a listening/processing motion cue). Decorative
// (hidden from AT). Takes `active`/`reduceMotion`/`color`/`size` as EXPLICIT props
// (not from context). reduce-motion OR inactive → two STATIC hairlines, no pulse.
// Shown on the dark shell it lives on.
import { View } from 'react-native'
import { PulseRings, SurfaceProvider } from 'voxi'

const Shell = ({ children }: { children: React.ReactNode }) => (
  <SurfaceProvider surface="dark">
    <View style={{ backgroundColor: '#17181A', padding: 40, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  </SurfaceProvider>
)

// A small aurora-green core so the rings visibly frame something (as they do the Orb).
const Core = () => (
  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#2FB463' }} />
)

// Voxi accent green — the ring hue used around the narrator during a voice session.
const RING = '#2FB463'

// Active but reduce-motion → the calm two-hairline STATIC frame (what a captured
// still shows, and what a reduce-motion user sees). This is the stable frame.
export const Active = () => (
  <Shell>
    <PulseRings active reduceMotion={true} color={RING} size={220}>
      <Core />
    </PulseRings>
  </Shell>
)

// Inactive → also the two static hairlines (identical calm state, no pulse).
export const Inactive = () => (
  <Shell>
    <PulseRings active={false} reduceMotion={false} color={RING} size={220}>
      <Core />
    </PulseRings>
  </Shell>
)

// A blue halo hue + smaller size — proves color + size are honored.
export const BlueSmall = () => (
  <Shell>
    <PulseRings active reduceMotion={true} color="#3D89F5" size={160}>
      <Core />
    </PulseRings>
  </Shell>
)
