/**
 * expo-image web shim for the converge scope ONLY.
 *
 * reveal.tsx renders the captured photo thumbnail via expo-image's <Image>. Under the real Expo web build,
 * expo-image ships a react-native-web-backed web implementation; here, to keep the converge bundle minimal and
 * dependency-light, we map <Image> to react-native-web's own <Image>, which renders a DOM element carrying the
 * testID/dataSet props through unchanged (the contract attributes are what the E2E driver reads, not the pixels).
 *
 * This preserves reveal.tsx unchanged. In server.ts's real-component path, expo-image's actual web build is used.
 */
// @ts-expect-error react-native-web has no bundled types in this scope
import { Image as RNWImage } from 'react-native-web'

export const Image = RNWImage
export default RNWImage
