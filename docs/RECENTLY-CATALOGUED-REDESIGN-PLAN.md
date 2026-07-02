# Recently-catalogued fix + tray→floating-card redesign (DRY with the fixed Collection) — PLAN

Status: **IMPLEMENTED + VERIFIED (2026-07-02).** Author: Claude. Gates cleared: `/plan-eng-review` (clean) →
6-lens adversarial workflow (10 raised → 6 confirmed, all folded) → implemented → **green**: whole TS suite 370/0
(incl. the new `useRevisitThread` lost-photo regression unit), `lint:selectors`, static `testid-coverage`, and
**4 converge runners** — the new `recent-catalogued-rnw` (floating card opens, decoded thumbnail via the shared
`CatalogTile`, revisit seeds the photo + closes the card), plus `camera-rnw` / `flow-rnw` / `collection-persistence-rnw`
all still green (no regression). Visually confirmed via a converge screenshot (floating cream card, hairline edge,
green/blue lanes, clears the shutter).

**Adversarial fixes folded (6 confirmed):** (P2) `flow-rnw` can't seed a photo item → the revisit-photo proof lives
in a NEW dedicated `recent-catalogued-*` runner instead; (P2) the pure `useRevisitThread` can't clear camera-local
`trayOpen` → `RecentCard` closes itself on tile tap (`onClose(); onOpen(item)`); (P2) seeding a thread in the shared
`camera-entry.tsx` would flip the `retakeHint` copy and break `camera-rnw` → seeding is isolated to the new entry;
(P3) seed site is `*-entry.tsx` not `*-client.tsx`; (P3) `RecentCard` anchors at `insets.bottom + BAR_CLEARANCE`
(clears the capture orb; the hint is hidden while open) rather than reusing reveal's `bottom:0`; (P3) the expired-URL
failure-mode row corrected (§7). **Self-caught:** the app is parchment (cream) EVERYWHERE (the `dark` theme is unused
as a default), so `RecentCard` is a white card on cream via `useTheme` — matching the reveal, with a hairline border
for edge definition on the low-contrast canvas.

## 0. Intent

Two coupled problems on the **camera home**, both about the same data (`useQuery(['threads'])`) the Collection
screen already renders correctly:

1. **"Recently catalogued" doesn't work** — its cards are stale, title-only cream tiles. `RecentlyIdentified.tsx`
   ignores `photoUrl`, `revealTitle`, and `band` even though `ThreadSummary` now carries them and the Collection
   grid (`threads.tsx`, already fixed) renders them as rich photo tiles. It also **loses the photo on revisit**
   (camera's `openThread` never seeds `startCapture(photoUrl)`), so tapping a recent item lands on a blank reveal.
2. **The tray is broken/off-brand** — `Tray.tsx` is a full-width slide-up bottom-sheet (grab handle + scrim, fixed
   `SHEET_H=300`) that clashes with the new reveal **floating-card** language (`reveal.tsx` `floatCard` +
   `RevealDock` morph card). The user wants to **drop the tray entirely** and align it with that information panel.

The fix is **DRY**: the Collection was already fixed; recently-catalogued must reuse the *same tile* and the *same
revisit path*, and the tray becomes a **floating card** matching the reveal aesthetic.

## 1. Locked decisions

- **D1 — One shared tile: `CatalogTile`.** Extract the Collection grid tile (photo thumbnail via `expo-image` +
  legibility scrim + `revealTitle || title` + date) into `app/src/components/CatalogTile.tsx`. Both the Collection
  grid AND the recent carousel render it. A `variant: 'grid' | 'carousel'` prop switches only sizing (grid ≈ 47%
  width block; carousel = fixed 140px card). This is the DRY core — it deletes the divergent, stale duplicate in
  `RecentlyIdentified`.
- **D2 — One shared revisit: `useRevisitThread()`.** Extract the revisit action into
  `app/src/lib/useRevisitThread.ts` returning `openThread(item: ThreadSummary)` = `startCapture(item.photoUrl ?? null)`
  → `setThread(item.threadId)` → `router.push('/processing')`. `threads.tsx` and the camera recent carousel both call
  it. This fixes the lost-photo revisit bug in ONE place and guarantees the two surfaces can never diverge again.
  **`onOpen` type widens from `(threadId: string)` to `(item: ThreadSummary)`** so the photo can be seeded.
- **D3 — Remove the tray; use a floating card (reveal-aligned).** Delete `Tray.tsx` (slide-up sheet, grab handle,
  scrim-dim). Replace with a compact **floating cream card** (`RecentCard`) that reuses the reveal's `floatCard`
  styling (rounded-`xl`, shallow `shadow` token, cream `surface.surface`, side margins, centered, `maxWidth`),
  containing a header row ("Recently catalogued" overline + "See all →") and a **horizontal carousel** of
  `CatalogTile`s. Mobbin precedent: Taobao scan ("我拍过的" bottom peek), Apple Notes/Freeform thumbnail-beside-shutter,
  Messenger filmstrip — a floating recent-captures strip, never a sheet.
- **D4 — Keep the toggle; morph, don't slide.** The viewfinder stays clean by default: `camera.recentToggle` opens
  the floating card, which **morphs in** (opacity + `translateY` rise + subtle `scale`, `useNativeDriver:false`,
  `motion.base`, reduce-motion → cross-fade) — the SAME cheap single-node morph as `RevealDock`'s `BucketCard`, not a
  full-width sheet. Tap-away (`camera.recentClose` scrim, light — NOT the heavy sheet-dim) or the toggle closes it.
  (Considered + rejected: an always-on bottom peek strip — bolder but competes with the viewfinder + capture hint on
  a 375px screen and removes the clean Shazam-minimal default; noted for the design review to challenge.)
- **D5 — testID contract preserved, assertions only strengthened.** All four camera ids keep their meaning:
  `recentToggle` (open), `recent` (card container), `recentItem` (a tile), `recentClose` (tap-away). Add
  `camera.recentItemPhoto` (parity with `threads.itemPhoto`) so the carousel photo is assertable. No id is removed;
  the converge tests are *extended* to assert the richer state (photos render, revisit seeds the photo), never
  weakened. `lint:selectors` stays green (new id in the registry).
- **D6 — Zero contract/BFF churn.** `ThreadSummary` already carries `photoUrl`/`revealTitle`/`band`; `listThreads`
  already absolutizes `photoUrl`. No shared-schema, BFF, or events change. This is UI-only (app + e2e).

## 2. Current state (code-cited)

- **Collection (fixed reference).** `app/app/(tabs)/threads.tsx:162-182` renders each `PressableTile` with an
  `expo-image` `Image` (`:171`, `ids.threads.itemPhoto`) under a legibility scrim (`:173`, `styles.scrim`
  `rgba(20,18,14,0.42)`), `revealTitle || title` (`:176`) + date. `openThread(item)` (`:85-93`) seeds
  `startCapture(item.photoUrl ?? null)` then `setThread` then `/processing`. **This is the shape to reuse.**
- **Recently-catalogued (broken).** `app/src/components/RecentlyIdentified.tsx:87-104` renders a title-only card
  (`t.title` + date, `styles.card` cream tile) — NO photo, NO `revealTitle`, NO band; its docstring (`:5-8`) still
  claims "there is NO thumbnail URL … cards are cream title-only tiles" (stale). `onOpen: (threadId: string)`
  (`:51`) can't carry a photo. `camera.tsx:75-80` `openThread(threadId)` does `reset(); setThread(threadId)` —
  **never `startCapture`**, so revisit shows a blank reveal.
- **The tray.** `app/src/components/Tray.tsx` — `Animated` slide (`SHEET_H=300`, `translateY`), grab handle (`:69`,
  `:82`), scrim (`:58`, `scrimColor`), `bottom:-insets.bottom` full-bleed sheet (`:65`). Hosts
  `RecentlyIdentified`. Opened from `camera.tsx:200-212`; `trayOpen` state `:54`.
- **Reveal aesthetic to match.** `app/app/reveal.tsx:234-237` `floatWrap`/`floatCard` (`styles` `:322-323`):
  `borderRadius: radius.xl`, `shadow`, `backgroundColor: surface.surface`, `maxWidth:460`, centered, floats above
  the bottom inset. `RevealDock.tsx:246-249` `BucketCard` = scrim overlay + single-node `opacity/translateY/scale`
  morph (`:227-241`), `useNativeDriver:false`, reduce-motion → cross-fade — the morph pattern to reuse.
- **Data.** `apiClient.ts:37-46` `ThreadSummary { threadId, title, revealTitle?, band?, createdAt, photoUrl? }`;
  `listThreads` (`:228-231`) maps `photoUrl` through `absPhoto`. `captureStore.startCapture(photoUri)` (`:102`)
  resets + seeds the photo.
- **E2E.** `camera-rnw.web.ts:39-41` asserts `recentToggle` renders. `flow-rnw.web.ts:29-34` taps `recentToggle`
  → waits `recent` → taps `recentClose`. `collection-persistence-rnw.web.ts` already seeds a **durable thread with
  a photo** and asserts the Collection grid renders `threads.itemPhoto` — the rig to mirror for the carousel. The
  converge camera bundle mounts the REAL `camera.tsx` (`camera-client.tsx`).

## 3. Principles & invariants (must not regress)

1. **DRY, one source of truth.** The Collection tile + revisit logic live in exactly one place after this; the two
   surfaces import them. No copy that can drift.
2. **Design-system fidelity (`design.md`).** Cream canvas, white floating card, **shallow** shadow only (`y2 blur12
   rgba(20,18,14,0.06)` — no glow/heavy shadow), rounded-`xl` card corners, `rounded.lg` tiles, warm-neutral text,
   green/blue lanes unchanged (this surface adds neither accent). "See all" is a **blue** link (`accentSecondary`).
3. **No cheating in tests.** Converge asserts real observable state through stable selectors (photo `src`, revisit
   nav intent), never internals; assertions are added/strengthened, never weakened. Selector-lint governs.
4. **Converge-safe motion.** `Animated` `useNativeDriver:false`, lucide-only glyphs (`Images`/`X` already shimmed),
   no `react-native-gesture-handler` (the morph is a tap-driven overlay, never a swipe).
5. **Graceful states preserved.** `RecentlyIdentified`'s three states (LOADING skeletons / ERROR+retry / EMPTY
   ghost) survive the reparent into the floating card — a loading/errored query must never collapse to the empty
   ghost and falsely tell a returning collector they have zero finds.

## 4. Target UX

### 4.1 Camera home (resting)
Unchanged from today: full-bleed viewfinder, `AppHeader` (menu + wordmark), the capture hint, the bottom bar with
`recentToggle` (left) + central `CaptureOrb`. The toggle glyph stays `Images` (lucide).

### 4.2 Tap `recentToggle` → floating Recent card
```
┌ full-bleed viewfinder ─────────────────────────────┐
│ ☰  voxi                                             │
│                                                     │
│         (light tap-away scrim — camera.recentClose) │
│   ┌ RecentCard (camera.recent) ─ cream, rounded-xl, shallow shadow ┐
│   │  RECENTLY CATALOGUED                    See all →│  ← overline + blue link
│   │  ┌ CatalogTile ┐ ┌ CatalogTile ┐ ┌ … ┐          │  ← horizontal carousel
│   │  │ [photo]     │ │ [photo]     │ │   │  →scroll  │     camera.recentItem (+ …ItemPhoto)
│   │  │ 1976 Canon  │ │ Eames chair │ │   │          │     revealTitle||title + date over scrim
│   │  └─────────────┘ └─────────────┘ └───┘          │
│   └──────────────────────────────────────────────┘ │
│                                                     │
│   (⧉)              ( ◉ capture )              ( )    │  ← bottom bar unchanged
└─────────────────────────────────────────────────────┘
```
- The card **morphs up** from the bottom (opacity + translateY + subtle scale, `motion.base`, `Easing.out`), sits
  above the bottom bar with side margins, centered, `maxWidth ≈ 460`. Reduce-motion → cross-fade in place.
- Empty → the EMPTY ghost ("Nothing catalogued yet. Point me at something.") inside the same card. Loading →
  skeleton tiles. Error → retry. (States carried over verbatim from `RecentlyIdentified`.)
- Tapping a tile → `useRevisitThread().openThread(item)` (seeds photo, resumes the durable thread). Tapping "See
  all" → `/(tabs)/threads`. Tapping the scrim or the toggle again → close (reverse morph).

### 4.3 Collection screen
Visually identical to today, but its grid tiles are now `<CatalogTile variant="grid" …>` — same pixels, extracted.

### 4.4 Accessibility
Toggle `accessibilityRole="button"`, label "Recently catalogued"; card `accessibilityViewIsModal` while open, SR
focus moves into it on open and back to the toggle on close (mirrors `BucketCard`). Tiles are buttons with a
`revealTitle||title` label. Min 44pt targets. State via structure/label, never color alone.

## 5. Workstreams (file-by-file)

**app (new):**
- `src/components/CatalogTile.tsx` — shared tile. Props `{ item: ThreadSummary; onPress: () => void; variant?:
  'grid'|'carousel'; testID?: string; photoTestID?: string }`. Photo (`expo-image`) + scrim + `revealTitle||title`
  (2 lines) + date. Defaults: grid → `threads.item`/`threads.itemPhoto`; carousel → `camera.recentItem`/
  `camera.recentItemPhoto`. No band chip (parity with today's Collection; out of scope).
- `src/lib/useRevisitThread.ts` — `openThread(item)` hook (startCapture+setThread+push). Pure wrapper over the
  store + router; unit-testable.
- `src/components/RecentCard.tsx` — the floating morph card (replaces `Tray`). Reuses reveal `floatCard` styles +
  `BucketCard`-style single-node morph + light tap-away scrim (`camera.recentClose`). Hosts the header row + a
  horizontal `ScrollView` of `CatalogTile variant="carousel"`, plus the loading/error/empty states.

**app (edit):**
- `app/(tabs)/threads.tsx` — grid maps to `<CatalogTile variant="grid" item={item} onPress={()=>openThread(item)}/>`;
  `openThread` now comes from `useRevisitThread()` (delete the local copy). Behavior byte-identical.
- `app/(tabs)/camera.tsx` — replace `<Tray …>` with `<RecentCard open={trayOpen} …/>`; `openThread` from
  `useRevisitThread()` (delete the local `reset()+setThread` variant → the lost-photo fix). Keep `trayOpen` state +
  the toggle. Remove the `Tray` import.
- `src/components/RecentlyIdentified.tsx` — **either** refactored into `RecentCard`'s body **or** deleted if
  `RecentCard` subsumes it. Prefer: fold its 3-state carousel body into `RecentCard`, delete the file, keep tests.
- `lib/testid.ts` — re-export the new `camera.recentItemPhoto` id (registry lives in `e2e/framework/testids.ts`,
  mirrored in the app's `lib/testid`).

**app (delete):** `src/components/Tray.tsx`.

**e2e:**
- `framework/testids.ts` — add `camera.recentItemPhoto`. (App `lib/testid` mirrors it.)
- `web/converge/camera-client.tsx` / `camera-rnw.web.ts` — seed a durable thread-with-photo for `converge` (mirror
  `collection-persistence`), then assert: open the card → `camera.recentItem` renders with a real `recentItemPhoto`
  `src` (the persisted capture), and the EMPTY-when-none path.
- `web/converge/flow-rnw.web.ts` — keep the open/close check; ADD: with a seeded recent item, tap it → assert
  `data-last-nav=/processing` AND the store `photoUri` is seeded (revisit carries the photo — the bug's regression
  guard).
- `web/converge/collection-persistence-*` — unaffected (Collection tile is visually identical), but re-run to prove
  the `CatalogTile` extraction didn't regress `threads.itemPhoto`.

## 6. Test coverage
```
[+] CatalogTile: renders photo (src=persisted), revealTitle||title fallback, date; grid vs carousel sizing   [ADD] unit
[+] useRevisitThread.openThread(item): calls startCapture(photoUrl) + setThread + push('/processing')          [ADD] unit [CRIT]
[+] camera revisit seeds the photo (regression for the lost-photo bug — was reset() w/o startCapture)          [ADD] unit/e2e [CRIT]
[+] RecentCard: LOADING skeleton / ERROR+retry / EMPTY ghost states preserved (never collapses to empty)       [ADD] unit
[→E2E] camera-rnw: toggle opens RecentCard; seeded item renders recentItem + recentItemPhoto(real src); empty path
[→E2E] flow-rnw: open/close preserved; tap recent item → nav /processing + store.photoUri seeded (revisit)
[→E2E] collection-persistence: unchanged green (CatalogTile extraction did not regress threads.item/itemPhoto)
[+] typecheck; lint:selectors (new id registered, no coordinate taps); whole TS suite green
```
**Regressions (IRON RULE):** `flow-rnw`/`camera-rnw` open/close + Collection grid assertions stay green; the tray
removal must not drop any existing assertion — only add. No shared/BFF test touched (UI-only change).

## 7. Failure modes
| Failure | Handled | User sees | Test |
|---|---|---|---|
| thread has no `photoUrl` (older/no capture) | `CatalogTile` falls back to a cream card + title (as today) | title tile, no broken image | unit |
| `listThreads` loading/errored | 3-state carousel preserved | skeleton / retry, never false-empty | unit |
| revisit of a thread whose photo URL expired | NOT re-hydrated — identical to today: `startCapture(item.photoUrl)` seeds the stale signed `/media` URL and nothing writes `photoUri` from the stream or `getThread`, so the `<Image>` stays blank (`listThreads` re-signs `photoUrl` at fetch, so the URL is fresh unless the card sits open past the short TTL) | blank photo (name + tile label still render) | n/a (no e2e; do NOT cite collection-persistence, which seeds a fresh URL) |
| reduce-motion | morph → cross-fade | card appears, no slide | unit/visual |

## 8. Resolved decisions (eng-review, 2026-07-02)
- **Q1 (design) → RESOLVED: toggle-opened floating card** (D4). User chose it over an always-on peek strip: keeps the
  Shazam-minimal viewfinder, matches the reveal floating card exactly, and preserves all four camera testids (the
  peek-strip would drop `recentToggle`/`recentClose`).
- **Q2 (eng) → RESOLVED: fold `RecentlyIdentified` into `RecentCard` and delete it** — one consumer, no 2-file
  indirection. **CRITICAL preserve-invariant (C1):** the three states (LOADING skeletons / ERROR+retry / EMPTY ghost)
  must survive the fold verbatim — a loading/errored `['threads']` query must NEVER collapse to the empty ghost and
  falsely tell a returning collector they have zero finds. Unit-tested.
- **Q3 → RESOLVED: keep tile parity with the Collection** (no band/confidence chip) — no new scope.
- **A1 (arch):** `CatalogTile` takes `testID`/`photoTestID` props (defaulted per `variant`) so the two id namespaces
  stay clean without a copy.
- **A2 (arch):** `RecentCard` overlay reuses `Tray`'s z-index/scrim layering (zIndex 20/21) so it floats above the
  live viewfinder + capture bar; light tap-away scrim (`camera.recentClose`), never the heavy sheet-dim.
```

## 9. Follow-up fix — missing update logic (2026-07-02)

Reported after landing: **a fresh capture didn't appear in Recently catalogued.** Root cause (pre-existing, not
introduced here): the app's `QueryClient` runs `staleTime: 30s` + `refetchOnWindowFocus: false`
(`app/app/_layout.tsx:32`) and **nothing invalidated `['threads']` after `createThread`**. The camera is a
persistent tab that never remounts, so its `useQuery(['threads'])` kept the stale cached list → the newest thread
was invisible until an unrelated refetch.

Fix (UI-only, DRY): a shared `app/src/lib/queryKeys.ts` (`threadsKey`) used by the camera recent carousel, the
Collection grid, AND the new invalidation; `camera.tsx` `onShutter` calls
`queryClient.invalidateQueries({ queryKey: threadsKey })` the moment `createThread` resolves, so both surfaces
refetch and show the capture. The converge react-query shim gained a faithful `useQueryClient`/`invalidateQueries`
(a module-level active-query registry that re-runs matching mounted queries, mirroring TanStack's cache-observer
invalidation), and `recent-catalogued-rnw` asserts the list GROWS after a new shutter capture. Green: whole TS
suite 391/0, all converge runners.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 arch (folded), 1 code-quality CRITICAL preserve-invariant (folded), 6 test paths added, 0 critical gaps |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (UI-only, no product/scope change) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | covered by the converge visual-verify screenshot (clean floating card) |
| Adversarial | 6-lens refute+verify workflow | Independent refute | 1 | CLEAR | 10 raised → 6 confirmed (3× P2, 3× P3), ALL folded; 4 refuted as false |
| Visual verify | converge screenshot + 4 runners | Real UI, real clicks | 1 | CLEAR | floating card clean; recent-catalogued + camera-rnw + flow-rnw + collection-persistence all green |

- **SCOPE:** right-sized + DRY-forward — extracts existing Collection tile + revisit (reuse, not rebuild); net +1 module.
- **UNRESOLVED:** 0 — Q1/Q2/Q3 + A1/A2/C1 resolved; all 6 adversarial findings folded.
- **VERDICT:** ENG + ADVERSARIAL + VISUAL CLEARED — IMPLEMENTED & VERIFIED. Whole TS suite 370/0, lint:selectors,
  testid-coverage, and 4 converge runners green; changed files typecheck clean.
