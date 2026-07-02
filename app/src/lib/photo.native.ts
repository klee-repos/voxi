/**
 * Read a captured `file://` JPEG into an inline `data:image/jpeg;base64,…` URI — the shape the BFF's cascade
 * decodes (services/eve-agent/agent/lib/gcp-vision.ts loadImageBytes).
 *
 * `readAsStringAsync` (base64) is the ONLY reliable file→base64 path on RN iOS: `fetch(file://)`+Blob throws
 * "Creating blobs from ArrayBuffer … not supported", and a multipart `{uri}` FormData part throws "Unsupported
 * FormDataPart implementation" under Expo's winter fetch.
 *
 * Metro resolves THIS on device; the web/converge bundle resolves `photo.ts`, keeping expo-file-system out of it.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy'

export async function toDataUri(fileUri: string): Promise<string> {
  const b64 = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64 })
  if (!b64) throw new Error('photo read produced no data')
  return `data:image/jpeg;base64,${b64}`
}
