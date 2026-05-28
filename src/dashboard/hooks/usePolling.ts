import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "../api";

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
  const stoppedRef = useRef(false);
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const stopPolling = useCallback(() => {
    stoppedRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const fetchData = useCallback(async () => {
    if (stoppedRef.current) return;
    setState((prev) => ({ ...prev, loading: prev.data === null, error: null }));
    try {
      const data = await fetchFnRef.current();
      if (!mountedRef.current) return;
      setState({ data, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof AuthError) {
        stopPolling();
        setState((prev) => ({ ...prev, loading: false, error: "unauthorized" }));
        window.dispatchEvent(new CustomEvent("auth:expired"));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, loading: false, error: message }));
    }
  }, [stopPolling]);

  const refresh = useCallback(() => {
    stoppedRef.current = false;
    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        void fetchData();
      }, intervalMs);
    }
    void fetchData();
  }, [fetchData, intervalMs]);

  useEffect(() => {
    mountedRef.current = true;
    stoppedRef.current = false;
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
