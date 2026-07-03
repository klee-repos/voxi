// Preview for Button — the primary tap target. Three variants: filled accent
// (primary), hairline outline (secondary), filled danger. Rendered on parchment.
import { View } from 'react-native'
import { Button } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'flex-start' }}>{children}</View>
)

export const Primary = () => (
  <Cream><Button id="b-primary" label="Start a Room" onPress={() => {}} /></Cream>
)
export const Secondary = () => (
  <Cream><Button id="b-secondary" label="Not now" variant="secondary" onPress={() => {}} /></Cream>
)
export const Danger = () => (
  <Cream><Button id="b-danger" label="Delete this find" variant="danger" onPress={() => {}} /></Cream>
)
export const Disabled = () => (
  <Cream><Button id="b-disabled" label="Regenerate" disabled onPress={() => {}} /></Cream>
)
export const AllVariants = () => (
  <Cream>
    <Button id="b-all-1" label="Start a Room" onPress={() => {}} />
    <Button id="b-all-2" label="Not now" variant="secondary" onPress={() => {}} />
    <Button id="b-all-3" label="Delete this find" variant="danger" onPress={() => {}} />
  </Cream>
)
