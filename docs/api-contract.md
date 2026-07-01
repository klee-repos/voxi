# Voxi API Contract — BFF ↔ eve + voice-bot ↔ eve (DX-6)

> The real spec PLAN §4.3 / §6.3 / DX-6 reference and that the voice-bot flagged as missing.
> Every shape below is transcribed from the implemented code; each claim cites `file:line`.
> If code and doc disagree, the code is canonical — file an issue, do not silently patch the doc.

## 0. Topology and trust boundary

```
 RN/web client ──Clerk JWT──▶ voxi-api (BFF, the ONLY public surface) ──▶ eve FRONT (Cloud Run, private)
                                     │                                          │
 Pipecat voice-bot ──scoped token──▶ BFF (tool bridge + transcript write-back) ─┘   eve POLLER (non-serverless)
```

- The BFF (`services/voxi-api/src/app.ts`) is the only public surface; eve is never reached directly by a client
  (`services/voxi-api/src/app.ts:1-8`, the `EveClient` is injected and "never exposed publicly").
- The eve agent re-enforces the SAME auth+ACL at its own boundary (defence in depth) in
  `services/eve-agent/agent/channels/eve.ts:10-17`.
- The voice-bot never holds a broad credential — it gets a per-session scoped token from the BFF
  (`services/voice-bot/voxi_voice/bff_bridge.py:3-17`).

Auth model on the two hops:
- **client → BFF**: `Authorization: Bearer <Clerk session JWT>` (`services/voxi-api/src/app.ts:95-100`).
- **BFF → eve FRONT**: in-VPC HTTP; user identity forwarded as the `x-voxi-user` header on the stream, body field
  `userId` on session create (`infra/docker/voxi-api/server.ts:49-63`).
- **voice-bot → BFF**: per-session `ScopedToken` as bearer (`services/voice-bot/voxi_voice/bff_bridge.py:29-35`).

---

## 1. Clerk JWT verification contract

The BFF authenticates **every** `/v1/*` request through an injected `Verifier`; a missing/invalid principal is a
hard `401` and the route never runs (`services/voxi-api/src/app.ts:94-100`).

```ts
// services/voxi-api/src/auth.ts:8-12
export interface Principal { userId: string }
export type Verifier = (bearer: string) => Promise<Principal | null>
```

- **Bearer extraction** — case-insensitive `^Bearer\s+(.+)$`; anything else → `null`
  (`services/voxi-api/src/auth.ts:36-40`).
- **Production verify** — `clerkVerifier(verifyToken)` wraps `@clerk/backend` `verifyToken(token, { jwtKey:
  CLERK_JWT_KEY })`, **networkless** (signature check against the cached JWKS/PEM; no per-request network). The
  principal is `claims.sub`. Any throw (bad signature, expiry, clock skew) → `null` → `401`
  (`services/voxi-api/src/auth.ts:21-34`; mirrored at the eve boundary in
  `services/eve-agent/agent/channels/eve.ts:36-49`).
- **Production wiring** — `CLERK_JWT_KEY` is **required** in prod; boot throws if it is absent and
  `VOXI_TEST_MODE!=1` (`infra/docker/voxi-api/server.ts:27-41`). The real `verifyToken` is imported lazily from
  `@clerk/backend`; until present the route fails loudly, never silently green (`infra/docker/voxi-api/server.ts:34-39`).
- **Test verify** — `testVerifier` honored **only** when `VOXI_TEST_MODE=1`; accepts `test:<userId>` matching
  `^test:([a-zA-Z0-9_-]+)$` and returns `{ userId }`. Returns `null` outside test mode
  (`services/voxi-api/src/auth.ts:14-19`).

`userId = claims.sub` is the single key for the per-user session-ownership ACL and the `users` row
(`services/voxi-api/src/auth.ts:5-7`; `services/eve-agent/agent/channels/eve.ts:19`).

### eve-side authorize (the ACL, defence-in-depth)

`makeAuthFn(verify, ownership)` authenticates then authorizes by access kind
(`services/eve-agent/agent/channels/eve.ts:80-118`):

| `AccessKind` | Requires sessionId | Authorize rule | Deny status |
| --- | --- | --- | --- |
| `create`   | no  | authenticated only; ownership recorded after the runtime mints the id | `401` |
| `stream`   | yes | session must exist AND `ownerOf(sessionId) === principal.userId` | `401` / `403` |
| `continue` | yes | same as stream | `401` / `403` |

Deny reasons (`services/eve-agent/agent/channels/eve.ts:103-115`): `invalid or missing Clerk session token` (401);
`no sessionId on a non-create access` (403); `unknown session` (403); `session is owned by another user` (403 — the
load-bearing §4.3 line). Ownership is recorded on create via `onSessionCreated`
(`services/eve-agent/agent/channels/eve.ts:120-127`).

---

## 2. BFF routes (`/v1/*`) — the public surface

All routes require auth (the `/v1/*` middleware, `services/voxi-api/src/app.ts:95-100`). The error envelope on
**every** non-2xx is `{ "error": string }` (see each route + client mirror `app/src/lib/apiClient.ts:99-108`).
The injected/optional collaborators that back several routes are typed in `services/voxi-api/src/app.ts:14-86`.

### 2.1 `POST /v1/uploads/sign` — short-TTL signed upload URL

`services/voxi-api/src/app.ts:104-108`. No request body. Response is `mintSignedUrl(...)`
(`services/voxi-api/src/signing.ts:30-41`):

```jsonc
{ "url": "https://storage.example/<bucket>/u/<userId>/<uuid>?u=<userId>&s=private&exp=<ms>&sig=<hex32>",
  "objectKey": "u/<userId>/<uuid>",   // private => per-user prefix + UUID (non-enumerable)
  "expiresAt": 1700000000000 }         // now + ttl; TTL default 120s, hard max 900s
```

Photo signed-URL file-part structure (PLAN §4.3 "how the photo signed-URL file-part is structured"):
- **scope** — `'private'` for the user's captured photo; `objectKey = u/<userId>/<uuid>`. `'global'` (audio cached
  by catalog id) → `g/<uuid>` (`services/voxi-api/src/signing.ts:35-36`).
- **HMAC** — `sign(payload)` = `HMAC-SHA256(VOXI_URL_SIGNING_KEY, "<bucket>|<objectKey>|<userId>|<scope>|<expiresAt>")`,
  hex, first 32 chars (`services/voxi-api/src/signing.ts:26-28,37-39`).
- **TTL guard** — `ttlSeconds > 900` throws `signed URL TTL too long (max 900s)` (`services/voxi-api/src/signing.ts:31-32`).
- **Read authorization** (`authorizeRead`, `services/voxi-api/src/signing.ts:44-64`): re-derive the HMAC and check
  `sig` match → else `{ ok:false, reason:'bad_signature' }`; `now > exp` → `expired`; private object bound to user X
  read by user Y → `cross_tenant_denied`; unparseable URL → `bad_url`.

Status: `200` always (auth already passed). Verified `services/voxi-api/src/app.test.ts:47-56`.

### 2.2 `POST /v1/threads` — create thread (1 photo = 1 eve session, charges a scan)

`services/voxi-api/src/app.ts:111-126`.

- **Request** `{ "photoUrl": string, "title"?: string }` (`app/src/lib/apiClient.ts:26-29`).
- **`400`** `{ "error": "photoUrl required" }` when `photoUrl` is missing/body unparseable.
- **`402`** `{ "error": "scan_limit_reached" }` when `charge(store, userId, 'scan')` fails the atomic decrement
  (`services/voxi-api/src/app.ts:115`; `charge`→`tryDecrement` in `services/voxi-api/src/metering.ts:65-67,22-23`).
- **`200`** `{ "threadId": string }` — `threadId === eve sessionId`. On success the BFF: records
  `sessionOwner[sessionId] = userId` (the in-memory ACL, `services/voxi-api/src/app.ts:117`) and persists a
  `ThreadRecord` carrying the durable `continuationToken` (`services/voxi-api/src/app.ts:118-124`).

`eve.createSession({ userId, photoUrl })` returns `{ sessionId, continuationToken }`
(`services/voxi-api/src/app.ts:14-16`). Cap behavior verified `services/voxi-api/src/app.test.ts:58-63`.

### 2.3 `GET /v1/threads` — the caller's own collection (owner-scoped ACL)

`services/voxi-api/src/app.ts:129-133`. No request body. Response:

```jsonc
{ "threads": [ { "threadId": string, "title": string, "createdAt": number } ] }
```

Only `listByOwner(userId)` rows are returned — never a client-supplied userId (`services/voxi-api/src/app.ts:131`;
`ThreadStore.listByOwner` "the ACL boundary", `services/voxi-api/src/app.ts:34-37`). If `deps.threads` is unset the
route returns `{ "threads": [] }` (`services/voxi-api/src/app.ts:130`). `continuationToken` is intentionally NOT in
the list projection (`services/voxi-api/src/app.ts:132`).

### 2.4 `GET /v1/threads/:id` — revisit → resume the durable eve session

`services/voxi-api/src/app.ts:136-144`. No request body.

- **`403`** `{ "error": "forbidden" }` if `sessionOwner[id]` exists and `!== userId`
  (`services/voxi-api/src/app.ts:140`).
- **`404`** `{ "error": "not_found" }` if no persisted row or `rec.ownerUserId !== userId`
  (`services/voxi-api/src/app.ts:142`).
- **`200`** `{ "threadId": string, "title": string, "continuationToken": string, "resumes": true }`
  (`services/voxi-api/src/app.ts:143`). This is the only route that exposes `continuationToken` to the client.

Both the in-memory ownership map AND the persisted row's `ownerUserId` are owner-checked (belt-and-suspenders,
`services/voxi-api/src/app.ts:139-142`). Client mirror `ThreadDetail` `app/src/lib/apiClient.ts:38-43`.

### 2.5 `GET /v1/threads/:id/stream` — proxy the eve NDJSON stream (see §3)

`services/voxi-api/src/app.ts:147-179`.

- **`403`** `{ "error": "forbidden" }` if `sessionOwner[id] !== userId` (`services/voxi-api/src/app.ts:150`).
  Note this is stricter than §2.4: a non-recorded id (`undefined !== userId`) is forbidden here.
- **`200`** body is `application/x-ndjson` (`services/voxi-api/src/app.ts:177`); one JSON event per line, `\n`
  terminated (`services/voxi-api/src/app.ts:171`).
- **`?startIndex=`** parsed as `Number(query.startIndex ?? 0)` and passed to `eve.stream(id, userId, startIndex)`
  (`services/voxi-api/src/app.ts:151-152`). See §4 for replay semantics.
- **Scan-refund tap** — while proxying, the BFF inspects each line; on the FIRST terminal `error` with
  `code === 'safety_refusal'` or `code === 'hard_failure'` it credits the scan back exactly once per thread,
  idempotent across reconnects (`services/voxi-api/src/app.ts:160-170`; §13/F9). Non-JSON lines pass through
  unchanged (`services/voxi-api/src/app.ts:167-169`).

ACL verified `services/voxi-api/src/app.test.ts:65-72` (user B → 403 on user A's thread).

### 2.5a `POST /v1/threads/:id/speech` — voice the reveal narration (spoken British voice)

`services/voxi-api/src/app.ts` (the `/v1/threads/:id/speech` handler). The narration text is **server-owned** —
read from `eve.narrationText(sessionId, userId)`, never supplied by the client — so the BFF cannot be coerced
into voicing arbitrary text (ANALYSIS-VOICE-PLAN B1).

- **`403`** `{ "error": "forbidden" }` if `sessionOwner[id]` is set and `!== userId` (belt); the strict layer is
  `eve.narrationText(id, userId)`, which returns null for a non-owner.
- **`503`** `{ "error": "speech_unconfigured" }` when no `speech` seam is wired (fail-loud, never a fake success).
- **`404`** `{ "error": "no_narration" }` when no server-owned narration was captured for the session.
- **`502`** `{ "error": "synthesis_failed" }` when the TTS provider throws.
- **`200`** body is `audio/mpeg` — the synthesized MP3. A content-hash cache (`speech.cache`, keyed by
  `sha256(narrationText)`) makes a stable narration synthesize **exactly once**, so autoplay + replay and a
  request loop collapse to a single paid vendor call (A10). Not metered (the spoken reveal is free).

ACL/route verified `services/voxi-api/src/app.test.ts` (`describe('BFF — spoken reveal …')`: 401/403/503/404/200 +
cache-one-synth). The idempotent server-owned capture is `services/voxi-api/src/narration-store.test.ts`.

### 2.6 `POST /v1/podcast` — gate paid generation (atomic + idempotent)

`services/voxi-api/src/app.ts:182-194`.

- **Request** `{ "catalogItemId": string, "version"?: number }` (`version` defaults to `1`,
  `services/voxi-api/src/app.ts:189`; `app/src/lib/apiClient.ts:44-47`).
- **`400`** `{ "error": "catalogItemId required" }`.
- **`402`** `{ "error": "insufficient_entitlement" }` when the atomic podcast decrement fails
  (`gatePodcastGeneration`→`tryDecrement('podcast',1)`, `services/voxi-api/src/metering.ts:47-61`).
- **`200`** `{ "token": string, "replay": boolean }`. Idempotency key = `<userId>:<catalogItemId>:v<version>`
  (`services/voxi-api/src/metering.ts:39-41`). A second call with the same `(item,user,version)` returns the SAME
  token and does NOT decrement again; `replay` is `true` exactly when `reason === 'idempotent_replay'`
  (`services/voxi-api/src/app.ts:193`; `services/voxi-api/src/metering.ts:53-54`). Token format
  `gen_<uuid>` (`services/voxi-api/src/app.ts:190`).

Verified `services/voxi-api/src/app.test.ts:74-83` (200+token, idempotent replay returns same token, then 402 out of
entitlement). Client mirror `PodcastGateResult` `app/src/lib/apiClient.ts:48-51`.

### 2.7 `GET /v1/podcast/:token` — poll render status (BFF never fabricates "ready")

`services/voxi-api/src/app.ts:198-204`. Owner-scoped: the worker status is queried as `status(token, userId)`.

- **`404`** `{ "error": "not_found" }` when no status (unknown token OR not the owner — the service returns `null`
  for a cross-owner read, `e2e/web/server.ts:114-122`).
- **`200`** `{ "state": "composing" | "ready" | "failed", "audioUrl"?: string }`
  (`services/voxi-api/src/app.ts:42-45`; client mirror `app/src/lib/apiClient.ts:52-55`).

### 2.8 `POST /v1/interview` — open the unknown-item interview (default PRIVATE)

`services/voxi-api/src/app.ts:208-217`.

- **Request** `{ "threadId": string, "visibility"?: "private" | "global" }`; `visibility` defaults to `"private"`
  (kb-02 — a global exemplar requires an explicit toggle, `services/voxi-api/src/app.ts:215`).
- **`400`** `{ "error": "threadId required" }`.
- **`403`** `{ "error": "forbidden" }` if `sessionOwner[threadId]` exists and `!== userId`
  (`services/voxi-api/src/app.ts:212-213`).
- **`503`** `{ "error": "unavailable" }` if `deps.interviews` is unset (`services/voxi-api/src/app.ts:214`).
- **`200`** `{ "interviewId": string, "visibility": "private"|"global",
  "questions": [ { "id": string, "prompt": string, "whyAsked": string } ] }`
  (`services/voxi-api/src/app.ts:61-66`; client mirror `app/src/lib/apiClient.ts:56-69`). Q-count is capped by the
  service (kb-01).

### 2.9 `POST /v1/interview/:id/answer` — answer or skip (answer:null = skip)

`services/voxi-api/src/app.ts:220-228`.

- **Request** `{ "questionId": string, "answer": string | null }` (`null` = skip,
  `services/voxi-api/src/app.ts:226`; `app/src/lib/apiClient.ts:70-73`).
- **`400`** `{ "error": "questionId required" }`.
- **`503`** `{ "error": "unavailable" }` if `deps.interviews` unset.
- **`200`** `{ "done": boolean }` (`services/voxi-api/src/app.ts:67`).

### 2.10 `POST /v1/tips` — submit a tip (server-side trust gate)

`services/voxi-api/src/app.ts:232-240`.

- **Request** `{ "catalogItemId": string, "text": string }`.
- **`400`** `{ "error": "catalogItemId and text required" }`.
- **`503`** `{ "error": "unavailable" }` if `deps.contributions` unset.
- **`200`** `{ "tipId": string, "status": "pending_review" | "live", "trustLevel": number }`. The disposition is
  driven by the SERVER trust level, never a client flag: TL0..1 → `pending_review`, TL2+ → `live`
  (`services/voxi-api/src/app.ts:230-239`; `e2e/web/server.ts:131-133`; client mirror
  `app/src/lib/apiClient.ts:74-82`).

### 2.11 `POST /v1/reports` — report a tip/episode (first report auto-hides)

`services/voxi-api/src/app.ts:243-250`.

- **Request** `{ "targetId": string, "kind": "tip" | "episode" }`.
- **`400`** `{ "error": "targetId and kind required" }`.
- **`503`** `{ "error": "unavailable" }` if `deps.contributions` unset.
- **`200`** `{ "autoHidden": boolean }` — first report auto-hides pending SLA review (kb-04/pod-04)
  (`services/voxi-api/src/app.ts:248`; `app/src/lib/apiClient.ts:83-89`).

### 2.12 `GET /v1/me` — subscription status + live entitlement counts

`services/voxi-api/src/app.ts:253-260`. No request body.

```jsonc
{ "userId": string,
  "plan": "free" | "explorer" | "voyager",   // planFor(userId) ?? "free"
  "remaining": { "scan": number, "podcast": number, "voiceMin": number } }
```

Counts are live from `store.remaining(userId, meter)` for `['scan','podcast','voiceMin']`
(`services/voxi-api/src/app.ts:256-258`; `services/voxi-api/src/metering.ts:13,28`; client mirror
`app/src/lib/apiClient.ts:90-94`). Status `200`.

### 2.13 `DELETE /v1/account` — Apple-required deletion cascade

`services/voxi-api/src/app.ts:263-266`. No request body. Response `{ "deleted": string[] }` from
`deletion.cascade(userId)` (`services/voxi-api/src/app.ts:19-21,264`; client mirror
`app/src/lib/apiClient.ts:95-97`). Status `200`. Spans photos/embeddings/sessions/contributions (verified
`services/voxi-api/src/app.test.ts:85-90`).

### 2.14 Route summary

| Method | Path | Auth | Success | Error statuses |
| --- | --- | --- | --- | --- |
| POST | `/v1/uploads/sign` | Clerk | 200 SignedUrl | 401 |
| POST | `/v1/threads` | Clerk | 200 `{threadId}` | 400, 401, 402 |
| GET | `/v1/threads` | Clerk | 200 `{threads[]}` | 401 |
| GET | `/v1/threads/:id` | Clerk + owner ACL | 200 ThreadDetail | 401, 403, 404 |
| GET | `/v1/threads/:id/stream` | Clerk + owner ACL | 200 NDJSON | 401, 403 |
| POST | `/v1/podcast` | Clerk | 200 `{token,replay}` | 400, 401, 402 |
| GET | `/v1/podcast/:token` | Clerk + owner-scoped | 200 PodcastStatus | 401, 404 |
| POST | `/v1/interview` | Clerk + owner ACL | 200 InterviewResult | 400, 401, 403, 503 |
| POST | `/v1/interview/:id/answer` | Clerk | 200 `{done}` | 400, 401, 503 |
| POST | `/v1/tips` | Clerk | 200 TipResult | 400, 401, 503 |
| POST | `/v1/reports` | Clerk | 200 `{autoHidden}` | 400, 401, 503 |
| GET | `/v1/me` | Clerk | 200 MeResult | 401 |
| DELETE | `/v1/account` | Clerk | 200 `{deleted[]}` | 401 |

---

## 3. NDJSON stream event taxonomy

Defined as a Zod `discriminatedUnion('type', …)` in `packages/shared/src/events.ts:11-25`. The client must handle
**exactly** this taxonomy; `parseEventLine` throws on any malformed/unknown event so the client never sees an
untyped event (`packages/shared/src/events.ts:29-32`; verified `packages/shared/src/events.test.ts:18-21`). Every
event carries `index: number` (the int the reconnection uses, §4).

| `type` | Payload (beyond `type`, `index`) | Source line |
| --- | --- | --- |
| `token` | `text: string` | `packages/shared/src/events.ts:12` |
| `tool_start` | `tool: string` | `packages/shared/src/events.ts:13` |
| `tool_result` | `tool: string`, `ok: boolean` | `packages/shared/src/events.ts:14` |
| `confidence_band` | `band: 'CONFIDENT'\|'PROBABLE'\|'UNKNOWN'`, `title: string`, `candidates: string[]` (default `[]`) | `packages/shared/src/events.ts:15-21` |
| `partial_id` | `title: string` | `packages/shared/src/events.ts:22` |
| `error` | `code: string`, `message: string` | `packages/shared/src/events.ts:23` |
| `done` | `sessionId: string` | `packages/shared/src/events.ts:24` |

`ConfidenceBand = enum(['CONFIDENT','PROBABLE','UNKNOWN'])` (`packages/shared/src/events.ts:9`).
`candidates` defaults to `[]` when omitted (verified `packages/shared/src/events.test.ts:28-31`).

Wire examples (real bytes the harness emits, `e2e/web/server.ts:45-82`):

```ndjson
{"type":"token","index":0,"text":"A 2008 Cannondale SuperSix EVO."}
{"type":"confidence_band","index":1,"band":"CONFIDENT","title":"2008 Cannondale SuperSix EVO","candidates":[]}
{"type":"done","index":2,"sessionId":"sess_qa_confident_0"}
```

```ndjson
{"type":"error","index":0,"code":"safety_refusal","message":"I keep to objects, not medicine. …"}
{"type":"done","index":1,"sessionId":"sess_qa_pill_0"}
```

### 3.1 `error.code` taxonomy (the two codes the BFF acts on)

The BFF refunds a scan only on these terminal error codes; any other `error.code` does NOT refund
(`services/voxi-api/src/app.ts:163`):

- `safety_refusal` — persona refused a regulated/medical identification; a confidence chip is NOT shown (distinct
  caution path). Refunds the scan (`e2e/web/server.ts:46-50`; `services/voxi-api/src/app.ts:163-166`).
- `hard_failure` — the agent lost the thread. Refunds the scan (`e2e/web/server.ts:52-56`).

`done.sessionId` echoes the streamed session id (`packages/shared/src/events.ts:24`; `e2e/web/server.ts:49,63,69,75,81`).

---

## 4. `?startIndex=` reconnection → event-index semantics

- Every event carries a monotonic `index` (`packages/shared/src/events.ts:12-24`).
- On reconnect the client passes the **last index it saw**; the helper computes the resume point:
  `nextStartIndex(null) → 0`, `nextStartIndex(last) → last + 1` (`packages/shared/src/events.ts:34-37`; verified
  `packages/shared/src/events.test.ts:23-26`).
- The client `streamThread` issues `GET …/stream?startIndex=<start>` with `start = opts.startIndex ?? 0`
  (`app/src/lib/apiClient.ts:217-225`).
- The BFF reads `Number(query.startIndex ?? 0)` and forwards it to `eve.stream(id, userId, startIndex)`
  (`services/voxi-api/src/app.ts:151-152`).
- The prod eve client requests `GET <EVE_FRONT_URL>/eve/v1/session/<sessionId>/stream?startIndex=<n>` (default `0`)
  with the user forwarded as the `x-voxi-user` header (`infra/docker/voxi-api/server.ts:59-63`). eve replays
  events from `index >= startIndex` — i.e. the stream resumes after the last index the client acknowledged, so a
  dropped connection replays only the unseen tail (PLAN §4.3; the §4.5 resume-smoke arms this:
  `infra/ci/resume-smoke.ts:43-45` "reconnect the stream at `?startIndex=<last>` … assert it reaches 'done'").
- The scan-refund tap is idempotent across reconnects: a thread already refunded is in `refundedThreads` and a
  replayed terminal error does not double-credit (`services/voxi-api/src/app.ts:91-92,160-170`).

---

## 5. sessionId ↔ continuationToken ↔ threads.eve_session_id mapping

Three ids name the same durable session at different layers:

| Name | Created / owned by | Meaning | Cite |
| --- | --- | --- | --- |
| `sessionId` | eve `createSession` returns it | the eve durable session/workflow id | `services/voxi-api/src/app.ts:14-16` |
| `threadId` | the BFF | **identical** to `sessionId` (`threadId: session.sessionId`) — the client-facing handle | `services/voxi-api/src/app.ts:122` |
| `continuationToken` | eve `createSession` returns it | durable resume token so a revisit resumes the SAME session (thread-03) | `services/voxi-api/src/app.ts:14-16,29-30` |
| `threads.eve_session_id` | Postgres (prod ACL store) | the `sessionId` persisted as the thread row's session key + owner | `services/eve-agent/agent/channels/eve.ts:58-65` |

Mapping invariants, from code:
- `1 photo = 1 thread = 1 eve session`: `POST /v1/threads` mints exactly one eve session and persists one
  `ThreadRecord{ threadId: sessionId, ownerUserId, title, createdAt, continuationToken }`
  (`services/voxi-api/src/app.ts:111-126,23-31`).
- `threadId === sessionId` everywhere (the BFF never re-keys; `services/voxi-api/src/app.ts:122`). So
  `GET /v1/threads/:id/stream` ACLs on `sessionOwner[id]` where `id` is both the thread and session id
  (`services/voxi-api/src/app.ts:147-150`).
- `continuationToken` is stored on the thread row (`services/voxi-api/src/app.ts:123`) and returned **only** by
  `GET /v1/threads/:id` (`services/voxi-api/src/app.ts:143`) so a revisit resumes the durable session — it is NOT
  in the list projection (`services/voxi-api/src/app.ts:132`). The E2E asserts the durable token survives reopen:
  `e2e/web/run-sc-conversation.web.ts:179-182`, `e2e/web/run-sc-threads.web.ts:224-229`.
- In prod the ACL store IS the `threads` table: `SessionOwnership` "backs it with Postgres
  (`threads.eve_session_id` + owner)"; tests/G3 use an in-memory map (`services/eve-agent/agent/channels/eve.ts:58-78`).

```
client threadId ─── identity ───▶ eve sessionId ─── persisted as ───▶ threads.eve_session_id (+ ownerUserId)
                                        │
                                        └─ continuationToken (durable resume) stored on the same thread row
```

---

## 6. BFF → eve FRONT — the proxied endpoints

The BFF reaches eve over private in-VPC HTTP at `$EVE_FRONT_URL` via the injected `EveClient`
(`infra/docker/voxi-api/server.ts:43-82`). The shapes:

### 6.1 Create session

```
POST <EVE_FRONT_URL>/eve/v1/session
content-type: application/json
{ "userId": string, "photoUrl": string }
→ 200 { "sessionId": string, "continuationToken": string }     // non-2xx => BFF throws
```
`infra/docker/voxi-api/server.ts:49-57`; interface `services/voxi-api/src/app.ts:14-16`.

### 6.2 Stream session (NDJSON)

```
GET <EVE_FRONT_URL>/eve/v1/session/<sessionId>/stream?startIndex=<n>      // n default 0
x-voxi-user: <userId>
→ 200 application/x-ndjson  (one §3 event per line)                       // non-2xx/no-body => throws
```
`infra/docker/voxi-api/server.ts:59-80`. The BFF re-emits these lines to the client unchanged except for the
refund tap (§2.5). eve enforces the ownership ACL again at this boundary
(`services/eve-agent/agent/channels/eve.ts:99-118`, kind `stream`).

### 6.3 Follow-up write-back (used by the voice-bot; §7)

```
POST /eve/v1/session/:id        // eve is the SINGLE WRITER of finalized turns
```
`services/voice-bot/voxi_voice/bff_bridge.py:11-14`; PLAN §6.3 (`docs/PLAN.md:277-280`).

---

## 7. voice-bot → eve bridge (`services/voice-bot/`)

Two responsibilities, both auth'd by a per-session **scoped token** the BFF mints; the bot never holds a broad
credential (`services/voice-bot/voxi_voice/bff_bridge.py:3-17`). The transport to the BFF is the `BffTransport`
Protocol so it is testable with no network (`services/voice-bot/voxi_voice/bff_bridge.py:49-56`).

### 7.1 Per-session scoped token

```python
# services/voice-bot/voxi_voice/bff_bridge.py:29-35
@dataclass(frozen=True)
class ScopedToken:
    value: str        # the opaque bearer the BFF minted
    user_id: str      # binds the bot's calls to one user …
    session_id: str   # … and one session (cross-session denied)
```
Presented as the bearer on every bridge call; it "carries the same userId↔sessionId ACL as every other surface"
(`services/voice-bot/voxi_voice/bff_bridge.py:6-9`, PLAN §6.3 `docs/PLAN.md:274-276`).

### 7.2 Tool bridge (live LLM tools through the BFF)

`ToolBridge.call(tool, args)` routes the live LLM's tool calls through the BFF with the scoped token — never a
direct eve credential (`services/voice-bot/voxi_voice/bff_bridge.py:119-127`).

```python
# BffTransport.call_tool — services/voice-bot/voxi_voice/bff_bridge.py:52
async def call_tool(self, token: ScopedToken, tool: str, args: dict) -> dict
# result envelope (fake/contract): { "ok": bool, "tool": str, "result": Any }
```
(`services/voice-bot/voxi_voice/bff_bridge.py:75-77`). The BFF re-checks the ACL and proxies the tool to eve.
Verified `services/voice-bot/tests/test_bridge_and_persona.py:38-45`.

### 7.3 Transcript write-back (eve single writer) + per-turn idempotency key

Finalized turns are appended via the eve session follow-up endpoint `POST /eve/v1/session/:id`. eve stays the
single writer — no dual-write to `app.messages` (`services/voice-bot/voxi_voice/bff_bridge.py:11-14`).

```python
# BffTransport.append_turn — services/voice-bot/voxi_voice/bff_bridge.py:54-56
async def append_turn(self, token: ScopedToken, session_id: str,
                      idempotency_key: str, turn: dict) -> dict
```

`TranscriptWriter.write_turn(turn_index, turn)` builds the payload and key
(`services/voice-bot/voxi_voice/bff_bridge.py:108-116`):

```python
payload = { "turn_index": int, "role": str, "text": str, "interrupted": bool }
```

**Per-turn idempotency key** (`services/voice-bot/voxi_voice/bff_bridge.py:38-46`):
```
turn_idempotency_key(session_id, turn_index, role, text)
 = f"{session_id}:t{turn_index}:{role}:{sha256(f'{role}\n{text}')[:16]}"
```
- Deterministic: same `(session_id, index, role, text)` → same key (verified
  `services/voice-bot/tests/test_bridge_and_persona.py:49-57`).
- Content-sensitive: different text or different index → different key (so a genuine new turn is never mistaken for
  a replay; defensive content hash guards an index reused with different content).

**Idempotency / dedup contract** the real eve endpoint MUST hold (modeled by `FakeBff`,
`services/voice-bot/voxi_voice/bff_bridge.py:59-91`):
- **Cross-session ACL** — if `token.session_id != session_id`: NOT written, returns
  `{ "ok": false, "reason": "cross_session_denied" }` (`bff_bridge.py:82-85`). A token minted for session A cannot
  write to session B.
- **Replay** — if `idempotency_key` already seen: acknowledged but NOT re-appended →
  `{ "ok": true, "duplicate": true, "idempotency_key": <key> }` (`bff_bridge.py:86-88`). A reconnect that replays
  the tail creates no duplicate turn (TEST-PLAN conv-06).
- **First write** — `{ "ok": true, "duplicate": false, "idempotency_key": <key> }`; the turn is appended to the
  canonical log a reopened thread replays (`bff_bridge.py:89-91`).

**Barge-in honesty** — an interrupted (barge-in) turn IS written, flagged `interrupted: true`
(committed-as-interrupted), never as a complete turn; the partial assistant generation is cancelled/discarded with
only what was actually spoken (`services/voice-bot/voxi_voice/bff_bridge.py:94-101`;
`services/voice-bot/voxi_voice/pipeline.py:141-165,186-189`). Verified
`services/voice-bot/tests/test_bridge_and_persona.py:60-69`.

**Turn index is monotonic across the session AND reconnects** — the writer increments per committed turn; on
reconnect a fresh pipeline is built against the SAME `TranscriptWriter` so write-back stays idempotent
(`services/voice-bot/voxi_voice/pipeline.py:50-55,186-189`).

### 7.4 Voice-minute metering (bot is the live enforcement point)

The BFF owns the entitlement ledger (`voiceMin`, §2.12; `services/voice-bot/voxi_voice/metering.py:6-7`); the bot
enforces the per-session minute cap: soft warnings at 80%/90% (fired at most once each), short grace to finish the
current turn, then a latched HARD-CUTOFF that fail-closes every subsequent tick
(`services/voice-bot/voxi_voice/metering.py:20-103`). The cap is never extended — grace is only for audio already
in flight (`services/voice-bot/voxi_voice/metering.py:42-54,81-93`; PLAN §6.4 `docs/PLAN.md:285-289`).

---

## 8. What is a documented seam vs. live code (honesty, PLAN §22.3)

- **Live + tested here (no creds):** all BFF routes + auth + signing + metering (`services/voxi-api/src/*`,
  verified `services/voxi-api/src/app.test.ts`); the NDJSON event contract + reconnection helper
  (`packages/shared/src/events.ts`, verified `packages/shared/src/events.test.ts`); the voice-bot bridge,
  idempotency keying, transcript write-back, metering (`services/voice-bot/voxi_voice/*`, verified
  `services/voice-bot/tests/`); the full BFF served against a real eve-stream fake in the E2E harness
  (`e2e/web/server.ts`).
- **Documented integration seams (cred/toolchain-gated, fail loud not green):** the real `@clerk/backend`
  `verifyToken` (`infra/docker/voxi-api/server.ts:34-39`); the live `EveClient` HTTP calls to `$EVE_FRONT_URL`
  (`infra/docker/voxi-api/server.ts:46-82`); the Cloud SQL `Store` and `deletion.cascade`
  (`infra/docker/voxi-api/server.ts:86,88-93`); the eve runtime bind (`services/eve-agent/agent/agent.ts:96-129`);
  the §4.5 resume-smoke (`infra/ci/resume-smoke.ts`). None fabricate a green.
</content>
</invoke>
