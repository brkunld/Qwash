import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { BayClaimView } from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { Bay, BayClaim, WashSession } from '../generated/prisma/client';
import { BayClaimStatus, SessionStatus } from '../generated/prisma/enums';
import {
  commandTopic,
  MAX_SESSION_SEC,
  type MenuEventPayload,
  type ParsedTopic,
  type ScreenCommandPayload,
  type ShowMenuCommandPayload,
} from '../iot/iot.contract';
import type { OutboxService } from '../outbox/outbox.service';
import { WalletError } from '../wallet/wallet.errors';
import type { Tx } from '../wallet/wallet.service';
import {
  BayBusyError,
  BayClaimedError,
  BayNotFoundError,
  BayUnavailableError,
  SessionError,
} from './session.errors';
import type { DeviceMessageOutcome, SessionService } from './session.service';

export interface ClaimTimings {
  /** QR okutulup bag kurulduktan sonra ilk secim icin sure. */
  idleSec: number;
  /** Seans bitince "tekrar sec" ekraninin suresi (Burak, 2026-09-27: ~30 sn). */
  afterSessionSec: number;
  /** Ekrandan baslatilan seansin ACK beklerken bagi tuttugu sure (ACK 10 sn'nin ustunde). */
  startWaitSec: number;
}

export const DEFAULT_CLAIM_TIMINGS: ClaimTimings = {
  idleSec: 90,
  afterSessionSec: 30,
  startWaitSec: 60,
};

/** Ekrandaki hazir sure dugmeleri (Burak: hazir dugmeler). */
export const SCREEN_DURATIONS_SEC = [120, 300, 600];

/** SessionService'in cagirdigi kancalar (bag servisi SessionService'e baglanir). */
export interface ClaimHooks {
  onSessionClosed(tx: Tx, session: WashSession): Promise<void>;
  onMenuEvent(topic: ParsedTopic, payload: MenuEventPayload): Promise<DeviceMessageOutcome>;
}

type BayWithStation = Bay & { station: { code: string } };

const ACTIVE_SESSION: SessionStatus[] = [
  SessionStatus.STARTING,
  SessionStatus.RUNNING,
  SessionStatus.RECONCILING,
];

/**
 * Dokunmatik ekrandan seans (2026-09-27, Burak karari).
 *
 *   musteri QR okutur, telefonda "ekrandan sececegim" der -> bag (ACTIVE) + SHOW_MENU
 *   ekranda paket + sure secilir -> cihaz MENU_START -> musteri adina normal seans (HOLD + START)
 *   seans surerken ekranda DURDUR -> cihaz roleyi hemen kapatir, SESSION_ENDED ile kalan sureyi bildirir
 *   seans bitince -> SHOW_MENU (afterSession, 30 sn); secilmezse bag EXPIRED + SHOW_QR
 *
 * Para yolu degismez: seans her zaman bagli musterinin cuzdanindan, SessionService.start ile
 * acilir. Ekran yalniz "hangi paket, kac sn" der; tutar ve bakiye kontrolu backend'dedir.
 * Risk (bilerek kabul): bag acikken peronun onundeki herkes o hesaptan secim yapabilir;
 * bu yuzden sureler kisa, ekranda maskeli hesap etiketi var ve musteri telefondan birakabilir.
 */
export class BayClaimService implements ClaimHooks {
  private readonly logger = new Logger(BayClaimService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    private readonly clock: () => Date = () => new Date(),
    private readonly timings: ClaimTimings = DEFAULT_CLAIM_TIMINGS,
  ) {
    sessions.attachClaims(this);
  }

  // ---------------------------------------------------------------------------
  // Musteri (telefon) islemleri
  // ---------------------------------------------------------------------------

  /** Peron ekranini musterinin hesabina baglar ve menuyu acar. Ayni musteri tekrar cagirirsa sure yenilenir. */
  async claim(userId: string, bayCode: string): Promise<BayClaimView> {
    const bay = await this.prisma.bay.findUnique({
      where: { bayCode },
      include: { station: true, device: true },
    });
    if (!bay) throw new BayNotFoundError(bayCode);
    const problem = this.sessions.bayProblem(bay);
    if (problem) throw new BayUnavailableError(bayCode, problem);

    const claim = await this.prisma.$transaction(async (tx) => {
      // Ayni perona ayni anda iki "bagla" istegi sirayla islenir.
      await tx.$queryRaw`SELECT "id" FROM "Bay" WHERE "id" = ${bay.id} FOR UPDATE`;
      const now = this.clock();

      const running = await tx.washSession.findFirst({
        where: { bayId: bay.id, status: { in: ACTIVE_SESSION } },
      });
      if (running && running.userId !== userId) throw new BayBusyError(bayCode);

      const current = await tx.bayClaim.findFirst({
        where: { bayId: bay.id, status: BayClaimStatus.ACTIVE },
      });
      const expiresAt = new Date(now.getTime() + this.timings.idleSec * 1000);
      let claim: BayClaim;
      if (current && current.userId === userId) {
        claim = await tx.bayClaim.update({ where: { id: current.id }, data: { expiresAt } });
      } else {
        if (current) {
          if (current.expiresAt > now || running) throw new BayClaimedError(bayCode);
          await this.end(tx, current, BayClaimStatus.EXPIRED);
        }
        claim = await tx.bayClaim.create({ data: { bayId: bay.id, userId, expiresAt } });
      }
      // Kendi seansi surerken bag kurulduysa menu seans bitince acilir (onSessionClosed).
      if (!running) await this.sendMenu(tx, claim, bay, false, this.timings.idleSec);
      return claim;
    });
    return this.view(claim, bayCode);
  }

  /** Musterinin bu perondaki acik bagi (yoksa null). */
  async mine(userId: string, bayCode: string): Promise<BayClaimView | null> {
    const claim = await this.prisma.bayClaim.findFirst({
      where: { userId, status: BayClaimStatus.ACTIVE, bay: { bayCode } },
    });
    return claim ? this.view(claim, bayCode) : null;
  }

  /** Musteri telefondan birakir: ekran QR'a doner. Suren seans etkilenmez. */
  async release(userId: string, bayCode: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.bayClaim.findFirst({
        where: { userId, status: BayClaimStatus.ACTIVE, bay: { bayCode } },
        include: { bay: { include: { station: true } } },
      });
      if (!claim) return;
      await this.end(tx, claim, BayClaimStatus.RELEASED);
      await this.sendScreen(tx, claim.bay, { type: 'SHOW_QR', claimId: claim.id });
    });
  }

  // ---------------------------------------------------------------------------
  // Cihaz (dokunmatik ekran) olaylari
  // ---------------------------------------------------------------------------

  async onMenuEvent(topic: ParsedTopic, p: MenuEventPayload): Promise<DeviceMessageOutcome> {
    switch (p.type) {
      case 'MENU_START':
        return this.onMenuStart(topic, p);
      case 'MENU_EXIT':
        return this.onMenuExit(topic, p.claimId);
    }
  }

  private async onMenuStart(
    topic: ParsedTopic,
    p: Extract<MenuEventPayload, { type: 'MENU_START' }>,
  ): Promise<DeviceMessageOutcome> {
    const claim = await this.prisma.bayClaim.findUnique({
      where: { id: p.claimId },
      include: { bay: { include: { station: true } } },
    });
    if (!claim) return 'UNKNOWN_CLAIM';
    if (!onTopic(claim.bay, topic)) {
      this.logger.error(
        { claimId: claim.id, topic },
        'Bag baska perona ait; ekran olayi reddedildi',
      );
      return 'BAY_MISMATCH';
    }
    const now = this.clock();
    if (claim.status !== BayClaimStatus.ACTIVE || claim.expiresAt <= now) {
      // Bag kapanmis: ekran eski menude kalmasin.
      await this.prisma.$transaction((tx) =>
        this.sendScreen(tx, claim.bay, { type: 'SHOW_QR', claimId: claim.id }),
      );
      return 'CLAIM_EXPIRED';
    }

    try {
      await this.sessions.start({
        userId: claim.userId,
        bayCode: claim.bay.bayCode,
        programCode: p.programCode,
        durationSec: p.durationSec,
        // Ayni dokunus mesaji tekrar gelirse ayni seans doner (ikinci HOLD olmaz).
        idempotencyKey: `${claim.userId}:screen:${claim.id}:${p.requestId}`,
      });
    } catch (error) {
      if (!(error instanceof SessionError) && !(error instanceof WalletError)) throw error;
      await this.prisma.$transaction(async (tx) => {
        const extended = await tx.bayClaim.update({
          where: { id: claim.id },
          data: {
            expiresAt: new Date(now.getTime() + this.timings.afterSessionSec * 1000),
          },
        });
        await this.sendScreen(tx, claim.bay, {
          type: 'MENU_ERROR',
          claimId: extended.id,
          message: screenMessage(error.code),
        });
      });
      return 'MENU_START_REJECTED';
    }

    // Seans basladi: ACK gelene kadar bag canli kalsin; seans bitince onSessionClosed yeniler.
    await this.prisma.bayClaim.updateMany({
      where: { id: claim.id, status: BayClaimStatus.ACTIVE },
      data: { expiresAt: new Date(now.getTime() + this.timings.startWaitSec * 1000) },
    });
    return 'MENU_SESSION_STARTED';
  }

  /** Ekrandaki "Cikis": bag kapanir. Ekran zaten QR'a donmustur. */
  private async onMenuExit(topic: ParsedTopic, claimId: string): Promise<DeviceMessageOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.bayClaim.findUnique({
        where: { id: claimId },
        include: { bay: { include: { station: true } } },
      });
      if (!claim) return 'UNKNOWN_CLAIM';
      if (!onTopic(claim.bay, topic)) return 'BAY_MISMATCH';
      if (claim.status !== BayClaimStatus.ACTIVE) return 'NO_OP';
      await this.end(tx, claim, BayClaimStatus.RELEASED);
      return 'CLAIM_RELEASED';
    });
  }

  // ---------------------------------------------------------------------------
  // SessionService kancasi ve tarama
  // ---------------------------------------------------------------------------

  /** Seans bitti (tamamlandi veya basarisiz): bagli musteriye 30 sn "tekrar sec" menusu. */
  async onSessionClosed(tx: Tx, session: WashSession): Promise<void> {
    const claim = await tx.bayClaim.findFirst({
      where: { bayId: session.bayId, userId: session.userId, status: BayClaimStatus.ACTIVE },
    });
    if (!claim) return;
    const bay = await tx.bay.findUniqueOrThrow({
      where: { id: session.bayId },
      include: { station: true },
    });
    const expiresAt = new Date(this.clock().getTime() + this.timings.afterSessionSec * 1000);
    const updated = await tx.bayClaim.update({ where: { id: claim.id }, data: { expiresAt } });
    await this.sendMenu(tx, updated, bay, true, this.timings.afterSessionSec);
  }

  /** Suresi dolan baglari kapatir (peronda seans suruyorsa beklenir). */
  async sweep(): Promise<number> {
    const due = await this.prisma.bayClaim.findMany({
      where: { status: BayClaimStatus.ACTIVE, expiresAt: { lte: this.clock() } },
      select: { id: true },
      take: 50,
    });
    let expired = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "BayClaim" WHERE "id" = ${id} AND "status" = 'ACTIVE' FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return false;
        const claim = await tx.bayClaim.findUniqueOrThrow({
          where: { id },
          include: { bay: { include: { station: true } } },
        });
        if (claim.expiresAt > this.clock()) return false; // Bu arada yenilendi
        const running = await tx.washSession.count({
          where: { bayId: claim.bayId, status: { in: ACTIVE_SESSION } },
        });
        if (running > 0) return false;
        await this.end(tx, claim, BayClaimStatus.EXPIRED);
        await this.sendScreen(tx, claim.bay, { type: 'SHOW_QR', claimId: claim.id });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  // ---------------------------------------------------------------------------
  // Yardimcilar
  // ---------------------------------------------------------------------------

  private async end(tx: Tx, claim: BayClaim, status: BayClaimStatus): Promise<void> {
    await tx.bayClaim.update({
      where: { id: claim.id },
      data: { status, endedAt: this.clock() },
    });
  }

  private async sendMenu(
    tx: Tx,
    claim: BayClaim,
    bay: BayWithStation,
    afterSession: boolean,
    timeoutSec: number,
  ): Promise<void> {
    // Ayni transaction'da sorgular sirayla (tek baglanti).
    const programs = await tx.bayProgram.findMany({
      where: { bayId: bay.id, isEnabled: true, program: { isActive: true, deletedAt: null } },
      include: { program: true },
      orderBy: { relayIndex: 'asc' },
    });
    const wallet = await tx.wallet.findUnique({ where: { userId: claim.userId } });
    const user = await tx.user.findUniqueOrThrow({
      where: { id: claim.userId },
      select: { email: true },
    });
    const payload: ShowMenuCommandPayload = {
      type: 'SHOW_MENU',
      claimId: claim.id,
      timeoutSec,
      afterSession,
      holder: maskEmail(user.email),
      availableKurus: wallet ? Number(wallet.balanceKurus - wallet.holdKurus) : 0,
      programs: programs.map(({ program }) => ({
        code: program.code,
        label: toScreenText(program.name, 16),
        pricePerSecondKurus: program.pricePerSecondKurus,
      })),
      durationsSec: SCREEN_DURATIONS_SEC.filter((d) => d <= MAX_SESSION_SEC),
    };
    await this.sendScreen(tx, bay, payload);
  }

  private async sendScreen(
    tx: Tx,
    bay: BayWithStation,
    payload: ScreenCommandPayload,
  ): Promise<void> {
    const now = this.clock();
    await this.outbox.enqueue(tx, {
      topic: commandTopic(bay.station.code, bay.bayCode),
      envelope: { commandId: randomUUID(), sessionId: '', timestamp: now.toISOString(), payload },
      // Gec ulasan ekran komutu anlamsizdir (bag bu arada degismis olabilir).
      expiresAt: new Date(now.getTime() + 30_000),
    });
  }

  private view(claim: BayClaim, bayCode: string): BayClaimView {
    return {
      claimId: claim.id,
      bayCode,
      expiresAt: claim.expiresAt.toISOString(),
      serverTime: this.clock().toISOString(),
    };
  }
}

function onTopic(bay: BayWithStation, topic: ParsedTopic): boolean {
  return bay.bayCode === topic.bayCode && bay.station.code === topic.stationCode;
}

const TR_ASCII: Record<string, string> = {
  ç: 'c',
  Ç: 'C',
  ğ: 'g',
  Ğ: 'G',
  ı: 'i',
  İ: 'I',
  ö: 'o',
  Ö: 'O',
  ş: 's',
  Ş: 'S',
  ü: 'u',
  Ü: 'U',
};

/** Ekran fontu yalniz ASCII basar: Turkce harfler sadelesir, gerisi atilir, BUYUK harf. */
export function toScreenText(text: string, max: number): string {
  return text
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_ASCII[c]!)
    .normalize('NFD')
    .replace(/[^\x20-\x7E]/g, '')
    .toUpperCase()
    .trim()
    .slice(0, max);
}

/** "burak@gmail.com" -> "BU***@GMAIL.COM": musteri dogru hesabi gorur, yoldan gecen e-postayi goremez. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at) : '';
  return toScreenText(`${local.slice(0, 2)}***${domain}`, 24);
}

/** Ekrana gidecek kisa ASCII hata metni. */
function screenMessage(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'BAKIYE YETERSIZ';
    case 'BAY_BUSY':
    case 'BAY_CLAIMED':
      return 'PERON MESGUL';
    case 'BAY_UNAVAILABLE':
      return 'PERON KULLANILAMAZ';
    case 'PROGRAM_NOT_AVAILABLE':
      return 'PAKET KAPALI';
    case 'ACCOUNT_NOT_ACTIVE':
      return 'HESAP KAPALI';
    default:
      return 'BASLATILAMADI';
  }
}
