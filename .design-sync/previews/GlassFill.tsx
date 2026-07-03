// Preview for GlassFill — the Liquid-Glass material fill: an absolute-fill layer
// that blurs + warm-tints whatever is painted BEHIND it (web backdrop-filter). It's
// decorative and NEVER participates in layout, so it needs a colorful backdrop to
// show the effect. Three tint depths: default (over the photo), strong (over the
// dimmed scrim), card (deepest — the reveal reading sheet). Light text on top proves
// legibility. `radiusStyle` clips the blur to the host card's rounded rect.
//
// The backdrop is built from SOLID colored Views (not an <Image> — expo-image's
// data-URI decode doesn't paint in the bundle sandbox), so the warm tint's
// translucency reads honestly against a vivid ground.
import { View, Text } from 'react-native'
import { GlassFill } from 'voxi'

// A vivid multi-colour backdrop from overlapping solid Views (always paints).
const Backdrop = () => (
  <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#f5a623' }}>
    <View style={{ position: 'absolute', left: -20, top: -20, width: 180, height: 180, borderRadius: 90, backgroundColor: '#e0457b' }} />
    <View style={{ position: 'absolute', right: -30, bottom: -30, width: 200, height: 200, borderRadius: 100, backgroundColor: '#3d89f5' }} />
    <View style={{ position: 'absolute', left: 90, top: 40, width: 120, height: 120, borderRadius: 60, backgroundColor: '#2fb463' }} />
  </View>
)

const Card = ({ label, strong, card }: { label: string; strong?: boolean; card?: boolean }) => (
  <View style={{ width: 300, height: 150, borderRadius: 20, overflow: 'hidden' }}>
    <Backdrop />
    <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20 }}>
      <GlassFill radiusStyle={{ borderRadius: 20 } as any} strong={strong} card={card} />
      <Text style={{ color: '#FFFFFF', fontFamily: 'Nunito_700Bold', fontSize: 17 }}>{label}</Text>
      <Text style={{ color: 'rgba(255,255,255,0.85)', fontFamily: 'Nunito_400Regular', fontSize: 13, marginTop: 4 }}>
        Warm tint over the colour behind it.
      </Text>
    </View>
  </View>
)

// Show the tint-depth ladder side by side: bare backdrop (no glass) → default →
// strong → card, so the graded cell reads the translucency AND the deepening tint.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#17181A', padding: 28, alignItems: 'center', gap: 16 }}>{children}</View>
)

// Bare backdrop, NO glass — the reference ground so the tint's translucency is
// legible by comparison in the same cell.
const Bare = () => (
  <View style={{ width: 300, height: 90, borderRadius: 20, overflow: 'hidden' }}>
    <Backdrop />
    <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20 }}>
      <Text style={{ color: '#FFFFFF', fontFamily: 'Nunito_700Bold', fontSize: 15 }}>No glass (bare backdrop)</Text>
    </View>
  </View>
)

// Default tint — the dock over the bright photo (lightest, gradient reads through).
export const Default = () => (
  <Frame>
    <Bare />
    <Card label="Liquid Glass dock (default)" />
  </Frame>
)

// Strong — the ⋯ MORE action sheet: a denser modal material over the scrim.
export const Strong = () => (
  <Frame>
    <Bare />
    <Card label="Strong (action sheet)" strong />
  </Frame>
)

// Card — deepest tint: the reveal reading sheet, so enlarged prose stays crisp.
export const Deep = () => (
  <Frame>
    <Bare />
    <Card label="Card (reading sheet)" card />
  </Frame>
)
