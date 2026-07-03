// Preview for CodeInput — the 6-digit email verification field for /sign-up and
// /sign-in. Six visual cells (the active one gets the accent border) behind one
// real transparent TextInput that holds the whole value. props: { id, value,
// onChangeText, length? }. Shown partially entered, empty, and complete.
// Rendered on the parchment surface. Controlled value + no-op handler.
import { View } from 'react-native'
import { CodeInput } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, width: 360 }}>{children}</View>
)

const noop = () => {}

export const PartiallyEntered = () => (
  <Cream><CodeInput id="ci-partial" value="4821" onChangeText={noop} autoFocus={false} /></Cream>
)

export const Empty = () => (
  <Cream><CodeInput id="ci-empty" value="" onChangeText={noop} autoFocus={false} /></Cream>
)

export const Complete = () => (
  <Cream><CodeInput id="ci-complete" value="424242" onChangeText={noop} autoFocus={false} /></Cream>
)
