import { View } from 'react-native'
import { Body } from 'voxi'

export const Default = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12 }}>
    <Body>
      A moulded plywood shell on a five-star aluminium base. Designed to look
      effortless and be anything but — the sort of chair that appears in films
      to signal that a character has read at least one book about design.
    </Body>
  </View>
)

export const Clamped = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12 }}>
    <Body numberOfLines={2}>
      Point me at a human-made object and I shall tell you, with as much
      precision as the evidence permits, exactly what it is — and rather more
      than you strictly needed to know about it.
    </Body>
  </View>
)

export const Short = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12 }}>
    <Body>Point me at a human-made object.</Body>
  </View>
)
