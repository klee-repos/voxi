// Preview for Link — the secondary-lane text link (accent-secondary ink, no
// pill). Used for evidence sources + low-emphasis actions. On parchment.
import { View } from 'react-native'
import { Link } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'flex-start' }}>{children}</View>
)

export const Default = () => (
  <Cream><Link id="ln-default" label="View the source" onPress={() => {}} /></Cream>
)
export const Sources = () => (
  <Cream>
    <Link id="ln-src-1" label="Herman Miller — product page" onPress={() => {}} />
    <Link id="ln-src-2" label="Skip for now" onPress={() => {}} />
  </Cream>
)
