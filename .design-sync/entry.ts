// Bundle entry for the Voxi design system → claude.ai/design.
// This repo is a React Native (Expo) app, not a conventional web component
// library: components are built from `react-native` primitives that render in a
// browser only via react-native-web. This entry re-exports the web-safe
// component sources (NEVER a `.native.tsx`, never the `.ttf`-importing fonts.ts)
// so the converter bundles the app's REAL components through RNW (aliased in
// tsconfig.bundle.json — the same substitutions the converge E2E harness uses).
// The `./preamble` import MUST stay first (sets the RN-web runtime globals);
// `./rnw-rootfix` second (arms the render-check root-selector fix before RNW loads).
import './preamble'
import './rnw-rootfix'

// Theme context — cfg.provider wraps every preview in <ThemeProvider>; dark-shell
// component previews nest <SurfaceProvider surface="dark"> themselves.
export { ThemeProvider, SurfaceProvider } from '../app/src/lib/themeProvider'
// Surface tokens re-exported so previews can pass a `surface` object to the few
// components that take one as an explicit prop (e.g. KaraokeTranscript).
export { dark, parchment } from '../app/src/lib/theme'
// Auth + API providers — DrawerMenu reads useAuth()/useApi(); its preview wraps
// in these (AuthProvider → FakeAuth via EXPO_PUBLIC_TEST_MODE in the preamble).
export { AuthProvider } from '../app/src/lib/clerk'
export { ApiProvider } from '../app/src/lib/api'

// ── UI primitives (app/src/components/ui.tsx) ──
export {
  Screen,
  Title,
  Wordmark,
  Link,
  Body,
  Muted,
  Button,
  TextField,
  Toggle,
  LoadingLine,
  ErrorState,
} from '../app/src/components/ui'

// ── standalone components ──
export { ConfidenceChip } from '../app/src/components/ConfidenceChip'
export { Orb } from '../app/src/components/Orb'
export { PulseRings } from '../app/src/components/PulseRings'
export { OfflineBanner, SafetyRefusal } from '../app/src/components/Banners'
export { CaptureOrb } from '../app/src/components/CaptureOrb'
export { CatalogTile } from '../app/src/components/CatalogTile'
export { CodeInput } from '../app/src/components/CodeInput'
export { ComposeHero } from '../app/src/components/ComposeHero'
export { ConfirmDialog } from '../app/src/components/ConfirmDialog'
export { KaraokeTranscript } from '../app/src/components/KaraokeTranscript'
export { LegalNote } from '../app/src/components/LegalNote'
export { LoadingOverlay } from '../app/src/components/LoadingOverlay'
export { LoadingPill } from '../app/src/components/LoadingPill'
export { PlayerTransport } from '../app/src/components/PlayerTransport'
export { RecentCard } from '../app/src/components/RecentCard'
export { Scrubber } from '../app/src/components/Scrubber'
export { RevealMoreMenu } from '../app/src/components/RevealMoreMenu'
export { AppHeader } from '../app/src/components/AppHeader'
export { AudioElement } from '../app/src/components/AudioElement'
export { FadeRise } from '../app/src/components/FadeRise'
export { GlassFill } from '../app/src/components/GlassFill'
export { BucketDock, BucketCard } from '../app/src/components/RevealDock'
// DrawerHost is a structural host (mounts DrawerMenu + drawer animation) with no
// standalone visual — dropped from the DS; DrawerMenu (the nav surface) is kept.
export { DrawerMenu } from '../app/src/components/Drawer'
