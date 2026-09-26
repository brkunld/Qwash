import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { Bay, WashSession } from '../generated/prisma/client';
import { BayStatus, LedgerSource, SessionStatus, UserStatus } from '../generated/prisma/enums';
import {
  commandTopic,
  DeviceMessageSchema,
  MAX_SESSION_SEC,
  parseDeviceTopic,
  type CommandEnvelope,
  type DeviceMessage,
  type ParsedTopic,
  type StopCommandPayload,
} from '../iot/iot.contract';
import { OutboxService } from '../outbox/outbox.service';
import { WalletNotFoundError } from '../wallet/wallet.errors';
import { WalletService, type Tx } from '../wallet/wallet.service';
import {
  BayBusyError,
  BayNotFoundError,
  BayUnavailableError,
  InvalidDurationError,
  ProgramNotAvailableError,
  SessionAccountNotActiveError,
  SessionIdempotencyConflictError,
  SessionNotFoundError,
} from './session.errors';

export interface SessionTimings {
  /** START'tan sonra STARTED_ACK icin beklenen en uzun sure (IOT.md: 10 sn). */
  ackTimeoutMs: number;
  /** Planlanan sure dolduktan sonra cihazdan bitis bildirimi icin tolerans. */
  endGraceSec: number;
  /** Bu kadar suredir haber alinamayan cihaz kullanilamaz sayilir (heartbeat 30 sn). */
  deviceStaleMs: number;
  /**
   * RECONCILING'de cihazin donmesi icin beklenen sure. Dolunca yalnizca kanitlanmis
   * kullanim tahsil edilir, kalani iade edilir (Burak'in karari, 2026-09-25).
   */
  reconcileTimeoutMs: number;
  /**
   * Musteri durdurunca tahsilat tavani = durdurma ani - baslama + bu pay (STOP'un cihaza
   * ulasma suresi). STOP kaybolup cihaz calismaya devam etse bile musteri fazlasini odemez.
   */
  stopGraceSec: number;
  /** Cihazdan STOPPED_ACK/bitis gelmezse STOP bu aralikla yeniden gonderilir. */
  stopRetryMs: number;
  /** En fazla bu kadar STOP gonderilir (ilk gonderim dahil). */
  stopMaxAttempts: number;
  /**
   * Device twin: cihazin bildirdigi durum bu sureden uzun sure seansla uyusmazsa kalici
   * drift sayilir (heartbeat seansta 10, bosta 30 sn; mesaj yarislarini elemek icin).
   */
  driftToleranceMs: number;
}

export const DEFAULT_TIMINGS: SessionTimings = {
  ackTimeoutMs: 10_000,
  endGraceSec: 30,
  deviceStaleMs: 90_000,
  reconcileTimeoutMs: 30 * 60_000,
  stopGraceSec: 5,
  stopRetryMs: 5_000,
  stopMaxAttempts: 24, // ~2 dk
  driftToleranceMs: 15_000,
};

export interface StartSessionInput {
  userId: string;
  bayCode: string;
  programCode: string;
  durationSec: number;
  /** Istemcinin "baslat" istegi icin urettigi anahtar; tekrar eden istek ikinci seans acmaz. */
  idempotencyKey: string;
}

/** Cihaz mesajinin nasil islendigi (log ve testler icin). */
export type DeviceMessageOutcome =
  | 'IGNORED_TOPIC'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'DUPLICATE_EVENT'
  | 'DEVICE_STATE_RECORDED'
  | 'UNKNOWN_SESSION'
  | 'BAY_MISMATCH'
  | 'NO_OP'
  | 'SESSION_RUNNING'
  | 'SESSION_FAILED'
  | 'SESSION_COMPLETED'
  | 'LATE_ACK_STOP_SENT'
  | 'UNPAID_RUN'
  | 'LATE_END_RECORDED'
  | 'RECOVERY_RECORDED';

export interface SweepResult {
  ackTimeouts: number;
  reconciling: number;
  autoClosed: number;
  stopRetries: number;
}

/** Cihazi kaybolan seans otomatik kapatildiginda kullanilan bitis nedeni. */
export const DEVICE_LOST_REASON = 'DEVICE_LOST';

type StopReason = StopCommandPayload['reason'];

/**
 * Device twin uyusmazliklari (ADR-0006):
 * - UNEXPECTED_RUNNING: cihaz calisiyor, peronda aktif seans yok (para alinmayan su).
 * - SESSION_MISMATCH: cihaz aktif seanstan baska bir seansi calistiriyor.
 * - NOT_RUNNING: seans RUNNING ama cihaz bosta (bitis bildirimi kaybolmus / cihaz sifirlanmis).
 * - RELAY_MISMATCH: cihaz seansin rolesinden farkli bir role cekiyor.
 */
export type DriftKind =
  'UNEXPECTED_RUNNING' | 'SESSION_MISMATCH' | 'NOT_RUNNING' | 'RELAY_MISMATCH';

type HeartbeatPayload = Extract<DeviceMessage['payload'], { type: 'HEARTBEAT' }>;

type SessionWithBay = WashSession & { bay: Bay & { station: { code: string } } };

export type BayWithDevice = Bay & { device: { reportedStatus: string; lastSeenAt: Date } | null };

/** Seans durum degisikliklerinin yayinlandigi PostgreSQL LISTEN/NOTIFY kanali. */
export const SESSION_CHANNEL = 'qwash_session_changed';

const ACTIVE: SessionStatus[] = [
  SessionStatus.STARTING,
  SessionStatus.RUNNING,
  SessionStatus.RECONCILING,
];

/**
 * Seans yasam dongusu ve two-phase ACK (ADR-0007, ADR-0010).
 *
 *   baslat -> [HOLD + seans(STARTING) + START outbox]  (tek transaction)
 *   STARTED_ACK SUCCESS   -> RUNNING
 *   STARTED_ACK REJECTED  -> FAILED, bloke iade
 *   ACK suresi doldu      -> FAILED, bloke iade, tedbiren STOP
 *   SESSION_ENDED         -> COMPLETED, kullanilan sure tahsil, kalan iade
 *   bitis bildirilmedi    -> RECONCILING (bloke durur, cihaz donunce kapanir)
 *   FAILED iken STARTED_ACK (gec ACK) -> STOP gonderilir
 *   STOP onaylanmadi      -> STOPPED_ACK/bitis gelene kadar yeniden gonderilir
 *   musteri durdurdu      -> tahsilat durdurma anina (+ pay) kadar; fazlasi incelemeye
 *
 * Her durum degisikligi seans satiri FOR UPDATE kilitliyken yapilir; ACK isleyicisi ile
 * zaman asimi taramasi ayni seansi ayni anda degistiremez.
 */
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallets: WalletService,
    private readonly outbox: OutboxService,
    private readonly clock: () => Date = () => new Date(),
    private readonly timings: SessionTimings = DEFAULT_TIMINGS,
  ) {}

  // ---------------------------------------------------------------------------
  // Musteri islemleri
  // ---------------------------------------------------------------------------

  async start(input: StartSessionInput): Promise<WashSession> {
    if (
      !Number.isSafeInteger(input.durationSec) ||
      input.durationSec < 1 ||
      input.durationSec > MAX_SESSION_SEC
    ) {
      throw new InvalidDurationError(input.durationSec, MAX_SESSION_SEC);
    }

    const replay = await this.findReplay(input);
    if (replay) return replay;

    const bay = await this.prisma.bay.findUnique({
      where: { bayCode: input.bayCode },
      include: { station: true, device: true },
    });
    if (!bay) throw new BayNotFoundError(input.bayCode);
    this.assertBayUsable(bay);

    const bayProgram = await this.prisma.bayProgram.findFirst({
      where: {
        bayId: bay.id,
        isEnabled: true,
        program: { code: input.programCode, isActive: true, deletedAt: null },
      },
      include: { program: true },
    });
    if (!bayProgram) throw new ProgramNotAvailableError(input.bayCode, input.programCode);

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: input.userId },
      include: { user: { select: { status: true } } },
    });
    if (!wallet) throw new WalletNotFoundError(`user:${input.userId}`);
    // Silinen hesabin bakiyesi zaten sifir/bloke (cuzdan kilidi); bu net hata icin.
    if (wallet.user.status !== UserStatus.ACTIVE) throw new SessionAccountNotActiveError();

    const price = bayProgram.program.pricePerSecondKurus;
    const sessionId = randomUUID();
    const commandId = randomUUID();
    const now = this.clock();
    const ackDeadlineAt = new Date(now.getTime() + this.timings.ackTimeoutMs);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const { hold } = await this.wallets.holdTx(tx, {
          walletId: wallet.id,
          amountKurus: price * input.durationSec,
          source: LedgerSource.SESSION,
          idempotencyKey: `session:${input.idempotencyKey}`,
          referenceId: sessionId,
        });

        const session = await tx.washSession.create({
          data: {
            id: sessionId,
            userId: input.userId,
            walletId: wallet.id,
            bayId: bay.id,
            programId: bayProgram.programId,
            relayIndex: bayProgram.relayIndex,
            pricePerSecondKurus: price,
            plannedDurationSec: input.durationSec,
            holdId: hold.id,
            idempotencyKey: input.idempotencyKey,
            startCommandId: commandId,
            ackDeadlineAt,
          },
        });
        await this.transition(tx, session.id, null, SessionStatus.STARTING, 'START_REQUESTED');

        const envelope: CommandEnvelope = {
          commandId,
          sessionId,
          deviceId: bay.device?.deviceId,
          timestamp: now.toISOString(),
          expiresAt: ackDeadlineAt.toISOString(),
          payload: {
            type: 'START',
            program: bayProgram.program.code,
            relayIndex: bayProgram.relayIndex,
            durationSec: input.durationSec,
          },
        };
        await this.outbox.enqueue(tx, {
          topic: commandTopic(bay.station.code, bay.bayCode),
          envelope,
          expiresAt: ackDeadlineAt,
          sessionId,
        });
        await tx.bay.update({ where: { id: bay.id }, data: { status: BayStatus.WAITING } });
        return session;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Ayni anahtarla eszamanli iki istek: kazananin seansi doner.
        const winner = await this.findReplay(input);
        if (winner) return winner;
        // Peronda aktif seans var (WashSession_one_active_per_bay).
        const active = await this.prisma.washSession.findFirst({
          where: { bayId: bay.id, status: { in: ACTIVE } },
        });
        if (active) throw new BayBusyError(input.bayCode);
      }
      throw error;
    }
  }

  /** Musterinin seansi erken bitirmesi. Tahsilat, cihaz SESSION_ENDED bildirince yapilir. */
  async requestStop(sessionId: string, userId: string): Promise<WashSession> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, { id: sessionId });
      if (!session || session.userId !== userId) throw new SessionNotFoundError(sessionId);
      if (session.status === SessionStatus.STARTING || session.status === SessionStatus.RUNNING) {
        await this.enqueueStop(tx, session, 'USER_STOP');
        await this.transition(tx, session.id, session.status, session.status, 'STOP_REQUESTED');
        return tx.washSession.findUniqueOrThrow({ where: { id: session.id } });
      }
      return session;
    });
  }

  /**
   * Admin acil durdurma (ADR-0011 #6). Musteri durdurmasiyla ayni yol (STOP takibi,
   * tahsilat tavani); fark: sahiplik kontrolu yok, neden ADMIN_OVERRIDE. `audit` ayni
   * transaction'da denetim kaydi yazar. Aktif olmayan seansta null doner.
   */
  async adminStop(
    sessionId: string,
    audit: (tx: Tx, session: WashSession) => Promise<void>,
  ): Promise<WashSession | null> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, { id: sessionId });
      if (!session) throw new SessionNotFoundError(sessionId);
      if (session.status !== SessionStatus.STARTING && session.status !== SessionStatus.RUNNING) {
        return null;
      }
      await this.enqueueStop(tx, session, 'ADMIN_OVERRIDE');
      await this.transition(tx, session.id, session.status, session.status, 'ADMIN_STOP_REQUESTED');
      await audit(tx, session);
      return tx.washSession.findUniqueOrThrow({ where: { id: session.id } });
    });
  }

  // ---------------------------------------------------------------------------
  // Cihazdan gelen mesajlar
  // ---------------------------------------------------------------------------

  async handleDeviceMessage(topic: string, raw: string): Promise<DeviceMessageOutcome> {
    const parsed = parseDeviceTopic(topic);
    if (!parsed) return 'IGNORED_TOPIC';

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn({ topic }, 'Cihaz mesaji JSON degil');
      return 'INVALID_JSON';
    }
    const result = DeviceMessageSchema.safeParse(json);
    if (!result.success) {
      this.logger.warn({ topic, issues: result.error.issues }, 'Cihaz mesaji sozlesmeye uymuyor');
      return 'INVALID_SCHEMA';
    }
    const msg = result.data;

    if (parsed.kind === 'status' || parsed.kind === 'heartbeat') {
      await this.recordDeviceState(parsed, msg);
      return 'DEVICE_STATE_RECORDED';
    }

    return this.prisma.$transaction(async (tx) => {
      if (msg.eventId && !(await this.claimInbox(tx, msg.eventId, topic))) {
        return 'DUPLICATE_EVENT';
      }
      const p = msg.payload;
      switch (p.type) {
        case 'STARTED_ACK':
          return this.onStartedAck(tx, parsed, p);
        case 'SESSION_ENDED':
          return this.settle(tx, parsed, p.sessionId, p.remainingSec, `DEVICE_${p.reason}`);
        case 'STOPPED_ACK':
          // Hangi durumla gelirse gelsin STOP cihaza ulasmistir: yeniden gonderim durur.
          await this.confirmStop(tx, parsed, p.sessionId);
          // Normalde SESSION_ENDED'den hemen sonra gelir; o kaybolduysa bu kapatir.
          if (p.status === 'SUCCESS' && p.remainingSec !== undefined) {
            return this.settle(tx, parsed, p.sessionId, p.remainingSec, 'DEVICE_STOPPED');
          }
          return 'NO_OP';
        case 'SESSION_RECOVERED':
          return this.onRecovered(tx, parsed, p.sessionId, p.detail, p.remainingSec);
        default:
          return 'NO_OP';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Periyodik tarama (zaman asimi ve bitisi bildirilmeyen seanslar)
  // ---------------------------------------------------------------------------

  async sweep(): Promise<SweepResult> {
    const now = this.clock();
    const result: SweepResult = { ackTimeouts: 0, reconciling: 0, autoClosed: 0, stopRetries: 0 };

    const timedOut = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "WashSession"
      WHERE "status" = 'STARTING' AND "ackDeadlineAt" <= ${now}
      ORDER BY "ackDeadlineAt" LIMIT 100`;
    for (const { id } of timedOut) {
      const done = await this.prisma.$transaction(async (tx) => {
        const s = await this.lockSession(tx, { id }, true);
        if (!s || s.status !== SessionStatus.STARTING) return false; // ACK yetisti
        await this.fail(tx, s, 'ACK_TIMEOUT', BayStatus.ERROR);
        // Cihaz START'i almis ama ACK'i kaybolmus olabilir: suyu tedbiren kapat.
        await this.enqueueStop(tx, s, 'ACK_TIMEOUT');
        return true;
      });
      if (done) result.ackTimeouts += 1;
    }

    const overdue = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "WashSession"
      WHERE "status" = 'RUNNING'
        AND "startedAt" + make_interval(secs => "plannedDurationSec" + ${this.timings.endGraceSec})
            <= ${now}
      LIMIT 100`;
    for (const { id } of overdue) {
      const done = await this.prisma.$transaction(async (tx) => {
        const s = await this.lockSession(tx, { id }, true);
        if (!s || s.status !== SessionStatus.RUNNING) return false;
        await tx.washSession.update({
          where: { id },
          data: { status: SessionStatus.RECONCILING, reconcilingAt: now },
        });
        await this.transition(
          tx,
          id,
          SessionStatus.RUNNING,
          SessionStatus.RECONCILING,
          'END_NOT_REPORTED',
        );
        return true;
      });
      if (done) result.reconciling += 1;
    }

    // Cihaz beklenen surede donmedi: yalnizca kanitlanmis kullanim tahsil, kalan iade,
    // admin incelemesine isaretle (Burak'in karari, 2026-09-25; ADR-0010 #8).
    const reconcileDeadline = new Date(now.getTime() - this.timings.reconcileTimeoutMs);
    const lost = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "WashSession"
      WHERE "status" = 'RECONCILING' AND "reconcilingAt" <= ${reconcileDeadline}
      LIMIT 100`;
    for (const { id } of lost) {
      const done = await this.prisma.$transaction(async (tx) => {
        const s = await this.lockSession(tx, { id }, true);
        if (!s || s.status !== SessionStatus.RECONCILING) return false; // Cihaz yetisti
        const billed = this.billableSeconds(s, s.provenUsedSec);
        const chargedKurus = billed * s.pricePerSecondKurus;
        await this.wallets.captureTx(tx, s.holdId, chargedKurus);
        await tx.washSession.update({
          where: { id },
          data: {
            status: SessionStatus.COMPLETED,
            usedSeconds: billed,
            chargedKurus: BigInt(chargedKurus),
            endedAt: now,
            endReason: DEVICE_LOST_REASON,
            needsReview: true,
          },
        });
        await tx.bay.update({ where: { id: s.bayId }, data: { status: BayStatus.ERROR } });
        await this.transition(tx, id, s.status, SessionStatus.COMPLETED, DEVICE_LOST_REASON, {
          provenUsedSec: s.provenUsedSec,
          plannedDurationSec: s.plannedDurationSec,
          chargedKurus,
        });
        return true;
      });
      if (done) result.autoClosed += 1;
    }

    // Onaylanmayan STOP'lari yeniden gonder. Onceki STOP hala outbox'ta bekliyorsa
    // (broker yok) yenisi eklenmez; kuyruk sisirilmez.
    const retryBefore = new Date(now.getTime() - this.timings.stopRetryMs);
    const unconfirmed = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s."id" FROM "WashSession" s
      WHERE s."stopRequestedAt" IS NOT NULL AND s."stopConfirmedAt" IS NULL
        AND s."lastStopSentAt" <= ${retryBefore}
        AND s."stopAttempts" < ${this.timings.stopMaxAttempts}
        AND NOT EXISTS (
          SELECT 1 FROM "OutboxEvent" o
          WHERE o."sessionId" = s."id" AND o."status" = 'PENDING'
            AND o."payload"->'payload'->>'type' = 'STOP')
      ORDER BY s."lastStopSentAt" LIMIT 100`;
    for (const { id } of unconfirmed) {
      const done = await this.prisma.$transaction(async (tx) => {
        const s = await this.lockSession(tx, { id }, true);
        if (!s || !s.stopRequestedAt || s.stopConfirmedAt) return false;
        if (s.stopAttempts >= this.timings.stopMaxAttempts) return false;
        if (s.lastStopSentAt && s.lastStopSentAt > retryBefore) return false;
        await this.enqueueStop(tx, s, (s.stopReason ?? 'USER_STOP') as StopReason, true);
        return true;
      });
      if (done) result.stopRetries += 1;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Ic yardimcilar
  // ---------------------------------------------------------------------------

  private async onStartedAck(
    tx: Tx,
    topic: ParsedTopic,
    p: Extract<DeviceMessage['payload'], { type: 'STARTED_ACK' }>,
  ): Promise<DeviceMessageOutcome> {
    const s = await this.lockSession(tx, { startCommandId: p.commandId });
    if (!s) return 'UNKNOWN_SESSION';
    if (!sameBay(s, topic)) return this.bayMismatch(s, topic);

    if (p.status === 'SUCCESS') {
      if (s.status === SessionStatus.STARTING) {
        await tx.washSession.update({
          where: { id: s.id },
          data: { status: SessionStatus.RUNNING, startedAt: this.clock() },
        });
        await tx.bay.update({ where: { id: s.bayId }, data: { status: BayStatus.RUNNING } });
        await this.transition(
          tx,
          s.id,
          SessionStatus.STARTING,
          SessionStatus.RUNNING,
          'STARTED_ACK',
        );
        return 'SESSION_RUNNING';
      }
      if (s.status === SessionStatus.FAILED) {
        // Gec ACK: bloke iade edildi ama cihaz suyu acti. Hemen kapat (ROADMAP Faz 4).
        await this.enqueueStop(tx, s, 'LATE_ACK');
        await this.transition(tx, s.id, s.status, s.status, 'LATE_ACK_STOP_SENT');
        this.logger.warn(
          { sessionId: s.id },
          'Gec STARTED_ACK: iade edilmis seans icin STOP gonderildi',
        );
        return 'LATE_ACK_STOP_SENT';
      }
      return 'NO_OP';
    }

    if (p.status === 'REJECTED' && s.status === SessionStatus.STARTING) {
      await this.fail(tx, s, `DEVICE_REJECTED_${p.reason ?? 'UNKNOWN'}`, BayStatus.IDLE);
      return 'SESSION_FAILED';
    }
    return 'NO_OP';
  }

  /** Cihazin bildirdigi kalan sureye gore kullanilan sureyi tahsil eder, kalani iade eder. */
  private async settle(
    tx: Tx,
    topic: ParsedTopic,
    sessionId: string,
    remainingSec: number,
    reason: string,
  ): Promise<DeviceMessageOutcome> {
    const s = await this.lockSession(tx, { id: sessionId });
    if (!s) return 'UNKNOWN_SESSION';
    if (!sameBay(s, topic)) return this.bayMismatch(s, topic);

    const usedSeconds = Math.min(
      s.plannedDurationSec,
      Math.max(0, s.plannedDurationSec - remainingSec),
    );
    // Cihaz bitti bildirdiyse STOP'a gerek kalmadi.
    if (s.stopRequestedAt && !s.stopConfirmedAt) {
      await tx.washSession.update({ where: { id: s.id }, data: { stopConfirmedAt: this.clock() } });
    }

    // Firmware son bitisi her baglantida yeniden gonderir; asagidaki isaretler bir kez yazilir.
    if (s.status === SessionStatus.COMPLETED) {
      if (s.endReason !== DEVICE_LOST_REASON) return 'NO_OP';
      // Otomatik kapatildiktan sonra cihaz dondu: gercek kullanim admin incelemesi icin
      // kaydedilir. Para hareket etmez (tahsil edilen sure kesin alt sinirdi).
      if (await this.hasTransition(tx, s.id, 'LATE_END_AFTER_AUTO_CLOSE')) return 'NO_OP';
      await this.transition(tx, s.id, s.status, s.status, 'LATE_END_AFTER_AUTO_CLOSE', {
        reportedUsedSeconds: usedSeconds,
        chargedUsedSeconds: s.usedSeconds,
        reason,
      });
      return 'LATE_END_RECORDED';
    }
    if (s.status === SessionStatus.FAILED) {
      // Bloke iade edilmisken cihaz calistigini bildiriyor: tahsil edilemez, isaretle.
      if (await this.hasTransition(tx, s.id, 'UNPAID_RUN_REPORTED')) return 'NO_OP';
      await this.transition(tx, s.id, s.status, s.status, 'UNPAID_RUN_REPORTED', {
        usedSeconds,
        reason,
      });
      await tx.washSession.update({ where: { id: s.id }, data: { needsReview: true } });
      this.logger.error({ sessionId: s.id, usedSeconds }, 'Iade edilmis seansta cihaz calisti');
      return 'UNPAID_RUN';
    }

    const billed = this.billableSeconds(s, usedSeconds);
    const chargedKurus = billed * s.pricePerSecondKurus;
    await this.wallets.captureTx(tx, s.holdId, chargedKurus);
    await tx.washSession.update({
      where: { id: s.id },
      data: {
        status: SessionStatus.COMPLETED,
        usedSeconds: billed,
        chargedKurus: BigInt(chargedKurus),
        endedAt: this.clock(),
        endReason: reason,
        ...(billed < usedSeconds ? { needsReview: true } : {}),
      },
    });
    await tx.bay.update({ where: { id: s.bayId }, data: { status: BayStatus.IDLE } });
    await this.transition(tx, s.id, s.status, SessionStatus.COMPLETED, reason, {
      usedSeconds: billed,
      remainingSec,
      chargedKurus,
      ...(billed < usedSeconds ? { reportedUsedSeconds: usedSeconds, stopCapApplied: true } : {}),
    });
    if (billed < usedSeconds) {
      this.logger.warn(
        { sessionId: s.id, reportedUsedSeconds: usedSeconds, billed },
        'STOP sonrasi cihaz calismaya devam etti; fazlasi tahsil edilmedi',
      );
    }
    return 'SESSION_COMPLETED';
  }

  private async onRecovered(
    tx: Tx,
    topic: ParsedTopic,
    sessionId: string | undefined,
    detail: string | undefined,
    remainingSec: number | undefined,
  ): Promise<DeviceMessageOutcome> {
    if (!sessionId) return 'NO_OP';
    const s = await this.lockSession(tx, { id: sessionId });
    if (!s) return 'UNKNOWN_SESSION';
    if (!sameBay(s, topic)) return this.bayMismatch(s, topic);
    if (remainingSec !== undefined) {
      await this.recordProvenUsage(tx, s.bayId, s.id, remainingSec);
    }
    await this.transition(tx, s.id, s.status, s.status, 'DEVICE_RECOVERED', {
      detail: detail ?? null,
      remainingSec: remainingSec ?? null,
    });
    return 'RECOVERY_RECORDED';
  }

  /**
   * Cihazin seans sirasinda bildirdigi kalan sureden kesin calisilmis sureyi gunceller.
   * Deger yalnizca artar (eski/sirasi karismis heartbeat geri alamaz) ve yalnizca o
   * perondaki aktif seans icin yazilir. Tek kosullu UPDATE; otomatik kapatma satiri
   * kilitliyse bekler ve durum degismisse hicbir sey yazmaz.
   */
  private async recordProvenUsage(
    db: Tx | PrismaClient,
    bayId: string,
    sessionId: string,
    remainingSec: number,
  ): Promise<void> {
    await db.$executeRaw`
      UPDATE "WashSession"
      SET "provenUsedSec" = GREATEST(
            "provenUsedSec",
            LEAST("plannedDurationSec", GREATEST(0, "plannedDurationSec" - ${remainingSec}))
          ),
          "updatedAt" = now()
      WHERE "id" = ${sessionId}
        AND "bayId" = ${bayId}
        AND "status" IN ('RUNNING', 'RECONCILING')`;
  }

  /**
   * Musteri durdurduysa tahsil edilebilecek en uzun sure: durdurma anina kadar gecen sure
   * + stopGraceSec. Baslamadan once durdurulduysa yalnizca pay.
   */
  private billableSeconds(s: WashSession, usedSeconds: number): number {
    if (!s.stopRequestedAt || s.stopReason !== 'USER_STOP') return usedSeconds;
    const startMs = s.startedAt?.getTime() ?? s.stopRequestedAt.getTime();
    const beforeStop = Math.max(0, Math.ceil((s.stopRequestedAt.getTime() - startMs) / 1000));
    return Math.min(usedSeconds, beforeStop + this.timings.stopGraceSec);
  }

  /**
   * Device twin: heartbeat'teki bildirilen durumu, seans tablosundan turetilen istenen
   * durumla karsilastirir. Aktif seansi olmayan calisma icin tolerans beklenmeden STOP
   * gonderilir (su bedava akiyor olabilir); digerleri tolerans asilinca kalici isaretlenir.
   */
  private async evaluateTwin(bayId: string, deviceId: string, p: HeartbeatPayload): Promise<void> {
    const now = this.clock();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Device" WHERE "deviceId" = ${deviceId} FOR UPDATE`;
      const device = await tx.device.findUniqueOrThrow({ where: { deviceId } });
      const desired = await tx.washSession.findFirst({
        where: { bayId, status: { in: ACTIVE } },
        orderBy: { createdAt: 'desc' },
      });

      let kind: DriftKind | null = null;
      let driftSessionId: string | null = null;
      if (p.sessionActive && p.sessionId) {
        if (!desired || desired.id !== p.sessionId) {
          kind = desired ? 'SESSION_MISMATCH' : 'UNEXPECTED_RUNNING';
          driftSessionId = p.sessionId;
        } else if (
          desired.status === SessionStatus.RUNNING &&
          p.relayIndex !== undefined &&
          p.relayIndex !== desired.relayIndex
        ) {
          kind = 'RELAY_MISMATCH';
          driftSessionId = desired.id;
        }
      } else if (p.sessionActive === false && desired?.status === SessionStatus.RUNNING) {
        kind = 'NOT_RUNNING';
        driftSessionId = desired.id;
      }

      if (!kind) {
        if (device.driftKind) {
          if (device.driftConfirmedAt) {
            this.logger.log({ deviceId, kind: device.driftKind }, 'Cihaz drift duzeldi');
          }
          await tx.device.update({
            where: { deviceId },
            data: {
              driftKind: null,
              driftSessionId: null,
              driftSince: null,
              driftConfirmedAt: null,
            },
          });
        }
        return;
      }

      const same = device.driftKind === kind && device.driftSessionId === driftSessionId;
      const since = same && device.driftSince ? device.driftSince : now;
      const confirmed = now.getTime() - since.getTime() >= this.timings.driftToleranceMs;
      const newlyConfirmed = confirmed && !(same && device.driftConfirmedAt);
      await tx.device.update({
        where: { deviceId },
        data: {
          driftKind: kind,
          driftSessionId,
          driftSince: since,
          driftConfirmedAt: confirmed ? (same && device.driftConfirmedAt) || now : null,
        },
      });

      if (newlyConfirmed) {
        this.logger.warn({ deviceId, kind, sessionId: driftSessionId }, 'DEVICE_DRIFT');
        const s = await tx.washSession.findFirst({ where: { id: driftSessionId!, bayId } });
        if (s) {
          await this.transition(tx, s.id, s.status, s.status, 'DEVICE_DRIFT', {
            kind,
            deviceId,
            reportedRelayIndex: p.relayIndex ?? null,
          });
        }
      }

      if ((kind === 'UNEXPECTED_RUNNING' || kind === 'SESSION_MISMATCH') && p.sessionId) {
        const last = device.lastDriftStopAt?.getTime() ?? 0;
        if (now.getTime() - last >= this.timings.stopRetryMs) {
          await this.enqueueStrayStop(tx, bayId, p.sessionId);
          await tx.device.update({ where: { deviceId }, data: { lastDriftStopAt: now } });
        }
      }
    });
  }

  /** Cihazin calistirdigi (aktif olmayan) seansi durdurur. Firmware sessionId eslesirse uygular. */
  private async enqueueStrayStop(tx: Tx, bayId: string, sessionId: string): Promise<void> {
    const bay = await tx.bay.findUniqueOrThrow({
      where: { id: bayId },
      include: { station: true },
    });
    const payload: StopCommandPayload = { type: 'STOP', reason: 'DRIFT' };
    await this.outbox.enqueue(tx, {
      topic: commandTopic(bay.station.code, bay.bayCode),
      envelope: {
        commandId: randomUUID(),
        sessionId,
        timestamp: this.clock().toISOString(),
        payload,
      },
      sessionId,
    });
  }

  /** STOPPED_ACK geldi: STOP cihaza ulasti, yeniden gonderim durur. */
  private async confirmStop(tx: Tx, topic: ParsedTopic, sessionId: string): Promise<void> {
    const s = await this.lockSession(tx, { id: sessionId });
    if (!s || !sameBay(s, topic) || !s.stopRequestedAt || s.stopConfirmedAt) return;
    await tx.washSession.update({ where: { id: s.id }, data: { stopConfirmedAt: this.clock() } });
  }

  private async hasTransition(tx: Tx, sessionId: string, reason: string): Promise<boolean> {
    return (await tx.sessionTransition.count({ where: { sessionId, reason } })) > 0;
  }

  private async fail(tx: Tx, s: WashSession, reason: string, bayStatus: BayStatus): Promise<void> {
    await this.wallets.releaseTx(tx, s.holdId);
    await tx.washSession.update({
      where: { id: s.id },
      data: {
        status: SessionStatus.FAILED,
        endedAt: this.clock(),
        endReason: reason,
        usedSeconds: 0,
        chargedKurus: 0n,
      },
    });
    await tx.bay.update({ where: { id: s.bayId }, data: { status: bayStatus } });
    await this.transition(tx, s.id, s.status, SessionStatus.FAILED, reason);
  }

  /**
   * STOP'u outbox'a yazar ve takibini baslatir. Ilk durdurma ani korunur (tahsilat tavani).
   * Yeni bir STOP nedeni onceki onayi gecersiz kilar ve deneme sayacini sifirlar; tarama
   * yeniden gonderimi (retry) sayaci artirir.
   */
  private async enqueueStop(
    tx: Tx,
    s: SessionWithBay,
    reason: StopReason,
    retry = false,
  ): Promise<void> {
    const now = this.clock();
    await tx.washSession.update({
      where: { id: s.id },
      data: {
        stopRequestedAt: s.stopRequestedAt ?? now,
        stopReason: reason,
        lastStopSentAt: now,
        ...(retry
          ? { stopAttempts: { increment: 1 } }
          : { stopAttempts: 1, stopConfirmedAt: null }),
      },
    });
    const payload: StopCommandPayload = { type: 'STOP', reason };
    await this.outbox.enqueue(tx, {
      topic: commandTopic(s.bay.station.code, s.bay.bayCode),
      envelope: {
        commandId: randomUUID(),
        sessionId: s.id,
        timestamp: this.clock().toISOString(),
        payload,
      },
      sessionId: s.id,
    });
  }

  private async recordDeviceState(topic: ParsedTopic, msg: DeviceMessage): Promise<void> {
    const now = this.clock();
    const bay = await this.prisma.bay.findUnique({
      where: { bayCode: topic.bayCode },
      include: { station: true, device: true },
    });
    const bayMatches = bay !== null && bay.station.code === topic.stationCode;
    const boundElsewhere = bayMatches && bay.device && bay.device.deviceId !== msg.deviceId;
    if (boundElsewhere) {
      this.logger.warn(
        { bayCode: topic.bayCode, deviceId: msg.deviceId, boundDeviceId: bay.device!.deviceId },
        'Perona baska bir cihaz bagli; yeni cihaz perona baglanmadi',
      );
    }
    const bayId = bayMatches && !boundElsewhere ? bay.id : undefined;

    const p = msg.payload;
    const reportedStatus =
      p.type === 'DEVICE_STATUS'
        ? p.status
        : p.type === 'HEARTBEAT' && p.sessionActive
          ? 'BUSY'
          : 'ONLINE';
    const firmwareVersion = 'firmwareVersion' in p ? p.firmwareVersion : undefined;
    const resetReason = p.type === 'DEVICE_STATUS' ? p.resetReason : undefined;

    await this.prisma.device.upsert({
      where: { deviceId: msg.deviceId },
      create: {
        deviceId: msg.deviceId,
        bayId: bayId ?? null,
        reportedStatus,
        firmwareVersion: firmwareVersion ?? null,
        resetReason: resetReason ?? null,
        lastSeenAt: now,
      },
      update: {
        ...(bayId ? { bayId } : {}),
        ...(p.type === 'DEVICE_STATUS' || p.type === 'HEARTBEAT' ? { reportedStatus } : {}),
        ...(firmwareVersion ? { firmwareVersion } : {}),
        ...(resetReason !== undefined ? { resetReason } : {}),
        lastSeenAt: now,
      },
    });

    // Yalnizca perona bagli cihazin heartbeat'i kullanim kaniti sayilir.
    if (bayId && p.type === 'HEARTBEAT' && p.sessionId && p.remainingSec !== undefined) {
      await this.recordProvenUsage(this.prisma, bayId, p.sessionId, p.remainingSec);
    }

    if (bayId && p.type === 'HEARTBEAT') await this.evaluateTwin(bayId, msg.deviceId, p);

    // Peron durumu yalnizca bilgi amaclidir; seans karari seans tablosundan verilir.
    if (bayId && p.type === 'DEVICE_STATUS') {
      if (p.status === 'OFFLINE') {
        await this.prisma.bay.updateMany({
          where: { id: bayId, status: { in: [BayStatus.IDLE, BayStatus.ERROR] } },
          data: { status: BayStatus.OFFLINE },
        });
      } else if (p.status === 'ONLINE') {
        await this.prisma.bay.updateMany({
          where: { id: bayId, status: { in: [BayStatus.OFFLINE, BayStatus.ERROR] } },
          data: { status: BayStatus.IDLE },
        });
      }
    }
  }

  private assertBayUsable(bay: BayWithDevice): void {
    const reason = this.bayProblem(bay);
    if (reason) throw new BayUnavailableError(bay.bayCode, reason);
  }

  /**
   * Peronun cihaz/bakim durumu. null: baslatilabilir. Seans baslatma ve QR onay ekrani
   * ayni kurali kullanir (onay ekraninda "uygun" gorunen peron baslatmada reddedilmesin).
   */
  bayProblem(bay: BayWithDevice): string | null {
    if (bay.status === BayStatus.MAINTENANCE || bay.maintenanceAt) return 'MAINTENANCE';
    if (!bay.device) return 'NO_DEVICE';
    if (bay.device.reportedStatus !== 'ONLINE') return `DEVICE_${bay.device.reportedStatus}`;
    const age = this.clock().getTime() - bay.device.lastSeenAt.getTime();
    if (age > this.timings.deviceStaleMs) return 'DEVICE_STALE';
    return null;
  }

  private async findReplay(input: StartSessionInput): Promise<WashSession | null> {
    const existing = await this.prisma.washSession.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { bay: true, program: true },
    });
    if (!existing) return null;
    const same =
      existing.userId === input.userId &&
      existing.bay.bayCode === input.bayCode &&
      existing.program.code === input.programCode &&
      existing.plannedDurationSec === input.durationSec;
    if (!same) throw new SessionIdempotencyConflictError(input.idempotencyKey);
    const { bay: _bay, program: _program, ...session } = existing;
    return session;
  }

  /** Seans satirini kilitler. skipLocked: baska islem tutuyorsa beklemeden atla (tarama). */
  private async lockSession(
    tx: Tx,
    where: { id: string } | { startCommandId: string },
    skipLocked = false,
  ): Promise<SessionWithBay | null> {
    const rows =
      'id' in where
        ? skipLocked
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "WashSession" WHERE "id" = ${where.id} FOR UPDATE SKIP LOCKED`
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "WashSession" WHERE "id" = ${where.id} FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "WashSession" WHERE "startCommandId" = ${where.startCommandId} FOR UPDATE`;
    if (rows.length === 0) return null;
    return tx.washSession.findUniqueOrThrow({
      where: { id: rows[0]!.id },
      include: { bay: { include: { station: { select: { code: true } } } } },
    });
  }

  /** Ayni eventId ikinci kez gelirse false. Transaction geri alinirsa kayit da geri alinir. */
  private async claimInbox(tx: Tx, messageId: string, topic: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ messageId: string }[]>`
      INSERT INTO "InboxMessage" ("messageId", "topic", "receivedAt")
      VALUES (${messageId}, ${topic}, ${this.clock()})
      ON CONFLICT ("messageId") DO NOTHING
      RETURNING "messageId"`;
    return rows.length > 0;
  }

  private async transition(
    tx: Tx,
    sessionId: string,
    fromState: SessionStatus | null,
    toState: SessionStatus,
    reason: string,
    detail?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.sessionTransition.create({
      data: {
        sessionId,
        fromState,
        toState,
        reason,
        detail: detail ?? Prisma.JsonNull,
        createdAt: this.clock(),
      },
    });
    // Anlik bildirim (Faz 5c). PostgreSQL NOTIFY'i yalniz commit'te iletir: geri alinan
    // transaction musteriye hic gorunmez. Ayni transaction'daki tekrarlar tek bildirime iner.
    await tx.$queryRaw`SELECT pg_notify(${SESSION_CHANNEL}, ${sessionId})::text`;
  }

  private bayMismatch(s: SessionWithBay, topic: ParsedTopic): DeviceMessageOutcome {
    // Bir cihaz baska peronun seansini degistiremez (ACL'ye ek uygulama katmani kontrolu).
    this.logger.warn(
      { sessionId: s.id, sessionBay: s.bay.bayCode, topicBay: topic.bayCode },
      'Cihaz mesaji seansin peronuyla eslesmiyor; yok sayildi',
    );
    return 'BAY_MISMATCH';
  }
}

function sameBay(s: SessionWithBay, topic: ParsedTopic): boolean {
  return s.bay.bayCode === topic.bayCode && s.bay.station.code === topic.stationCode;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
