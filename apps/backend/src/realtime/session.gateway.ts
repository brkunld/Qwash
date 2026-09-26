import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from '@nestjs/websockets';
import { SOCKET_EVENTS } from '@qwash/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { SessionQueries } from '../session/session.queries';
import { SessionChangeListener } from './session-change.listener';

export const userRoom = (userId: string) => `user:${userId}`;

/**
 * Musteriye anlik seans durumu (Faz 5c, ARCHITECTURE.md 6).
 *
 * Baglanti handshake'te access token ister (auth.token). Dogrulanan soket yalniz kendi
 * kullanici odasina girer; istemci oda secemez, baskasinin seansini dinleyemez.
 * Seans degisince (commit sonrasi pg NOTIFY) guncel SessionView sahibinin odasina gider.
 * Geri sayim istemcide startedAt + plannedDurationSec ile hesaplanir; saniyelik tick yok.
 *
 * Access token baglanti sirasinda dogrulanir. Token suresi dolsa da baglanti acik kalir
 * (ARCHITECTURE.md 6); istemci yenilenen tokenla yeniden baglanir.
 */
@WebSocketGateway()
export class SessionGateway
  implements OnGatewayConnection, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SessionGateway.name);
  /** Ayni seansin bildirimleri sirayla islenir: eski okuma yeni durumun ustune yazamaz. */
  private readonly chains = new Map<string, Promise<void>>();

  @WebSocketServer() server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly queries: SessionQueries,
    private readonly listener: SessionChangeListener,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.listener.bind(
      (sessionId) => this.enqueue(sessionId),
      () => this.server.emit(SOCKET_EVENTS.RESYNC),
    );
    await this.listener.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.listener.close();
  }

  async handleConnection(socket: Socket): Promise<void> {
    const token: unknown = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    try {
      if (typeof token !== 'string' || token.length === 0) throw new Error('token yok');
      const claims = await this.auth.verifyAccessToken(token);
      socket.data.userId = claims.userId;
      await socket.join(userRoom(claims.userId));
    } catch {
      socket.emit(SOCKET_EVENTS.AUTH_ERROR, { code: 'UNAUTHENTICATED' });
      socket.disconnect(true);
    }
  }

  /** Testler ve yayin icin: bir seansin guncel durumunu sahibine gonderir. */
  enqueue(sessionId: string): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => this.broadcast(sessionId))
      .catch((err: unknown) => this.logger.error({ err, sessionId }, 'Seans yayini basarisiz'))
      .finally(() => {
        if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
      });
    this.chains.set(sessionId, next);
    return next;
  }

  private async broadcast(sessionId: string): Promise<void> {
    const found = await this.queries.getForBroadcast(sessionId);
    if (!found) return;
    this.server.to(userRoom(found.userId)).emit(SOCKET_EVENTS.SESSION_UPDATED, found.view);
  }
}
