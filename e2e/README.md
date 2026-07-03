# Voxi E2E — hybrid deterministic + agentic test framework

Goal: simulate a real user (iOS taps/typing/voice) as closely as possible — "Playwright for the app" — with
a deliberate **balance between deterministic and agentic** so the suite is trustworthy *and* scales fast.
**No cheating:** tests drive the real UI through stable selectors and assert on real observable state; they
never reach into app internals to fake a pass. Vendor calls are either **recorded/replayed** (deterministic
runs) or **live** (cred-gated integration runs) — never stubbed to silently force green.

## The runnable surfaces (same scenarios, the right driver per job)

The same `Scenario` (user `Steps` + `Assertions`) compiles to whichever driver fits the surface. Deterministic
work uses precise testID drivers; agentic exploration uses agent-native drivers:

| Surface | Driver | Runs where | Covers | Why |
|---|---|---|---|---|
| **Web — deterministic** | **Playwright** (`drivers/playwright.ts`) | this sandbox / any CI (no Mac) | the golden flows: auth, navigation, threads, chat, reveal-card state, settings, error/empty/offline | precise `testID` selectors, low-flake; **proven green here** |
| **Web — agentic** | **agent-browser** (`drivers/agent-browser.ts`, vercel-labs) | this sandbox / cloud (Browserbase, Kernel) / MCP | `explore-*` suites: goal-driven sweeps, state discovery, scenario generation | native CLI **built for agents**: a11y-tree-with-refs snapshots + annotated screenshots + MCP/cloud sessions → scales the agentic layer better than hand-driving Playwright; **proven driving the real app here** |
| **iOS native — deterministic** | **Maestro** (YAML) | a Mac w/ Xcode or a device cloud | golden happy-paths + camera/voice/IAP native flows | low-flake YAML; "Playwright-for-mobile" |
| **iOS native — agentic** | **Appium / XCUITest** + agent | a Mac w/ Xcode or a device cloud | iOS exploratory + resilience | full a11y tree for an LLM planner |

> Deterministic ASSERTIONS always go through `testID`s — even in agentic runs the agent navigates by
> perception (a11y refs) but outcomes are pinned by `getByTestId` (no agentic cheating; see below).

A `Scenario` is authored **once** against the shared `Driver` interface (`driver.ts`) and a shared **testID
registry** (`testids.ts`); the runner picks Playwright / Maestro / Appium per `--surface`. This is what keeps
authoring cheap as features grow.

## The deterministic ↔ agentic balance (the core idea)

Every scenario has two kinds of steps, and you choose the mix per test:

- **Deterministic steps** — exact, pinned: `tap(ids.camera.shutter)`, `expectText(ids.reveal.title, /Cannondale/)`,
  `expectChipState(ids.reveal.confidenceChip, 'PROBABLE')`. Fast, zero flake, the backbone of CI.
- **Agentic steps** — a goal handed to an LLM driver that observes the screen (a11y tree + screenshot) and
  decides the taps to reach it: `agent.achieve("open the most recent thread and play its podcast")`.
  Resilient to layout churn; great for exploration and for generating new deterministic flows.

**The rule that prevents "agentic cheating":** an agentic step may *navigate*, but **every value that matters
is asserted deterministically.** The agent gets you to the screen; a pinned assertion proves the outcome.
e.g. `agent.achieve("scan a bicycle")` then **deterministic** `expectVisible(ids.reveal.card)` +
`expectOneOf(ids.reveal.title, ['identified','confident maybe','first witness'])`. The LLM never decides
whether the test passed.

Scaling pattern: write the **golden flow deterministically once**, then let the **agentic explorer** fan out
across variations (different objects, permission-denied, offline, low-confidence) and **auto-propose new
deterministic scenarios** from the paths it found (saved to `scenarios/_generated/` for human review — never
auto-merged). Loop-until-dry: keep exploring until N rounds surface no new uncovered screen/state.

### Agentic runners — real screens, real clicks (`bun run e2e:web:agentic`)

The agentic suite drives the **real Expo screens** (react-native-web via the converge harness, real Zustand
store, real ApiClient → real BFF) — an autonomous `Agent` navigates by perceiving the live testID/a11y tree and
tapping like a person; every outcome is pinned by a deterministic `testID` read. All live under `web/converge/`
and share one sign-in (`agentic-shared.ts`):

- **`agentic-auth`** — signs in through the real welcome + first-run UI to the real camera.
- **`agentic-collection`** — real shutter capture → revisit from the real collection (revisit replays, is not
  re-billed; identification durable server-side).
- **`reveal-agentic`** — the real reveal dock (open buckets → per-bucket spoken reveal, facts, Ask-Voxi) + the
  real refusal surface.
- **`agentic-sweep`** — one agent walks auth → both confidence bands → empty collection → settings privacy.
- **`agentic-explore-ab`** — the SAME planners over the **agent-browser** native backend (wrapped as a `Driver`,
  `drivers/agent-browser-driver.ts`); skips cleanly if the CLI/Chrome is absent. Wired as `e2e:web:explore-mcp`.

Perception matches what a user sees: `PlaywrightDriver.a11yTree()` excludes off-screen **and occluded** testIDs
(a closed RNW drawer behind the active screen is not "visible"), and `Agent.achieve({ settleMs })` paces taps
like a human so a triggered navigation/re-render lands before the next perception.

## Determinism controls (so runs are reproducible)

- **Vendor record/replay (`fixtures/`):** a `VendorTape` records real responses from Gemini/Cloud Vision/
  ElevenLabs/Deepgram/Clerk on a one-time live run, then replays byte-for-byte in CI. Keyed by a hash of the
  request (image bytes, prompt, voice_id). Live runs (`--live`) bypass the tape and hit real APIs with creds.
- **Seeded world:** each run boots a disposable Postgres (pgvector) seeded from `fixtures/seed.sql` (a known
  catalog + users + entitlements) so vector matches and quotas are deterministic.
- **Frozen clock + seeded ids** via the BFF's test header `x-voxi-test-seed` (only honored when
  `VOXI_TEST_MODE=1`), so timestamps/UUIDs/`Math.random`-driven copy are stable.
- **Stable selectors only:** every interactive element ships an `accessibilityLabel`/`testID` from
  `testids.ts`. Coordinate taps are banned in committed scenarios (lint-enforced) — that's the "no brittle
  cheating" guarantee.

## What runs without creds vs. what needs them

- **No creds, runs here now:** web Playwright scenarios for auth-shell, navigation, threads, chat-UI,
  reveal-card states, settings, error/empty/offline states — against the Expo web build + the BFF in
  `VOXI_TEST_MODE` with replayed vendor tapes + seeded DB.
- **Needs a Mac + Xcode:** Maestro/Appium iOS-native scenarios (camera capture, push-to-talk voice, StoreKit 2
  paywall (direct, no vendor), deep-link magic-link).
- **Needs vendor creds (`--live`):** the integration tier that re-records tapes and validates real
  identification accuracy, real TTS, real Clerk sessions, real safety-classifier behavior.

## Layout

```
framework/
  testids.ts        single source of truth for every selector (id registry)
  driver.ts         the Driver interface + Step/Assertion/Scenario types (surface-agnostic)
  drivers/          playwright.ts | maestro.ts (compiler) | appium.ts
  agent.ts          the agentic planner (observe a11y tree+screenshot → plan → act → assert)
  vendor-tape.ts    record/replay for all external vendors
  world.ts          disposable seeded Postgres + BFF test-mode boot
  assertions.ts     deterministic assertion helpers (expectChipState, expectPlaying, expectRefusal, …)
  runner.ts         picks surface, runs scenarios, reports (JUnit + screenshots + a11y dumps)
scenarios/          one file per feature/scenario (TS)
flows/              Maestro YAML for the iOS golden paths (generated from scenarios where possible)
fixtures/           seed.sql, vendor tapes, sample object photos
```

Run (once the app + BFF exist): `bun run e2e --surface web` (here) · `bun run e2e --surface ios` (Mac) ·
`bun run e2e --live` (re-record tapes / integration).
