'use client';

import { SOCKET_EVENTS, type SessionView } from '@qwash/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getFreshAccessToken, refreshSession, SOCKET_URL } from './api';

export type Connection = 'connecting' | 'live' | 'offline';

const TERMINAL = new Set<SessionView['status']>(['COMPLETED', 'FAILED']);
/** Soket yokken durum bu aralikla REST'ten okunur (yedek yol). */
const FALLBACK_POLL_MS = 5_000;

export function isTerminal(view: SessionView | null): boolean {
  return view !== null && TERMINAL.has(view.status);
}

/**
 * Tek bir seansin canli durumu (ADR-0008, ARCHITECTURE.md 6).
 *
 * Kaynaklar: ilk REST okumasi, Socket.IO session.updated, session.resync / yeniden
 * baglanma / sekmenin one gelmesi sonrasi REST, soket yokken 5 sn'lik yoklama.
 * Bu kaynaklar birbirini gecebilir; daha eski serverTime'li gorunum yenisinin uzerine
 * yazilmaz. Geri sayim icin sunucu-istemci saat farki (offsetMs) serverTime'dan cikarilir.
 */
export function useLiveSession(sessionId: string): {
  view: SessionView | null;
  connection: Connection;
  offsetMs: number;
  error: unknown;
  reload: () => void;
} {
  const [view, setView] = useState<SessionView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [offsetMs, setOffsetMs] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef<SessionView | null>(null);

  const accept = useCallback((next: SessionView) => {
    const cur = latest.current;
    if (cur && Date.parse(next.serverTime) < Date.parse(cur.serverTime)) return;
    latest.current = next;
    setView(next);
    setOffsetMs(Date.parse(next.serverTime) - Date.now());
  }, []);

  const reload = useCallback(() => {
    api<SessionView>(`/sessions/${sessionId}`)
      .then((v) => {
        setError(null);
        accept(v);
      })
      .catch((e: unknown) => setError(e));
  }, [sessionId, accept]);

  useEffect(() => {
    latest.current = null;
    reload();

    let socket: Socket | null = null;
    let disposed = false;
    let authRetried = false;

    socket = io(SOCKET_URL, {
      transports: ['websocket'],
      // Her (yeniden) baglanmada guncel token istenir; suresi dolan token yenilenir.
      auth: (cb) => {
        void getFreshAccessToken().then((token) => cb({ token }));
      },
    });

    socket.on('connect', () => {
      authRetried = false;
      setConnection('live');
      // Kopukken kacan olaylar olabilir.
      reload();
    });
    socket.on('disconnect', () => setConnection('offline'));
    socket.on('connect_error', () => setConnection('offline'));
    socket.on(SOCKET_EVENTS.SESSION_UPDATED, (v: SessionView) => {
      if (v.sessionId === sessionId) accept(v);
    });
    socket.on(SOCKET_EVENTS.RESYNC, reload);
    // Sunucu token'i reddetti ve baglantiyi kapatti (sunucu kapatinca istemci kendiliginden
    // yeniden baglanmaz). Bir kez yenileyip tekrar dene; yine reddedilirse yoklamaya kal.
    socket.on(SOCKET_EVENTS.AUTH_ERROR, () => {
      if (authRetried) return;
      authRetried = true;
      void refreshSession().then((ok) => {
        if (ok && !disposed) socket?.connect();
      });
    });

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Telefon uyuyunca soket sessizce olebilir; one gelince durumu hemen tazele.
      reload();
      if (socket && !socket.connected) socket.connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = null;
    };
  }, [sessionId, reload, accept]);

  // Yedek yoklama: soket canli degilken ve seans bitmemisken.
  useEffect(() => {
    if (connection === 'live' || isTerminal(view)) return;
    const t = setInterval(reload, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [connection, view, reload]);

  return { view, connection, offsetMs, error, reload };
}

/** Kalan saniye; seans baslamadiysa null. Her saniye yeniden hesaplanir. */
export function useRemainingSeconds(view: SessionView | null, offsetMs: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  const running = view?.status === 'RUNNING' && view.startedAt !== null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  if (!view?.startedAt) return null;
  const endMs = Date.parse(view.startedAt) + view.plannedDurationSec * 1000;
  return Math.max(0, (endMs - (now + offsetMs)) / 1000);
}
