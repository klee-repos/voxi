# Bug A — "Ask Voxi" voice: Daily-fork migration (device validation checklist)

## What was broken (verified RCA)
On device, opening the Conversation screen threw `TypeError: undefined is not a function` at
`app/src/lib/pipecat.ts` (the transport `require`). Metro's dev `guardedLoadModule` reports the module-factory
error to LogBox and returns `undefined` (it does not re-throw), so `createRealVoiceSession` fell through to
`null` and **the deterministic canned stub ran — real WebRTC voice never connected.** The screen did not crash.

Root cause: `@pipecat-ai/react-native-small-webrtc-transport@1.8.0` requires the **Daily fork**
`@daily-co/react-native-webrtc`. The app shipped the community `react-native-webrtc@124.0.7` and papered over the
missing peer with a Metro alias (`metro.config.js`) on the unverified "the JS APIs are compatible" assumption.
No published transport version has ever used the community fork (earliest is 1.4.0, already Daily-only), so the
alias was structurally unsound; the forks diverge at runtime.

## Code changes already applied (verifiable off-device; `bun test app/src/lib/pipecat.test.ts`)
- `app/package.json` — depend on `@daily-co/react-native-webrtc@^124.0.6-daily.2`; community `react-native-webrtc` removed.
- `app/metro.config.js` — the cross-fork `extraNodeModules` alias is removed.
- `app/src/lib/voiceMediaManager.native.ts` — imports `mediaDevices` from `@daily-co/react-native-webrtc` (same fork as the transport).
- `app/app.json` — added `ios.infoPlist.NSAllowsLocalNetworking: true` so a `--clean` prebuild keeps cleartext LAN access to the BFF.
- `@config-plugins/react-native-webrtc` is KEPT — verified it is fork-agnostic (`build/withWebRTC.js` hardcodes the
  name and does NOT `require` the community package; it only disables bitcode + adds camera/mic Info.plist strings).

## Device validation (your step — needs Mac + Xcode + the iPhone, per CLAUDE.md)
```sh
# from repo root, on the Mac with the phone connected, under Node >= 20.19.4 (Expo SDK 57 CLI)
rm -rf node_modules app/node_modules && bun install    # guarantees a single WebRTC pod (no community leftover)
cd app
npx expo prebuild --clean                              # regenerates ios/ — confirm Info.plist keeps NSAllowsLocalNetworking
npx pod-install || (cd ios && pod install)             # autolinks @daily-co/react-native-webrtc's pod
npx expo run:ios --device <UDID>
```
Then on the phone:
1. Capture → settle a CONFIDENT reveal → tap **Ask Voxi**.
2. **Expect:** NO LogBox `undefined is not a function`; the mic permission prompt appears; the orb reaches
   `listening` on hold-to-talk; a real transcript turn appears (NOT the canned "A reasonable question…" stub reply).
3. If it still fails, capture the FULL stack (with `node_modules` frames) — that pins the exact remaining symbol.

## Rollback
`git checkout -- app/package.json app/metro.config.js app/app.json app/src/lib/voiceMediaManager.native.ts && bun install`
(restores the alias + community fork — the known-broken state, but boots).

## Notes / residual risk (device-gated)
- New Architecture is on (`app.json newArchEnabled: true`); `@daily-co/react-native-webrtc@124` supports it, but
  the pod build is the one thing that can only be confirmed on the Mac.
- Do NOT reintroduce a cross-fork Metro alias — the guard test (`app/src/lib/pipecat.test.ts`) fails if you do.
