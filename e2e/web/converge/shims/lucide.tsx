/**
 * lucide-react-native web/converge shim.
 *
 * The app uses Lucide icons (design.md's icon base) for its chrome. Lucide RN icons render through
 * `react-native-svg`, which (a) is an app-workspace dep the converge scope can't resolve and (b) pulls Fabric
 * native code that breaks the esbuild browser bundle (per the redesign plan §4/§7). The icons are decorative —
 * every converge/E2E assertion targets the `testID` on the surrounding Pressable, never the glyph — so the
 * harness ALIASES `lucide-react-native` to these size-preserving stub Views. The real `expo start --web` + native
 * builds use the real icons (react-native-svg supports web); only the isolated converge bundle uses this stub.
 */
import React from 'react'
import { View } from 'react-native'

type IconProps = { size?: number; color?: string; strokeWidth?: number; style?: unknown }
const Stub = ({ size = 24 }: IconProps): React.ReactElement => (
  <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no" aria-hidden />
)

export const Menu = Stub
export const Aperture = Stub
export const Camera = Stub
export const Images = Stub
export const LayoutGrid = Stub
export const Library = Stub
export const History = Stub
export const X = Stub
export const ChevronLeft = Stub
export const ArrowLeft = Stub
export const Play = Stub
export const Pause = Stub
export const Sparkles = Stub
export const Settings = Stub
export const Plus = Stub
export const Search = Stub
// ANALYSIS-UX reveal dock glyphs (details + conversation + retry; the per-bucket glyphs are retained for the
// app-side ICON map though the dock no longer renders them post-collapse)
export const BookOpen = Stub
export const Target = Stub
export const Stamp = Stub
export const Lightbulb = Stub
export const AudioLines = Stub
export const ScrollText = Stub // the Details dock icon (the research lane collapsed to one slot)
export const MessageCircle = Stub
export const RotateCcw = Stub
export const RefreshCw = Stub // Deep Dive player: regenerate (left of the close X) — distinct from the ±15 rotate arrows
// reveal ⋯ More-menu glyphs (header overflow + regenerate/delete rows)
export const MoreHorizontal = Stub
export const RotateCw = Stub
export const Trash2 = Stub
export const Check = Stub // CatalogTile multi-select badge (the selected-tile checkmark)
export default Stub
