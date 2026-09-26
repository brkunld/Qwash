import type { BayUnavailableReason, BayView, SessionView } from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { Bay, WashProgram, WashSession } from '../generated/prisma/client';
import { SessionStatus } from '../generated/prisma/enums';
import { MAX_SESSION_SEC } from '../iot/iot.contract';
import { BayNotFoundError, SessionNotFoundError } from './session.errors';
import type { SessionService } from './session.service';

const ACTIVE: SessionStatus[] = [
  SessionStatus.STARTING,
  SessionStatus.RUNNING,
  SessionStatus.RECONCILING,
];

type SessionRow = WashSession & { bay: Bay; program: WashProgram };

/** Musteri ekranlari icin salt okunur peron/seans gorunumleri (Faz 5c). */
export class SessionQueries {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** QR okutuldu: "Peron X'e baglaniyorsunuz" onayi icin peron bilgisi. */
  async getBay(bayCode: string): Promise<BayView> {
    const bay = await this.prisma.bay.findUnique({
      where: { bayCode },
      include: {
        station: true,
        device: true,
        programs: {
          where: { isEnabled: true, program: { isActive: true, deletedAt: null } },
          include: { program: true },
          orderBy: { relayIndex: 'asc' },
        },
      },
    });
    if (!bay) throw new BayNotFoundError(bayCode);

    let reason = toPublicReason(this.sessions.bayProblem(bay));
    if (!reason) {
      const busy = await this.prisma.washSession.count({
        where: { bayId: bay.id, status: { in: ACTIVE } },
      });
      if (busy > 0) reason = 'BUSY';
    }

    return {
      bayCode: bay.bayCode,
      bayName: bay.name,
      stationName: bay.station.name,
      available: reason === null,
      unavailableReason: reason,
      programs: bay.programs.map(({ program }) => ({
        code: program.code,
        name: program.name,
        description: program.description,
        icon: program.icon,
        pricePerSecondKurus: program.pricePerSecondKurus,
      })),
      maxDurationSec: MAX_SESSION_SEC,
    };
  }

  /** Yalniz seans sahibine doner; baskasinin seansi "bulunamadi" sayilir. */
  async getSession(userId: string, sessionId: string): Promise<SessionView> {
    const row = await this.prisma.washSession.findFirst({
      where: { id: sessionId, userId },
      include: { bay: true, program: true },
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    return this.toView(row);
  }

  /** Arka plandan donen PWA'nin durumu geri yuklemesi (ADR-0008). */
  async getActive(userId: string): Promise<SessionView | null> {
    const row = await this.prisma.washSession.findFirst({
      where: { userId, status: { in: ACTIVE } },
      include: { bay: true, program: true },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toView(row) : null;
  }

  /** Bildirim yayini icin: seans sahibi ve gorunum. */
  async getForBroadcast(sessionId: string): Promise<{ userId: string; view: SessionView } | null> {
    const row = await this.prisma.washSession.findUnique({
      where: { id: sessionId },
      include: { bay: true, program: true },
    });
    return row ? { userId: row.userId, view: this.toView(row) } : null;
  }

  private toView(s: SessionRow): SessionView {
    return {
      sessionId: s.id,
      status: s.status,
      bayCode: s.bay.bayCode,
      bayName: s.bay.name,
      programCode: s.program.code,
      programName: s.program.name,
      pricePerSecondKurus: s.pricePerSecondKurus,
      plannedDurationSec: s.plannedDurationSec,
      heldKurus: s.pricePerSecondKurus * s.plannedDurationSec,
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      stopRequested: s.stopRequestedAt !== null,
      usedSeconds: s.usedSeconds,
      chargedKurus: s.chargedKurus === null ? null : Number(s.chargedKurus),
      endReason: s.endReason,
      serverTime: this.clock().toISOString(),
    };
  }
}

function toPublicReason(problem: string | null): BayUnavailableReason | null {
  if (problem === null) return null;
  if (problem === 'MAINTENANCE' || problem === 'NO_DEVICE' || problem === 'DEVICE_STALE') {
    return problem;
  }
  return 'DEVICE_OFFLINE';
}
