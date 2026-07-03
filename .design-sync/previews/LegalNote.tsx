// Preview for LegalNote — the consent microcopy under the primary auth CTA
// (clickwrap: 16+ attestation + tappable Terms / Privacy links in the blue
// secondary lane). No checkbox. Shared by landing + both auth email screens.
// Its `verb` swaps the leading phrase per screen. Rendered on parchment.
import { View } from 'react-native'
import { LegalNote } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, width: 360 }}>{children}</View>
)

export const Default = () => (
  <Cream><LegalNote /></Cream>
)

export const OnSignUp = () => (
  <Cream><LegalNote verb="creating an account" /></Cream>
)

export const OnContinue = () => (
  <Cream><LegalNote verb="tapping Continue" /></Cream>
)
