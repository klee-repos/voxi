/**
 * Web/E2E fallback for the native podcast transport controls. The web player is a DOM <audio> owned by
 * AudioElement; ±15s on web is a non-critical nicety, so this is a no-op (the deterministic E2E asserts playback
 * via the `playing` prop, not skip).
 */
export async function seekBy(_seconds: number): Promise<void> {
  /* no-op on web */
}
