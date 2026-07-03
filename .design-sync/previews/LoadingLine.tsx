// Preview for LoadingLine — inline spinner + muted caption. Cells: default copy
// and a custom label. Rendered on the parchment (cream) surface.
import { View } from 'react-native'
import { LoadingLine } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'flex-start' }}>{children}</View>
)

export const Default = () => (
  <Cream><LoadingLine /></Cream>
)
export const CustomLabel = () => (
  <Cream><LoadingLine label="Reading the room…" /></Cream>
)
