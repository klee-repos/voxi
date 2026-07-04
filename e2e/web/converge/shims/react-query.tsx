/**
 * @tanstack/react-query web shim for the converge scope ONLY.
 *
 * app/app/(tabs)/threads.tsx loads its collection with TanStack Query's `useQuery` (queryKey ['threads'],
 * queryFn = api.listThreads). Under the real Expo build the full @tanstack/react-query package is resolved by
 * Metro from app/node_modules; the converge scope deliberately owns a minimal node_modules (it is NOT a
 * workspace member and we must not `bun add`), so we provide a tiny, behaviourally-faithful shim of the EXACT
 * surface threads.tsx consumes — `QueryClient`, `QueryClientProvider`, and `useQuery` returning
 * `{ data, isLoading, isError, error, refetch, isFetching }`.
 *
 * This is the SAME substitution Metro performs (resolve the import to the real package) reduced to the methods
 * the screen actually calls; it renders the real screen's loading → populated/empty/error states off the real
 * BFF response, and does NOT edit threads.tsx. The query lifecycle here is faithful: mount fires the queryFn,
 * a thrown error sets isError/error, refetch re-runs it — AND `useQueryClient().invalidateQueries({ queryKey })`
 * re-runs every active query whose key matches (a module-level registry mirrors TanStack's cache invalidation),
 * which is how a new capture appears in Recently catalogued / the Collection without a remount.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

// Active-query registry (key → set of refetchers), so invalidateQueries can re-run matching mounted queries —
// the faithful analogue of TanStack invalidating a cache entry and refetching its active observers.
const registry = new Map<string, Set<() => void>>()
// Cache + observer registry for setQueryData: a successful fetch seeds the cache, setQueryData reads `old` off
// it, computes `next`, stores it, and pushes `next` to every active observer (which setData → re-render). This is
// the faithful analogue of TanStack's optimistic cache write notifying active observers WITHOUT a refetch — the
// exact mechanism the single + bulk delete use to drop tiles instantly before the invalidate refetch reconciles.
const cache = new Map<string, unknown>()
const observers = new Map<string, Set<(data: unknown) => void>>()
const keyOf = (queryKey: unknown[]): string => JSON.stringify(queryKey)
function invalidate(queryKey: unknown[]): Promise<void> {
  registry.get(keyOf(queryKey))?.forEach((refetch) => refetch())
  return Promise.resolve()
}

export class QueryClient {
  // The real client caches; the screen never reads the cache directly, so an empty marker object suffices.
  constructor(_opts?: unknown) {}
  invalidateQueries(opts: { queryKey: unknown[] }): Promise<void> {
    return invalidate(opts.queryKey)
  }
  setQueryData<T>(queryKey: unknown[], updater: T | ((old: T | undefined) => T)): void {
    const k = keyOf(queryKey)
    const old = cache.get(k) as T | undefined
    const next = typeof updater === 'function' ? (updater as (o: T | undefined) => T)(old) : updater
    cache.set(k, next)
    observers.get(k)?.forEach((fn) => fn(next))
  }
  removeQueries(opts: { queryKey: unknown[]; exact?: boolean }): void {
    // Minimal faithful analogue: drop the cache entry. (The deepDiveReady queries removed on bulk delete are not
    // mounted on the collection screen, so there are no active observers to reset.)
    cache.delete(keyOf(opts.queryKey))
  }
}

const Ctx = createContext<QueryClient | null>(null)
const defaultClient = new QueryClient()

/** Mirrors TanStack's `useQueryClient` — returns the provided client (or a default); both hit the shared registry. */
export function useQueryClient(): QueryClient {
  return useContext(Ctx) ?? defaultClient
}

export function QueryClientProvider({
  client,
  children,
}: {
  client: QueryClient
  children: React.ReactNode
}): React.ReactElement {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}

export interface UseQueryResult<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
  isFetching: boolean
  refetch: () => Promise<void>
}

export function useQuery<T>({
  queryKey,
  queryFn,
}: {
  queryKey: unknown[]
  queryFn: () => Promise<T>
}): UseQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(true)
  const mounted = useRef(true)
  const fnRef = useRef(queryFn)
  fnRef.current = queryFn
  const k = keyOf(queryKey)

  async function run(first: boolean): Promise<void> {
    setIsFetching(true)
    if (first) setIsLoading(true)
    try {
      const res = await fnRef.current()
      if (!mounted.current) return
      cache.set(k, res) // seed the cache so a later setQueryData updater sees the real `old`
      setData(res)
      setError(undefined)
    } catch (e) {
      if (!mounted.current) return
      setError(e)
    } finally {
      if (mounted.current) {
        setIsLoading(false)
        setIsFetching(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    void run(true)
    // Register this active query so invalidateQueries({ queryKey: k }) can re-run it (TanStack cache-observer parity).
    const refetch = (): void => void run(false)
    // Register an observer so setQueryData({ queryKey: k }) pushes the optimistic next value into React state
    // (TanStack notifies active observers on a cache write — the optimistic-disappear mechanism).
    const observer = (next: unknown): void => {
      if (mounted.current) setData(next as T | undefined)
    }
    let set = registry.get(k)
    if (!set) {
      set = new Set()
      registry.set(k, set)
    }
    set.add(refetch)
    let obs = observers.get(k)
    if (!obs) {
      obs = new Set()
      observers.set(k, obs)
    }
    obs.add(observer)
    return () => {
      mounted.current = false
      set!.delete(refetch)
      obs!.delete(observer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k])

  return { data, isLoading, isError: error !== undefined, error, isFetching, refetch: () => run(false) }
}
