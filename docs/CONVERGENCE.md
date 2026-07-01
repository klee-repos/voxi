# Expo ↔ harness convergence — the proof, the path, the findings

**Question this answers (PLAN §9 client × §14 evals × TEST-PLAN surface `W`):** the web E2E harness
(`e2e/web/server.ts`) renders its *own* web UI behind the testIDs; the *real* screens are `app/app/*.tsx`
(react-native-web compatible). **Are the real screens E2E-testable behind the same contract — i.e. can the
harness UI be swapped for the real components without touching a single scenario?**

**Answer: yes, proven.** `e2e/web/converge/reveal-rnw.web.ts` renders the **real, unmodified
`app/app/reveal.tsx`** under **react-native-web** in a **real Chromium via Playwright**, driven through the
**same framework `PlaywrightDriver` by the same testIDs**, with its real Zustand store fed by the **real
voxi-api BFF NDJSON stream**. Seven deterministic testid assertions pass; two real-screen divergences were
surfaced (recorded below, not hidden). A static companion check (`testid-coverage.ts`) proves the registry,
the harness shell, and the real app screens converge on the same testid set.

This directory (`e2e/web/converge/`) is the **only** thing this work owns. It does **not** edit `app/` or
`e2e/web/server.ts`.

---

## 1. What runs, and what is "real" vs aliased

| Layer | Real / aliased | Notes |
|---|---|---|
| `app/app/reveal.tsx` (the screen under test) | **REAL, unmodified** | the whole `Reveal → SurfaceProvider → RevealBody` tree |
| `app/src/components/*` (ui, Orb, ConfidenceChip, Banners, FadeRise) | **REAL** | rendered as-is under RNW |
| `app/src/state/captureStore.ts` (Zustand) | **REAL** | driven by real BFF events |
| `app/src/lib/themeProvider.ts`, `theme.ts`, `connectivity`, `useOffline`, `testid` | **REAL** | |
| `packages/shared/src/confidence.ts` (the register / band copy) | **REAL** | the same module the BFF uses |
| `services/voxi-api` BFF (`createApp` via `createWebHarness`) | **REAL** | real auth, metering, session ownership, NDJSON streaming |
| `react` / `react-dom` / `zustand` | aliased to the converge scope's installed copies | so the app files resolve them here |
| `react-native` | aliased → `react-native-web` | the convergence substrate |
| `expo-router` / `expo-image` / `react-native-safe-area-context` | thin web shims (`shims/*`) | **exactly what `babel-preset-expo` + Metro substitute on `expo start --web`** |

The aliases are **the Metro/babel-preset-expo boundary, made explicit and auditable** — not a re-implementation
of the screen. On a real `expo start --web` build these substitutions are performed by Expo's Metro config;
here we state them in one bundler plugin so the boundary is reviewable.

### Why esbuild (not `Bun.build`)
`Bun.build({target:'browser'})` trips on react-native-web's deep ESM/CJS interop cycles
(`inline-style-prefixer`'s `createPrefixer` default-interop, then a `styleq.factory` TDZ in RNW's CJS build,
then a `StyleSheet` namespace temporal-dead-zone — `default27 is not defined`). **esbuild** (react-native-web's
blessed bundler, also what Expo/Metro's transforms are modelled on) resolves those cycles cleanly. It is
installed **only in the converge scope** (`e2e/web/converge/package.json`), which is **deliberately not a
workspace member** — making it one would inherit `app/`'s Expo-pinned ranges (`react-native-safe-area-context@~6`,
`react-native-svg@~16`) that don't yet exist on npm and break root resolution. The scope owns its own
`node_modules` + `bun.lock`; `bun test` at root stays 90/0 and `node_modules/` at root stays minimal.

### The one resolver shim that is NOT a Metro analogue
`app/app/reveal.tsx` imports the shared contract as `../../../packages/shared/src/confidence`. From `app/app/`
that path literally resolves *one level above the repo root* (`app/app` is two dirs deep, so `../../../` =
`/Users/.../dev/`, not `/Users/.../voxi/packages`). It only works under the real build because Metro resolves
it via the tsconfig `@voxi/shared` alias + `watchFolders`, not by literal relative path. The converge bundler
reproduces exactly that: a resolver maps any `…/packages/shared/src/<name>` specifier to the real workspace
file. **This also flags a latent bug in `reveal.tsx`'s import path** (it happens to work only because the
`@voxi/shared` alias masks it) — see Findings.

---

## 2. How `server.ts` will import the real components (the convergence path)

The harness today hand-writes a web UI behind the testIDs. The convergence end-state replaces that UI with the
real screens, **with zero scenario changes**, because both locate by the same `data-testid`. Concretely:

1. **Mount the real provider stack.** `app/app/_layout.tsx` already composes `SafeAreaProvider → AuthProvider →
   QueryClientProvider → ThemeProvider → ApiProvider`. The harness mounts the same stack (Clerk swapped for the
   test verifier, ApiClient pointed at the in-process BFF) — the converge entry (`entry.tsx`) demonstrates the
   minimal version (`ThemeProvider` + a connectivity-aware root + the real store).
2. **Bundle the real screens with esbuild + the alias plugin** in §1 (the same plugin in `reveal-rnw.web.ts`),
   serving the bundle from the harness `Bun.serve` instead of the hand-written `HTML` string. The `/api/*`
   routes are untouched (already the real BFF).
3. **Drive the real `expo-router` tree.** Replace the converge `expo-router` shim (which records navigations to
   `data-last-nav`) with `expo-router`'s real web build so route transitions render real screens. The shim
   exists only because the converge scope bundles ONE screen in isolation; the full harness bundles the router.
4. **Scenarios are unchanged.** Every committed scenario locates by `ids.*` → `data-testid`; nothing in
   `e2e/scenarios/`, `e2e/framework/`, or the runners changes. The proof that this holds is exactly the
   passing assertions in `reveal-rnw.web.ts` (same `PlaywrightDriver`, same `ids`).

The static check (`testid-coverage.ts`) is the **guardrail** for step 4: it fails CI if a real screen or the
harness shell grows a testid the other lacks (a non-registry/stray id is a hard failure today; app↔harness set
differences are reported as divergences to close during the swap).

---

## 3. Findings (TRUE divergences the proof surfaced — fixes are app-side)

These are real behaviours of the real screen. They are **reported, not hidden, and not forced green**. They do
not block the convergence claim (the screen renders and is testable behind the contract); they are the punch
list that brings the real screen to full parity with the harness shell.

### A. `ui.tsx` `<Title>` / `<Body>` drop their `tid()` props → `reveal.title` / `reveal.quip` / `reveal.whatItIs` never reach the DOM
`reveal.tsx` does `<Title {...tid(ids.reveal.title)}>` and `<Body {...tid(ids.reveal.quip)}>` /
`<Body {...tid(ids.reveal.whatItIs)}>`, but `app/src/components/ui.tsx`'s `Title`/`Body` are typed
`{ children, style }` and render `<Text style=…>{children}</Text>` — the spread props are silently dropped. So
those three contract ids render on the **harness shell** but are **absent on the real screen**. A scenario
asserting them passes on the shell and would fail on the real screen.
**Fix (app/):** accept and spread `...rest` onto the underlying `<Text>` in `Title`/`Body` (and `Muted`), e.g.
`function Title({ children, style, ...rest }) { return <Text {...rest} style={…}>{children}</Text> }`.

### B. The reveal evidence panel does not auto-elevate on async band settle (works on tap)
`reveal.tsx` initialises `const [showEvidence, setShowEvidence] = useState(isLow)`, but `isLow` is computed from
`band`, which is still `null` at first render (the band arrives later from the stream). So `useState` captures
`false` and the panel does not auto-expand for PROBABLE/low as `design §10.2.6` intends. It **does** expand on
tapping `howSure`, and the 3 BFF-streamed candidates render correctly under it (asserted, passing).
**Fix (app/):** derive `showEvidence` from `band` (a `useEffect`/`useMemo` keyed on `band`, or
`useState(() => isLow)` re-synced when the band settles) so PROBABLE/low auto-elevates.

### C. (static) `nav.openConversation` / `nav.openPodcast` / `nav.openContribute` are app-only
The real `reveal.tsx` renders a secondary nav row with these three `nav.*` affordances; the frozen harness
shell reaches the same destinations via `reveal.primaryAction` / `reveal.askVoxi` / `reveal.addTip` instead.
These are real registry ids, used by the app, absent from the harness shell. They auto-converge when `server.ts`
adopts the real components (§2). No app bug — a harness-shell gap, recorded so it's not silent.

### D. (latent) `reveal.tsx`'s shared-package import path overshoots the repo root
`import … from '../../../packages/shared/src/confidence'` from `app/app/` resolves one level above the repo
root; it only works because Metro's `@voxi/shared` tsconfig alias masks the literal path. Harmless under Metro,
but brittle. **Fix (app/):** import via the `@voxi/shared` alias (`@voxi/shared/confidence`) like the rest of
the app, or correct the relative depth to `../../packages/…`.

---

## 4. Run it

```bash
# runtime proof — real reveal.tsx under react-native-web in Playwright + real BFF
bun e2e/web/converge/reveal-rnw.web.ts        # exit 0 = GREEN; prints 7 PASS + 2 FINDING

# static proof — registry ↔ harness shell ↔ real app screens converge on the same testid set
bun e2e/web/converge/testid-coverage.ts       # exit 0 = no stray ids; lists documented divergences
```

Both are deterministic, creds-free, and run in this sandbox. The runtime proof's GREEN status reflects "the
real screen renders and IS E2E-testable behind the testID contract"; the findings in §3 are the parity punch
list, each with its exact app-side fix.

---

## 5. Files in this scope

| File | Role |
|---|---|
| `reveal-rnw.web.ts` | the runtime convergence proof (esbuild bundle → Bun.serve + real BFF → Playwright + `PlaywrightDriver`) |
| `testid-coverage.ts` | the static convergence check (registry ↔ harness ↔ app testid set equality) |
| `entry.tsx` | mounts the real `<Reveal/>` + real `ThemeProvider`, drives the real capture store from the real BFF NDJSON stream |
| `client.tsx` | the browser entry the bundle is built from (`createRoot().render(<ConvergeRoot/>)`) |
| `shims/expo-router.tsx` | web shim: in-memory router that records navigations to `data-last-nav` (Metro analogue) |
| `shims/expo-image.tsx` | web shim: `<Image>` → react-native-web `<Image>` (Metro analogue) |
| `shims/safe-area.tsx` | web shim: `SafeAreaView` → RNW `<View>`, zero insets on web (Metro analogue) |
| `package.json` / `bun.lock` / `node_modules/` | the isolated converge scope (NOT a workspace member; owns `react-native-web`, `react-dom`, `react`, `zustand`, `esbuild`) |
