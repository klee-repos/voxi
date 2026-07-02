/**
 * Shared TanStack Query keys — one source of truth so a key can never silently drift between the query site and
 * its invalidation. `threadsKey` is the owner-scoped collection (`GET /v1/threads`): read by the camera-home
 * recent carousel AND the Collection grid, and invalidated after a new capture so the newest thread appears
 * without a remount (the camera is a persistent tab — a bare `staleTime` never refetches it).
 */
export const threadsKey = ['threads'] as const
