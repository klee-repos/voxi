// Preview for TextField — the boxed input (card fill, hairline border). Cells:
// filled value, empty w/ placeholder, and multiline. Rendered on parchment.
import { View } from 'react-native'
import { TextField } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'stretch' }}>
    <View style={{ width: 320 }}>{children}</View>
  </View>
)

export const Filled = () => (
  <Cream><TextField id="tf-filled" value="Eames Lounge Chair" onChangeText={() => {}} /></Cream>
)
export const Empty = () => (
  <Cream><TextField id="tf-empty" value="" onChangeText={() => {}} placeholder="Name this find…" /></Cream>
)
export const Email = () => (
  <Cream><TextField id="tf-email" value="curator@voxi.app" onChangeText={() => {}} keyboardType="email-address" placeholder="you@example.com" /></Cream>
)
export const Multiline = () => (
  <Cream><TextField id="tf-multi" value="A moulded plywood shell on a rosewood veneer — mid-century, and rather pleased with itself." onChangeText={() => {}} multiline placeholder="Add a note…" /></Cream>
)
