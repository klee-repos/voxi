/**
 * Web/converge fallback for the native photo reader (`photo.native.ts`). There is no live camera off-device,
 * so the capture flow drives through the signed-upload seam instead; this just passes a URI through unchanged.
 */
export async function toDataUri(uri: string): Promise<string> {
  return uri
}
