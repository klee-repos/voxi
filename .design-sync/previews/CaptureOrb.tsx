// Preview for CaptureOrb — the camera shutter: a flat green disc + white aperture
// glyph (no bloom — that's reserved for the narrator Orb). Idle breathe + press
// spring via RN Animated; reduce-motion freezes to a static disc. `busy` disables
// the control and darkens the fill. Reads surface from context; shown on the dark
// camera shell it lives on.
import { View } from 'react-native'
import { CaptureOrb, SurfaceProvider } from 'voxi'

const Shell = ({ children }: { children: React.ReactNode }) => (
  <SurfaceProvider surface="dark">
    <View style={{ backgroundColor: '#17181A', padding: 32, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  </SurfaceProvider>
)

const noop = () => {}

// Default idle shutter — accent green disc, aperture glyph, breathe animation
// settles to a static frame in the still capture.
export const Default = () => (
  <Shell>
    <CaptureOrb busy={false} onPress={noop} />
  </Shell>
)

// Busy — mid-capture: darker green (#238C4F), breathing stopped, control disabled.
export const Busy = () => (
  <Shell>
    <CaptureOrb busy onPress={noop} />
  </Shell>
)

// Smaller size variant (a compact placement) — proves the size prop scales the
// disc, rim, and aperture proportionally.
export const Small = () => (
  <Shell>
    <CaptureOrb busy={false} onPress={noop} size={72} />
  </Shell>
)
