import { useEffect, useState } from 'react';

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads once per `key`, ignoring replies that a newer key has replaced. Passing a null loader means
 * there is nothing to load yet. Callers keep `load` stable with useCallback.
 */
export function useLoad<T>(load: (() => Promise<T>) | null, key: unknown): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ data: null, loading: load !== null, error: null });

  useEffect(() => {
    if (!load) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let current = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    load().then(
      (data) => {
        if (current) setState({ data, loading: false, error: null });
      },
      (cause: unknown) => {
        if (!current) return;
        const error = cause instanceof Error ? cause.message : 'Request failed.';
        setState({ data: null, loading: false, error });
      },
    );
    return () => {
      current = false;
    };
  }, [load, key]);

  return state;
}
