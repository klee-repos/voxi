/**
 * Font loading + families for Voxi's design system (see design.md → Typography).
 *   • sans  = Nunito   — the UI face
 *   • serif = Fraunces — logo / display only (the "voxi" wordmark)
 *
 * RN does NOT honour `fontWeight` on a named static instance, so always pick the correct *family* for the weight
 * you want — use `sans(weight)` / `serif(weight)` or a ready style from `typeStyles`.
 */
import { useFonts } from 'expo-font'
import {
  Nunito_400Regular,
  Nunito_500Medium,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
} from '@expo-google-fonts/nunito'
import {
  Fraunces_700Bold,
  Fraunces_800ExtraBold,
  Fraunces_900Black,
} from '@expo-google-fonts/fraunces'
import {
  OpenSans_400Regular,
  OpenSans_600SemiBold,
  OpenSans_700Bold,
} from '@expo-google-fonts/open-sans'

/** Every font instance loaded at startup, keyed by its RN family name. */
export const fontsToLoad = {
  Nunito_400Regular,
  Nunito_500Medium,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
  Fraunces_700Bold,
  Fraunces_800ExtraBold,
  Fraunces_900Black,
  // Open Sans — the documented sans fallback; loaded so it's available too.
  OpenSans_400Regular,
  OpenSans_600SemiBold,
  OpenSans_700Bold,
} as const

/** Load all design-system fonts. Returns `[loaded, error]`. Call once at the app root and hold rendering until loaded. */
export function useVoxiFonts(): [boolean, Error | null] {
  return useFonts(fontsToLoad)
}

export type SansWeight = '400' | '500' | '600' | '700' | '800'
export type SerifWeight = '700' | '800' | '900'

const SANS: Record<SansWeight, string> = {
  '400': 'Nunito_400Regular',
  '500': 'Nunito_500Medium',
  '600': 'Nunito_600SemiBold',
  '700': 'Nunito_700Bold',
  '800': 'Nunito_800ExtraBold',
}
const SERIF: Record<SerifWeight, string> = {
  '700': 'Fraunces_700Bold',
  '800': 'Fraunces_800ExtraBold',
  '900': 'Fraunces_900Black',
}

/** Correct static family name for a sans weight. */
export const sans = (weight: SansWeight = '400'): string => SANS[weight]
/** Correct static family name for a serif weight (logo/display only). */
export const serif = (weight: SerifWeight = '800'): string => SERIF[weight]

/** Per-weight family maps, e.g. `fontFamily.sans['600']`. */
export const fontFamily = { sans: SANS, serif: SERIF } as const

/**
 * The design.md type ramp as ready-to-use RN text styles. DEFINED in `./theme` (family NAMES only, no `.ttf`
 * imports) and re-exported here for back-compat, so a converge-reachable component can pull `typeStyles` WITHOUT
 * dragging this file's `@expo-google-fonts` `.ttf` imports into the esbuild web bundle (which has no `.ttf` loader).
 */
export { typeStyles } from './theme'
