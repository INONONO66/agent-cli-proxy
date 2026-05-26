import { useEffect, useRef, useState } from "react";
import type { OAuthJobEvent } from "../api";

interface SSEState {
  events: OAuthJobEvent[];
  connected: boolean;
  error: string | null;
}

export function useSSE(url: string): SSEState {
  const [events, setEvents] = useState<OAuthJobEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;

    function connect() {
      if (esRef.current) {
        esRef.current.close();
      }

      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        if (!mounted) return;
        setConnected(true);
        setError(null);
      };

      es.addEventListener("started", (e) => {
        if (!mounted) return;
        const data = parseEvent(e);
        if (data) setEvents((prev) => [...prev, data]);
      });

      es.addEventListener("url", (e) => {
        if (!mounted) return;
        const data = parseEvent(e);
        if (data) setEvents((prev) => [...prev, data]);
      });

      es.addEventListener("done", (e) => {
        if (!mounted) return;
        const data = parseEvent(e);
        if (data) setEvents((prev) => [...prev, data]);
        es.close();
      });

      es.addEventListener("error", (e: Event) => {
        if (!mounted) return;
        const data = parseEvent(e as MessageEvent);
        if (data) setEvents((prev) => [...prev, data]);
        es.close();
      });

      es.addEventListener("cancelled", (e) => {
        if (!mounted) return;
        const data = parseEvent(e);
        if (data) setEvents((prev) => [...prev, data]);
        es.close();
      });

      es.onerror = () => {
        if (!mounted) return;
        setConnected(false);
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(() => {
          if (mounted) connect();
        }, 3000);
      };
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [url]);

  return { events, connected, error };
}

function parseEvent(e: MessageEvent): OAuthJobEvent | null {
  try {
    return JSON.parse(e.data) as OAuthJobEvent;
  } catch {
    return null;
  }
}
