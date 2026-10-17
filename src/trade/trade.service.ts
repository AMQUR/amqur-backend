import { Injectable } from '@nestjs/common';
import { TradeRequest, TradeRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ProviderContext,
  TradeProvider,
} from '../integrations/contracts/provider.interfaces';
import {
  DisabledTradeValuationProvider,
  tradeValuationBlocked,
  type GetValuationParams,
  type GetValuationResult,
} from '../integrations/trade/trade-valuation.provider';

/** IntegrationConnection.capability for licensed trade valuation APIs. */
export const TRADE_VALUATION_CAPABILITY = 'trade_valuation';

/** Stub — never invent appraisal values. */
export class DisabledTradeProvider implements TradeProvider {
  readonly name = 'disabled_trade';
  async isLiveReady(_ctx: ProviderContext): Promise<boolean> {
    return false;
  }
  async health(
    _ctx: ProviderContext,
  ): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: 'trade_provider_disabled' };
  }
  async requestAppraisal(
    _ctx: ProviderContext,
    _payload: Record<string, unknown>,
  ): Promise<{
    verified: boolean;
    appraisalValue?: number;
  }> {
    return { verified: false };
  }
}

@Injectable()
export class TradeService {
  private readonly provider = new DisabledTradeProvider();
  private readonly valuationProvider = new DisabledTradeValuationProvider();

  constructor(private readonly prisma: PrismaService) {}

  getProvider(): TradeProvider {
    return this.provider;
  }

  async createRequest(params: {
    tenantId: string;
    locationId?: string | null;
    conversationId?: string | null;
    vin?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    mileage?: number | null;
    condition?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerEmail?: string | null;
    notes?: string | null;
    photoFileIds?: string[];
  }) {
    const created = await this.prisma.tradeRequest.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: params.conversationId ?? null,
        vin: params.vin?.toUpperCase().trim() ?? null,
        year: params.year ?? null,
        make: params.make ?? null,
        model: params.model ?? null,
        trim: params.trim ?? null,
        mileage: params.mileage ?? null,
        condition: params.condition ?? null,
        customerName: params.customerName ?? null,
        customerPhone: params.customerPhone ?? null,
        customerEmail: params.customerEmail ?? null,
        notes: params.notes ?? null,
        photoFileIds: params.photoFileIds ?? [],
        status: TradeRequestStatus.REQUESTED,
        appraisalVerified: false,
        appraisalValue: null,
      },
    });
    await this.notifyTradeAdvisor(created).catch(() => undefined);
    return created;
  }

  /**
   * Queue a trade advisor escalation when chat captures a trade request.
   * Never invents appraisal values — staff must respond.
   */
  private async notifyTradeAdvisor(row: TradeRequest) {
    if (!row.conversationId) return;
    const open = await this.prisma.escalation.findFirst({
      where: {
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
        reason: 'TRADE_ADVISOR',
      },
    });
    if (open) return;
    const vehicle = [row.year, row.make, row.model].filter(Boolean).join(' ');
    const vin = row.vin ? ` VIN ${row.vin}` : '';
    await this.prisma.escalation.create({
      data: {
        tenantId: row.tenantId,
        locationId: row.locationId,
        conversationId: row.conversationId,
        reason: 'TRADE_ADVISOR',
        urgency: 'NORMAL',
        summary:
          `Trade request needs staff review${vehicle ? `: ${vehicle}` : ''}${vin}`.slice(
            0,
            280,
          ),
        metadata: {
          tradeRequestId: row.id,
          appraisalVerified: row.appraisalVerified,
        },
      },
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: row.tenantId,
          locationId: row.locationId,
          eventType: 'trade.advisor_queued',
          properties: { tradeRequestId: row.id },
        },
      })
      .catch(() => null);
  }

  /** Integration gate only — no vehicle input, never returns dollar amounts. */
  async getValuationIntegrationStatus(
    tenantId: string,
    locationId?: string | null,
  ): Promise<
    | {
        status: 'blocked';
        reason: 'not_connected' | 'not_configured';
        verified: false;
      }
    | { status: 'ready'; verified: false; providerId: string }
  > {
    const gate = await this.resolveValuationGate(tenantId, locationId ?? null);
    if (!gate.allowed) {
      return tradeValuationBlocked(gate.reason);
    }
    return {
      status: 'ready',
      verified: false,
      providerId: this.valuationProvider.providerId,
    };
  }

  /** Licensed provider valuation only — never invents dollar amounts. */
  async getValuation(
    ctx: ProviderContext,
    input: Omit<GetValuationParams, 'tenantId' | 'locationId'>,
  ): Promise<GetValuationResult> {
    const gate = await this.resolveValuationGate(
      ctx.tenantId,
      ctx.locationId ?? null,
    );
    if (!gate.allowed) {
      return tradeValuationBlocked(gate.reason);
    }
    return this.valuationProvider.getValuation({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId ?? null,
      ...input,
    });
  }

  private async resolveValuationGate(
    tenantId: string,
    locationId?: string | null,
  ): Promise<
    | { allowed: true }
    | { allowed: false; reason: 'not_connected' | 'not_configured' }
  > {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        capability: TRADE_VALUATION_CAPABILITY,
        enabled: true,
        liveReady: true,
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      select: { id: true },
    });
    if (!conn) {
      return { allowed: false, reason: 'not_connected' };
    }
    if (!this.valuationProvider.isLiveConfigured()) {
      return { allowed: false, reason: 'not_configured' };
    }
    return { allowed: true };
  }

  /** Never invent appraisal — only returns verified values from provider. */
  async fetchVerifiedAppraisal(
    ctx: ProviderContext,
    requestId: string,
  ): Promise<{ verified: boolean; appraisalValue?: number }> {
    const ready = await this.provider.isLiveReady(ctx);
    if (!ready) return { verified: false };
    const result = await this.provider.requestAppraisal!(ctx, { requestId });
    if (result.verified && result.appraisalValue != null) {
      await this.prisma.tradeRequest.updateMany({
        where: { id: requestId, tenantId: ctx.tenantId },
        data: {
          appraisalVerified: true,
          appraisalValue: result.appraisalValue,
        },
      });
    }
    return result;
  }

  customerSafeMessage(): string {
    return (
      'I recorded your trade-in details for our team. ' +
      'I cannot provide an appraisal value until a verified appraisal is completed.'
    );
  }
}
