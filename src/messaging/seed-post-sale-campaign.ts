import { FollowUpCampaign, Prisma, PrismaClient } from '@prisma/client';
import { renderTemplate } from './campaign.engine';

/** Stable upsert key — one disabled playbook per tenant. */
export const POST_SALE_CAMPAIGN_NAME = 'Post-sale thank you (bootstrap)';

export const POST_SALE_TRIGGER = 'deal.sold_recorded' as const;

/** Approved placeholders only; validated before upsert. */
export const POST_SALE_CAMPAIGN_TEMPLATE =
  'Hi {firstName}, thank you for choosing {dealerName}. We appreciate your business.';

export const POST_SALE_CAMPAIGN_POLICY: Prisma.InputJsonValue = {
  delayMinutes: 24 * 60,
  pauseOnHumanTakeover: true,
  stopOnCustomerReply: true,
};

export type SeedPostSaleCampaignInput = {
  tenantId: string;
  locationId?: string | null;
  createdByUserId?: string | null;
};

type FollowUpCampaignDelegate = Pick<
  PrismaClient,
  'followUpCampaign'
>['followUpCampaign'];

/**
 * Idempotent helper for scripts/admin — not wired into production bootstrap.
 *
 * Creates or refreshes a **disabled** SMS campaign for `deal.sold_recorded`.
 * Does **not** set tenant/location `automatedFollowup`.
 *
 * ## Enable after review
 * 1. Confirm MARKETING SMS consent + STOP handling for the audience.
 * 2. Turn on `automatedFollowup` only after owner authorization.
 * 3. Preview audience (`POST /api/campaigns/:id/preview`) and fix suppressions.
 * 4. PATCH the campaign with `{ "enabled": true }` via Command Center or API.
 */
export async function seedDisabledPostSaleCampaign(
  prisma: { followUpCampaign: FollowUpCampaignDelegate },
  input: SeedPostSaleCampaignInput,
): Promise<FollowUpCampaign> {
  const probe = renderTemplate(POST_SALE_CAMPAIGN_TEMPLATE, {
    firstName: 'x',
    dealerName: 'x',
    appointmentDate: 'x',
    appointmentTime: 'x',
    vehicle: 'x',
  });
  if (probe === null) {
    throw new Error('post-sale seed template failed validation');
  }

  const base = {
    trigger: POST_SALE_TRIGGER,
    channel: 'SMS',
    template: POST_SALE_CAMPAIGN_TEMPLATE,
    policy: POST_SALE_CAMPAIGN_POLICY,
    locationId: input.locationId ?? null,
    ...(input.createdByUserId
      ? { createdByUserId: input.createdByUserId }
      : {}),
  };

  return prisma.followUpCampaign.upsert({
    where: {
      tenantId_name: {
        tenantId: input.tenantId,
        name: POST_SALE_CAMPAIGN_NAME,
      },
    },
    create: {
      tenantId: input.tenantId,
      name: POST_SALE_CAMPAIGN_NAME,
      enabled: false,
      ...base,
    },
    update: base,
  });
}
