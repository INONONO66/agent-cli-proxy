import { useCallback, useEffect, useRef, useState } from "react";

interface PollingState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface PollingResult<T> extends PollingState<T> {
  refresh: () => void;
}

export function usePolling<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
): PollingResult<T> {
  const [state, setState] = useState<PollingState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: prev.data === null, error: null }));
    try {
      const data = await fetchFn();
      if (!mountedRef.current) return;
      setState({ data, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, loading: false, error: message }));
    }
  }, [fetchFn]);

  const refresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchData();
    intervalRef.current = setInterval(() => {
      void fetchData();
    }, intervalMs);
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, intervalMs]);

  return { ...state, refresh };
}
