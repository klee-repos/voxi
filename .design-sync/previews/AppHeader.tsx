// Preview for AppHeader — the app's ONE universal top bar (constant height; only
// the glyphs swap). Three regions: LEFT leading (back chevron / hamburger / none),
// CENTER (serif wordmark OR a centered Nunito title), RIGHT (close X or ⋯ more).
// Over media it renders white glyphs in Liquid-Glass discs; on a surface it reads
// the theme (parchment) ink. useDrawer/useRouter are no-op/shimmed → renders fine.
// Full-width bar → record cfg.overrides.AppHeader = {"cardMode":"column"}.
import { View } from 'react-native'
import { AppHeader } from 'voxi'

// On-surface cells sit on parchment; give a cream backdrop so the dark ink reads.
const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8' }}>{children}</View>
)

// Camera-home / refusal card: the hamburger paired with the left serif wordmark.
export const MenuWithWordmark = () => (
  <Cream>
    <AppHeader leading="menu" showWordmark onLeadingPress={() => {}} />
  </Cream>
)

// A pushed screen: back chevron + a truly-centered Nunito title + the modal close X.
export const TitleWithClose = () => (
  <Cream>
    <AppHeader leading="back" title="Settings" showClose onClose={() => {}} onLeadingPress={() => {}} />
  </Cream>
)

// Large-title section (Collection/Settings): hamburger, empty center, no wordmark
// (the in-body title carries the screen name) — with the optical menu nudge.
export const MenuBare = () => (
  <Cream>
    <AppHeader leading="menu" onLeadingPress={() => {}} />
  </Cream>
)

// Over a photo (reveal): white glyphs in glass discs — back chevron + ⋯ overflow.
// Sits on a dark image stand-in so the glass discs + white ink read correctly.
export const OverMedia = () => (
  <View style={{ backgroundColor: '#2A2320' }}>
    <AppHeader leading="back" onMedia showMore onMore={() => {}} onLeadingPress={() => {}} />
  </View>
)
