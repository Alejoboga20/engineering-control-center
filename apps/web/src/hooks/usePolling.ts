import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Polls a loader. Keeps the last good data through failures, and ignores out-of-order replies. */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++latestRequest.current;
    try {
      const result = await load();
      if (id !== latestRequest.current) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (id !== latestRequest.current) return;
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      if (id === latestRequest.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      clearInterval(timer);
      // Invalidates replies still in flight. This ref is a counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latestRequest.current++;
    };
  }, [refresh, intervalMs]);

  return { data, loading, error, refresh };
}
