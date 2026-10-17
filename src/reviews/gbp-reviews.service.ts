import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DisabledGbpReviewsProvider,
  gbpReviewsBlocked,
  type DraftReplyParams,
  type DraftReplyResult,
  type ListPendingReviewsParams,
  type ListPendingReviewsResult,
  type PublishReplyParams,
  type PublishReplyResult,
} from '../integrations/gbp/gbp-reviews.provider';

/** IntegrationConnection.capability for GBP review reply workflow. */
export const GBP_REVIEWS_CAPABILITY = 'google_business_profile';

/**
 * Fail-closed GBP review workflow: staff may list/draft/publish only when a
 * live-ready connection exists and a verified provider adapter is configured.
 */
@Injectable()
export class GbpReviewsService {
  private readonly provider = new DisabledGbpReviewsProvider();

  constructor(private readonly prisma: PrismaService) {}

  async listPendingReviews(
    params: ListPendingReviewsParams,
  ): Promise<ListPendingReviewsResult> {
    const gate = await this.resolveGate(params.tenantId, params.locationId);
    if (!gate.allowed) {
      return gbpReviewsBlocked(gate.reason);
    }
    return this.provider.listPendingReviews(params);
  }

  async draftReply(params: DraftReplyParams): Promise<DraftReplyResult> {
    const gate = await this.resolveGate(params.tenantId, params.locationId);
    if (!gate.allowed) {
      return gbpReviewsBlocked(gate.reason);
    }
    return this.provider.draftReply(params);
  }

  async publishReply(params: PublishReplyParams): Promise<PublishReplyResult> {
    const gate = await this.resolveGate(params.tenantId, params.locationId);
    if (!gate.allowed) {
      return gbpReviewsBlocked(gate.reason);
    }
    return this.provider.publishReply(params);
  }

  private async resolveGate(
    tenantId: string,
    locationId?: string | null,
  ): Promise<
    | { allowed: true }
    | { allowed: false; reason: 'not_connected' | 'not_configured' }
  > {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        capability: GBP_REVIEWS_CAPABILITY,
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
    if (!this.provider.isLiveConfigured()) {
      return { allowed: false, reason: 'not_configured' };
    }
    return { allowed: true };
  }
}
