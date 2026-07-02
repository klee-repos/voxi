# Design Migration Plan — adopt `design.md` as the app's source of truth

**Goal.** Make the running app (Expo/React Native, `app/`) render according to
`design.md` (Voxi's design system) — colors, typography, shape, spacing, and the
core component patterns — with **zero functional regressions**, verified by the
e2e agentic suite.

**Principle.** `design.md` is the source of truth. Where the app has semantics
`design.md` does not cover (confidence bands, podcast-speaker colors, the orb
gradient), those stay app-specific but are re-tuned to sit inside the new
palette. Nothing that changes behavior or breaks a `testID` contract.

---

## 1. Why this is low-risk / high-leverage

The app is almost fully token-driven (verified by recon):

- **20 files** consume `theme.ts`; there are only **2 hard-coded hex** values and
  **4 `fontWeight:'600'` literals** in the whole app, **0 `rgba()` literals**.
- All surfaces/colors/type/space/radius flow from `theme.ts` via `themeProvider`
  and the `ui.tsx` primitives.

⇒ Re-skinning is mostly a **`theme.ts` token remap** plus a handful of surgical
component edits. No screen needs a rewrite.

## 2. Surface mapping (the key decision)

`theme.ts` exposes two surfaces; `design.md` defines two themes. They map 1:1:

| App surface | Role today | → `design.md` theme |
|---|---|---|
| `dark` (default shell — camera, threads, processing, chat) | deep-space ink | **Dark** (charcoal `#212325`) |
| `parchment` (reveal card + podcast read-along) | museum reading surface | **Warm** (cream `#F4F1E8`) |

This preserves the app's UX architecture (dark-first shell, warm reading
surface) while recoloring both to `design.md`. The parchment surface is already
a warm cream, so that half is nearly a no-op.

## 3. Token changes (`app/src/lib/theme.ts`)

### 3.1 `dark` surface → design **Dark**

| token | old | new (`design.md`) |
|---|---|---|
| `bg` | `#0B0B14` | `#212325` (dark-background) |
| `surface` | `#12121F` | `#2A2C2E` (dark-surface) |
| `card` | `#1B1B2E` | `#2A2C2E` (dark-surface) |
| `border` | `#2A2A40` | `#343638` (dark-hairline) |
| `text` | `#F2F2F8` | `#ECEEEE` (dark-text-primary) |
| `textMuted` | `#C8C9DA` | `#9D9E9E` (dark-text-secondary) |
| `accent` | `#7AE0D0` | `#29AB60` (green — primary action) |
| `onAccent`/`accentText` | `#0B2A26` | `#FFFFFF` (on-green) |
| `danger` | `#E2725B` | `#C56A3E` (terracotta) |
| `offline` | `#5A5A78` | `#5E6061` (dark-text-tertiary) |

### 3.2 `parchment` surface → design **Warm**

| token | old | new (`design.md`) |
|---|---|---|
| `bg` | `#F4ECDE` | `#F4F1E8` (background) |
| `surface` | `#FBF6EC` | `#FFFFFF` (surface) |
| `card` | `#FBF6EC` | `#FBF9F3` (surface-warm) |
| `border` | `#D8CBB0` | `#E6E2D7` (hairline) |
| `text` | `#241D12` | `#262524` (text-primary) |
| `textMuted` | `#4A3F2C` | `#605E58` (text-secondary) |
| `accent` | `#0E6E5E` | `#29AB60` (green) |
| `onAccent`/`accentText` | `#FBF6EC` | `#FFFFFF` (on-green) |
| `danger` | `#E2725B` | `#C56A3E` (terracotta) |

### 3.3 Add secondary/link + surface-sunken tokens (both surfaces)

`design.md` splits action color into **green (primary)** and **blue (links /
people)**. Add to each surface:

- `accentSecondary` (a.k.a. `link`): `#3D89F5` (blue) — links, follow/secondary buttons.
- `sunken`: dark `#2A2C2E` / warm `#EDEAE0` — inset fields, chips, ghost fills.
- keep `onAccent` = `#FFFFFF`.

**Eng-review add:** `surface.accent` (green) is currently used as tappable **text**
in `settings.tsx:76,84` ("Retry", "Upgrade your plan"). Per `design.md`, links are
**blue** and green is fills-only — move those to `accentSecondary`. This also
sidesteps green-as-text contrast (green on cream ≈ 2.5:1).

### 3.4 Typography (`type`)

Already partially done (Nunito + Fraunces loaded via `src/lib/fonts.ts`).
Finalize the ramp to `design.md`:

- `serif` = `Fraunces_700Bold` (titles) / `family.serif['800']` = wordmark.
- `sans` = `Nunito_400Regular`; `family.sans[400..800]` for weights.
- `size`: **keep the app's existing scale as-is** (`xs12 sm14 base16 lg20 xl26
  xxl34 display44`). Eng-review call: the brand identity comes from
  fonts + color + shape, not the exact px ramp; retuning sizes risks the
  Dynamic-Type clamp (a11y-04) and layout for near-zero brand payoff. `base`=16
  already equals `design.md` body. Lower-risk / smaller diff (boring by default).

### 3.5 Shape (`radius`)

- `lg`: `18` → `16` (design cards). Add `xl`=`20` (squircle tiles). Keep
  `sm`=8, `md`=12, `pill`=999.

### 3.6 Spacing (`space`)

Already on `design.md`'s 4pt grid (`xs4 sm8 md12 lg16 xl24 xxl32`). No change;
keep app's extra `xxxl`=48.

### 3.7 App-specific semantics (kept, retuned)

- Confidence bands: `CONFIDENT` → `#29AB60` (green success), `PROBABLE` keep
  gold `#E8B45C` (functional "warn" status, like `danger` — an explicit,
  documented exception to the two-hue rule), `UNKNOWN` → neutral `#9AA0C0`.
- Podcast speakers (`arlo`/`mave`) and the `orb` gradient: **unchanged**
  (data-viz identity, outside `design.md`).

## 4. Component changes

1. **`ui.tsx` `Button`** → `design.md` pill spec:
   - `borderRadius: radius.pill`, primary height 52 (`hit.min`+8), no border on
     filled variants.
   - variants: `primary` = green fill + white; `secondary` = blue fill + white;
     `ghost` = `sunken` fill + primary text; `danger` = terracotta.
   - label uses `type.family.sans['600']` (RN ignores `fontWeight` on a named
     instance — must pick the SemiBold family).
2. **Text primitives** (`Title`/`Body`/`Muted`) — already token-wired; ensure
   `Title` uses `serif`, body/labels use the correct sans weight family.
3. **`Toggle`** ON fill → green (`surface.accent`), matching `design.md`.
4. **Remove the 2 hard-coded hex**:
   - `ConfidenceChip.tsx:23` `#0B2A26` → `surface.onAccent` (text on filled
     chip) via `useTheme()`.
   - `podcast.tsx:187` `#0B0B14` → a token (speaker name color from `surface`).
5. **`fontWeight:'600'` (4 sites)** → `fontFamily: type.family.sans['600']`
   (Button, ConfidenceChip, podcast, Toggle-area).
6. **`settings.tsx:76,84`** — text links `color: surface.accent` (green) →
   `surface.accentSecondary` (blue), per `design.md` links-are-blue.
7. **New `app/src/lib/theme.test.ts`** — deterministic guard (no such test
   exists today; no e2e contrast check exists either): asserts (a) both
   surfaces expose the full token set, (b) WCAG contrast — `text`/`bg` ≥ 4.5,
   `textMuted`/`bg` ≥ 4.5, `accentSecondary`/`bg` ≥ 4.5 on dark; and encodes the
   **documented brand exception**: white-on-`accent` (`#29AB60`) = ~2.96:1
   (per `design.md`, matching the reference brand) — asserted `≥ 2.9` with a
   comment, not silently dropped. Runs under `bun test`.

## 5. Files touched (complete list)

- `app/src/lib/theme.ts` — token remap (§3).
- `app/src/lib/fonts.ts` — already added (loader + `typeStyles`).
- `app/app/_layout.tsx` — already loads fonts.
- `app/src/components/ui.tsx` — Button/Toggle/text (§4.1–4.3, 4.5).
- `app/src/components/ConfidenceChip.tsx` — hex→token, weight family (§4.4).
- `app/app/podcast.tsx` — hex→token, weight family (§4.4).
- `app/app/(tabs)/settings.tsx` — green text-links → blue (§4.6).
- `app/src/lib/theme.test.ts` — **new** deterministic contrast/token guard (§4.7).
- (No other screen files need edits — they read tokens.)

Files touched to edit: **6** (theme.ts, ui.tsx, ConfidenceChip, podcast,
settings) + 1 new test. Under the 8-file complexity bar. Not overbuilt.

## 6. Risks & mitigations

- **Contrast (a11y gate).** White on green `#29AB60` ≈ 2.8:1 (below AA-normal;
  OK for large/UI bold ~3:1 borderline). Mitigation: buttons use ≥15px SemiBold
  (large-text tier); if the a11y e2e flags it, darken fills to the pressed green
  `#238C4F` (≈3.3:1) or use `text-primary` on green. `dark.textMuted #9D9E9E` on
  `#212325` ≈ 5.7:1 (AA body ✓). Warm text `#262524` on `#F4F1E8` ≈ 14:1 ✓.
- **Serif heaviness.** App titles now render Fraunces Bold (heavier than the old
  never-loaded `Newsreader`). Acceptable per `design.md`; can drop to Fraunces
  700→600-equivalent if titles read too heavy. Flagged for reviewer.
- **Semantic-color creep.** Keeping gold `PROBABLE` technically violates
  `design.md`'s "one accent pair" rule — documented, intentional (status color).
- **No behavior change.** Only styles/tokens change; every `testID`,
  `accessibilityLabel`, and component contract is untouched → e2e selectors hold.

## 7. Validation (e2e agentic)

Runnable here (no creds, RN-web build + BFF test mode + replayed tapes):

1. `bun test` — unit/token tests.
2. `bun e2e/web/run-auth.web.ts` — auth shell golden flow.
3. `bun run e2e:web:agentic` — **agentic** suite over the REAL screens: an `Agent` signs
   in→camera (and captures/revisits/sweeps) by perception, asserted by `testID`.
4. The `run-sc-*.web.ts` scenario runners (reveal/proc, threads, conversation,
   podcast, subs/a11y/safety) — cover the reskinned surfaces incl. the a11y &
   safety-refusal states.

**Acceptance:** all of the above green (same pass set as pre-change baseline),
`bunx tsc --noEmit` introduces no new errors, and a visual spot check of the
reskinned primitives. Loop: run baseline first → implement → re-run → fix any
regression → repeat until the full set is green.

## 8. Rollout order

1. Baseline: run the e2e set on `main` to capture the current green set.
2. `theme.ts` token remap (§3).
3. `ui.tsx` + `ConfidenceChip` + `podcast` edits (§4).
4. `tsc` + `bun test`.
5. Re-run e2e set; fix regressions; loop to green.
6. Update `app/src/lib/theme.ts` header comment to cite `design.md` as source.

## 9. Out of scope (explicit)

- Re-architecting screens or adding `design.md`'s social-app surfaces
  (rooms/backchannel) that Voxi doesn't have.
- Native iOS Maestro run (needs a Mac + Xcode) — covered by the web agentic
  tier here; iOS flows unchanged (same testIDs).
- Splash/app-icon rebrand (separate asset task).

## 10. Eng-review outcome

**What already exists (reuse, don't rebuild).** The app is fully token-driven:
`theme.ts` → `themeProvider` → `ui.tsx` primitives; every screen reads tokens.
The `parchment` surface is already a warm cream (~`#F4ECDE`), so the Warm-theme
half is nearly a no-op. Fonts are already loaded (`fonts.ts` + `_layout.tsx`).
⇒ We reuse the entire token pipeline; no parallel styling system is introduced.

**Decisions locked in review:**
1. **Contrast / brand green** — *follow `design.md`*: keep `#29AB60` + white
   (~2.96:1) as the brand primary, documented exception; test asserts `≥2.9`
   for that pair only. All other pairs must clear AA (`≥4.5`).
2. **Text links → blue** (`accentSecondary`), fills stay green — `design.md`
   rule + fixes green-as-text contrast.
3. **Keep the app's size scale** (don't retune to `design.md` px) — lower risk,
   protects the a11y-04 Dynamic-Type clamp.
4. **Serif = Fraunces for display/reveal titles** (an intentional "display"
   usage of the `design.md` serif family), sans everywhere else.
5. **Semantic colors** (confidence bands, speaker colors, orb gradient) stay
   app-owned; `danger`→terracotta, `CONFIDENT`→green to harmonize.

**Failure modes (new codepaths).**
- *Font load fails at startup* → `_layout.tsx` falls through on `fontError`
  (renders with system fallback) rather than a blank screen. Covered.
- *A token key missing on a surface* → `theme.test.ts` fails deterministically
  (token-completeness assertion) before it ships. Covered.
- *A contrast regression* (someone edits a token) → `theme.test.ts` catches it.
  Covered. No silent visual-a11y failures.

**Parallelization.** Sequential — every edit funnels through `theme.ts` and the
shared `ui.tsx`; no independent lanes. One worktree.

**Implementation tasks (from findings):**
- [ ] **T1 (P1)** theme.ts token remap (§3) incl. `accentSecondary`/`sunken`.
- [ ] **T2 (P1)** theme.test.ts — token-completeness + WCAG contrast guard (§4.7).
- [ ] **T3 (P2)** ui.tsx Button→pill + weight-family + Toggle green (§4.1–4.5).
- [ ] **T4 (P2)** settings.tsx green text-links → blue (§4.6).
- [ ] **T5 (P2)** ConfidenceChip + podcast hex→token, weight family (§4.4).
- [ ] **T6 (P1)** run `bun test` + the e2e web set; loop to green (§7).

## 11. Implementation & validation results

**Adversarial review verdict: material-fixes — all applied.** It caught 5 real
blockers/majors the eng review missed:
1. Missed `fontWeight` site `conversation.tsx:225` (the "Hold to talk" CTA would
   silently render Regular) → `type.family.sans['600']`.
2. Button `secondary` blast radius (10 call sites) → kept `secondary` as the
   outline/de-emphasized button; no blue-fill repurposing, no hierarchy inversion.
3. ConfidenceChip filled-label contrast **regression** (white-on-green 2.96) →
   filled label uses `onColorInk` (dark, 6.3:1), not `onAccent`.
4. e2e web tier is a testID mock (can't see color) → added `theme.test.ts`
   deterministic contrast/token guard.
5. 3-digit-hex grep miss (`conversation.tsx:162`, `Banners.tsx:19`) + podcast
   speaker label → all tokenized. Plus Toggle ON → green-soft; danger→terracotta pinned.

**Files changed:** `theme.ts`, `ui.tsx`, `ConfidenceChip.tsx`, `podcast.tsx`,
`conversation.tsx`, `Banners.tsx`, `(tabs)/settings.tsx`, new `theme.test.ts`,
`tsconfig.json` (exclude tests). (`fonts.ts` / `_layout.tsx` done earlier.)

**Validation — all green:**
- `theme.test.ts`: 11 pass (token completeness + WCAG contract + documented exceptions).
- unit suite (theme + shared + e2e framework): 56 pass / 0 fail.
- `tsc --noEmit`: 8 errors = pre-existing baseline, **0 new**.
- e2e web flows (auth, reveal/proc, threads, conversation, podcast,
  subs/a11y/safety, kb, auth-extra): **8/8 GREEN**.
- agentic flows (Playwright sign-in→camera + agent-browser explore): **GREEN**.
- testID coverage: **GREEN** (no selector lost in the reskin).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clean | 3 folded in (link-color, contrast test, size-scale de-risk) |
| Adversarial | multi-agent (5 lenses + judge) | Independent challenge | 1 | material-fixes → **all applied** | 5 blockers/majors caught + fixed |

- **UNRESOLVED:** 0.
- **VALIDATION:** unit 56/0 · theme-guard 11/0 · e2e 8/8 GREEN · agentic GREEN · tsc 0-new.
- **VERDICT:** CLEARED & SHIPPED to working tree — app reskinned to `design.md`,
  verified green end-to-end.
