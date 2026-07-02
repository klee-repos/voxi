# Reveal swipe-nav + distinct revisit-loading — implementation plan (FINAL)

Two related reveal-screen features, client-only (`app/`) + E2E. No BFF/agent/schema changes.

- **Feature A — Swipe paging.** On `/reveal`, swipe (and invisible edge tap-zones) page across catalogued
  items in recency order, **in place** — the next item paints instantly from the collection cache, then its
  research buckets stream in behind. No loader flash, no screen change.
- **Feature B — Distinct revisit loading.** Opening an already-analyzed item from the Collection grid / camera
  "Recently catalogued" tray (the `/processing` replay path) shows calm "opening a saved entry" copy instead of
  the fresh-analysis "identifying…" copy.

Design + approach were verified by `/plan-eng-review` methodology and a 5-lens adversarial review (see
`## GSTACK REVIEW REPORT`). The two user decisions: **in-place paging** (not route-based) and
**swipe-only-minimal** affordances (no visible chevrons/counter; hidden testIDs for E2E + a11y).

> **IMPLEMENTATION NOTE (final, supersedes the PanResponder details in §4).** The swipe is a **horizontal
> paging `FlatList`** (`app/app/reveal.tsx`) — the standard, documented RN pager (native UIScrollView paging on
> iOS, the same primitive photo galleries use). Each page is a full-screen photo of a `pageableThreads` item; a
> debounced `onScroll` (reliable on native AND react-native-web, unlike `onMomentumScrollEnd`) loads the settled
> item in place. This REPLACES the earlier hand-rolled PanResponder + edge-tap-zone approach (removed) — that
> was the fragile part on native and is not needed. The E2E drives a REAL FlatList scroll (`reveal.pager`) and
> pins the page change via `reveal.position`. Everything else in the plan (in-place seed from cache, single-owner
> `threadStream`, revealable-only filter, revisit-loading copy) stands unchanged.
>
> **Camera-at-the-newest-edge.** The pager prepends a `CAMERA_PAGE` sentinel before the newest item (the
> Instagram/Snap "camera as a page" pattern). Swiping past the newest toward a newer item — which doesn't exist —
> lands on it and opens the capture screen (`goToCamera` = `reset()` + `router.replace('/(tabs)/camera')`).
> `initialScrollIndex={curIdx + 1}` opens the reveal on the newest (verified in the harness), so the camera is one
> swipe past it; browsing older items is unchanged. E2E: `reveal.pagerCamera` + a real scroll to pager index 0
> asserts the camera nav fires.
>
> **Camera → newest (the mirror).** `app/app/(tabs)/camera.tsx` gets the same 2-page pager (`camera.pager`): page 0
> is a TRANSPARENT layer over the fixed live `CameraView` (so the camera never remounts), page 1 is the newest
> catalogued photo. Swiping left settles on page 1 → `revisit(newest)` opens its reveal (fast-open); the pager
> resets to page 0 so returning shows the viewfinder. This is the exact reverse of the reveal's "swipe past newest
> → camera", so the two are consistent and reversible. E2E: scroll `camera.pager` to page 1 → `reveal.card` appears.

---

## 1. Current architecture (verified against source)

- **Reveal** (`app/app/reveal.tsx`) renders one item from the global Zustand singleton `useCaptureStore()`
  (no route params). Branches: EMPTY (:113) · ERROR/REFUSAL (`outcome==='failure'|'refusal'`, :130) ·
  LOADING (`!band`, :154) · READY (:181/:223). **Self-heal guard** (:56–58):
  `if (threadId && !band && !outcome && !error) router.replace('/processing')`.
- **Bucket status** derives purely (`captureStore.ts:137-150`): `what` is `active` the instant `band` is set;
  purpose/maker/facts are `loading` until their `section`/`fact` events arrive. **So the resting READY view
  needs only `band` + `title` + `photoUri`** — everything else streams in progressively.
- **Per-bucket audio** state (`reveal.tsx:69-73`) is component-local, keyed by `AudioBucket` (not thread).
- **Processing** (`app/app/processing.tsx`) is the fresh-capture AND collection-revisit loader. `run()` (:92)
  streams `api.streamThread(threadId)`; on `confidence_band` → `setBand` + `navTo` (:150) which
  `router.replace('/reveal')` after `settleDelay=450ms` while keeping the stream alive (`keepAliveRef`, :125,
  :213 — **its AbortController is component-local at :67/:105, unreachable from elsewhere**). Scan-line sweeps
  while `scanning` (:75). Fires `haptics.success()`/`warning()` per band (:154,:160,:174). **Fresh and revisit
  are byte-identical here today.**
- **Collection**: `threadsKey=['threads']`, `api.listThreads()` → `ThreadSummary[]`
  (`{threadId,title,revealTitle?,band?,createdAt,photoUrl?}`, `apiClient.ts:37-46`). **The BFF persists a
  replayable reveal only for CONFIDENT/PROBABLE** (`voxi-api/src/app.ts:528-529`); UNKNOWN/refusal/failure
  rows are listed with `band:null` and re-run live → route to `/interview` or a failure screen.
- **Revisit (push path)** = `useRevisitThread()` → `revisitThread(item, deps)` (`revisitThread.ts`):
  `startCapture(photoUrl)` → `setThread(id)` → `push('/processing')`. Shared by Collection grid + camera tray.
- **Gestures — hard rule.** No `react-native-gesture-handler`/`reanimated`: the converge bundle aliases both
  to a throwing stub (`e2e/web/converge/harness.ts:85-86`). Motion is core RN `Animated` +
  `PanResponder` (the `DrawerHost` pattern, `Drawer.tsx:70-82`). Drawer edge-swipe claims on
  `moveX < 32` (`Drawer.tsx:74,217`) — a conflict zone for a left→right reveal swipe.
- **E2E.** `e2e/framework/testids.ts` is the single selector registry (app imports via `app/src/lib/testid.ts`;
  `tid`→`data-testid`/`aria-label`, `tidWith`→`data-*`). `PlaywrightDriver.state()` exposes `data-x` as
  `attrs.x` (strips the `data-` prefix, `playwright.ts:53`). Full-app runners: `standUp('app-client.tsx')` →
  real welcome→…→reveal under NavHost (shim implements `push/replace/navigate/back`) + DrawerHost + real BFF.
  `?scan=` (Referer) picks the fixture: `confident`→"2008 Cannondale SuperSix EVO"/CONFIDENT, default
  `probable`, `pill`/`fail`/`slow`/`unknown`. **FakeAuth is in-memory** (`clerk.tsx:79`) — a `page.goto`
  reload signs you out. The converge react-query shim is per-mount `useState(undefined)` (no cross-mount cache,
  `react-query.tsx:71`) — a fresh `listThreads()` fires on each mount.

---

## 2. Feature A design — in-place pager (the decision)

Swipe/tap seeds the next item **into the same mounted reveal** from data already in the `['threads']` cache,
then streams its buckets in the background. Reveal never re-enters `/processing` for a page.

```
swipe ‹ / tap right edge  (currently viewing item B, band already settled)
   │  goToNeighbor(next):
   │    beginThreadStream()                      # abort any prior in-flight stream (fresh keepAlive OR last swipe)
   │    startCapture(A.photoUrl) ; setThread(A)  # reset store, seed photo
   │    setBand(A.band, A.revealTitle, [])       # band non-null → READY paints NOW (no LOADING, guard never fires)
   │    markRevisit()                            # isRevisit=true
   │    consumeThreadStream(api, A, ac.signal)   # fill whatItIs/facts/sections progressively (fire-and-forget)
   ▼
[reveal A]  name + dock painted instantly; buckets go loading→active as the replay lands (~0.5s)
```

Why this is correct (each dissolves a bug route-based would have needed guards for):
- `setBand` keeps `band` non-null across the swap → the LOADING branch and the self-heal guard **never fire**.
- **One** owner of the stream (`threadStream` module, single current AbortController) → a `beginThreadStream()`
  at every reseed aborts the prior stream → **no cross-item contamination**, and it fixes the pre-existing
  push-path contamination too.
- No `/processing` re-entry → **no celebratory haptics per page**, no interstitial.
- The "no new thread / no re-bill" invariant holds — `GET /stream` never bills.

### A.1 Ordering + neighbor selection (`app/src/lib/collectionOrder.ts`, pure, unit-tested)
- `orderThreads(threads): ThreadSummary[]` — newest-first (`b.createdAt - a.createdAt`). `threads.tsx`
  `groupByDate` refactors to call it (removes the duplicated sort; DRY).
- `neighborsOf(ordered, currentId): { index, count, prev, next }` — operates over the **revealable subset**:
  `band==='CONFIDENT' || band==='PROBABLE' || threadId===currentId` (the current item is exempt so a
  fresh capture, transiently `band:null` in the cache, is never filtered out of its own set). `prev` = newer
  (index-1), `next` = older (index+1); null at the ends. Absent-id → `{index:-1,count,prev:null,next:null}`.

### A.2 Shared stream module (`app/src/lib/threadStream.ts`)
- `beginThreadStream(): AbortController` — `current?.abort(); current = new AbortController(); return current`.
- `abortThreadStream(): void` — `current?.abort(); current = null`.
- `applyStreamEvent(ev, actions)` — the store-write reducer **extracted from `processing.run`** (token→appendText,
  fact→appendFact, section(purpose|maker)→appendSection, description_upgrade→upgradeDescription,
  confidence_band→setBand, done→setResearchComplete; setLastSeenIndex always). Signal-guarded.
- `consumeThreadStream(api, threadId, signal, actions)` — the loop: `for await (ev) { if(signal.aborted) return;
  applyStreamEvent(ev) }`, `catch`→setResearchError (unless aborted), terminal `done`→setResearchComplete.
- **`processing.run()` changes minimally:** `const ac = beginThreadStream()` instead of `new AbortController()`
  (registers its controller so a later swipe can abort it), and delegates its per-event **store** writes to
  `applyStreamEvent` (its UI/orb/line/nav/haptics switch is untouched — behavior-preserving, Beck's
  "make the change easy then make the change").

### A.3 Store changes (`captureStore.ts`)
- Add `isRevisit: boolean` (initial `false`) + `markRevisit()` action (sets `true`). **Not** a widened
  `startCapture` signature — keeps the camera call-site byte-identical (a `?mode=` route param is impossible:
  the expo-router shim stubs `useLocalSearchParams` to `{}` and strips query strings).
- `startCapture` and `reset` call `abortThreadStream()` (belt-and-suspenders: any full reseed kills a lingering
  stream even on paths that don't `beginThreadStream`, e.g. `backToCamera`).

### A.4 Reveal changes (`reveal.tsx`)
- READY only: `const { data } = useQuery(threadsKey)`; `const nb = neighborsOf(orderThreads(data?.threads ?? []),
  threadId)`.
- `goToNeighbor(target)`: if `!target || offline || openBucket` → `haptics.tick()` + no-op. Else `closeCard();
  setPlaying(null)`; `beginThreadStream()`; `startCapture(target.photoUrl ?? null); setThread(target.threadId);
  setBand(target.band!, target.revealTitle ?? target.title, []); markRevisit()`; then
  `void consumeThreadStream(api, target.threadId, ac.signal, actions)`.
- **Audio reset** on thread change: `useEffect(reset openBucket/audioUrls/audioStates/playing/pollRef, [threadId])`
  (fixes cross-item audio bleed on the in-place swap).
- **Top-level hooks** (above the four early returns, per hook-order rules): the drag `Animated.Value` +
  the `PanResponder` (created once). Both read `nb`/`goToNeighbor`/`offline`/`openBucket` from a ref updated
  each render (Drawer's `openRef` pattern) to avoid a stale first-render closure.
- **Invisible edge tap-zones** (READY, `!openBucket`, `!offline`, only when the neighbor exists): transparent
  full-height ~15%-width `Pressable`s at left/right carrying `ids.reveal.prevItem` / `ids.reveal.nextItem`
  (real `accessibilityRole="button"` + labels "Previous/Next item"). The a11y + deterministic-test seam.
- **Swipe** (READY, `!openBucket`, `!offline`): the `PanResponder` catcher sits **behind** header/dock;
  `onMoveShouldSetPanResponder: moveX>=40 && |dx|>24 && |dx|>|dy|*1.5` (clears the drawer's `<32` edge; a
  next/older swipe is `dx<0` and never triggers the drawer regardless). Release: `dx<=-THRESH`→next,
  `dx>=THRESH`→prev, else spring back. Live photo `translateX` drag (branch on `reduceMotion`). Both triggers
  call the same `goToNeighbor`.
- **Position anchor** (hidden, no visible counter — user chose minimal): a `srQuip`-style offscreen element
  `ids.reveal.position` rendered in READY, `tidWith(id, { index, count, openedvia: isRevisit?'revisit':'analyze' })`.
  E2E reads `attrs.index`/`attrs.count`/`attrs.openedvia`.

### A.5 New testIDs (register in `e2e/framework/testids.ts` under `reveal`)
`prevItem: 'reveal.prevItem'`, `nextItem: 'reveal.nextItem'`, `position: 'reveal.position'`. Then
`bun run lint:selectors`.

---

## 3. Feature B design — distinct revisit loading (the `/processing` replay path)

Opening an item from the Collection grid / camera tray still routes `revisitThread → /processing`; that loader
must read as retrieval, not analysis. (Swipe paging is instant and bypasses `/processing`, so Feature B is only
the collection/tray revisit.)

- `revisitThread` calls `markRevisit()` after `startCapture` (add `markRevisit` to `RevisitDeps`; forwarded by
  `useRevisitThread`). Camera fresh-capture leaves `isRevisit=false`.
- `app/src/lib/loadingCopy.ts` (pure, unit-tested): `analyzeLines` (the current `WITTY`), `revisitLines`
  (`["Opening your entry…","Recalling what the Guide found…","Almost there…"]`), `settledLine(kind,title)`
  (analyze "I've got it: X." / revisit "Here it is: X."), `longWaitAck(kind)`, `revealLoading(kind)`.
- `processing.tsx`: `const isRevisit = useCaptureStore(s=>s.isRevisit)`; `kind='revisit'|'analyze'`. Use
  `loadingCopy` for line/settled/longWait; **gate the scan-line** to `scanning && !isRevisit`; **gate the
  celebratory haptics** to `!isRevisit` (S4). Expose the transient mode:
  `tidWith(ids.processing.loadingLine, { mode: kind })`.
- `reveal.tsx` `!band` pill uses `revealLoading(kind)` (consistency; rarely hit).

---

## 4. Verification (E2E agentic + unit)

### 4.1 Unit (`bun test`)
- `collectionOrder.test.ts`: `orderThreads` newest-first + stable; `neighborsOf` start/mid/end, absent-id,
  count-1, **UNKNOWN/null filtered out**, current-id exempt.
- `loadingCopy.test.ts`: revisit vs analyze select distinct lines/settled/ack; no analyze phrasing in revisit.
- `captureStore.test.ts` (extend): `markRevisit()` sets `isRevisit`; `reset()`/`startCapture` clear it;
  `isRevisit` untouched by processing's `researchError/researchComplete` reset (the `unavailable`-retry).
- `revisitThread.test.ts`: calls `markRevisit`. `threadStream.test.ts`: `beginThreadStream` aborts the prior
  controller; `applyStreamEvent` maps each event to the right store action; `consumeThreadStream` stops on abort.

### 4.2 Agentic (real screens; wire into `package.json` `e2e:web:agentic`)
- **`agentic-swipe.web.ts`** (Feature A): sign in → capture item1 (`?scan=confident`) → wait `reveal.card` →
  back to camera → capture item2 (same `?scan=confident`; two distinct `threadId`s, identical titles — fine,
  FakeAuth can't re-`goto` for a 2nd fixture so we prove nav by position). On reveal for item2: **poll
  `reveal.position` `attrs.count` until it equals 2** (converge shim has no cross-mount cache — S1), record
  `attrs.index`. `d.tap(ids.reveal.nextItem)` (or `prevItem`). Assert: `attrs.index` changed;
  `reveal.card`/`reveal.title` still valid; **no `/processing` nav** (`data-last-nav` never became processing
  after the tap — proves in-place); `threadCount` + `remainingScan` **unchanged** (no re-bill); `rig.errors`
  empty. (Swipe gesture itself is native polish; the tap-zone drives the same `goToNeighbor` deterministically.)
- **`agentic-collection.web.ts`** (extend for Feature B): after the fresh capture, assert `reveal.position`
  `attrs.openedvia==='analyze'`; after reopening the tile (revisit), assert `attrs.openedvia==='revisit'`
  (durable post-settle anchor — avoids racing the 450ms processing window, S3). The replay-not-rebilled
  invariant is already asserted there.

### 4.3 Full gates
`bun test` · `bun run typecheck` · `bun run lint:selectors` · `bun run e2e:web:agentic` (all green).

---

## 5. What already exists / reused (not rebuilt)
- Revisit→replay→no-rebill path (Feature B's `/processing` route, proven by `agentic-collection.web.ts`).
- `['threads']` query + `ThreadSummary` (band/title/photo already present — the pager's data source).
- Bucket-status derivation + `keepAlive` background-stream pattern (reveal reuses via `consumeThreadStream`).
- `DrawerHost` PanResponder+Animated gesture idiom; `srQuip` offscreen-anchor idiom; `tidWith` data-* seam.
- `groupByDate` sort → refactored onto the shared `orderThreads` (DRY).

## 6. NOT in scope (deferred, with rationale)
- **Paging into UNKNOWN/failed items** — excluded by the revealable-subset filter (they have no reveal;
  paging into an interview form is user-hostile).
- **A visible "n / m" counter or chevrons** — user chose swipe-only-minimal; hidden anchor only.
- **`getThread`/`ThreadDetail`** — unnecessary; `ThreadSummary` already carries band/title/photo.
- **Prefetching neighbor buckets before the swipe** — background stream on-demand is enough; prefetch is a
  latency optimization for later.
- **iOS-Photos swipe-direction convention** (next=older here) — a deliberate default; a directional coach-mark
  is a follow-up.

## 7. Failure modes (new codepaths)
| Path | Failure | Covered by |
|---|---|---|
| `goToNeighbor` at collection edge | null neighbor | haptic no-op; `neighborsOf` unit test |
| `goToNeighbor` offline | replay impossible, would wipe current item | gated on `!offline` (haptic no-op) |
| swipe while bucket card open | tap hits scrim / steals scroll | gated on `!openBucket`; card owns its touches |
| rapid swipes / lingering fresh stream | contamination of the new item | `beginThreadStream()` aborts prior at every reseed; signal-guarded `applyStreamEvent` |
| in-place swap keeps old audio | item A clip plays on item B | audio-reset `useEffect([threadId])` |
| PanResponder stale closure / hook order | first-render null neighbors / hook count mismatch | top-level hooks + ref-read (Drawer pattern) |
| fresh capture not yet in `['threads']` | index -1, position "0/N" flash | current-id exempt from filter; position is hidden anyway |
| drawer edge-swipe vs prev-swipe | left-edge drag opens drawer | swipe gated `moveX>=40`; tap-zone is the drawer-immune path |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | scope: heavy reuse, 2 pure helpers + 1 stream module, no new services |
| Adversarial | 5-lens workflow | Correctness/UX/E2E/arch/edges | 1 | issues resolved | 5 must-fix + 8 should-fix, all folded in |

**ADVERSARIAL (must-fix, all resolved in this rewrite):**
- M1 — swipe set was unfiltered → paged into the interview/failure screens. Fixed: `neighborsOf` restricts to CONFIDENT/PROBABLE (+ current-id exempt).
- M2 — route-based was a loader-slideshow, not paging; neighbor band/title/photo already in cache. Fixed: switched to in-place seeding (user-approved).
- M3 — orphaned `keepAlive` stream contaminated the next item; the old mitigation was un-implementable. Fixed: single-owner `threadStream` module, `beginThreadStream()` aborts prior at every reseed; `processing.run` registers its controller.
- M4 — self-heal guard double-fired on every route-based swipe. Dissolved by in-place `setBand` (band never null).
- M5 — both Feature-B runners were red-on-arrival (`data-mode` token contradiction + wrong `attrs` key). Fixed: single token set `{analyze,revisit}`, read via `attrs.mode`/`attrs.openedvia`; durable post-settle anchor instead of racing the 450ms window.

**SHOULD-FIX folded in:** S1 (poll `reveal.position` count before reading — no converge cache), S2 (same-fixture-twice; FakeAuth can't re-goto), S3 (durable `openedvia` anchor), S4 (gate revisit haptics), S5 (offline swipe gated), S7 (top-level PanResponder hooks + ref-read), S8 (no visible counter). C3 (`markRevisit()` not a widened `startCapture`), C4 (gate on `!openBucket`, stop audio), C2 (`orderThreads` DRY) all adopted.

**CROSS-MODEL:** The two reviews agreed once the false premise ("full replay required anyway") was corrected against source (`ThreadSummary` carries band/title/photo). User re-decided route-based → in-place with corrected facts.

**UNRESOLVED:** none.

**VERDICT:** ENG CLEARED — in-place pager + `threadStream` seam + revealable-subset filter + durable E2E anchors. Ready to implement.
