/**
 * useRevisitThread — the ONE revisit action, shared by the Collection grid (`threads.tsx`) and the camera-home
 * "Recently catalogued" carousel (`RecentCard.tsx`). Resumes a durable capture's eve session:
 *
 *   startCapture(item.photoUrl ?? null)   // reset scan state + SEED the durable photo so the reveal shows the
 *                                         //   image immediately (content is re-derived by replay)
 *   setThread(item.threadId)              // point the store at the durable thread
 *   push('/processing')                   // /processing STREAMS → the BFF REPLAYS the persisted reveal
 *
 * One action for both surfaces so they can't diverge (the fix for a revisit landing on a blank reveal).
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
  const markRevisit = useCaptureStore((s) => s.markRevisit)
  const setBand = useCaptureStore((s) => s.setBand)

  return useCallback(
    (item: ThreadSummary) => revisitThread(item, { startCapture, setThread, markRevisit, setBand, push: (href) => router.push(href) }),
    [router, startCapture, setThread, markRevisit, setBand],
  )
}
