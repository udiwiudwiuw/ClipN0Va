"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client";

/** Haalt data op en ververst elke `intervalMs` (0 = niet). */
export function usePoll<T>(url: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;

  const reload = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const d = await api<T>(urlRef.current);
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    return () => clearInterval(t);
  }, [url, intervalMs, reload]);

  return { data, error, loading, reload, setData };
}
