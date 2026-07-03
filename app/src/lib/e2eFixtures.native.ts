/**
 * Bundled E2E camera fixture → `data:image/jpeg;base64,…` (the iOS Simulator has no camera). This is an honest,
 * clearly-labeled test image fed through the SAME intake path as a real capture (readAsStringAsync base64, exactly
 * like photo.native.ts); determinism of the reveal comes from the seed steer, not the pixels.
 *
 * Metro resolves THIS on device; the web/converge bundle resolves `e2eFixtures.ts` (a throwing stub that is never
 * called there, since getTestSeed()/isTestMode() are false off-device), keeping expo-asset out of the web bundle.
 */
import { Asset } from 'expo-asset'
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FIXTURE = require('../../assets/e2e/fixture.jpg')

export async function loadFixtureDataUri(): Promise<string> {
  const asset = Asset.fromModule(FIXTURE)
  await asset.downloadAsync() // materialize the bundled asset to a local file:// uri
  const uri = asset.localUri ?? asset.uri
  const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 })
  if (!b64) throw new Error('e2e fixture read produced no data')
  return `data:image/jpeg;base64,${b64}`
}
