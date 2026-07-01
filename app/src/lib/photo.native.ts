/**
 * Read a captured `file://` JPEG into an inline `data:image/jpeg;base64,…` URI — the exact shape the BFF's
 * cascade decodes (services/eve-agent/agent/lib/gcp-vision.ts loadImageBytes).
 *
 * Uses expo-file-system's `readAsStringAsync` (base64) — the ONLY reliable file→base64 path on RN iOS. The
 * earlier `fetch(file://)`+Blob/FileReader approach throws "Creating blobs from ArrayBuffer … not supported",
 * and a multipart `{uri}` FormData part throws "Unsupported FormDataPart implementation" under Expo's winter
 * fetch. ExpoFileSystem's native module is compiled into the build; this is JS-only.
 *
 * Metro resolves THIS on device; the web/converge bundle resolves `photo.ts` (a pass-through), keeping
 * expo-file-system out of the web bundle.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy'

export async function toDataUri(fileUri: string): Promise<string> {
  const b64 = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64 })
  if (!b64) throw new Error('photo read produced no data')
  return `data:image/jpeg;base64,${b64}`
}
