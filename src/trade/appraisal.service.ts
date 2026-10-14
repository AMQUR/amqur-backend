import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TradeAppraisal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Provider-neutral trade-in appraisal lifecycle.
 *
 * Valuation sources (vAuto, Manheim MMR, CARFAX History-Based Value, KBB, Black Book,
 * ACV/ClearCar) each require their own license, and display rights differ per provider.
 * Owning CARFAX vehicle-history access does NOT grant valuation rights. Until a provider is
 * licensed and its official contract implemented, the registry is empty and every request
 * is routed to a human appraisal queue. No value is ever estimated by AMQUR itself.
 */
export type AppraisalKind =
  | 'MARKET_ESTIMATE'
  | 'PRELIMINARY_ESTIMATE'
  | 'DEALER_APPRAISAL'
  | 'FINAL_OFFER';

export const CANDIDATE_PROVIDERS = [
  { id: 'vauto', name: 'vAuto (Provision)', status: 'NOT_LICENSED' },
  { id: 'manheim_mmr', name: 'Manheim Market Report', status: 'NOT_LICENSED' },
  {
    id: 'carfax_hbv',
    name: 'CARFAX History-Based Value',
    status: 'NOT_LICENSED',
  },
  { id: 'kbb', name: 'Kelley Blue Book', status: 'NOT_LICENSED' },
  { id: 'black_book', name: 'Black Book', status: 'NOT_LICENSED' },
  { id: 'acv_clearcar', name: 'ACV / ClearCar', status: 'NOT_LICENSED' },
] as const;

export interface AppraisalProvider {
  readonly id: string;
  isConfigured(tenantId: string): Promise<boolean>;
  /** Must come from the provider's official API; display rights returned by the provider/contract. */
  estimate(input: {
    vin?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    mileage?: number | null;
    zip?: string | null;
    condition?: string | null;
  }): Promise<{
    kind: 'MARKET_ESTIMATE' | 'PRELIMINARY_ESTIMATE';
    amount?: number;
    amountLow?: number;
    amountHigh?: number;
    providerRef: string;
    displayPermitted: boolean;
  } | null>;
}

const MANAGER_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);
const STAFF_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']);

/** What the CUSTOMER may see right now for a trade (pure — unit tested). */
export function customerVisibleValue(
  rows: Pick<
    TradeAppraisal,
    | 'kind'
    | 'status'
    | 'displayPermitted'
    | 'amount'
    | 'amountLow'
    | 'amountHigh'
    | 'expiresAt'
    | 'createdAt'
  >[],
  now = new Date(),
): {
  kind: AppraisalKind;
  amount: number | null;
  low: number | null;
  high: number | null;
  expiresAt: Date | null;
} | null {
  const live = rows
    .filter(
      (r) =>
        r.status === 'ACTIVE' &&
        r.displayPermitted &&
        (!r.expiresAt || r.expiresAt > now) &&
        (r.amount != null || (r.amountLow != null && r.amountHigh != null)),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // A final offer outranks an appraisal, which outranks any estimate.
  const rank: Record<string, number> = {
    FINAL_OFFER: 0,
    DEALER_APPRAISAL: 1,
    PRELIMINARY_ESTIMATE: 2,
    MARKET_ESTIMATE: 3,
  };
  live.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  const r = live[0];
  if (!r) return null;
  return {
    kind: r.kind as AppraisalKind,
    amount: r.amount ?? null,
    low: r.amountLow ?? null,
    high: r.amountHigh ?? null,
    expiresAt: r.expiresAt ?? null,
  };
}

@Injectable()
export class AppraisalService {
  /** Licensed providers get registered here once their official contract is implemented. */
  private readonly providers: AppraisalProvider[] = [];

  constructor(private readonly prisma: PrismaService) {}

  providerStatus() {
    return CANDIDATE_PROVIDERS.map((p) => ({
      ...p,
      registered: this.providers.some((x) => x.id === p.id),
    }));
  }

  private async trade(tenantId: string, id: string) {
    const t = await this.prisma.tradeRequest.findFirst({
      where: { id, tenantId },
    });
    if (!t) throw new NotFoundException('Trade request not found');
    return t;
  }

  /** Try licensed providers; otherwise queue for a human appraiser. Never invents a value. */
  async requestEstimate(tenantId: string, tradeRequestId: string) {
    const t = await this.trade(tenantId, tradeRequestId);
    for (const p of this.providers) {
      if (!(await p.isConfigured(tenantId))) continue;
      const est = await p.estimate(t);
      if (!est) continue;
      return this.prisma.tradeAppraisal.create({
        data: {
          tenantId,
          tradeRequestId,
          kind: est.kind,
          provider: p.id,
          providerRef: est.providerRef,
          amount: est.amount ?? null,
          amountLow: est.amountLow ?? null,
          amountHigh: est.amountHigh ?? null,
          displayPermitted: est.displayPermitted,
        },
      });
    }
    await this.prisma.tradeRequest.update({
      where: { id: t.id },
      data: { status: 'APPRAISAL_PENDING' },
    });
    return null;
  }

  async list(tenantId: string, tradeRequestId: string) {
    await this.trade(tenantId, tradeRequestId);
    return this.prisma.tradeAppraisal.findMany({
      where: { tenantId, tradeRequestId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async audit(
    tenantId: string,
    userId: string,
    action: string,
    id: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action,
        resource: 'TradeRequest',
        resourceId: id,
        metadata: meta as Prisma.InputJsonValue,
      },
    });
  }

  /** Staff appraisal after review/inspection. */
  async recordAppraisal(
    tenantId: string,
    user: { id: string; role: string },
    tradeRequestId: string,
    input: {
      amount: number;
      conditionBasis?: string;
      notes?: string;
      showToCustomer?: boolean;
    },
  ) {
    if (!STAFF_ROLES.has(user.role)) throw new ForbiddenException();
    if (!(input.amount > 0 && input.amount < 500_000))
      throw new BadRequestException('amount out of range');
    await this.trade(tenantId, tradeRequestId);
    await this.prisma.tradeAppraisal.updateMany({
      where: {
        tenantId,
        tradeRequestId,
        status: 'ACTIVE',
        kind: 'DEALER_APPRAISAL',
      },
      data: { status: 'SUPERSEDED' },
    });
    const row = await this.prisma.tradeAppraisal.create({
      data: {
        tenantId,
        tradeRequestId,
        kind: 'DEALER_APPRAISAL',
        provider: 'staff',
        amount: input.amount,
        conditionBasis: input.conditionBasis?.slice(0, 200) ?? null,
        notes: input.notes?.slice(0, 1000) ?? null,
        // Only a manager can release a staff appraisal to the customer.
        displayPermitted:
          input.showToCustomer === true && MANAGER_ROLES.has(user.role),
        createdById: user.id,
      },
    });
    await this.audit(
      tenantId,
      user.id,
      'trade.appraisal.recorded',
      tradeRequestId,
      {
        amount: input.amount,
        appraisalId: row.id,
        displayPermitted: row.displayPermitted,
      },
    );
    return row;
  }

  /** Manager-approved, expiring offer. */
  async issueOffer(
    tenantId: string,
    user: { id: string; role: string },
    tradeRequestId: string,
    input: { amount: number; validDays: number; notes?: string },
  ) {
    if (!MANAGER_ROLES.has(user.role))
      throw new ForbiddenException('Only managers can issue trade offers');
    if (!(input.amount > 0 && input.amount < 500_000))
      throw new BadRequestException('amount out of range');
    if (!(input.validDays >= 1 && input.validDays <= 30))
      throw new BadRequestException('validDays must be 1–30');
    await this.trade(tenantId, tradeRequestId);
    await this.prisma.tradeAppraisal.updateMany({
      where: {
        tenantId,
        tradeRequestId,
        status: 'ACTIVE',
        kind: 'FINAL_OFFER',
      },
      data: { status: 'SUPERSEDED' },
    });
    const now = new Date();
    const row = await this.prisma.tradeAppraisal.create({
      data: {
        tenantId,
        tradeRequestId,
        kind: 'FINAL_OFFER',
        provider: 'staff',
        amount: input.amount,
        displayPermitted: true,
        createdById: user.id,
        approvedById: user.id,
        approvedAt: now,
        expiresAt: new Date(now.getTime() + input.validDays * 86_400_000),
        notes: input.notes?.slice(0, 1000) ?? null,
      },
    });
    await this.prisma.tradeRequest.update({
      where: { id: tradeRequestId },
      data: {
        status: 'QUOTED',
        appraisalVerified: true,
        appraisalValue: input.amount,
      },
    });
    await this.audit(tenantId, user.id, 'trade.offer.issued', tradeRequestId, {
      amount: input.amount,
      validDays: input.validDays,
      appraisalId: row.id,
    });
    return row;
  }

  /** Customer counter-offer or decline, recorded for staff (never auto-accepted). */
  async respond(
    tenantId: string,
    appraisalId: string,
    response: { decline?: boolean; counterAmount?: number },
  ) {
    const row = await this.prisma.tradeAppraisal.findFirst({
      where: {
        id: appraisalId,
        tenantId,
        kind: 'FINAL_OFFER',
        status: 'ACTIVE',
      },
    });
    if (!row)
      throw new NotFoundException('Offer not found or no longer active');
    if (row.expiresAt && row.expiresAt <= new Date()) {
      await this.prisma.tradeAppraisal.update({
        where: { id: row.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Offer expired');
    }
    return this.prisma.tradeAppraisal.update({
      where: { id: row.id },
      data: response.decline
        ? { status: 'DECLINED' }
        : {
            status: 'COUNTERED',
            counterAmount: response.counterAmount ?? null,
          },
    });
  }

  async customerValue(tenantId: string, tradeRequestId: string) {
    const rows = await this.prisma.tradeAppraisal.findMany({
      where: { tenantId, tradeRequestId },
    });
    return customerVisibleValue(rows);
  }
}
