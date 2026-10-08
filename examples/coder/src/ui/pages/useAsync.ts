import { useEffect, useState } from 'react'

/** Result of {@link useAsync}. */
export type Async<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string }

/** Run `load` once on mount (a page opens, loads its data, and shows it). */
export function useAsync<T>(load: () => Promise<T>): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' })
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    load().then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data })
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
