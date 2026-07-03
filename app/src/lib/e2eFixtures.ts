/**
 * Web/converge stub for the native camera fixture. Never called off-device — isTestMode() is false in the web
 * bundle (EXPO_PUBLIC_TEST_MODE is a native-build-only flag), so the capture path never reaches this. Present only
 * so Metro/esbuild can resolve the `./e2eFixtures` import without pulling expo-asset into the web bundle.
 */
export async function loadFixtureDataUri(): Promise<string> {
  throw new Error('e2e camera fixtures are native-only')
}
