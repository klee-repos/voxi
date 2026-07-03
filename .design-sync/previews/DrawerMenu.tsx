// Preview for DrawerMenu — the left nav drawer contents: the "voxi" serif
// wordmark, a profile monogram + "Signed in", the nav rows (Capture / Collection
// / Settings), an Upgrade CTA, and a terracotta Sign out. It reads useAuth()
// (FakeAuth session), useApi() (the ['me'] query) and useTheme(), so the cell is
// wrapped in AuthProvider + ApiProvider + a dark SurfaceProvider (all exported on
// 'voxi'). The me() query has no server here, so it settles to the signed-in
// chrome without a fetched profile.
import { View } from 'react-native'
import { DrawerMenu, SurfaceProvider, AuthProvider, ApiProvider } from 'voxi'

export const Menu = () => (
  <SurfaceProvider surface="dark">
    <AuthProvider>
      <ApiProvider>
        <View style={{ backgroundColor: '#17181A', height: 560, width: 320 }}>
          <DrawerMenu onNavigate={() => {}} width={320} />
        </View>
      </ApiProvider>
    </AuthProvider>
  </SurfaceProvider>
)
