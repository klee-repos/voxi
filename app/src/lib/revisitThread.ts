/**
 * Pure revisit core — the ONE action both the Collection grid (`threads.tsx`) and the camera-home recent carousel
 * (`RecentCard`) run to resume a durable capture. Kept in its OWN module (no `react`/`expo-router` imports, only a
 * type import) so the lost-photo regression is unit-testable without a component renderer or the RN runtime.
 *
 *   revisitThread(item)
 *     → startCapture(item.photoUrl ?? null)   // SEED the durable photo (the bug: the tray reset() WITHOUT this →
 *                                             //   a blank reveal on revisit). null for older/no-capture threads.
 *     → setThread(item.threadId)              // point the store at the durable thread
 *     → push('/processing')                   // /processing STREAMS → the BFF REPLAYS the persisted reveal
 */
import type { ThreadSummary } from './apiClient'

/** The injectable seams the revisit action drives (store setters + router push). `push` is narrowed to the one
 *  route this action navigates to so the expo-router `Href` type is satisfied without a cast. */
export interface RevisitDeps {
  startCapture: (photoUri: string | null) => void
  setThread: (threadId: string) => void
  push: (href: '/processing') => void
}

export function revisitThread(item: ThreadSummary, deps: RevisitDeps): void {
  deps.startCapture(item.photoUrl ?? null)
  deps.setThread(item.threadId)
  deps.push('/processing')
}
