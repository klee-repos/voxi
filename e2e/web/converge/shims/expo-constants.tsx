/**
 * expo-constants web shim for the converge scope ONLY.
 *
 * app/src/lib/config.ts and app/src/lib/clerk.tsx import expo-constants to read `Constants.expoConfig?.extra`
 * (the public, non-secret runtime config baked by app.config). Under the real Expo web build, babel-preset-expo
 * + the expo plugin supply the populated Constants object; here we are bundling app screens in isolation with no
 * app.config, so we provide the SAME shape with an empty `extra` (and `manifest`/`manifest2` = null). The screens
 * then fall back to their public-env defaults — exactly the path the real web build takes when `extra` is unset:
 *   config.ts → apiBaseUrl resolves to '/api' on web (Platform.OS === 'web'),
 *   clerk.tsx → PUBLISHABLE_KEY is '' → the deterministic FakeAuth provider (the harness auth seam) is used.
 *
 * This does NOT edit a single line of app/; it satisfies the `expo-constants` import the same way Metro would
 * with no `extra` configured, and is what makes the FakeAuth (`test:<user>`) bearer the active auth in converge.
 */
const Constants = {
  expoConfig: { extra: {} as Record<string, string | undefined> },
  manifest: null,
  manifest2: null,
  executionEnvironment: 'bare',
}

export default Constants
