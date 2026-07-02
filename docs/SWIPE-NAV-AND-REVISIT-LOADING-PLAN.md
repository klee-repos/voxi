# Reveal swipe-nav + distinct revisit-loading — implementation plan

Status: DRAFT (pre-review). Two related reveal-screen features:

- **Feature A — Swipe nav.** While viewing an analyzed item (`/reveal`), swipe left/right (and tap
  discrete chevrons) to navigate across catalogued items, in recency order — "page through the
  recently catalogued items."
- **Feature B — Distinct revisit loading.** When loading an *already-analyzed* item, show a calm
  "opening a saved entry" loading experience instead of the fresh-analysis "identifying…" one, so a
  revisit never looks like re-analysis.

Both are client-only (`app/`) + E2E. No BFF, agent, or schema changes. The BFF already replays a
persisted reveal on revisit (no re-bill) — proven by `e2e/web/converge/agentic-collection.web.ts`.

---

## 1. Current architecture (cited)

- **Reveal** (`app/app/reveal.tsx`) renders **exactly one** item from the global Zustand singleton
  `useCaptureStore()` — no route params. Branches: EMPTY (`!photoUri && !band && !error`, :113) ·
  ERROR/REFUSAL (:130) · LOADING (`!band`, :154) · READY (:223, full-bleed photo + floating dock).
- **Self-heal guard** (:56–58): `if (threadId && !band && !outcome && !error) router.replace('/processing')`.
  Landing on reveal with only a `threadId` bounces to `/processing`.
- **Per-bucket audio** state (`openBucket/audioUrls/audioStates/playing/pollRef`, :69–73) is keyed by
  `AudioBucket`, **not** `threadId`.
- **Processing** (`app/app/processing.tsx`) is the **only** path into reveal for both fresh and revisit.
  `run()` (:92) streams `api.streamThread(threadId)`; on `confidence_band` it `setBand` + `navTo` (:150),
  which `router.replace('/reveal')` after `settleDelay` while keeping the stream alive (`keepAliveRef`,
  :125) so async facts/sections keep filling the store. Copy: `WITTY` (:29), `FIRST` (:34), rotate
  (:110–115); scan-line sweeps while `scanning` (:75); settled `statusText` (:225–235). **Fresh and
  revisit are byte-identical here** — the replay-vs-live decision is entirely server-side and never
  surfaced to the client.
- **Collection** is one TanStack query, `threadsKey = ['threads']` (`app/src/lib/queryKeys.ts`),
  `api.listThreads()` → `ThreadSummary[]` (`{threadId,title,revealTitle?,band?,createdAt,photoUrl?}`).
  Server returns `created_at DESC`; `threads.tsx groupByDate` (:50) re-sorts `b.createdAt - a.createdAt`.
- **Revisit** = `useRevisitThread()` → pure `revisitThread(item, deps)`
  (`app/src/lib/revisitThread.ts`): `startCapture(item.photoUrl ?? null)` → `setThread(item.threadId)`
  → `push('/processing')`. Shared 1:1 by the Collection grid and the camera "Recently catalogued" card.
- **Gestures — hard rule.** App code deliberately avoids `react-native-gesture-handler` and
  `react-native-reanimated`: the converge/react-native-web E2E bundle **aliases both to a throwing
  stub** (`e2e/web/converge/harness.ts`). All motion is core RN `Animated` (`useNativeDriver:false`).
  The only real gesture precedent is `DrawerHost` (`app/src/components/Drawer.tsx`), a core RN
  `PanResponder` (:72–82). `RevealDock`'s "no swipe" rule is about **bucket** nav only; item-level
  swipe is a separate, orthogonal layer.
- **Drawer edge-swipe** is active on `/reveal` (DrawerHost wraps the whole Stack). It claims the
  responder on `!open && moveX < 32 && dx > 6 && |dy| < 24` — a conflict zone for a left→right swipe.
- **E2E.** `e2e/framework/testids.ts` is the single selector registry (app imports it via
  `app/src/lib/testid.ts`; `tid`/`tidWith` → `data-testid`/`aria-label`/`data-*`). Agentic runners
  drive the **real** screens via `standUp('app-client.tsx')` + `Agent(planner)` (agent navigates only;
  outcomes pinned by `driver.state()`). `agentic-collection.web.ts` is the capture→revisit template.
  Scan fixtures (`e2e/web/server.ts`, chosen by `?scan=` on the Referer): `confident` (→ "2008
  Cannondale SuperSix EVO", CONFIDENT), `probable`/default (→ "a confident maybe", PROBABLE), `pill`
  (refusal), `fail`, `slow`, `unknown`.

---

## 2. Design decision: route-based revisit, NOT an in-place pager

Feature A navigates between items by **re-running the existing revisit** (`revisitThread` →
`/processing` replay → `/reveal`), using `router.replace` so the stack never grows. It is **not** an
in-place multi-page pager.

**Why (an in-place pager was considered and rejected):**

| In-place pager needs… | …which fights the current architecture |
|---|---|
| Render a neighbor without leaving reveal | Self-heal guard (:56–58) ejects any `threadId`-without-`band` to `/processing` |
| Per-item content (title, band, whatItIs, facts, sections) | Store is a single flat singleton; `startCapture`/`reset` clobber wholesale |
| A no-stream data source per item | `getThread`/`ThreadDetail` is unused **and returns no facts/sections** — a full `streamThread` replay is required anyway |
| Correct audio per item | Audio state is keyed by bucket, not thread → bleeds across pages |
| Correct routing per band | Only CONFIDENT/PROBABLE → reveal; UNKNOWN → `/interview`, refusal/failure → their surfaces. Processing already centralizes this routing |

Route-based revisit **reuses** all of that for free: processing streams the replay, routes by band,
resets the store and remounts reveal per item (so audio never bleeds, the guard never fires). The one
downside — a brief `/processing` screen per swipe — is exactly what **Feature B** turns into a calm
"opening your entry" moment, and replay settles fast. This is the lower-risk, correct choice and it
delivers the paging behavior the user asked for.

> Alternatives kept open for the reviews: (A2) full in-place pager with a keyed store + guard rework;
> (A3) prefetch neighbor `band`/`revealTitle` via `getThread` for an instant READY shell then stream
> buckets. Both are larger and riskier; documented here so the eng/adversarial reviews can push back.

---

## 3. Feature B — distinct revisit loading (build first; independent)

### B.1 Store: carry a fresh-vs-revisit flag
`app/src/state/captureStore.ts`:
- Add `isRevisit: boolean` to `CaptureState` + `initial` (default `false`).
- Change `startCapture(photoUri: string | null, opts?: { revisit?: boolean })` →
  `set({ ...initial, photoUri, isRevisit: !!opts?.revisit })`. Because it already resets to `initial`,
  the camera path (`startCapture(displayUri)`) stays `false` automatically. `reset()` clears it.

### B.2 Revisit passes the flag
- `app/src/lib/revisitThread.ts`: widen `RevisitDeps.startCapture` to
  `(photoUri: string | null, opts?: { revisit?: boolean }) => void`; call
  `deps.startCapture(item.photoUrl ?? null, { revisit: true })`.
- `app/src/lib/useRevisitThread.ts`: already forwards `startCapture` — the wider signature flows through.
- Camera (`onShutter`) unchanged → stays fresh.

### B.3 Centralize the loading copy
New `app/src/lib/loadingCopy.ts` (pure, unit-testable), the single source of truth for both processing
and reveal loading text:
- `analyzeLines` = the current `WITTY` set ("Consulting the Guide…", "Cross-referencing…", "Narrowing…").
- `revisitLines` = calm retrieval copy: e.g. `["Opening your entry…", "Recalling what the Guide found…",
  "Almost there…"]` (no "cross-referencing / narrowing" — those imply fresh analysis).
- `settledLine(kind, title)` → revisit: `` `Here it is: ${title}.` `` / analyze: `` `I've got it: ${title}.` ``.
- `longWaitAck(kind)` → analyze: existing "Some objects are coy…"; revisit: "Still fetching it from
  your collection."
- `revealLoading(kind)` → `{ title, sub }` for reveal's `!band` pill (analyze: "Settling on a title…" /
  "Nearly there. I don't like to be wrong."; revisit: "Opening your entry…" / "Fetching what I saved.").

### B.4 Processing consumes it
`app/app/processing.tsx`:
- `const isRevisit = useCaptureStore((s) => s.isRevisit)`; `kind = isRevisit ? 'revisit' : 'analyze'`.
- Replace `FIRST`/`WITTY` at the `useState`/`setLine`/rotate sites with `loadingCopy` (`lines[0]`, `lines`).
- Settled copy uses `settledLine(kind, title)`; long-wait uses `longWaitAck(kind)`.
- **Soften the "analyzing" signal on revisit:** render the green identity scan-line only when
  `scanning && !isRevisit` (a revisit is a retrieval, not a scan). Keep the photo + orb + pill.
- Expose the mode for E2E: line 277 `{...tid(ids.processing.loadingLine)}` →
  `{...tidWith(ids.processing.loadingLine, { mode: kind })}` (reads via `state().attrs['data-mode']`,
  no brittle text match).

### B.5 Reveal loading pill (consistency)
`reveal.tsx` `!band` branch (:154): use `revealLoading(kind)` for the pill title/sub so a rare
transient loading on reveal matches. Minor but keeps copy coherent.

### B.6 Feature B tests
- **Unit** `app/src/lib/loadingCopy.test.ts`: revisit vs analyze select the right lines/settled/ack;
  no analyze-only phrasing leaks into revisit copy.
- **Unit** `app/src/state/captureStore.test.ts` (extend): `startCapture(uri)` → `isRevisit=false`;
  `startCapture(uri,{revisit:true})` → `true`; `reset()` → `false`.
- **Unit** `app/src/lib/revisitThread.test.ts` (extend/create): revisit calls `startCapture(photo,
  {revisit:true})`.
- **Agentic** (see §5): fresh capture ⇒ `data-mode='fresh'`; revisit ⇒ `data-mode='revisit'` on
  `ids.processing.loadingLine`.

---

## 4. Feature A — swipe / chevron nav across catalogued items

### A.1 Ordering (shared, no drift)
New `app/src/lib/collectionOrder.ts`: `orderThreads(threads): ThreadSummary[]` = newest-first
(`[...threads].sort((a,b)=>b.createdAt-a.createdAt)`), plus
`neighborsOf(ordered, threadId): { index, count, prev: ThreadSummary|null, next: ThreadSummary|null }`
where `prev` = newer (`index-1`), `next` = older (`index+1`). Pure + unit-tested. `threads.tsx`
`groupByDate` is refactored to call `orderThreads` (single source; removes the duplicated inline sort).

### A.2 Reveal reads the collection and computes neighbors
`RevealBody`: `const { data } = useQuery({ queryKey: threadsKey, queryFn: () => api.listThreads() })`
(shared cache — already warm from camera/collection). Compute `neighborsOf(orderThreads(data.threads
?? []), threadId)` **only in the READY branch** (swipe is a settled-reveal affordance). If `threadId`
isn't in the list yet (fresh capture pre-refetch), `prev`/`next` are null until the query settles —
graceful (no neighbors shown yet).

### A.3 One navigation action, two triggers
`goToNeighbor(target: ThreadSummary | null)`: if `null`, `haptics.tick()` + no-op (edge). Else revisit
the target **with `replace`** so the back stack stays constant:

- Extend `revisitThread(item, deps, nav: 'push' | 'replace' = 'push')` and add
  `RevisitDeps.replace?: (href: '/processing') => void`. `useRevisitThread()` returns
  `(item, nav?) => …` wiring both `router.push` and `router.replace`. Camera/Collection keep the default
  `'push'`; reveal calls `revisit(target, 'replace')`.
- Stack proof: `[…, reveal] --replace--> […, processing] --replace('/reveal')--> […, reveal]` — depth
  constant across any number of swipes; back returns to camera/collection (correct — you don't unwind
  swipe-by-swipe).

### A.4 Triggers
1. **Chevrons** (primary; discoverable, a11y, deterministically testable): subtle edge chevrons over
   the photo, above the dock — `reveal.prevItem` (‹, newer) shown when `prev`, `reveal.nextItem` (›,
   older) shown when `next`. Each carries `tidWith(id, { disabled: '<bool>' })`; tap → `goToNeighbor`.
2. **Swipe** (native feel): a core RN `PanResponder` on a dedicated absolute-fill catcher **behind** the
   header/dock (so dock taps + the bucket card's vertical scroll are never stolen), mounted **only** in
   READY and **only** when `!openBucket`. Claim rule (drawer-safe): `onStartShouldSetPanResponder: false`;
   `onMoveShouldSetPanResponder: (_e,g) => moveX >= 40 && Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy)*1.5`
   (the `moveX >= 40` gate clears the drawer's `<32` edge). On release: `dx <= -THRESH` →
   `goToNeighbor(next)`; `dx >= THRESH` → `goToNeighbor(prev)`; else spring back. A subtle
   `Animated translateX` on the photo layer tracks the drag for feel (branch on `reduceMotion` → no
   transform). Both triggers call the same `goToNeighbor`.

### A.5 Position indicator + deterministic anchor
Add `reveal.position` element (subtle "‹index+1› / ‹count›" caption near the title, or visually muted),
spread with `tidWith(ids.reveal.position, { index: String(index), count: String(count) })`, so the E2E
can pin navigation via `state().attrs['data-index']`/`['data-count']` even when two items share a title.

### A.6 New testIDs (register in `e2e/framework/testids.ts` under `reveal`)
`prevItem: 'reveal.prevItem'`, `nextItem: 'reveal.nextItem'`, `position: 'reveal.position'`.
Run `bun run lint:selectors` after. (App reads them via `ids` — the same registry.)

### A.7 Feature A tests
- **Unit** `app/src/lib/collectionOrder.test.ts`: `orderThreads` newest-first + stable; `neighborsOf`
  at start/middle/end/absent-id.
- **Unit** `revisitThread.test.ts`: `nav:'replace'` calls `deps.replace` not `deps.push`.
- **Agentic** `agentic-swipe.web.ts` (see §5).

---

## 5. Verification (E2E agentic — the acceptance gate)

New runners under `e2e/web/converge/`, wired into `package.json` (`e2e:web:agentic:*`) and appended to
the `e2e:web:agentic` chain. All drive the **real** app via `standUp('app-client.tsx')`.

### 5.1 `agentic-swipe.web.ts` (Feature A)
Template: `agentic-collection.web.ts`. Steps:
1. Sign in (`makeSignInPlanner`), capture item #1 with `?scan=confident` (→ Cannondale) via
   `capturePlanner`; `waitFor(reveal.card)`; record `title1` + `position.data-index/-count`.
2. Return to camera and capture item #2 so the collection has ≥2. **Distinct-item strategy:** primary
   = capture a *second* object by re-seeding the Referer scan; **fallback if FakeAuth doesn't persist a
   re-`goto`** = capture the same fixture twice and prove navigation by `data-index`/`data-count`
   change + `threadId` (identical titles still pass because the assertion is on position, not text).
   The runner will detect and use whichever is available; the invariant asserted is *"nextItem/prevItem
   moves to a different catalogued item."*
3. On the reveal for the newest item, assert `ids.reveal.nextItem` (older neighbor) is present. Drive
   one hop **perception-first** (Agent taps the perceived chevron), then pin deterministically:
   `reveal.position` `data-index` advanced by 1 and `reveal.card` still valid.
4. Assert the hop **replayed, not re-billed**: `threadCount` unchanged and `remainingScan` unchanged
   across the swipe (same helpers as `agentic-collection.web.ts`).
5. Tap `ids.reveal.prevItem` → returns to the previous index. Assert no uncaught page errors.

### 5.2 `agentic-revisit-loading.web.ts` (Feature B)
1. Fresh capture (`capturePlanner`); assert `ids.processing.loadingLine` carries `data-mode='fresh'`
   (read immediately after the shutter, before `reveal.card` settles; retry within `settleDelay`).
2. Open the persisted item from the collection (`makeDrawerNavPlanner` → `threads.item`, or the camera
   `recentItem`); assert `data-mode='revisit'` on `ids.processing.loadingLine`. (Replay-not-rebilled is
   already covered by `agentic-collection.web.ts`; this adds the loading-message distinction.)

### 5.3 Full gates
`bun test` (unit incl. new files) · `bun run typecheck` · `bun run lint:selectors` ·
`bun run e2e:web:agentic` (all runners green).

---

## 6. Risks & mitigations

1. **Drawer edge-swipe conflict** — reveal pan gated to `moveX >= 40` (drawer is `< 32`); a next (older)
   swipe is `dx < 0` and never triggers the drawer regardless. Chevrons are the drawer-immune path.
2. **Rapid swipes / stream overlap** — a still-running background replay from the item you swiped *from*
   could write into the store after `startCapture` reset. Route-based revisit re-enters processing which
   `setState({researchError:false, researchComplete:false})` and drives fresh; but to be safe the plan
   adds **abort-on-revisit**: `revisitThread` (replace path) aborts any in-flight stream before seeding.
   *Decision for the reviews: implement a tiny shared abort registry (also fixes a latent existing
   revisit-contamination bug) vs. accept the pre-existing rare race.* Recommended: the abort registry.
3. **Fresh capture not yet in `['threads']`** — neighbors resolve once the post-capture invalidation
   refetch lands; until then no chevrons (graceful).
4. **Stale collection window** — `['threads']` refetches on invalidation/focusless; acceptable (the
   swipe set matches the collection the user last saw). Reveal's `useQuery` shares the cache.
5. **Converge gesture ban** — PanResponder + `Animated` only; **no** gesture-handler/reanimated (they
   throw in the bundle). Swipe is unreliable to simulate under Playwright → outcomes pinned via the
   chevron testIDs, per repo philosophy.
6. **`startCapture` signature change** — audit call sites: camera (`onShutter`), `revisitThread`, store
   tests. Optional 2nd arg keeps back-compat.
7. **Don't break existing reveal contracts** — keep `ids.reveal.howSure` carrying `{band}`,
   `ids.reveal.quip` (`srQuip`), and every `reveal.*` id the converge proof asserts.

---

## 7. Sequencing
1. Feature B (store flag + `loadingCopy` + processing/reveal copy + `data-mode`) + its unit tests.
2. Feature A ordering/neighbors + `revisitThread` replace + reveal chevrons/position + swipe + testIDs
   + unit tests. (Abort registry per risk #2.)
3. New agentic runners; wire into `package.json`; full gates green.

## 8. Open questions (resolve in review / implementation)
- Abort registry (risk #2): include now (recommended) or defer?
- Position indicator visible ("3 / 12") vs. visually-muted anchor only? (Product/design taste.)
- Distinct-item E2E: confirm FakeAuth persistence across a re-`goto` (enables two distinct titles);
  otherwise the position-based assertion stands.
- Swipe order source: full sorted `['threads']` grid order (chosen) vs. the `slice(0,8)` recent window.
