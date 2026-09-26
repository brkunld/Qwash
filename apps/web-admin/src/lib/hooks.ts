'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './errors';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

interface Snapshot<T> {
  /** Bu sonucun hangi `deps` anahtari icin yuklendigi. */
  key: string;
  data: T | null;
  error: string | null;
}

/**
 * Bir veriyi yukler; `pollMs` verilirse aralikla tazeler (sekme gizliyken durur).
 * `deps` degisince (or. secili istasyon) onceki sonuc gosterilmez, `loading` olur.
 * Tazeleme hatasi eski veriyi silmez, yalniz hata gosterir. Eski anahtarin gec gelen
 * yaniti yenisinin uzerine yazilmaz.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number): Loaded<T> {
  const key = JSON.stringify(deps);
  const [snap, setSnap] = useState<Snapshot<T> | null>(null);
  const loadRef = useRef(load);
  const keyRef = useRef(key);

  useEffect(() => {
    loadRef.current = load;
    keyRef.current = key;
  });

  const reload = useCallback(async () => {
    const requested = keyRef.current;
    try {
      const data = await loadRef.current();
      if (keyRef.current === requested) setSnap({ key: requested, data, error: null });
    } catch (e) {
      if (keyRef.current !== requested) return;
      setSnap((prev) => ({
        key: requested,
        data: prev?.key === requested ? prev.data : null,
        error: errorMessage(e),
      }));
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, pollMs);
    return () => clearInterval(timer);
  }, [reload, pollMs, key]);

  const current = snap?.key === key ? snap : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: current === null,
    reload,
  };
}

/** Bir eylemi calistirir; ust uste tiklamayi engeller, hatayi mesaja cevirir. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

/** Su anki zaman; `everyMs`'te bir guncellenir (render sirasinda Date.now() cagirmamak icin). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
