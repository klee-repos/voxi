// Preview for OfflineBanner — the cross-screen connectivity banner. A full-width
// bar (surface.offline fill, onAccent text) that appears when connectivity drops.
// props: { visible }. Shown visible on the parchment surface.
import { View } from 'react-native'
import { OfflineBanner } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, width: 380 }}>{children}</View>
)

export const Visible = () => (
  <Cream><OfflineBanner visible /></Cream>
)
