import { View } from 'react-native'
import { Wordmark, SurfaceProvider } from 'voxi'

export const OnCream = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 32 }}>
    <Wordmark style={{ fontSize: 48 }} />
  </View>
)

export const OnDark = () => (
  <SurfaceProvider surface="dark">
    <View style={{ backgroundColor: '#17181A', padding: 32 }}>
      <Wordmark style={{ fontSize: 48 }} />
    </View>
  </SurfaceProvider>
)

export const Default = () => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 32 }}>
    <Wordmark />
  </View>
)
