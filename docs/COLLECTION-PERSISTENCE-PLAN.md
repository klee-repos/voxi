# Collection persistence — save the photo + the generated content on every past item

Status: **DRAFT → to be verified by `/plan-eng-review` then an adversarial review workflow, then implemented.**

## 1. The bug (root cause, corroborated + code-cited)

When a user revisits a past collection item, **the photo is blank and the generated
identification/narration is either regenerated live or gone entirely**. Two distinct persistence
gaps in the *running* system (the assembled `server.ts` path, not the cred-gated durable-eve tier):

### Gap A — the photo is never persisted anywhere durable the client can read
- Capture sends `photoUrl` to `POST /v1/threads` (`app/app/(tabs)/camera.tsx:88-102`,
  `services/voxi-api/src/app.ts:190-222`).
- The BFF hands it to `eve.createSession(...)`; `CascadeEveClient` stores it in an **in-memory
  `Map`** (`services/voxi-api/src/cascade-eve-client.ts:24,41`) — lost on restart.
- The durable thread store has **no `photo_url` column** (`services/voxi-api/src/pg-stores.ts:67-73`),
  even though the production DDL defines `app.threads.photo_url`
  (`packages/db/migrations/0001_init.sql:87`).
- No read endpoint returns a photo. `ThreadSummary = {threadId,title,createdAt}` and
  `ThreadDetail = {threadId,title,continuationToken,resumes}` (`app/src/lib/apiClient.ts:33-43`) — no
  image field; the NDJSON stream carries no image (`packages/shared/src/events.ts:11-27`).
- On revisit the client `reset()`s `captureStore.photoUri` to `null` and never rehydrates it
  (`app/app/(tabs)/threads.tsx:79-86`, `app/src/state/captureStore.ts:35-49`), so
  `reveal.tsx`/`processing.tsx` render the blank-card / Orb fallback (`app/app/reveal.tsx:164-170`,
  `app/app/processing.tsx:194-200`).

### Gap B — the generated reveal (identification + narration) is never persisted; it is regenerated live
- The reveal content (`title`, `band`, `whatItIs`, `candidates`) is rebuilt entirely from re-streaming
  `GET /v1/threads/:id/stream` (`app/app/processing.tsx:104-158`).
- `CascadeEveClient.stream()` **re-runs the whole live cascade** (Gemini + Cloud Vision + narrator)
  on every call (`services/voxi-api/src/cascade-eve-client.ts:59-108`) — non-deterministic, costs
  vendor calls, and only works while the in-memory photo `Map` still holds the photo. After a restart
  it yields `hard_failure "session expired — capture again"` (`cascade-eve-client.ts:60-66`).
- Narration for `/speech` lives in an **in-memory `NarrationStore`** (`narration-store.ts:13-31`) —
  also lost on restart.
- The production DDL defines `app.turns` (`label`, `confidence_band`, `events jsonb` — "the durable
  NDJSON events, for replay + audit") (`0001_init.sql:254-263`), but **the runtime writes neither
  `app.turns` nor `app.threads.photo_url`**. The rich model is unused.

**One line:** the running BFF persists only lightweight thread metadata; the photo and all generated
content live in in-memory maps inside `CascadeEveClient`/`NarrationStore` and are recomputed on
demand — so a revisited item after the process (or memory) is gone shows a blank image and no content.

## 2. Goal & scope

**Goal:** every past collection item durably retains **(1) its captured photo** and **(2) the exact
generated reveal it produced** (identification title + confidence band + candidates + narration), and
renders them on revisit — surviving a **process restart** (the honest durability bar), with revisits
being **deterministic and free** (no re-billing, no re-running the model).

**In scope (decided 2026-07-01 — "fix this completely. everything"):** durable persistence + revisit
rendering for **all four content types a collection item produces**:
1. the **captured photo** (PGlite `bytea` locally; GCS behind `app.threads.photo_url` in prod);
2. the **generated reveal** (identification title + confidence band + candidates + narration) — persist + deterministic replay;
3. the **podcast** it generated (audio + two-voice transcript, `app.podcast_assets`) — the item "remembers" its episode;
4. the **conversation** it held (voice/text messages, `app.messages`) — replayed on revisit.
Plus list/detail enrichment (thumbnail + real identified title + band + "has podcast/conversation"),
client rehydrate on revisit, and full test coverage incl. a restart/durability proof and an agentic
"real user" revisit for each type.

**Storage decisions (user, this session):** photo = **PGlite `bytea`** (one durable store, clean
close/reopen proof; prod = GCS). Podcast + conversation **IN scope**. The interrupted-scan durable-photo
fallback **kept** (§3.3).

**Still out of scope (called out):** wiring the assembled BFF to the cred-gated durable-eve HTTP client
so prod replay uses eve's world streams (this plan's BFF-owned `reveals`/`messages` stores are the
coherent local projection + the `app.turns`/`app.messages` shapes). Noted in §10.

## 3. Design (BFF-owned durability)

**Principle:** the BFF owns `app.*` (schema `app` = db user `voxi_app`; the DDL puts `threads`,
`photo_url`, and `turns` there) and is the ACL boundary. So the *BFF* durably persists the photo + the
reveal projection and serves them on revisit. The eve client stays a live-cascade seam; it gains a
durable photo fallback so an interrupted first scan can still complete after a restart. This works
regardless of the (cred-gated) durable-eve tier and is fully provable here.

### 3.1 Durable stores (in `pg-stores.ts`, PGlite on disk → survives restart)

Two new stores + tables, alongside the existing `threads`/`entitlements`/`gen_tokens`:

```sql
-- photo bytes for a thread (the local stand-in for GCS behind app.threads.photo_url)
CREATE TABLE IF NOT EXISTS thread_photos (
  thread_id     text PRIMARY KEY,
  owner_user_id text   NOT NULL,
  mime          text   NOT NULL,
  bytes         bytea  NOT NULL,
  created_at    bigint NOT NULL
);

-- the durable projection of the reveal == app.turns (events jsonb + derived fields)
CREATE TABLE IF NOT EXISTS reveals (
  thread_id     text PRIMARY KEY,
  owner_user_id text   NOT NULL,
  band          text,                      -- CONFIDENT|PROBABLE|UNKNOWN (from the confidence_band event)
  title         text,                      -- the identified label
  candidates    jsonb  NOT NULL DEFAULT '[]',
  events        jsonb  NOT NULL DEFAULT '[]',  -- ordered StreamEvent[] — the source of truth for replay
  narration     text,                      -- joined `token` clauses (whatItIs) for /speech
  created_at    bigint NOT NULL
);

-- the durable podcast asset the item generated == app.podcast_assets (BFF-cached terminal record)
CREATE TABLE IF NOT EXISTS podcast_assets (
  token           text PRIMARY KEY,
  user_id         text   NOT NULL,
  catalog_item_id text   NOT NULL,          -- == threadId for a thread-scoped episode (the item link)
  version         integer NOT NULL DEFAULT 1,
  status          text   NOT NULL DEFAULT 'composing'
                  CHECK (status IN ('composing','ready','failed')),
  audio_url       text,                      -- set only on ready
  transcript      jsonb,                     -- [{speaker:'ARLO'|'MAVE',text}] set only on ready
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS podcast_item_version ON podcast_assets (catalog_item_id, version);

-- the durable conversation history == app.messages (idempotent single-writer append)
CREATE TABLE IF NOT EXISTS messages (
  id         text PRIMARY KEY,              -- uuid
  thread_id  text   NOT NULL,
  user_id    text   NOT NULL,               -- owner (ACL key)
  role       text   NOT NULL CHECK (role IN ('user','guide')),
  text       text   NOT NULL,
  source     text   NOT NULL DEFAULT 'text' CHECK (source IN ('text','voice')),
  client_key text,                          -- idempotency key from the single writer (voice-bot/client)
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_key ON messages (thread_id, client_key) WHERE client_key IS NOT NULL;
```

New `PgStores` members (with in-memory fakes for the core tests + harness):
- `photos: PhotoStore` — `put({threadId,ownerUserId,mime,bytes})`, `get(threadId) → {ownerUserId,mime,bytes}|null`, `has(threadId)`.
- `reveals: RevealStore` — `put(Reveal)`, `get(threadId) → Reveal|null`.
- `podcasts: PodcastAssetStore` — `upsert({token,userId,catalogItemId,version,status,audioUrl?,transcript?})`, `getByToken(token) → Asset|null`, `getByItem(catalogItemId,version) → Asset|null`.
- `messages: MessageStore` — `append({threadId,userId,role,text,source,clientKey?}) → {id,duplicate}` (idempotent on `(threadId,clientKey)`), `listByThread(threadId) → Message[]` (ordered).
- `purgeUser(userId)` extended to `DELETE FROM thread_photos|reveals|podcast_assets|messages` (owner-scoped) and return their counts.

`bytea` round-trips through PGlite; we store decoded bytes + mime (compact, not the base64 data-URI).

### 3.2 BFF wiring (`services/voxi-api/src/app.ts`)

New optional deps (defaulted so existing `createApp`-with-fakes tests still compile):
`photos?: PhotoStore`, `reveals?: RevealStore`.

1. **`POST /v1/threads` (create) — persist the photo.** After `eve.createSession`, decode `photoUrl`
   (data-URI or the multipart bytes we already read at `app.ts:200-203`) into `{mime, bytes}` and
   `await deps.photos?.put({threadId, ownerUserId, mime, bytes})`. (Guard: skip/della on decode
   failure; a non-image `obj:...` seed in tests stores a tiny placeholder or is skipped — see §7.)

2. **`GET /v1/threads/:id/stream` — replay-or-generate + persist.**
   - **Replay:** if `deps.reveals.get(id)` exists (owner-checked) → re-emit its stored `events`
     honoring `?startIndex=`, then return. **No eve call, no charge, deterministic** — this is the core
     "content is saved" fix. Revisits are free and identical every time.
   - **Generate (first run):** else iterate `deps.eve.stream(...)` as today (refund logic unchanged),
     **collecting** each event. On terminal `done`, **iff a `confidence_band` event was seen** (a real
     identification outcome — *not* a `safety_refusal`/`hard_failure`, which stay retryable and are
     **not** persisted), persist `deps.reveals.put({threadId, ownerUserId, band, title, candidates,
     events, narration})` where `narration` = the joined `token` texts, and update the thread's
     display title→identified title + `band` (see 3.4). Persist is **idempotent** (first successful
     drain wins; `put` is `ON CONFLICT DO NOTHING`).

3. **`GET /media/threads/:id/photo` — serve the photo (self-authenticating, OUTSIDE `/v1/*`).**
   A read-only, owner-bound, short-TTL, **HMAC-signed URL** (the same hardened-signed-URL model as
   `signing.ts`, and the prod GCS-signed-URL shape). It lives outside the Clerk `/v1/*` middleware so a
   browser `<img>` / native `<Image>` can load it **without an auth header** (RN-web `<img>` can't send
   one). Query: `?u=<userId>&exp=<ms>&sig=<hmac>`; the route verifies the sig (binds `u`+`threadId`+
   `exp`), rejects expired/forged, cross-checks the photo/thread owner == `u`, then streams
   `bytes` with `content-type: mime`. Missing photo → 404; bad/absent sig → 403.

4. **`GET /v1/threads` (list) + `GET /v1/threads/:id` (detail) — enrich.** Return per item:
   `photoUrl?` = a freshly-minted signed `/media/threads/:id/photo?...` (relative to the BFF root; the
   client prepends `baseUrl`) **only when a photo exists**, plus `band?` and the identified `title`.
   The list stays a single owner-scoped query (title+band come off the threads row after 3.4;
   photo existence off `photo_mime`).

5. **`POST /v1/threads/:id/speech` — durable narration.** Prefer the durable reveal narration:
   `text = (owner-checked deps.reveals.get(id))?.narration ?? await deps.eve.narrationText?.(id, userId)`.
   So `/speech` survives a restart and always matches the replayed `whatItIs`.

### 3.3 eve client durable-photo fallback (`cascade-eve-client.ts`)

Inject the same `PhotoStore` into `CascadeEveClient`. `stream()` reads the photo from its in-memory
`Map` first (hot path for the fresh scan), else falls back to `photoStore.get(sessionId)`. So an
**interrupted first scan** (created, never drained) can still complete after a restart instead of
`hard_failure`. `createSession`/`stream` signatures are unchanged; the in-memory `NarrationStore`
becomes redundant for durability (the BFF owns durable narration) but is left in place harmlessly.
Deletion still clears the in-memory maps.

### 3.4 Thread row: identified title + band + photo flag

Extend the `pg-stores` `threads` table (and `ThreadRecord`) with `band text` and `photo_mime text`
(both nullable). `photos.put` also sets `photo_mime` (so the list knows a photo exists without loading
bytes). On reveal-persist, `threads.applyReveal(threadId, {title, band})` replaces the default
`"Untitled capture"` with the identified title and sets `band`. Net: the collection grid shows
**"1976 Canon AE-1" with a thumbnail + a confidence chip**, not a title-less "Untitled capture".

### 3.5 Client (`app/`)

- `apiClient.ts`: add `photoUrl?: string` + `band?: ConfidenceBand` to `ThreadSummary`; `photoUrl?` to
  `ThreadDetail`. In `listThreads`/`getThread`, map the server's **relative** `photoUrl` → absolute
  (`this.baseUrl + photoUrl`) so screens get a ready-to-load `uri`.
- `threads.tsx`: render a thumbnail `<Image {...tid(ids.threads.itemPhoto)} source={{uri:item.photoUrl}}>`
  in each tile when present (title tile stays as the fallback + caption); a `ConfidenceChip`/band tag.
  `openThread(item)` stashes `item.photoUrl` into the store before navigating (via `startCapture(uri)`
  then `setThread(id)`), so processing/reveal show the real image on revisit.
- `reveal.tsx`/`processing.tsx`: unchanged except they now receive a non-null `photoUri` on revisit
  (already handle `photoUri` present → real `<Image>`); the replayed stream fills title/band/whatItIs
  exactly as a fresh scan. `reveal.photoThumb` is the existing image testID.
- `captureStore.ts`: reuse `startCapture(photoUri)` for revisit hydration (no new state needed), or add
  a tiny `hydrateRevisit(threadId, photoUri)` convenience.

### 3.6 testIDs (registry `e2e/framework/testids.ts`)

Add `threads.itemPhoto` (grid thumbnail) and, if a band tag is shown on tiles, `threads.itemBand`.
Register in `e2e/web/converge/testid-coverage.ts`; `bun run lint:selectors` must stay green.

### 3.7 Podcast durability (`app.podcast_assets`)

Today the podcast lives only in the worker's in-memory `jobs` Map + `/tmp` MP3
(`services/voxi-podcast-worker/src/server.ts:24-28`), so a generated episode is forgotten on restart
and a revisited item can't show it. The BFF (the public surface) becomes the durable record:
- `POST /v1/podcast`: on a fresh gate, `deps.podcasts.upsert({token, userId, catalogItemId, version,
  status:'composing'})` — the item now *has* a pending/known episode durably.
- `GET /v1/podcast/:token`: read the worker status; when it reports **ready**, persist
  `{status:'ready', audioUrl, transcript}` (idempotent). If the worker is unreachable *after* a
  restart, fall back to the durable terminal record (a ready episode stays playable). `getByToken` is
  owner-scoped.
- `GET /v1/threads/:id`: include `podcast?: {state, audioUrl?, transcript?}` via
  `getByItem(threadId, 1)` so the collection item **remembers its episode** on revisit (the reveal's
  "Generate story" becomes "Play story" when one exists).
- The worker writes its MP3 to a durable `OUT_DIR` (env; default `.voxi-data/podcasts`, not `/tmp`;
  prod = GCS) so the audio survives a local restart. The BFF-cached terminal asset is the load-bearing
  client durability; the worker dir is secondary hygiene.

### 3.8 Conversation durability (`app.messages`)

Today `app.messages` is never written and there is **no BFF conversation route**
(`conversation.tsx` state is in-memory; the reopened conversation is blank). Add BFF-owned durable
messages (the voice-bot is "the single idempotent writer of transcripts back" — it needs a route):
- `POST /v1/threads/:id/messages` — append `{role:'user'|'guide', text, source:'text'|'voice',
  clientKey?}`; owner-scoped; **idempotent** on `(threadId, clientKey)` (a retried transcript write
  collapses). Returns `{id, duplicate}`.
- `GET /v1/threads/:id/messages` — owner-scoped ordered history for revisit replay.
- `conversation.tsx`: write each user turn + each Guide reply through the route, and **load prior
  messages on mount** so revisiting a thread's conversation shows the real history (not a blank orb).
- `GET /v1/threads/:id`: include `hasConversation: boolean` (or a count) so the item can badge it.
- ACL: writes require the owner (or, in prod, the voice-bot's per-session scoped token — same `userId`
  ACL key); the deterministic proof uses the owner path.

testIDs: `conversation.transcriptText` already exists; add `conversation.history` (the replayed list
container) if needed for the revisit assertion.

## 4. Data-model alignment with `0001_init.sql`

The prod DDL already models this correctly: `app.threads.photo_url` (photo in blob storage, row holds
the URL) and `app.turns` (`events jsonb` = the reveal). Our local `pg-stores` stays a deliberate
subset (its header already acknowledges this) but is brought into line: `reveals` **is** the
`app.turns` projection; `thread_photos` **is** the local stand-in for GCS-behind-`photo_url`; the
signed `/media/...photo` URL **is** the local stand-in for a GCS signed URL. No prod DDL change needed;
a comment will cite the mapping. (Follow-up: the cred-gated durable-eve runtime already writes turns to
its world streams — `services/eve-agent/agent/server.ts` — so prod replay is covered there; this plan
makes the *assembled/local* system durable and is what the E2E proves.)

## 5. Security / ACL

- Every read stays **owner-scoped by the server-derived `userId`** (never client-trusted).
- The `/media/...photo` signed URL: HMAC over `photo|threadId|userId|exp`, short TTL (≤600s, under the
  900s cap), rejects forged/expired, and cross-checks `photo.owner_user_id == u == thread.owner`. A
  private photo bound to user X can't be read by user Y (same invariant as `signing.authorizeRead`).
- Replay never charges a scan (revisit hits `/stream`, not `/threads`). Persist happens only for a
  genuine identification (`confidence_band` seen) — refusals/failures stay retryable and unsaved.
- Deletion cascade purges `thread_photos` + `reveals` (Apple-required completeness).

## 6. Seam / interface changes (blast radius)

- `Deps` gains optional `photos?`, `reveals?` → no breakage to existing `createApp` callers.
- `ThreadRecord`/`ThreadStore` gain `band?`/`photoMime?` + `applyReveal`/`markPhoto` → update the two
  in-memory `ThreadStore` fakes (`local-collaborators.ts`, `e2e/web/server.ts`) + `pg-stores`.
- `CascadeEveClient` ctor gains an optional `photoStore` → `server.ts` passes the shared one; no test
  uses `CascadeEveClient` (app.test uses a fake eve), so no test breakage.
- `EveClient.createSession`/`stream` signatures **unchanged** (kept intentionally to bound the change).

## 7. Test plan (no cheating — real state through stable selectors; durability across a real restart)

**Unit / integration (`bun test`):**
1. `pg-stores.test.ts` (new/extended): photo + reveal `put` then **close → reopen same dataDir → get**
   returns them (the durability proof, mirroring the existing restart-survival pattern). `purgeUser`
   removes both.
2. `app.test.ts` (BFF): (a) first `/stream` drains + persists a reveal; a **second** `/stream` replays
   the **same events with `eve.stream` NOT called again** (spy asserts one live run) → deterministic;
   (b) `GET /v1/threads` returns `photoUrl`+`band`+identified `title`; (c) `GET /media/threads/:id/photo`
   returns bytes for the owner; **403** cross-tenant / forged sig; **404** missing; loads with **no
   Bearer** given a valid sig; (d) `/speech` reads durable narration after a simulated restart (new
   `createApp` over the same stores); (e) a `safety_refusal`/`hard_failure` terminal is **not**
   persisted (revisit re-attempts, not replays a failure) and the scan refund still fires once.
2b. **Podcast** (`app.test.ts`): a gate → `podcasts.upsert(composing)`; a poll that sees worker `ready`
   persists `{audioUrl,transcript}`; `GET /v1/threads/:id` returns the item's `podcast` after a
   simulated restart with the worker **unreachable** (durable terminal record served); owner-scoped
   (a non-owner token can't read the asset).
2c. **Conversation** (`app.test.ts` + `pg-stores.test.ts`): `POST .../messages` appends;
   a duplicate `clientKey` is idempotent (`duplicate:true`, one row); `GET .../messages` returns
   ordered history for the owner only (**403** cross-tenant); survives close/reopen.

**Web E2E — the "real user" validation:**
3. **Durability proof runner** (`e2e/web/converge/collection-persistence-rnw.web.ts`, or extend
   `threads-rnw`): drive the REAL screens over a REAL BFF backed by **durable pg-stores** → capture →
   drain reveal (image + content visible) → generate a podcast (ready) → hold a short conversation →
   **close + reopen the stores (simulated restart)** → open Collection → assert the tile shows a
   **thumbnail `<img>` that actually loaded** (`data-testid=threads.itemPhoto`, `naturalWidth>0`) and
   the **real identified title** → tap → revisit reveal shows the SAME image (`reveal.photoThumb`
   loaded) + SAME `reveal.title`/`reveal.whatItIs`/band; the **podcast still plays** and the
   **conversation history is still there**. Fail-closed. (Podcast/conversation legs may be split into
   their own converge runners if one file gets unwieldy.)
4. **Agentic scenario** (`e2e/scenarios/collection-persistence.scenario.ts` over the Agent/Playwright
   driver): the LLM *navigates* to the collection and opens a past item; **deterministic testID
   assertions** decide pass/fail — image present + content non-empty (the core rule: the LLM never
   decides pass/fail).
5. Extend the deterministic web shell (`e2e/web/server.ts`) + a `run-sc-*` runner so the collection
   list renders thumbnails + real titles off the real BFF (keeps the shell in parity with the app).

**Guards:** `bun run typecheck`, `bun run lint:selectors`, `testid-coverage` all green; new testIDs
registered.

## 8. Rollout / backfill

- New tables are `CREATE TABLE IF NOT EXISTS` (idempotent) — a fresh dir bootstraps, an existing dir
  gains the tables on next boot. **Existing pre-fix threads have no photo/reveal row**: the list shows
  them title-only (today's behavior) and revisit **falls back to live generation** (unchanged) — no
  crash, graceful degradation. No destructive migration.
- Prod DDL (`0001_init.sql`) already has `photo_url`/`app.turns`; no change required.

## 9. Risks & mitigations

- **Photo bytes in PGlite bloat** — acceptable for the local/assembled store; prod uses GCS behind
  `photo_url`. Bound: one row per thread; deletion purges. (Could add a max-size guard.)
- **Replaying a stale/incorrect reveal** — desired: the user sees exactly what they saw before
  (deterministic). A "re-scan" is a *new* capture (new thread), never a silent re-run of an old one.
- **Signed-URL TTL vs a long-scrolled grid** — TTL ≤600s; the list refetch re-mints; the image loads at
  render. If a tile is opened after expiry, detail re-mints. Acceptable.
- **`obj:...` seed strings aren't real images** (deterministic harness) — the create route stores a
  1×1 placeholder for a non-decodable `photoUrl` (or the harness seeds a tiny data-URI) so the E2E can
  still assert a loaded `<img>`; the *live* path stores the real capture bytes.

## 10. Follow-ups (explicitly deferred)

- Wire the assembled BFF to the cred-gated durable-eve HTTP client so prod replay uses eve's world
  streams (this plan's `reveals`/`messages` stores are the coherent local projection + the
  `app.turns`/`app.messages` shapes).
- Prod object-store (GCS) for photo + podcast bytes behind the same `photo_url`/`audio_url` seam
  (local uses `bytea` + `.voxi-data/podcasts`).
- Voice-bot writing conversation transcripts through `POST /v1/threads/:id/messages` with its
  per-session scoped token (this plan adds the route + the owner path; the live voice writer is the
  cred-gated tier).

## 11. File-by-file change list

- `services/voxi-api/src/pg-stores.ts` — `thread_photos`/`reveals`/`podcast_assets`/`messages` tables;
  `photos`/`reveals`/`podcasts`/`messages` stores; `threads` gains `band`/`photo_mime` +
  `applyReveal`/`markPhoto`; `purgeUser` cascade over all four.
- `services/voxi-api/src/app.ts` — `Deps.photos/reveals/podcasts/messages`; create-time photo persist;
  `/stream` replay-or-generate + persist reveal; `/media/threads/:id/photo` route; list/detail
  enrichment (photo/band/title + `podcast`/`hasConversation`); `/speech` durable narration;
  podcast gate/poll persistence; `POST|GET /v1/threads/:id/messages`.
- `services/voxi-api/src/signing.ts` — `mintPhotoUrl`/`verifyPhotoUrl` (reuse the existing `sign()` HMAC).
- `services/voxi-api/src/cascade-eve-client.ts` — inject `PhotoStore`, durable read fallback in `stream`.
- `services/voxi-api/src/server.ts` — wire `durable.{photos,reveals,podcasts,messages}` into `createApp` + the eve client.
- `services/voxi-api/src/local-collaborators.ts` — in-memory `ThreadStore` fake gains the new fields/methods.
- `services/voxi-podcast-worker/src/server.ts` — durable `OUT_DIR` (default `.voxi-data/podcasts`, not `/tmp`).
- `app/src/lib/apiClient.ts` — `ThreadSummary`/`ThreadDetail` gain `photoUrl`/`band`/`podcast`/`hasConversation`;
  `listMessages`/`postMessage`; absolute-URL mapping.
- `app/app/(tabs)/threads.tsx` — thumbnail + band on tiles; revisit photo hydrate.
- `app/app/reveal.tsx` — "Play story" when a durable podcast exists (else "Generate story").
- `app/app/conversation.tsx` — load prior messages on mount; persist each turn.
- `app/app/podcast.tsx` — resume a persisted ready episode instead of always re-gating.
- `app/src/state/captureStore.ts` — (optional) `hydrateRevisit`.
- `e2e/framework/testids.ts` + `e2e/web/converge/testid-coverage.ts` — `threads.itemPhoto` (+ band, conversation.history).
- `e2e/web/server.ts` — deterministic shell: thumbnails + real titles; wire in-memory photos/reveals/podcasts/messages.
- `e2e/web/converge/collection-persistence-rnw.web.ts` (new) + `e2e/scenarios/collection-persistence.scenario.ts` (new).
- `services/voxi-api/src/{pg-stores,app}.test.ts` — durability + replay + photo + podcast + messages + ACL tests.
- `docs/IMPLEMENTATION-STATUS.md` — record the fix + proofs.

## 12. Eng-review coverage diagram + failure modes

```
CODE PATHS                                                 USER FLOWS
[+] pg-stores.ts                                           [+] Capture → reveal (fresh)
  ├── photos.put/get/has (bytea round-trip)                  └── [★★★] image + content visible — converge
  ├── reveals.put(ONCONFLICT)/get                          [+] Revisit (same process)
  ├── podcasts.upsert/getByToken/getByItem                   └── [★★★] image+content replayed — app.test
  ├── messages.append(idempotent)/listByThread             [+] Revisit AFTER RESTART        [→E2E]
  ├── threads.applyReveal/markPhoto                          ├── [★★★] photo <img> loaded (naturalWidth>0)
  └── purgeUser (4-table cascade)                            ├── [★★★] title/band/whatItIs same
[+] app.ts POST /v1/threads                                  ├── [★★★] podcast still ready+plays
  ├── data: URI → decode → photos.put+markPhoto              └── [★★★] conversation history present
  ├── non-data photoUrl → skip (no fake)                   [+] Collection grid                [→E2E]
  └── 402 scan cap (unchanged)                               ├── [★★★] thumbnails + real titles + band
[+] app.ts GET /stream (replay-or-generate)               [+] ACL
  ├── reveals.get → REPLAY (startIndex filter, no eve)       ├── [★★★] cross-user photo/msg/podcast 403
  ├── else generate → collect → on done+band → persist      └── [★★★] forged/expired photo sig 403
  ├── refusal/hard_fail → NO persist + refund (F9)         [+] Degraded
  └── reveals.get throws → degrade to generate               ├── [★★] interrupted scan+restart → durable photo re-run
[+] app.ts GET /media/threads/:id/photo (outside /v1)        └── [★★] pre-fix thread (no photo/reveal) → title-only, no crash
  ├── valid sig+owner → bytes ;  forged/expired → 403
  └── missing photo → 404 ;  no photos dep → 404
[+] app.ts podcast gate/poll persist ; messages POST/GET
[+] signing.ts mintPhotoUrl/verifyPhotoUrl (reuse sign())
[+] cascade-eve-client stream: in-mem → durable photo → hard_fail
[+] client: threads tile thumb ; reveal Play-story ; conversation history load ; apiClient abs-url

COVERAGE TARGET: every path above has a unit/integration or E2E test (100% of new paths).
REGRESSION (CRITICAL, no ask): fresh scan still streams live + revisit replays deterministically;
  F9 refund-on-refusal still fires after the replay/persist refactor; proc-04/05/06 + thread-02/03 green.
```

**Failure modes (each: test? handled? user-visible?):**
- Photo decode throws → skip persist, thread still created. ✅ test ✅ handled ✅ no crash (blank-card fallback).
- `reveals.get` DB error mid-revisit → degrade to live generate (content non-secret; worst case a re-run, never a 500). ✅ handled.
- Podcast worker unreachable after restart → serve durable terminal asset. ✅ test ✅ handled ✅ plays.
- Signed photo URL expired while grid open → `<img>` 403 → existing blank-card fallback. ✅ handled (not a crash).
- Duplicate message write (voice-bot retry) → idempotent, one row. ✅ test ✅ handled.
- bytea corruption → durability test asserts byte-equality. ✅ test.
- **No critical gaps** (no failure that is untested AND unhandled AND silent).

## 13. NOT in scope (deferred, with rationale)
- Cred-gated durable-eve HTTP client wiring for prod replay — the BFF-owned stores are the local projection (§10).
- Prod GCS object store for photo/podcast bytes — local uses `bytea` + `.voxi-data/podcasts` behind the same seam.
- Live voice-bot writing transcripts through the new messages route — route + owner path added; live writer is cred-gated.
- Prod signing-key hardening (fail-closed if `VOXI_URL_SIGNING_KEY` unset) — pre-existing `signing.ts` default; separate.

## 14. What already exists (reused, not rebuilt)
- `pg-stores.ts` durable PGlite (close/reopen proven) → **extended**, not paralleled.
- `signing.ts` `sign()`/`authorizeRead` HMAC → **reused** for the photo URL (no duplicate crypto).
- `NarrationStore` idempotent-pin → superseded by durable reveal narration; kept as the eve seam fallback.
- The NDJSON `events.ts` contract + `?startIndex=` replay → the reveal replay re-emits persisted `events` (no new event types).
- `app.podcast_assets`/`app.turns`/`app.messages` in `0001_init.sql` → the local stores mirror these shapes.

## 15. Parallelization (worktree lanes)
| Step | Modules | Depends on |
|---|---|---|
| S1 stores | `voxi-api/pg-stores` + fakes | — |
| S2 BFF routes | `voxi-api/app,signing,cascade-eve-client,server` | S1 |
| S3 client | `app/*` | S2 (types) |
| S4 tests/e2e | `e2e/*`, `*.test.ts` | S2, S3 |
Lane A: S1 → S2 → S3 → S4 is largely sequential (tight type coupling through the BFF seam). The
independent parallel slices worth fanning out: **podcast** vs **conversation** vs **photo+reveal** are
three near-independent verticals *within* S2/S3/S4 once S1's tables exist — implement S1 once, then the
three verticals can be built + tested in parallel. Adversarial code-review fans out per vertical.

## 16. Adversarial review — confirmed findings folded in (BINDING)

A 5-lens adversarial workflow (each finding independently verified against the real code) raised 26,
**21 confirmed, 5 refuted**. Every confirmed fix below is now a hard implementation requirement.

**P0**
- **A1 (signing-key fail-closed).** The `/media` photo route lives outside `/v1/*` and is gated only by
  HMAC; the secret defaults to a public `'test-signing-key'` (`signing.ts:24`) and threadId embeds the
  owner's userId → forgeable photo exfiltration in prod. FIX: `signing.ts` **throws at init** if
  `VOXI_URL_SIGNING_KEY` is unset/short unless `VOXI_TEST_MODE=1`; add a `server.ts` startup assertion;
  use the **full-length** HMAC hex for the photo sig (not the 32-char slice). Ship the guard *with* the route.
- **A2 (durable /stream ACL).** `GET /v1/threads/:id/stream`'s first line is a HARD
  `sessionOwner.get(id) !== userId → 403` (`app.ts:246`); `sessionOwner` is in-memory and wiped on
  restart → **every replay 403s after restart**, breaking the whole feature. FIX: mirror
  `GET /v1/threads/:id` (`app.ts:236-238`) — soft map check **plus** durable
  `deps.threads.get(id).ownerUserId !== userId → 403` (thread row, not reveals, so an interrupted first
  scan still authorizes). The restart tests **must build a FRESH `createApp` with an empty `sessionOwner`**.

**P1**
- **A3 (honest image bytes).** No web path has real image bytes and the plan self-contradicted
  (1×1 placeholder vs skip). FIX: **delete the placeholder option**; the create route decodes + stores
  ONLY real `data:`/multipart bytes and **skips scheme URLs loudly (no fake)**; the durability E2E seeds
  a **real tiny `data:image/png;base64` URI** and asserts the exact bytes/dimensions round-trip.
- **A4 (assert the descendant `<img>`).** testID lands on the outer wrapper `<div>` (RNW Image AND
  expo-image); the `<img>` carrying `naturalWidth` is a child. FIX: assert
  `[data-testid="threads.itemPhoto"] img` / `[data-testid="reveal.photoThumb"] img` `naturalWidth>0`.
- **A5 (harness restart seam).** `createWebHarness` wires in-memory stores with no close/reopen. FIX:
  parameterize it to accept `createPgStores(dataDir)`; the E2E "restart" = a **fresh harness/page over the
  same `dataDir`** (signed URLs re-mint per list fetch, so no live-URL preservation needed). The
  load-bearing durability proof stays the **unit close→reopen** (`pg-stores.test.ts`, `app.test` fresh
  `createApp`). Reconcile §11 "wire in-memory" → durable. Add `harness.ts`/`server.ts` to the change set.
- **A6 (messages partial-index ON CONFLICT).** Verified in PGlite 0.5.3: the bare
  `ON CONFLICT (thread_id, client_key) DO NOTHING` **throws on every append** against a partial unique
  index. FIX: `ON CONFLICT (thread_id, client_key) WHERE client_key IS NOT NULL DO NOTHING`. The client
  always sends a `clientKey` (uuid) so every append is idempotent. Test a NULL-key append + a dup key.
- **A7 (4th ThreadStore fake).** A fourth `memThreads()` exists in `spikes/e2e-live-loop.ts`. FIX: make
  `applyReveal`/`markPhoto` **OPTIONAL** interface members, call via `deps.threads.applyReveal?.(...)` so
  any fake degrades gracefully; grep all impls before landing.
- **A8 (don't overwrite `title`).** `applyReveal` overwriting `threads.title` breaks `run-sc-threads`
  (thread-02/03 assert `/Capture ·/`). FIX: **never touch `title`**; store the identified label in a NEW
  `reveal_title` column + `band`; the list returns `{title, revealTitle, band, …}`; the tile renders
  `revealTitle || title`. Update `run-sc-threads` line ~149 to assert the identified label on the tile
  (honest behavior change), keeping the BFF `title` field = the auto-title (lines 172/230 stay green).
- **A9 (podcast keyspace ownership).** `POST /v1/podcast` trusts client `catalogItemId`; the asset
  keyspace + getters drop `userId` → cross-tenant squat/read. FIX: `podcast_assets` carries `user_id`;
  unique index `(user_id, catalog_item_id, version)`; `getByToken`/`getByItem` are **owner-scoped**
  (`user_id === caller`); the durable `GET /v1/podcast/:token` fallback returns only `asset.user_id ===
  userId`; `GET /v1/threads/:id` attaches via `getByItem(threadId,1,userId)`.
- **A10 (never persist UNKNOWN).** The cascade emits `confidence_band` for UNKNOWN too, with no
  narration; persisting it freezes the item into `/interview` forever + clobbers the title with a
  rejected label. FIX: persist a reveal + `applyReveal` **only for CONFIDENT/PROBABLE**; UNKNOWN stays
  retryable (like refusals), so revisit re-attempts and can catch later catalog growth.

**P2/P3**
- **A11 (messages `{id,duplicate}`).** `DO NOTHING RETURNING` returns no row on a dup. FIX: `duplicate =
  affectedRows===0`; ids are app-generated uuids; on a dup do a follow-up `SELECT id` to return the
  canonical id.
- **A12 (persist only on `startIndex===0`).** A first drain via a `?startIndex=>0` reconnect would persist
  a truncated reveal/narration. FIX: guard reveal persist on `startIndex === 0`.
- **A13 (don't log the sig).** `withRequestTelemetry` logs `pathname+search` incl. the photo `sig`
  (`telemetry/src/http.ts:69`), replayable within TTL from logs. FIX: strip `sig`/`exp`/`u`/`s` query
  params from logged path values in the redactor (or log pathname-only for `/media`).
- **A14 (deletion completeness).** `purgeUser` must delete all 4 tables **and** the user's OUT_DIR
  podcast MP3s (orphaned PII); widen the return counts + §5 to four tables.
- **A15 (durable refund guard).** `refundedThreads` is an in-memory Set; with the durable-photo fallback,
  a refused thread re-streams + **re-refunds a scan on every restart**. FIX: a durable per-thread
  `refunds` marker (checked+set before `credit`), so a refusal credits back exactly once ever.
- **A16 (jsonb read).** PGlite returns `jsonb` already-parsed and `bytea` as a byte-equal `Uint8Array`
  (verified). FIX: read jsonb columns directly (no `JSON.parse`); only stringify/pass-object on write.
- **A17 (local CHECK parity, minor).** Add a `podcast_ready_has_audio`-style guard locally; note `reveals`
  is intentionally single-turn (1 photo = 1 reveal).

Refuted (no action): sessionId-prefix brittleness (already belt-and-suspenders + owner columns);
create-route decode guard (already in plan); podcast double-arbiter (unreachable); conversation converge
harness missing (it exists); new-testID registration (already planned).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Adversarial Review | multi-agent workflow | Independent attack + verify | 1 | issues_resolved | 26 raised, **21 confirmed / 5 refuted**; 2 P0 + 8 P1 folded as A1–A17 (§16) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | Step-0 full-scope accepted; 3 user decisions (bytea / podcast+conversation IN / keep fallback); arch+quality+perf findings folded; coverage diagram + regression rule + failure modes added; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | thumbnails/badges are additive to existing screens; not run |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **UNRESOLVED:** none — the three load-bearing decisions were answered; all other findings resolved with sensible defaults and folded in.
- **VERDICT:** ENG + ADVERSARIAL CLEARED — plan verified, full "everything" scope, 21 confirmed adversarial findings folded in as binding requirements A1–A17 (§16). Ready to implement.

