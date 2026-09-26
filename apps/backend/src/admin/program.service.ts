import { Injectable } from '@nestjs/common';
import type {
  AdminAuditEntry,
  AdminProgram,
  CreateProgramRequest,
  SetBayProgramsRequest,
  UpdateProgramRequest,
} from '@qwash/contracts';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminError, StationNotFoundError } from './admin.errors';
import type { AdminActor } from './admin.guard';
import { writeAudit } from './audit';

const include = {
  bayPrograms: { include: { bay: { select: { bayCode: true } } }, orderBy: { relayIndex: 'asc' } },
} satisfies Prisma.WashProgramInclude;

type ProgramRow = Prisma.WashProgramGetPayload<{ include: typeof include }>;

/**
 * Program ve tarife yonetimi (ADR-0011; yalniz SUPER_ADMIN). Baslayan seans fiyati kendi
 * kaydina kopyaladigi icin fiyat degisikligi suren seansi etkilemez. Silme soft-delete:
 * gecmis seanslar ve ledger referanslari korunur.
 */
@Injectable()
export class ProgramService {
  constructor(private readonly prisma: PrismaService | PrismaClient) {}

  async list(stationId: string | undefined, includeDeleted: boolean): Promise<AdminProgram[]> {
    const rows = await this.prisma.washProgram.findMany({
      where: {
        ...(stationId ? { stationId } : {}),
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      include,
      orderBy: [{ stationId: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(actor: AdminActor, input: CreateProgramRequest): Promise<AdminProgram> {
    const station = await this.prisma.station.findUnique({ where: { id: input.stationId } });
    if (!station) throw new StationNotFoundError();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.washProgram.create({
          data: {
            stationId: input.stationId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            icon: input.icon ?? null,
            pricePerSecondKurus: input.pricePerSecondKurus,
          },
          include,
        });
        await writeAudit(tx, {
          actorId: actor.userId,
          action: 'PROGRAM_CREATED',
          targetType: 'PROGRAM',
          targetId: row.id,
          details: { code: row.code, pricePerSecondKurus: row.pricePerSecondKurus },
        });
        return toView(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AdminError(
          'PROGRAM_CODE_TAKEN',
          'Bu kod bu istasyonda kullanilmis (silinmis program da olabilir). Baska bir kod secin.',
        );
      }
      throw error;
    }
  }

  async update(actor: AdminActor, id: string, input: UpdateProgramRequest): Promise<AdminProgram> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.washProgram.findUnique({ where: { id } });
      if (!before || before.deletedAt) throw programNotFound();
      const row = await tx.washProgram.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          icon: input.icon,
          pricePerSecondKurus: input.pricePerSecondKurus,
          isActive: input.isActive,
        },
        include,
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'PROGRAM_UPDATED',
        targetType: 'PROGRAM',
        targetId: id,
        details: {
          before: {
            name: before.name,
            pricePerSecondKurus: before.pricePerSecondKurus,
            isActive: before.isActive,
          },
          after: {
            name: input.name,
            pricePerSecondKurus: input.pricePerSecondKurus,
            isActive: input.isActive,
          },
        },
      });
      return toView(row);
    });
  }

  async remove(actor: AdminActor, id: string): Promise<AdminProgram> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.washProgram.findUnique({ where: { id } });
      if (!before || before.deletedAt) throw programNotFound();
      const row = await tx.washProgram.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
        include,
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'PROGRAM_DELETED',
        targetType: 'PROGRAM',
        targetId: id,
        details: { code: before.code },
      });
      return toView(row);
    });
  }

  /**
   * Peronun program/role eslemesini tamamen degistirir. Suren seans etkilenmez (role
   * numarasi seansa kopyalanir). Ayni role iki programa atanamaz; iki programin rolelerini
   * takas etmek tek istekte mumkundur.
   */
  async setBayPrograms(
    actor: AdminActor,
    bayId: string,
    input: SetBayProgramsRequest,
  ): Promise<AdminProgram[]> {
    const relays = input.programs.map((p) => p.relayIndex);
    const ids = input.programs.map((p) => p.programId);
    if (new Set(relays).size !== relays.length) {
      throw new AdminError('RELAY_CONFLICT', 'Ayni role kanali iki programa atanamaz.');
    }
    if (new Set(ids).size !== ids.length) {
      throw new AdminError('DUPLICATE_PROGRAM', 'Ayni program peronda iki kez olamaz.');
    }

    await this.prisma.$transaction(async (tx) => {
      const bay = await tx.bay.findUnique({ where: { id: bayId } });
      if (!bay) throw new AdminError('BAY_NOT_FOUND', 'Peron bulunamadi.');
      const programs = await tx.washProgram.findMany({ where: { id: { in: ids } } });
      if (
        programs.length !== ids.length ||
        programs.some((p) => p.stationId !== bay.stationId || p.deletedAt)
      ) {
        throw new AdminError(
          'PROGRAM_NOT_AVAILABLE',
          'Programlardan biri bulunamadi, silinmis veya baska istasyona ait.',
        );
      }
      const before = await tx.bayProgram.findMany({ where: { bayId } });
      await tx.bayProgram.deleteMany({ where: { bayId } });
      await tx.bayProgram.createMany({ data: input.programs.map((p) => ({ bayId, ...p })) });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'BAY_PROGRAMS_SET',
        targetType: 'BAY',
        targetId: bayId,
        details: {
          before: before.map((b) => ({
            programId: b.programId,
            relayIndex: b.relayIndex,
            isEnabled: b.isEnabled,
          })),
          after: input.programs,
        },
      });
    });
    const bay = await this.prisma.bay.findUniqueOrThrow({ where: { id: bayId } });
    return this.list(bay.stationId, false);
  }

  async auditLog(
    limit: number,
    targetType?: string,
    targetId?: string,
  ): Promise<AdminAuditEntry[]> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true },
    });
    const email = new Map(actors.map((a) => [a.id, a.email]));
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorEmail: r.actorId ? (email.get(r.actorId) ?? null) : null,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function programNotFound(): AdminError {
  return new AdminError('PROGRAM_NOT_FOUND', 'Program bulunamadi veya silinmis.');
}

function toView(p: ProgramRow): AdminProgram {
  return {
    id: p.id,
    stationId: p.stationId,
    code: p.code,
    name: p.name,
    description: p.description,
    icon: p.icon,
    pricePerSecondKurus: p.pricePerSecondKurus,
    isActive: p.isActive,
    deleted: p.deletedAt !== null,
    bays: p.bayPrograms.map((b) => ({
      bayId: b.bayId,
      bayCode: b.bay.bayCode,
      relayIndex: b.relayIndex,
      isEnabled: b.isEnabled,
    })),
  };
}
