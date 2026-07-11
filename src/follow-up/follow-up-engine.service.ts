import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Follow-up campaign engine skeleton.
 * Never dispatches live communications until a messaging provider is configured
 * AND the tenant enables the campaign.
 */
@Injectable()
export class FollowUpEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async listEnabled(tenantId: string) {
    return this.prisma.followUpCampaign.findMany({
      where: { tenantId, enabled: true },
    });
  }

  async evaluateDispatch(params: {
    tenantId: string;
    campaignName: string;
    consentSms?: boolean;
    consentEmail?: boolean;
    optOut?: boolean;
  }): Promise<{ allowed: boolean; reason: string }> {
    if (params.optOut) {
      return { allowed: false, reason: 'opt_out' };
    }
    const campaign = await this.prisma.followUpCampaign.findUnique({
      where: {
        tenantId_name: {
          tenantId: params.tenantId,
          name: params.campaignName,
        },
      },
    });
    if (!campaign || !campaign.enabled) {
      return { allowed: false, reason: 'campaign_disabled' };
    }
    const policy = (campaign.policy as Record<string, unknown>) ?? {};
    if (policy.requireConsent === true) {
      if (campaign.channel === 'SMS' && !params.consentSms) {
        return { allowed: false, reason: 'missing_sms_consent' };
      }
      if (campaign.channel === 'EMAIL' && !params.consentEmail) {
        return { allowed: false, reason: 'missing_email_consent' };
      }
    }
    // Live send requires messaging provider — suppressed by default
    return {
      allowed: false,
      reason: 'messaging_provider_not_configured',
    };
  }
}
