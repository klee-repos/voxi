/**
 * expo-haptics web/converge shim — a NO-OP stand-in.
 *
 * Haptics are native-only. The real `expo-haptics` does not bundle under the converge esbuild build (it reaches
 * expo-modules-core's `TurboModuleRegistry`), and `Platform.OS !== 'web'` guards are a build-time no-op for
 * esbuild (every `import`/`require` string is statically resolved regardless of the guard). So the harness
 * ALIASES `expo-haptics` to this file. The app touches haptics only through `app/src/lib/haptics.ts`, which
 * also guards on `Platform.OS` — this shim is the belt to that suspenders: even a stray call is a harmless
 * resolved no-op instead of a bundle failure. Mirrors the real module's surface used by the app.
 */
export enum ImpactFeedbackStyle {
  Light = 'light',
  Medium = 'medium',
  Heavy = 'heavy',
  Soft = 'soft',
  Rigid = 'rigid',
}
export enum NotificationFeedbackType {
  Success = 'success',
  Warning = 'warning',
  Error = 'error',
}
export async function impactAsync(_style?: ImpactFeedbackStyle): Promise<void> {}
export async function notificationAsync(_type?: NotificationFeedbackType): Promise<void> {}
export async function selectionAsync(): Promise<void> {}
