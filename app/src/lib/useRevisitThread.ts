/**
 * useRevisitThread — the ONE revisit action, shared by the Collection grid (`threads.tsx`) and the camera-home
 * "Recently catalogued" carousel (`RecentCard.tsx`). Revisiting a durable capture resumes its eve session:
 *
 *   openThread(item)
 *     → startCapture(item.photoUrl ?? null)   // reset prior scan state + SEED the durable photo so the reveal
 *                                             //   shows the image immediately (content is re-derived by replay)
 *     → setThread(item.threadId)              // point the store at the durable thread
 *     → router.push('/processing')            // /processing STREAMS → the BFF REPLAYS the persisted reveal
 *
 * Before this hook, `threads.tsx` seeded the photo but the camera-home tray did NOT (it did `reset()` +
 * `setThread()` only), so a revisit from the tray landed on a blank reveal. Extracting the action guarantees the
 * two surfaces can never diverge again — the lost-photo bug is fixed in exactly one place.
 */
import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useCaptureStore } from '../state/captureStore'
import { revisitThread } from './revisitThread'
import type { ThreadSummary } from './apiClient'

export { revisitThread } from './revisitThread'
export type { RevisitDeps } from './revisitThread'

/** Hook wrapper: wires the pure `revisitThread` core to the live store setters + expo-router. */
export function useRevisitThread(): (item: ThreadSummary) => void {
  const router = useRouter()
  const startCapture = useCaptureStore((s) => s.startCapture)
  const setThread = useCaptureStore((s) => s.setThread)

  return useCallback(
    (item: ThreadSummary) => revisitThread(item, { startCapture, setThread, push: (href) => router.push(href) }),
    [router, startCapture, setThread],
  )
}
