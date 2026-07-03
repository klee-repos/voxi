// Preview for ConfidenceChip — the reveal band chip. Its treatment changes by
// band: solid green (CONFIDENT), warm-gold outline (PROBABLE), neutral (UNKNOWN).
// Shown on the parchment (cream) reveal surface it lives on.
import { View } from 'react-native'
import { ConfidenceChip } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, alignItems: 'flex-start', gap: 12 }}>{children}</View>
)

export const Confident = () => (
  <Cream><ConfidenceChip band="CONFIDENT" /></Cream>
)
export const Probable = () => (
  <Cream><ConfidenceChip band="PROBABLE" /></Cream>
)
export const Unknown = () => (
  <Cream><ConfidenceChip band="UNKNOWN" /></Cream>
)
export const AllBands = () => (
  <Cream>
    <ConfidenceChip band="CONFIDENT" />
    <ConfidenceChip band="PROBABLE" />
    <ConfidenceChip band="UNKNOWN" />
  </Cream>
)
