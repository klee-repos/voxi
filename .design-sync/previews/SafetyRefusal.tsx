// Preview for SafetyRefusal — the non-identifying refusal surface. A bordered
// alert card (danger hairline, plain surface fill) that MUST read visually
// distinct from a confidence chip. props: { visible, message? }. Shown with the
// default dry refusal and a custom line. Rendered on the parchment surface.
import { View } from 'react-native'
import { SafetyRefusal } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, width: 380 }}>{children}</View>
)

export const Default = () => (
  <Cream><SafetyRefusal visible /></Cream>
)

export const CustomMessage = () => (
  <Cream>
    <SafetyRefusal
      visible
      message="I don't identify people, I'm afraid — faces are firmly outside the Guide's remit. Point me at an object and we'll get on famously."
    />
  </Cream>
)
