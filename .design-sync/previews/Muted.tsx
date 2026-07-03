import { View } from 'react-native'
import { Muted, Body } from 'voxi'

export const Default = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12 }}>
    <Muted>Catalogued 3 minutes ago · New York</Muted>
  </View>
)

export const WithBody = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 6 }}>
    <Body>Eames Lounge Chair</Body>
    <Muted>Herman Miller · first sold 1956</Muted>
  </View>
)

export const Caption = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12 }}>
    <Muted>Fairly confident — the proportions give it away.</Muted>
  </View>
)
