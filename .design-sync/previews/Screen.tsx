import { View } from 'react-native'
import { Screen, Title, Body, Muted, SurfaceProvider } from 'voxi'

export const Parchment = () => (
  <View style={{ height: 320 }}>
    <Screen padded>
      <Title>Recently catalogued</Title>
      <Body style={{ marginTop: 8 }}>
        Point me at a human-made object and I shall do my level best to tell you
        what it is.
      </Body>
      <Muted style={{ marginTop: 8 }}>Catalogued 3 minutes ago · New York</Muted>
    </Screen>
  </View>
)

export const Dark = () => (
  <SurfaceProvider surface="dark">
    <View style={{ height: 320 }}>
      <Screen padded>
        <Title>The Guide</Title>
        <Body style={{ marginTop: 8 }}>
          Hold steady — I'm reading the room. This won't take a moment.
        </Body>
        <Muted style={{ marginTop: 8 }}>Listening…</Muted>
      </Screen>
    </View>
  </SurfaceProvider>
)
