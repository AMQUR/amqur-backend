import { Injectable, Optional } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { CampaignEngine } from '../messaging/campaign.engine';
import { PrismaService } from '../prisma/prisma.service';

/** Structured reconciliation input — never inferred from chat/AI text. */
export type SoldDealInputSource = 'staff' | 'dms';

export type RecordSoldDealInput = {
  locationId: string;
  source: SoldDealInputSource;
  /** Authoritative DMS deal / contract identifier */
  dmsDealId: string;
  leadId?: string;
  vin?: string;
  stockNumber?: string;
  /** ISO timestamp from DMS when available */
  soldAt?: string;
};

export type RecordSoldDealActor = {
  id: string;
  role: string;
};

export type RecordSoldDealResult =
  | {
      accepted: true;
      dmsDealId: string;
      leadId?: string;
    }
  | {
      accepted: false;
      reason:
        | 'dms_not_connected'
        | 'invalid_input'
        | 'lead_not_found'
        | 'lead_not_eligible';
    };

const CONVERTIBLE: LeadStatus[] = [
  LeadStatus.OPEN,
  LeadStatus.CONTACTED,
  LeadStatus.QUALIFIED,
];

/**
 * Fail-closed sold-deal reconciliation: accepts only structured staff or DMS
 * payloads when an enabled, live DMS integration exists. Never marks inventory sold.
 */
@Injectable()
export class SoldDealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly campaigns?: CampaignEngine,
  ) {}

  async recordSoldDeal(
    tenantId: string,
    actor: RecordSoldDealActor,
    input: RecordSoldDealInput,
  ): Promise<RecordSoldDealResult> {
    const dmsDealId = input.dmsDealId?.trim();
    if (
      !input.locationId?.trim() ||
      !dmsDealId ||
      (input.source !== 'staff' && input.source !== 'dms')
    ) {
      return { accepted: false, reason: 'invalid_input' };
    }

    const locationId = input.locationId.trim();
    const connected = await this.dmsConnected(tenantId, locationId);
    if (!connected) {
      return { accepted: false, reason: 'dms_not_connected' };
    }

    let leadId: string | undefined;
    let conversationId: string | null = null;
    if (input.leadId?.trim()) {
      const lead = await this.prisma.lead.findFirst({
        where: {
          id: input.leadId.trim(),
          tenantId,
          locationId,
        },
        select: {
          id: true,
          status: true,
          notes: true,
          conversationId: true,
        },
      });
      if (!lead) {
        return { accepted: false, reason: 'lead_not_found' };
      }
      if (!CONVERTIBLE.includes(lead.status)) {
        return { accepted: false, reason: 'lead_not_eligible' };
      }
      const stamp = `[sold:${dmsDealId}]`;
      const notes = lead.notes?.includes(stamp)
        ? lead.notes
        : [lead.notes, stamp].filter(Boolean).join('\n');
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { status: LeadStatus.CONVERTED, notes },
      });
      leadId = lead.id;
      conversationId = lead.conversationId;
    }

    const soldAt =
      input.soldAt && !Number.isNaN(Date.parse(input.soldAt))
        ? new Date(input.soldAt).toISOString()
        : undefined;

    // Attribute only when a campaignId was already persisted on an inbound message
    // (e.g. campaign SMS reply). Never invent campaign→sale links.
    const campaignId = conversationId
      ? await this.lastPersistedCampaignId(conversationId)
      : null;

    await this.analytics.trackEvent(
      tenantId,
      locationId,
      'deal.sold_recorded',
      {
        dmsDealId,
        source: input.source,
        leadId,
        vin: input.vin?.trim() || undefined,
        stockNumber: input.stockNumber?.trim() || undefined,
        soldAt,
        recordedByStaffId: input.source === 'staff' ? actor.id : undefined,
        staffRole: input.source === 'staff' ? actor.role : undefined,
        ...(campaignId ? { campaignId } : {}),
      },
    );

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: input.source === 'staff' ? actor.id : null,
        action: 'deal.sold_recorded',
        resource: 'lead',
        resourceId: leadId ?? null,
        metadata: {
          dmsDealId,
          source: input.source,
          locationId,
          vin: input.vin?.trim() || null,
          stockNumber: input.stockNumber?.trim() || null,
          soldAt: soldAt ?? null,
        },
      },
    });

    // Post-sale campaign enrollment only when a converted lead exists.
    // Still gated by automatedFollowup + per-campaign enabled + MARKETING consent at send.
    if (leadId) {
      await this.campaigns?.onEvent({
        tenantId,
        locationId,
        trigger: 'deal.sold_recorded',
        subjectId: leadId,
      });
      // Internal SALES CSI draft for staff follow-up — never auto-SMS, not OEM CSI.
      await this.prisma.customerSurvey
        .create({
          data: {
            tenantId,
            locationId,
            leadId,
            conversationId,
            kind: 'SALES',
            channel: 'IN_PERSON',
            status: 'DRAFT',
            metadata: {
              trigger: 'deal_sold',
              dmsDealId,
              note: 'Staff-recorded CSI draft — not an OEM manufacturer survey',
            },
          },
        })
        .catch(() => null);
    }

    return { accepted: true, dmsDealId, leadId };
  }

  /**
   * Latest campaignId already stored on a USER message for this conversation.
   * Returns null when none — never guesses from timing alone.
   */
  private async lastPersistedCampaignId(
    conversationId: string,
  ): Promise<string | null> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId, role: 'USER' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { metadata: true },
    });
    for (const row of rows) {
      const meta = row.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      const id = (meta as { campaignId?: unknown }).campaignId;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
  }

  /** Live DMS connection required before any sold attribution is persisted. */
  private async dmsConnected(
    tenantId: string,
    locationId: string,
  ): Promise<boolean> {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        capability: 'dms',
        enabled: true,
        liveReady: true,
        OR: [{ locationId }, { locationId: null }],
      },
      select: { id: true },
    });
    return conn != null;
  }
}
