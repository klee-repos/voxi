// Preview for Toggle — a checkbox+label switch row. Cells: checked (on) and
// unchecked (off). Rendered on the parchment (cream) surface.
import { View } from 'react-native'
import { Toggle } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'flex-start' }}>{children}</View>
)

export const On = () => (
  <Cream><Toggle id="tg-on" value={true} onValueChange={() => {}} label="Let the Guide read finds aloud" /></Cream>
)
export const Off = () => (
  <Cream><Toggle id="tg-off" value={false} onValueChange={() => {}} label="Let the Guide read finds aloud" /></Cream>
)
export const Both = () => (
  <Cream>
    <Toggle id="tg-both-on" value={true} onValueChange={() => {}} label="Reduce motion" />
    <Toggle id="tg-both-off" value={false} onValueChange={() => {}} label="Add to the public catalog" />
  </Cream>
)
