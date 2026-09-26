import {
  Body,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AdminMe,
  type AdminRefundRequest,
  type AdminStation,
  type AdminUserDetail,
  type AdminUserSummary,
  type BalanceAdjustmentRequest,
  BalanceAdjustmentRequestSchema,
  type BalanceAdjustmentResult,
  type CashReport,
  type CashReportQuery,
  CashReportQuerySchema,
  type CashTopUpReceipt,
  type CashTopUpRequest,
  CashTopUpRequestSchema,
  type RejectRefundRequest,
  RejectRefundRequestSchema,
  type ResolvePayoutRequest,
  ResolvePayoutRequestSchema,
  type TopUpSettingsView,
  type UpdateTopUpSettingsRequest,
  UpdateTopUpSettingsRequestSchema,
} from '@qwash/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { RefundRequestStatus } from '../generated/prisma/enums';
import { ZodBody } from '../http/api-envelope';
import { IdempotencyKeyRequiredError } from '../payments/payments.errors';
import { AdminGuard, adminFromRequest, type AdminActor, SuperAdminOnly } from './admin.guard';
import { AdminService } from './admin.service';
import { RefundAdminService } from './refund-admin.service';

const CurrentAdmin = createParamDecorator((_: unknown, context: ExecutionContext): AdminActor =>
  adminFromRequest(context.switchToHttp().getRequest<Request>()),
);

/** Para hareket ettiren uclarda zorunlu; cift tiklama ve ag tekrari ikinci hareket uretmez. */
function requireKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length > 100) throw new IdempotencyKeyRequiredError();
  return key;
}

const RefundStatusQuery = z.enum(RefundRequestStatus).optional();

@ApiTags('admin')
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly refunds: RefundAdminService,
  ) {}

  @Get('me')
  me(@CurrentAdmin() actor: AdminActor): Promise<AdminMe> {
    return this.admin.me(actor);
  }

  @Get('stations')
  stations(): Promise<AdminStation[]> {
    return this.admin.stations();
  }

  // --- Kullanici ve cuzdan ---------------------------------------------------

  @Get('users')
  searchUsers(@Query('q') q: string | undefined): Promise<AdminUserSummary[]> {
    return this.admin.searchUsers(q ?? '');
  }

  @Get('users/:id')
  userDetail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDetail> {
    return this.admin.userDetail(id);
  }

  @Post('users/:id/adjustments')
  @HttpCode(200)
  @SuperAdminOnly()
  adjust(
    @CurrentAdmin() actor: AdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBody(BalanceAdjustmentRequestSchema)) body: BalanceAdjustmentRequest,
  ): Promise<BalanceAdjustmentResult> {
    return this.admin.adjustBalance(actor, id, body, requireKey(key));
  }

  // --- Nakit yukleme ve kasa ----------------------------------------------------

  @Post('cash-topups')
  @HttpCode(200)
  cashTopUp(
    @CurrentAdmin() actor: AdminActor,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBody(CashTopUpRequestSchema)) body: CashTopUpRequest,
  ): Promise<CashTopUpReceipt> {
    return this.admin.cashTopUp(actor, body, requireKey(key));
  }

  @Get('reports/cash')
  cashReport(
    @Query(new ZodBody(CashReportQuerySchema)) query: CashReportQuery,
  ): Promise<CashReport> {
    return this.admin.cashReport(query);
  }

  // --- Iade talepleri ----------------------------------------------------------

  @Get('refund-requests')
  listRefunds(
    @Query('status', new ZodBody(RefundStatusQuery)) status: RefundRequestStatus | undefined,
  ): Promise<AdminRefundRequest[]> {
    return this.refunds.list(status);
  }

  @Get('refund-requests/:id')
  getRefund(@Param('id', ParseUUIDPipe) id: string): Promise<AdminRefundRequest> {
    return this.refunds.get(id);
  }

  @Post('refund-requests/:id/payouts/:index/card-refund')
  @HttpCode(200)
  sendCardPayout(
    @CurrentAdmin() actor: AdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<AdminRefundRequest> {
    return this.refunds.sendCardPayout(actor, id, index);
  }

  @Post('refund-requests/:id/payouts/:index/resolve')
  @HttpCode(200)
  resolvePayout(
    @CurrentAdmin() actor: AdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body(new ZodBody(ResolvePayoutRequestSchema)) body: ResolvePayoutRequest,
  ): Promise<AdminRefundRequest> {
    return this.refunds.resolvePayout(actor, id, index, body);
  }

  @Post('refund-requests/:id/reject')
  @HttpCode(200)
  rejectRefund(
    @CurrentAdmin() actor: AdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(RejectRefundRequestSchema)) body: RejectRefundRequest,
  ): Promise<AdminRefundRequest> {
    return this.refunds.reject(actor, id, body.reason);
  }

  // --- Ayarlar -----------------------------------------------------------------

  @Get('settings/topup')
  topUpSettings(): Promise<TopUpSettingsView> {
    return this.admin.topUpSettings();
  }

  @Put('settings/topup')
  @SuperAdminOnly()
  updateTopUpSettings(
    @CurrentAdmin() actor: AdminActor,
    @Body(new ZodBody(UpdateTopUpSettingsRequestSchema)) body: UpdateTopUpSettingsRequest,
  ): Promise<TopUpSettingsView> {
    return this.admin.updateTopUpSettings(actor, body);
  }
}
