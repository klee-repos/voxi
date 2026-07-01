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
 * a thrown error sets isError/error, refetch re-runs it — which is all the screen's state matrix branches on.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

export class QueryClient {
  // The real client caches; the screen never reads the cache directly, so an empty marker object suffices.
  constructor(_opts?: unknown) {}
}

const Ctx = createContext<QueryClient | null>(null)

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

  async function run(first: boolean): Promise<void> {
    setIsFetching(true)
    if (first) setIsLoading(true)
    try {
      const res = await fnRef.current()
      if (!mounted.current) return
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
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, isLoading, isError: error !== undefined, error, isFetching, refetch: () => run(false) }
}
