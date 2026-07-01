/**
 * Vertex multimodal image embedding (PLAN §5.3 Stage-3 "moat"), authed via the gcloud CLI — same bearer-token
 * model as gcp-vision.ts (no ADC, no SA key). This turns a captured image into the 1408-dim vector the catalog
 * (`packages/db` Catalog / pgvector `vector(1408)`) ranks against, so a prior scan of the same specific object
 * can short-circuit the paid web-grounding stage.
 *
 * Model: publishers/google/models/multimodalembedding@001 → `predictions[0].imageEmbedding` is a length-1408
 * float array. Errors THROW (a seam that fails loudly): the host wiring guards the call in try/catch so an
 * embedding/catalog failure degrades to vlm+web-only, never to a fake success.
 */
import { gcloudToken } from './gcp-vision'

const PROJECT = process.env.GCP_PROJECT ?? 'eighth-duality-354701'
const LOCATION = process.env.GCP_LOCATION ?? 'us-central1'
const EMBED_MODEL = process.env.VERTEX_EMBED_MODEL ?? 'multimodalembedding@001'

/** multimodalembedding@001 returns a 1408-dim image vector. */
export const EMBED_DIM = 1408

export interface EmbeddingProvider {
  /** image bytes (base64, no data: prefix) → a 1408-dim embedding. Throws on any transport/API error. */
  embedImage(b64: string): Promise<number[]>
}

/**
 * Live Vertex multimodalembedding@001 provider. Endpoint:
 *   POST https://{loc}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{loc}/publishers/google/models/
 *        multimodalembedding@001:predict
 *   body { instances: [{ image: { bytesBase64Encoded: "<b64>" } }] }
 *   → response.predictions[0].imageEmbedding : number[1408]
 */
export class VertexEmbeddingProvider implements EmbeddingProvider {
  async embedImage(b64: string): Promise<number[]> {
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${EMBED_MODEL}:predict`
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${gcloudToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [{ image: { bytesBase64Encoded: b64 } }] }),
    })
    const j = (await r.json()) as { predictions?: { imageEmbedding?: number[] }[] }
    if (!r.ok) throw new Error('multimodalembedding: ' + JSON.stringify(j).slice(0, 300))
    const emb = j.predictions?.[0]?.imageEmbedding
    if (!Array.isArray(emb) || emb.length !== EMBED_DIM) {
      throw new Error(`multimodalembedding: expected ${EMBED_DIM}-dim vector, got ${Array.isArray(emb) ? emb.length : typeof emb}`)
    }
    return emb
  }
}
