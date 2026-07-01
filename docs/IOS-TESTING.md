# iOS-native E2E testing (Maestro + Appium)

The web/backend E2E backbone runs here in CI (Playwright vs the Expo web build + BFF test-mode). But a set
of TEST-PLAN rows can **only** be proven on real iOS — they exercise OS-level capabilities the web surface
does not have: the camera, push-to-talk microphone, StoreKit 2 purchases (direct, no vendor), Universal-Link
deep-links, and Dynamic Type / 44pt touch targets. Those rows live on the **I** surface and are authored as
**Maestro flows** under `e2e/flows/*.yaml`, one file per row.

> Toolchain reality: this sandbox has **Command Line Tools only** (no full Xcode, no simulator), so the iOS
> flows are **authored and structurally validated here but executed on a Mac w/ Xcode** (or a device cloud
> like Maestro Cloud / BrowserStack). Nothing here fakes an iOS pass.

## Why these rows are iOS-only (not web)

| Row | iOS-only capability under test |
|-----|--------------------------------|
| `cam-01` | In-app camera/mic **permission priming shown before the OS prompt**, then the real iOS permission dialog |
| `cam-02` | Real **camera-permission-denied** state + recovery CTA that deep-links to the iOS **Settings** app |
| `cam-03` | Native camera **shutter → capture → signed-URL upload → processing** rises |
| `cam-05` | On-device **face-dominant refusal** ("objects, not people") that short-circuits **before** any upload/spend |
| `conv-01` | Full-screen orb **push-to-talk** voice mode + persistent **live-mic indicator** (press-and-hold gesture) |
| `conv-03` | A voice turn round-trips with the **same Voxi ElevenLabs voice** as the description narration |
| `conv-05` | **Voice-minutes-exhausted** hard-cutoff → in-persona message + the **StoreKit 2** paywall |
| `auth-05` | **Magic-link deep-link** (Universal Link) opens the app straight to an authed state |
| `a11y-04` | **Dynamic Type** scales the serif within clamps; **44pt** minimum touch targets |
| `sub-03` | **StoreKit 2** paywall renders (direct, no vendor); **restore purchases** |
| `thread-04` | Collection/retention mechanic ("uncatalogued near you") |

## Authoring rules (the "no cheating" guarantees)

1. **Locate only by testId.** Every `tapOn` / `assertVisible` references an id from
   `e2e/framework/testids.ts`. The iOS app exposes the **same** strings as `accessibilityIdentifier`s, so a
   rename is one edit and selectors never drift. **No coordinate taps** — `point:` / `x:`/`y:` are banned.
   The only non-id matchers permitted are **system-owned UI** outside our app (the OS "Allow" permission
   button, the "Settings" app title), which by definition have no testId.
2. **Deterministic by construction.** Every flow launches with `VOXI_TEST_MODE: "1"` and a
   `voxiTestSeed` (and, for voice, a `voxiVoiceFixture`). Test mode honors a fixed OTP/magic token, seeds the
   world (entitlements, catalog items), and feeds the camera/mic deterministic fixtures — so a run is
   reproducible with no live AI/voice spend and no flaky timing.
3. **Permissions are driven by the OS, not faked in-app.** Flows set the permission state on `launchApp`
   (`permissions: { camera: deny | allow | unset, microphone: ... }`) so the real platform path is exercised.
   `unset` is used by `cam-01` specifically to prove our primer renders **before** the system asks.
4. **Assert on real observable state.** Outcomes bottom out in a visible testId (e.g. `processing.screen`,
   `paywall.screen`, `global.safetyRefusal`) — never on app internals.

## Running the flows (on a Mac w/ Xcode)

```bash
# install Maestro once (https://maestro.mobile.dev)
curl -Ls "https://get.maestro.mobile.dev" | bash

# build + install the app onto a booted simulator/device, then:
maestro test e2e/flows/cam-01.yaml
maestro test e2e/flows/            # run every flow in the directory
```

`npm run e2e:ios` (root) prints this reminder; it does not attempt to run iOS here.

### Compiling a Scenario to a flow (optional)

A Scenario authored against `e2e/framework/driver.ts` can be compiled to a Maestro flow without a device — run
this anywhere (no Mac required), then `maestro test` the output on a Mac:

```ts
import { compileFlow } from './e2e/framework/drivers/maestro'
import scenario from './e2e/scenarios/your-scenario.scenario'

const yaml = await compileFlow(scenario, {
  env: { VOXI_TEST_MODE: '1', EMAIL: 'qa@voxi.test', OTP: '424242' },
  permissions: { camera: 'allow', microphone: 'allow' },
})
// write to e2e/flows/<id>.yaml, review (resolve any `# AGENTIC STEP` comments), then `maestro test` it.
```

### Driving the agentic Agent (Appium)

On a Mac with an Appium server + XCUITest + a booted simulator, the iOS agentic explorer is the framework
`Agent` wrapping an `AppiumDriver`:

```ts
import { AppiumDriver } from './e2e/framework/drivers/appium'
import { Agent } from './e2e/framework/agent'

const driver = new AppiumDriver(session) // `session` = a connected WebdriverIO/Appium remote
const agent = new Agent(driver, llmPlanner) // planner observes driver.a11yTree() (from the XCUITest source)
await agent.achieve('photograph the bike and wait until the Guide settles')
// then PIN the outcome deterministically (the agent never decides pass/fail):
await expect.chipBand(ids.reveal.confidenceChip, 'PROBABLE')
```

`AppiumDriver.a11yTree()` parses the XCUITest page source into the framework `A11yNode` tree the planner reads;
structured attributes (`chip.band`, `orb.state`, `voice.id`) are read via `state(id).attrs` — the data Maestro
YAML cannot assert on.

## The drivers (`e2e/framework/drivers/`)

The committed **YAML flows are the source of truth** for the deterministic iOS backbone and run via the
`maestro` CLI directly. The two TypeScript drivers let the **same `Scenario` objects** (authored once against
`e2e/framework/driver.ts`) also bind to iOS, keeping the "author once, three surfaces" contract:

- **`maestro.ts` — `MaestroDriver` (deterministic) + `compileFlow` (the compiler).** Each `Driver` primitive
  emits the exact Maestro command the committed flows use
  (`tapOn`/`inputText`/`longPressOn`/`extendedWaitUntil`/`assertNotVisible`), locating only by testId. With no
  transport bound (this sandbox) every action throws an honest error rather than reporting a false pass.
  `compileFlow(scenario, opts)` runs a Scenario against a **record-mode** driver (no device needed) and
  serializes the recorded commands to a Maestro flow YAML — the SAME shape as the hand-written flows
  (`appId` + `env` header, `launchApp` with `clearState`/`permissions`/`arguments`, then the command list with
  bare numeric `timeout`s). This is what keeps "author once, three surfaces" honest: a new iOS scenario written
  against `driver.ts` compiles to a runnable `maestro test` flow instead of being hand-ported. Compile-time
  rules: it refuses a scenario that does not target the iOS surface; `grantPermission()` overrides fold into
  the `launchApp` permission map; `speak()` becomes a `voxiVoiceFixture` launch argument; and an **agentic
  `agent.achieve(...)` step cannot be statically unrolled, so it is emitted as a `# AGENTIC STEP …` comment**
  the author must resolve to deterministic taps before committing the generated flow (no fabricated taps).
- **`appium.ts` — `AppiumDriver` (agentic + structured-attribute reads).** A full XCUITest/WebDriver session
  that exposes the live accessibility tree for `Agent.achieve` navigation, and can read **structured
  attributes Maestro YAML cannot** — e.g. `voice.id` on a Voxi turn (the `conv-03` same-voice check),
  `chip.band` on a reveal chip, `orb.state` on the orb. Locates only by `accessibilityIdentifier` (== testId).

Both are toolchain-gated: instantiating/running them requires the `maestro` CLI / an Appium server + a booted
iOS simulator on a Mac w/ Xcode.

## A note on `conv-03` (same-voice assertion)

Maestro YAML can match only `id` / `text` / `traits`, so judging "same ElevenLabs voice" by ear is not an
option (and would be non-deterministic). The app therefore **encodes the voice identity into the Voxi turn's
accessibility text** (a `voice:voxi` token), the same token the reveal description narration carries; the
flow asserts that token is present on the spoken reply. For richer checks the **`AppiumDriver` reads the raw
`voice.id` attribute** directly. Both paths assert voice **consistency** deterministically — no ear-judging.
