/**
 * react-native-safe-area-context web shim for the converge scope ONLY.
 *
 * The app's <Screen> (app/src/components/ui.tsx) wraps content in <SafeAreaView>. On web there are no device
 * insets, so safe-area-context's own web build degrades SafeAreaView to a plain View; we mirror that here by
 * mapping SafeAreaView → react-native-web's <View>, which forwards testID/dataSet/accessibilityLabel to the DOM
 * exactly as the contract requires. reveal.tsx and ui.tsx are unchanged.
 */
// @ts-expect-error react-native-web has no bundled types in this scope
import { View } from 'react-native-web'

export const SafeAreaView = View
export const SafeAreaProvider = ({ children }: { children: unknown }): unknown => children
export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  return { top: 0, bottom: 0, left: 0, right: 0 }
}
