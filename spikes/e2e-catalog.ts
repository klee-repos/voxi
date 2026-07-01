/**
 * E2E of the Stage-3 catalog "moat" against REAL infra (no fakes forcing green):
 *   real Vertex multimodalembedding@001  →  a real PGlite Catalog  →  the visibility ACL.
 *
 * Proves, on the real Canon AE-1 fixture:
 *   1. the live embedder returns a 1408-dim image vector,
 *   2. after upserting it as user A's PRIVATE item, searching with the SAME embedding returns it as the TOP hit
 *      at a small distance (nearest-neighbour works on real vectors),
 *   3. a DIFFERENT user does NOT see A's private entry (the security-critical ACL, enforced in SQL).
 *   4. file-backed persistence: the item survives closing and re-opening the catalog from the same dataDir.
 *
 * Run from repo root (so .env.local loads for the GCP project): `bun spikes/e2e-catalog.ts`.
 */
import { Catalog } from '../packages/db/catalog'
import { VertexEmbeddingProvider, EMBED_DIM } from '../services/eve-agent/agent/lib/embedding'
import { loadImageBytes } from '../services/eve-agent/agent/lib/gcp-vision'

const FIXTURE = new URL('./.fixtures/canon-ae1.jpg', import.meta.url).pathname
const USER_A = 'user_catalog_e2e_A'
const USER_B = 'user_catalog_e2e_B'

const check = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  return cond
}

console.log('\n── E2E: real Vertex embedding → real PGlite catalog → ACL ──')

// 1) Real multimodal embedding of the real fixture.
const { b64 } = await loadImageBytes(FIXTURE)
const embedder = new VertexEmbeddingProvider()
const emb = await embedder.embedImage(b64)
const dimOk = check(emb.length === EMBED_DIM, `embedding is ${EMBED_DIM}-dim (got ${emb.length})`)
const numeric = emb.every((x) => typeof x === 'number' && Number.isFinite(x))
const numericOk = check(numeric, 'embedding is all finite numbers')

// A second, unrelated vector to prove ranking discriminates (orthogonal-ish random unit-ish vector).
const other = Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1)

// 2) File-backed catalog (persists) — proves the new optional dataDir path works too.
const dataDir = `/tmp/voxi-catalog-e2e-${Date.now()}`
let cat = await Catalog.create(EMBED_DIM, dataDir)

// A far global item + A's private item (the fixture).
await cat.upsert({ id: 'global_decoy', name: 'A kettle', ownerUserId: null, visibility: 'global', embedding: other })
await cat.upsert({ id: 'canon_ae-1', name: '1976 Canon AE-1', ownerUserId: USER_A, visibility: 'private', embedding: emb })

// 3) A searches with the SAME embedding → the fixture is the top hit at ~0 distance.
const aHits = await cat.searchPartitioned(emb, USER_A, 3)
const topA = aHits[0]
const topOk = check(topA?.id === 'canon_ae-1', `user A top hit is the fixture (got "${topA?.id}")`)
const distOk = check((topA?.dist ?? 1) < 0.02, `top-hit distance is tiny (${topA?.dist?.toFixed(6)} < 0.02)`)

// 4) ACL: user B must NOT see A's private entry.
const bHits = await cat.searchPartitioned(emb, USER_B, 10)
const bIds = bHits.map((h) => h.id)
const aclOk = check(!bIds.includes('canon_ae-1'), `user B does NOT see A's private item (B sees: [${bIds.join(', ')}])`)

// 5) Persistence: close and re-open the SAME dataDir → A's item is still there.
await cat.close()
cat = await Catalog.create(EMBED_DIM, dataDir)
const reHits = await cat.searchPartitioned(emb, USER_A, 1)
const persistOk = check(reHits[0]?.id === 'canon_ae-1', `item survived close+reopen of the file-backed catalog`)
await cat.close()

const pass = dimOk && numericOk && topOk && distOk && aclOk && persistOk
console.log('\n' + (pass ? '✓ PASS' : '✗ FAIL') + ' — catalog moat: real embedding + ranking + ACL + persistence')
console.log(`   dim:${emb.length} · topHit:"${topA?.id}"@${topA?.dist?.toFixed(6)} · B-sees-A-private:${bIds.includes('canon_ae-1')} · persisted:${persistOk}`)
process.exit(pass ? 0 : 1)
