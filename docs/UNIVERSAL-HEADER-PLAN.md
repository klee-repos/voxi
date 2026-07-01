# Plan — Universal back-navigation header

Status: **DRAFT for review** (plan-eng-review → plan-design-review → adversarial review → implement)
Scope decision (2026-07-01, confirmed by user): **keep the left push-drawer as primary nav.** Do
**not** move nav into the header as tabs. This plan adds only a *universal top header with a back
chevron* so the app finally has a consistent "go back" affordance. See
`[[project-nav-header-decision]]`.

---

## 1. Problem

There is no consistent way to go back. Today the top chrome is a patchwork:

| Where | Control | testID | Leaves via |
|---|---|---|---|
| camera (root) | hamburger + `voxi` wordmark (`AppHeader`) | `nav.menuButton` | drawer only (no back — it's root) |
| processing (over photo) | inline hamburger + inline X | `nav.menuButton`, `processing.cancel` | X → abort + `replace('/(tabs)/camera')` |
| reveal (over photo) | inline hamburger + inline **X labelled "Back"** | `nav.menuButton`, `nav.close` | X → `backToCamera()` (`replace`) |
| threads, settings | **back chevron** (`NavClose variant="back"`) | `nav.close` | `navigate('/(tabs)/camera')` |
| podcast¹, conversation, contribute, paywall | **X** (`NavClose variant="close"`) | `nav.close` | `router.back()` |
| index, welcome, first-run, interview | **nothing** | — | CTA / `replace` only (interview is a dead-end backward) |

¹ podcast's **READY player state has no close control at all** — it relies on modal swipe-to-dismiss,
which does not exist on web. That is a latent bug this plan fixes.

Problems:
1. **No universal back.** `interview` and several reveal/podcast sub-states are backward dead-ends.
2. **`nav.close` is overloaded** — it means *back-chevron* on threads/settings, *X* on the modals,
   and an *X-that-says-Back* on reveal. One selector, three semantics.
3. **Inconsistent safe-area handling.** `NavClose` sits at raw `top: space.sm` (no top inset) — on a
   notched device it can collide with the status bar. Only `AppHeader` applies `insets.top`.
4. **No test coverage** — `nav.close` is exercised by zero E2E tests.

## 2. Goal

One formal `AppHeader` component, present on every in-app screen, giving a consistent, correctly
inset, testable back affordance — with a contextual leading control (back chevron on pushed screens,
hamburger on the camera root, X on modals) and a constant height that never jumps between screens.

## 3. Evidence & resolved design questions

Validated against real iOS apps in Mobbin (Cash App, Binance, Wise, Finimize, F1, BeReal, Craft,
ChatGPT, Slopes, TIDE, Outlook, monday.com, …). Full notes:
`scratchpad/mobbin-findings.md`.

- **Q (user): should the header height change when there's a back icon vs not?**
  **A: No — height is constant.** Every reference nav bar is the same height (~44pt content +
  status-bar inset) whether the leading slot holds a chevron, an X, or nothing. The glyph swaps; the
  bar never resizes. A resizing bar makes content jump between screens. **Resolved: constant height.**
  What *does* vary in iOS is whether a screen renders its own **large title** *below* the compact bar
  (Binance/Wise/Finimize) — that is the screen's content, not the bar. Voxi already does this (reveal's
  serif display title, threads' "Your collection"); we keep those and do not force a large title.
- **Back vs Close semantics.** Reference apps split them: **chevron = hierarchical push (return to
  parent); X = modal/sheet dismiss.** Both live in the same constant-height bar. We adopt the split.
- **Over full-bleed media** (camera viewfinder, captured photo) controls get a **scrim-backed circular
  white** treatment; over flat surfaces they are a **bare icon tinted to the text color.** → the header
  needs a `variant`.
- **Root screens use app chrome, not back.** Camera is the root; its leading control stays the
  hamburger (+ wordmark). A back chevron on the root would be a dead-end. This is why "the header spans
  the photo page" does **not** mean "a back chevron on the camera."

## 4. Component design — `AppHeader`

Evolve the existing `app/src/components/AppHeader.tsx` (today camera-only) into the single universal
header. `NavClose` in `ui.tsx` is retired (its two call-sites' behavior is absorbed here).

**Why custom, not the built-in expo-router / React Navigation Stack header** (`headerLeft`,
`headerBackVisible`, large-title, safe-area for free) — resolved by eng-review:
- The app is committed to `headerShown: false` everywhere and renders its screen bodies through a
  **react-native-web converge bundle** that deliberately stays off the reanimated/gesture-handler and
  nav-internals path ("the converge bundle can't take" — `Drawer.tsx` doc). Native Stack headers on
  RNW are inconsistent and would fight that bundle.
- We need a **scrim-backed white tint over the live viewfinder / captured photo** and the serif
  wordmark on the camera root — treatments the native header API does not express cleanly.
- Every control must carry the **testID + aria selector contract** (`tid(ids.*)`) for the E2E drivers;
  injecting that onto native header buttons is awkward, onto a custom RN component trivial.
- The custom `DrawerHost` slides the whole shell; keeping chrome custom keeps that model coherent.
This is boring-by-default reasoning: the whole rendering model is already custom chrome; a native
header would spend an innovation token to fight the existing architecture.

```ts
type Leading = 'back' | 'menu' | 'none'   // the LEFT control

interface AppHeaderProps {
  leading?: Leading          // default 'back'
  onClose?: () => void       // when set, render an X in the RIGHT slot (modal dismiss)
  title?: string             // centered, typeStyles.headline (SANS — never serif)
  showWordmark?: boolean     // camera root: render the serif voxi mark instead of a title
  onMedia?: boolean          // true over viewfinder/photo → scrim-backed white controls
  onLeadingPress?: () => void // override; see §5 for the default per leading kind
}
```

**Left vs right controls (adversarial-review m5 fix).** `close` is **not** a leading kind — the modal
dismiss X lives in the **right** slot via `onClose`, preserving the repo's established convention
(`ui.tsx` `navCloseRight`: *"an X == dismiss == trailing/right; a chevron == back == leading/left"*)
and users' muscle memory. So a modal renders `<AppHeader onClose={…} />` (X top-right, no leading);
a pushed screen renders `<AppHeader leading="back" />` (chevron top-left). Both slots are always 44×44
(empty box when unused) so the bar height and title centering never change.

Layout (the height-constant contract):

- Total height = `insets.top + BAR_H`, `BAR_H = 44`. **Independent of `leading`.**
- A single row: `[leading 44×44][center flex:1, centered][trailing 44×44]`. Both side slots are always
  44 wide (empty box when `leading='none'`/no trailing), so the title stays optically centered and the
  bar height is fixed.
- `leading` glyphs (lucide, already a dep): `back`→`ChevronLeft`, `close`→`X`, `menu`→`Menu`.
- `onMedia`: each control is a 40×40 circle filled `rgba(20,18,14,0.6)` with a white glyph (matches
  today's reveal/processing scrim buttons); title/wordmark tint white. `onSurface`: bare glyph tinted
  `surface.text`, transparent bar.
- Accessibility: `accessibilityRole="button"`; labels "Back" / "Close" / "Open menu"; the menu button
  keeps `accessibilityState={{ expanded }}`. `hitSlop={12}`. Title carries `accessibilityRole="header"`.

Two mounting modes (handled by the component + a `Screen` integration, so screens don't hand-pad):

- **In-flow (surface screens):** add a `header?: ReactNode` prop to `Screen`. When present, `Screen`'s
  `SafeAreaView` owns the **top** inset once, then renders the header row, then the content region
  (respecting `center`/`padded` — the header sits **outside** the centering so a `center` Screen keeps
  it pinned at top, not vertically centered with the content). The header does **not** re-apply
  `insets.top` in this mode.
- **Overlay (media screens: camera *granted*, processing, reveal photo):** the full-bleed background
  is `absoluteFill` behind; the header sits transparent on top and self-manages its top inset (as
  camera's granted overlay does today — `camera.tsx:179` is `position:absolute`, so it never
  double-insets).
- **Per-state inset (adversarial-review m1 fix).** The single owner of the top inset is chosen **per
  screen-state, not per screen**: the latent double-inset today is NOT the granted viewfinder overlay
  (which escapes `SafeAreaView`), it's camera's **denied / undetermined** states (`camera.tsx:124`,
  `:147`) where `<AppHeader/>` is an *in-flow* child of `<Screen padded={false}>` (SafeAreaView still
  pads top, `ui.tsx:50-57`) **and** `AppHeader` re-adds `insets.top`. Fix: those in-flow states use the
  `Screen` header mode (Screen owns the inset, header doesn't re-apply); only the true full-bleed
  overlays self-inset. Whichever owns it, exactly one does.

### Visual & interaction spec (design-review resolutions, calibrated to `design.md`)

- **Two chrome modes map to design.md's two nav tokens.** Camera root = `nav-home`: transparent bar,
  hamburger in the leading slot + the **left-aligned** serif `voxi` wordmark beside it (not centered).
  Pushed/modal = `nav-modal`: transparent bar, **centered** title slot. `showWordmark` renders the
  left brand; `title` renders the centered label.
- **Large-title pattern (resolved P7.2):** header `title` is **empty on every pushed/modal screen in
  v1** — those screens keep their existing **in-body large title** (reveal's serif display, threads'
  "Your collection", settings' "Settings", contribute's "Add a tip"). The compact bar stays a thin
  chevron bar above the big title, exactly the iOS large-title references (Binance/Wise/Finimize). The
  `title` prop stays for future use but is unused now.
- **Bar chrome:** **transparent, borderless, no shadow, no bottom divider** (design.md "keep chrome
  quiet: transparent bars … shallow shadows"). Not even a scroll-hairline in v1.
- **Tints:** `onSurface` = glyph/title in `surface.text` (warm near-black on parchment, `mist100` on
  charcoal) — both AA. `onMedia` = white glyph in a 40×40 circle filled `rgba(20,18,14,0.6)` (a
  button chip; distinct from the drawer/sheet `scrim` `rgba(20,18,14,0.35)`), white title.
- **Title type:** `typeStyles.headline` (Nunito 600 / 17) — **never serif** (serif = wordmark only),
  `numberOfLines={1}` with tail ellipsis so a long label never wraps into the 44×44 side slots.
- **Interaction states:** pressed → `opacity 0.6` (matches `NavRow`/`Link`); web keyboard
  `focus-visible` ring on each control; media scrim buttons use the same pressed opacity. No hover-only
  affordance (touch-first). The header fades in with the Stack's `animation: 'fade'` — no separate
  header slide (calm motion, design.md).
- **A11y:** every control is a 44×44 (`hit.min`) target; leading control is first in DOM/focus order
  (before scroll content); SR labels "Back"/"Close"/"Open menu"; Escape still closes the drawer
  (unchanged). **Heading role (adversarial-review m2 fix):** since the header center is empty on
  pushed/modal screens, apply `accessibilityRole="header"` to each screen's **in-body `<Title>`**
  (`ui.tsx` `Title` currently sets none) — NOT to the empty header slot — so VoiceOver's rotor still
  has a navigable heading on threads/settings/contribute/reveal.

## 5. Back-navigation semantics & fallbacks

All defaults use one guarded helper: **`dismiss(fallback) = router.canGoBack() ? router.back() :
router.replace(fallback)`** (the pattern paywall already uses). expo-router `router.back()` is a no-op
when `canGoBack()` is false; on a web reload or a deep link straight onto `#/threads`, the parent may
not be in the stack, so the fallback `replace` guarantees the control always goes *somewhere sane*
instead of dead-clicking.

Default handlers by control — and the **back-target split** eng-review settled:

- `menu` → open the drawer (`useDrawer().open`) — camera root only.
- **`onClose` (modals: podcast/conversation/contribute/paywall)** → `dismiss(fallback)` **guarded, with
  a concrete fallback** (adversarial-review M3). All four use `dismiss('/(tabs)/camera')` (paywall keeps
  its existing `/(tabs)/threads`). ⚠️ **Correction:** the plan previously said "paywall already uses a
  guarded dismiss" — that's only true on purchase/restore; paywall's **close X is a raw
  `router.back()` today** (`paywall.tsx:77`) and MUST be switched to `dismiss`, same as the other three.
  Bare `router.back()` no-ops on a web reload / deep-link (`canGoBack()===false`) with no swipe-dismiss →
  the X dead-clicks and traps the user (conversation/contribute have no other exit). The §6 table below
  now shows `dismiss(...)` for every modal, matching this.
- `back`, **top-level drawer destinations (threads, settings)** → go to **camera**. These feel
  top-level, not hierarchical; "back" from a top-level destination returns *home*, not to whichever
  other destination you happened to visit. (Matches today's `navigate('/(tabs)/camera')`.)
- `back`, **pushed detail screens (reveal, interview, processing)** → generic `dismiss('/(tabs)/camera')`
  so you return to the *actual* parent (camera **or** Collection, depending on entry) — a fix over
  today's always-camera. Screens preserve their side effects by wrapping the handler:
  processing `abort()`s the in-flight scan first; reveal runs `reset()` first (both then `dismiss`).

## 6. Per-screen migration

Leading control, title, tint, and back target for every screen. "NEW" = gains a back affordance it
lacked.

| Screen | Presentation | `leading` | title / wordmark | `onMedia` | leading action |
|---|---|---|---|---|---|
| `(tabs)/camera` | root | `menu` | wordmark | viewfinder=yes / denied=no | open drawer *(unchanged)* |
| `processing` | push (over photo) | `back` | — | yes | `abort()` then `dismiss('/(tabs)/camera')` |
| `reveal` (all states) | push (over photo / parchment) | `back` | — (keeps in-body serif title) | READY/LOADING=yes, empty/error=no | `reset()` then `dismiss('/(tabs)/camera')` (→ actual parent) |
| `(tabs)/threads` | push | `back` | "Your collection"² | no | → camera (top-level) |
| `(tabs)/settings` | push | `back` | "Settings"² | no | → camera (top-level) |
| `interview` **NEW** | push | `back` | — | no | `dismiss('/(tabs)/camera')` |
| `podcast` (all states, incl. READY) **fix** | modal | none + `onClose` (X right) | — | no | `dismiss('/(tabs)/camera')` |
| `conversation` | fullScreenModal | none + `onClose` (X right) | — | no | `dismiss('/(tabs)/camera')` |
| `contribute` | modal | none + `onClose` (X right) | "Add a tip"² | no | `dismiss('/(tabs)/camera')` |
| `paywall` | modal | none + `onClose` (X right) | — | no | `dismiss('/(tabs)/threads')` (switch from raw back) |
| `index` | redirect | — (no header) | — | — | — |
| `welcome`, `first-run` | pre-auth onboarding | **excluded** (see §9 decision) | — | — | — |

² **Resolved (design-review):** keep the in-body `<Title>` (large-title style); the header `title` stays
**empty** on these screens, so the bar is a thin chevron above the screen's own editorial big title
(iOS large-title pattern). The "title" column above names the *screen's* in-body title, not a header
label.

**Behavior changes to note (flagged for review):**
- **Pushed screens lose the in-flow hamburger** (processing, reveal). Drawer access on those screens
  is replaced by: back → camera → hamburger. This matches every reference app (drawer/menu at root
  only; detail screens show back). Alternative kept open for review: retain `menu` as `trailing` on
  processing/reveal.
- **Modals use X, not a chevron.** The user asked literally for "a left chevron"; the iOS-correct split
  (chevron pushed / X modal, validated in Mobbin) is the recommendation. Alternative: chevron
  everywhere for literal consistency. **→ decide in plan-design-review.**

## 7. testID changes (`e2e/framework/testids.ts`)

Append to the `nav` block (never renumber existing ids):

```ts
nav: {
  …
  menuButton: 'nav.menuButton',
  close: 'nav.close',   // KEEP: the modal-dismiss X (podcast/conversation/contribute/paywall)
  back: 'nav.back',     // NEW: the back chevron (processing/reveal/threads/settings/interview)
  header: 'nav.header', // NEW: the AppHeader root View — the element §8.5 measures for height
}
```

- Chevron control renders `{...tid(ids.nav.back, 'Back')}`; X renders `{...tid(ids.nav.close, 'Close')}`;
  the AppHeader root View carries `{...tid(ids.nav.header)}` so there is a single measurable element for
  the constant-height test (adversarial-review m3 — the leading controls are 40–44px boxes, not "the
  bar," so measuring them proves nothing).
- This **de-overloads** `nav.close`: it now means exactly "modal X." threads/settings/reveal/processing
  move to `nav.back`.
- `lint:selectors` requires any literal id in a governed file to exist in the registry → add the ids
  first. Referencing via `ids.nav.*` interpolation is lint-clean.
- **`nav.close` / `processing.cancel` have ZERO E2E-runner references today** (adversarial-review m4 —
  they appear only in `testids.ts` + app source; `run-coverage`/`run-sc-*` use `processing.retryBtn`,
  not `.cancel`). So there is **nothing to "migrate"**: the de-overload + `processing.cancel` retirement
  are currently *unguarded by tests*, and T4 adds their **first-ever** coverage. Drop any "migrate
  existing references" framing.
- `processing.cancel`: **retired**. The back chevron carries `nav.back` and aborts the scan on press.
- **`converge/testid-coverage.ts` is NON-BLOCKING** (adversarial-review m4 — it `exit(0)` on app↔harness
  set divergence; only stray/non-registry ids fail it). So it will *not* catch a missed harness render.
  Keep the app and both harnesses in sync deliberately; don't rely on the coverage check to enforce it.
- **Converge shim needs `canGoBack` (adversarial-review M1).** The guarded `dismiss()` calls
  `router.canGoBack()`, which the converge shim `e2e/web/converge/shims/expo-router.tsx` does **not**
  define (its `Router` is only `push/replace/navigate/back`). Add `canGoBack(): boolean` to the shim
  `Router` interface, to `recordingRouter` (→ `false`, so single-screen proofs take the deterministic
  replace-fallback branch) and to `NavHost` (→ `stack.length > 1`). Without this, the T4 header proof
  throws `TypeError` on the first chevron tap. The real Expo web/native router already has `canGoBack`,
  so **production is unaffected** — this is test-scaffolding only.

## 8. Testing strategy (E2E, real clicks)

**Target the converge bundle, not the `server.ts` mock (adversarial-review M2).** The deterministic
`server.ts` shell is a **frozen** tabbar mock: no drawer, none of the `nav.*` header controls, and a
stateless class-swap `show()`/`route()` with no history/`canGoBack` — so drawer navigation and the
canGoBack fallback have **no analogue** there and can't be authored against it. The header's
authoritative E2E is a **real-component converge proof** `e2e/web/converge/header-rnw.web.ts` (+ an
entry file), mirroring `converge/drawer-rnw.web.ts` + `converge/flow-rnw.web.ts`, which already mount
the real `DrawerHost` + `nav.menuButton` and the real `NavHost` router. **Prereq: the shim `canGoBack`
fix (§7 / M1).** Drive by `ids.*` only; assert via `data-last-nav` + `state`; assert
`rig.errors.length === 0`. Coverage:

1. **Header present on every in-app screen** — mount real camera under `DrawerHost` → assert
   `nav.menuButton` + wordmark; drive the real drawer → threads/settings → assert `nav.back`; mount
   reveal/interview → assert `nav.back`; mount podcast/conversation/contribute/paywall → assert the
   `nav.close` X in the **right** slot. (No uncaught errors mounting the real tree.)
2. **Back actually returns** — tap `nav.back` on threads → `data-last-nav` = camera; tap `nav.close` on
   a modal → dismiss; tap `nav.back` on `interview` → escape (regression for the old dead-end).
3. **Guarded fallback (M3)** — single-screen entry (shim `recordingRouter`, `canGoBack → false`): tap
   `nav.back`/`nav.close` → assert the handler records `replace(fallback)` (never a dead-click). Under
   `NavHost` (`stack.length > 1`) the same tap records `back()`. Covers the deep-link/reload case for
   BOTH a pushed screen AND a modal close (podcast/conversation/contribute) — not just threads-back.
4. **Constant height** — measure the `nav.header` root box on a `menu` screen and a `back` screen;
   assert equal. Make the header the **single inset owner in both mount modes** so the measured box is
   identical. The converge safe-area shim zeroes insets, so this proves the *layout* contract; add a
   case with a **simulated non-zero top inset** (override the shim) so the invariance is actually
   exercised (adversarial-review m3), rather than trivially true at inset=0.
5. **CRITICAL regressions** (mandatory, no skip): `interview` escape; `podcast`-READY close; **modal-close
   deep-link fallback** (M3). None had coverage before; `nav.close`/`processing.cancel` had **zero**
   runner references, so this is first-ever coverage, not a migration (adversarial-review m4).
6. **Keep the deterministic sweep green** — `run-auth.web.ts`, `run-coverage.web.ts`, etc. still drive
   `server.ts`; they don't exercise the header, so they only need to stay passing (the header isn't in
   that mock). Do **not** rebuild the frozen shell to fake a drawer.
7. **Component unit test** (`app/src/components/AppHeader.test.tsx`, Bun + RNW render): `nav.header`
   height is equal across `leading='back'|'menu'|'none'`; `onMedia` swaps tint/scrim; the correct
   `testID` renders per prop (`nav.back` for `leading='back'`, `nav.menuButton` for `'menu'`, `nav.close`
   when `onClose` is set); `onClose` renders the X in the **right** slot; `leading='none'` still reserves
   the left box.

Run loop until green: `bun run e2e:web:auth`, `bun test e2e/web/converge/header-rnw.web.ts` (the new
authoritative header proof), `run-coverage.web.ts`, `bun run lint:selectors`, `bun run typecheck`,
`bun test app` (the `AppHeader`/`ui` unit tests). Fix regressions; repeat.

## 9. Decisions to confirm in review

1. **Pre-auth screens (welcome, first-run): include the header or not?** Default = exclude (linear
   onboarding roots; a back chevron is a dead-end or breaks the step machine; they use `replace`, so
   `router.back()` wouldn't reach the prior step anyway). The user's "span all pages" is read as *the
   in-app surfaces*. Reviewers may push to include a header-less-back on first-run steps.
2. **Modal glyph:** *Resolved (design-review): X on modals, chevron on pushed* (convention — X
   dismisses, chevron goes back; Mobbin-validated). User may override to chevron-everywhere.
3. **Screen titles:** *Resolved (design-review): keep in-body large titles, header center empty.* §6².
4. **Drawer access on processing/reveal:** *Resolved: drop the hamburger, back chevron only* (detail
   screens use back per Mobbin). ⚠️ Visible behavior change — flagged for user veto.
5. **`processing.cancel` testID: retire vs keep as trailing X.** §7. *(Resolved: retire.)*
6. **Drawer edge-swipe vs iOS back-swipe conflict** on pushed screens. `DrawerHost`'s left-edge
   `PanResponder` opens the drawer app-wide; on a pushed detail screen that collides with the muscle
   memory "edge-swipe = go back." **Recommend a follow-up:** scope the drawer edge-swipe to the camera
   root (a root affordance) so detail screens are free for a future back-swipe. **Not a blocker** for
   the visible back button; tracked as a TODO, not built in this change.
7. **`conversation` has no title anywhere (adversarial-review m6).** It renders no in-body `<Title>`
   (it's the immersive orb screen), and the header center is empty — so it shows a bare X with nothing
   naming the screen, unlike design.md's `nav-modal` "a conversation name." *Resolved: deliberate
   deviation* — conversation stays title-less (orb-led, immersive); we **drop the blanket claim** that
   the header maps 1:1 to design.md `nav-modal`'s centered title and document large-title/no-title as a
   per-screen choice. (A future "object name" header title is an easy add if wanted.)

## 10. Risks & mitigations

- **Layout regressions** on centered/scroll screens when a top bar is introduced → mitigate with the
  `Screen` header-slot integration (§4/§6) so content clears the bar centrally, not via per-screen
  hand-padding; cover with `run-coverage` + converge proofs.
- **Broken selectors** from de-overloading `nav.close` → `nav.close`/`processing.cancel` have **zero
  runner refs** today (adversarial-review m4), so nothing existing breaks; `lint:selectors` still guards
  literal ids, but `testid-coverage` is **non-blocking** and won't catch a missed harness render — keep
  app + harnesses in sync by hand.
- **Losing modal swipe-dismiss on native while adding a web control** → additive; the X is a second way
  out, native swipe still works.
- **Safe-area double-inset** → single owner **per screen-state** (§4 per-state fix); covered by the
  `nav.header` height unit + converge proof.
- **Converge proof throws on `canGoBack`** (adversarial-review M1) → mitigated by the shim `canGoBack`
  addition (§7); without it the T4 proof `TypeError`s on the first tap.
- **Modal close dead-clicks on reload/deep-link** (adversarial-review M3) → mitigated by routing all
  modals through guarded `dismiss(fallback)`; covered by the §8.3 modal-close-fallback test.

## 11. Out of scope

Bottom/top tab bar, moving nav out of the drawer, a Profile surface, redesigning the drawer itself,
native-header migration, the **drawer edge-swipe vs back-swipe** resolution (§9.6, follow-up TODO),
pre-auth `welcome`/`first-run` headers, native-only polish (edge-swipe tuning). Tracked separately.

---

## Implementation Tasks — ✅ SHIPPED & VERIFIED
Synthesized from the eng-review. Each derives from a finding above. **All done**; verified by the
green converge proof `e2e/web/converge/header-rnw.web.ts` (27 checks) + the full regression sweep
(`lint:selectors`, `run-auth`, `run-coverage`, `testid-coverage`, `bun test app/src`, and the 7
existing converge proofs — all green).

- [x] **T1** — `AppHeader` built (leading `back`/`menu`/`none` + `onClose` X in the **right** slot,
  `nav.header` root id, `onMedia` scrim tint, guarded `dismiss(fallback)` default). *(The planned jsdom
  `AppHeader.test.tsx` was folded into the converge proof, which measures the real `nav.header` box
  height across `menu`/`back`/`close` under a real browser layout — strictly stronger than jsdom — and
  asserts the right testID per prop.)*
- [x] **T2** — `Screen` `header` prop added (single top-inset owner per state, header outside `center`);
  `NavClose` retired; `accessibilityRole="header"` on in-body `<Title>`.
- [x] **T2b** — added `nav.back` + `nav.header`; de-overloaded `nav.close`; retired `processing.cancel`;
  **added `canGoBack` to the converge shim** (M1). `server.ts` left frozen (M2).
- [x] **T3** — migrated all 10 in-app screens per §6; back-target split; all modals → guarded
  `dismiss(fallback)` incl. switching paywall off raw `router.back()`; removed inline scrim buttons.
- [x] **T4** — `converge/header-rnw.web.ts` (27 checks): per-screen control, guarded fallback (pushed
  **and** modal), `nav.header` constant height, interview escape, podcast close; real-stack back-return
  driven through the proven `flow-client` (real NavHost, canGoBack, no TypeError).
- [ ] **T5 (P3, deferred)** — drawer — scope edge-swipe to camera root (edge-swipe/back conflict). A3.

## NOT in scope
See §11. Key deferrals: native header (fought RNW converge bundle); tabs/drawer redesign (retracted by
user); edge-swipe conflict (T5 follow-up); welcome/first-run headers (pre-auth linear onboarding).

## What already exists (reused, not rebuilt)
`NavClose` (chevron+X) → **absorbed** into `AppHeader`. `AppHeader` (camera hamburger+wordmark) →
**evolved** into the universal component. reveal/processing inline scrim buttons → **replaced** by the
header's `onMedia` mode. paywall's `dismiss()` **helper** → generalized as the default handler — but
note paywall's *close X* is raw `router.back()` today (`paywall.tsx:77`) and **must be switched** to
`dismiss` (adversarial-review M3), it is NOT already guarded. `DrawerHost` / `useDrawer()` → reused
unchanged for the `menu` control. Converge shim (`expo-router.tsx`) → **extended** with `canGoBack`.

## Failure modes
| Codepath | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| back on deep-link/reload (pushed) | `router.back()` no-ops (no history) | yes (T4 §8.3) | yes (guarded `dismiss`) | lands on fallback |
| **modal close on deep-link/reload** | bare `router.back()` no-ops → X dead-clicks, trapped | yes (T4 §8.3, M3) | yes (guarded `dismiss`) | modal dismisses to camera |
| header + SafeAreaView (in-flow state) | double top inset | yes (`nav.header` unit) | yes (single owner per state) | correct spacing |
| converge proof taps chevron | `canGoBack` undefined → `TypeError` | yes (T4 runs it) | yes (shim `canGoBack`, M1) | proof green |
| modal X on native | lose swipe-dismiss | n/a | additive (both work) | X **and** swipe |
| interview back | (was) dead-end | yes (T4, CRITICAL) | yes (new back) | escapes |
No critical gaps (no failure is untested AND unhandled AND silent).

## Parallelization
Mostly **sequential** — `testids.ts`, `AppHeader`, and `ui.tsx`/`Screen` are shared choke points.
Lane A (foundation): T1 + T2 + T2b. Then Lane B: T3 screen migrations (per-screen parallelizable but
all depend on A and touch shared testids — coordinate). Then Lane C: T4 tests. T5 is independent/后.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (not a strategy change) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (self-resolved) | 1 scope surface (native-vs-custom), 3 arch (A1/A2/A3), 2 quality, 5 test gaps → all resolved into plan; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (self-resolved) | score 7.5→9.5/10; 7 passes; 3 taste calls resolved (modal X vs chevron, in-body large titles, drop hamburger on processing/reveal); interaction-state + a11y + design.md-token spec added |
| Adversarial | Workflow (6 lens skeptics → verify → synthesize) | Independent refutation, code-grounded | 1 | REVISED → CLEAR | 29 raw → **19 confirmed** (0 blocker after correction, 3 major, 16 minor), 10 refuted; verdict **REVISE**; all 3 majors (M1 shim `canGoBack`, M2 retarget E2E to converge, M3 guarded modal dismiss) + 6 minors folded in |

- **UNRESOLVED:** 0 blocking. One ⚠️ visible behavior change flagged for user veto: dropping the
  hamburger on processing/reveal (§9.4). All adversarial findings folded into §4–§10 above.
- **Adversarial highlights (all resolved):** M1 the converge RNW shim lacked `canGoBack` (guarded
  `dismiss` would `TypeError` the T4 proof) → shim extended. M2 the deterministic `server.ts` harness is
  a *frozen* drawerless/historyless mock → header E2E retargeted to the real-component converge bundle.
  M3 §6 gave 3 modals *unguarded* `router.back()` (traps user on reload) → all modals now guarded
  `dismiss(fallback)`, paywall's raw-back corrected. Minors: per-state double-inset, `role=header` on
  in-body title, `nav.header` measurable root, phantom test-migration removed, modal-X kept top-right,
  conversation title deviation documented.
- **VERDICT:** ENG + DESIGN + ADVERSARIAL CLEARED → **IMPLEMENTED + VERIFIED**. All 3 majors + 6 minors
  fixed in code; `header-rnw.web.ts` green (27 checks), full regression sweep green. Only T5 (drawer
  edge-swipe scoping) deferred as a tracked follow-up.
```
