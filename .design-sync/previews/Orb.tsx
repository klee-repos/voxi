// Preview for Orb — Voxi's persistent narrator character: an aurora sphere
// (green hot core → blue halo) that reflects 5 voice states. Shown on the dark
// shell surface it lives on.
import { View } from 'react-native'
import { Orb, SurfaceProvider } from 'voxi'

const Shell = ({ children }: { children: React.ReactNode }) => (
  <SurfaceProvider surface="dark">
    <View style={{ backgroundColor: '#17181A', padding: 32, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  </SurfaceProvider>
)

export const Idle = () => <Shell><Orb id="orb-idle" state="idle" size={132} /></Shell>
export const Listening = () => <Shell><Orb id="orb-listening" state="listening" size={132} /></Shell>
export const Thinking = () => <Shell><Orb id="orb-thinking" state="thinking" size={132} /></Shell>
export const Speaking = () => <Shell><Orb id="orb-speaking" state="speaking" size={132} /></Shell>
export const Uncertain = () => <Shell><Orb id="orb-uncertain" state="uncertain" size={132} /></Shell>
