import { FollowUpCampaign, Prisma, PrismaClient } from '@prisma/client';
import { renderTemplate } from './campaign.engine';

/** Stable upsert key — one disabled playbook per tenant. */
export const APPOINTMENT_REMINDER_CAMPAIGN_NAME =
  'Appointment confirmed reminder (bootstrap)';

export const APPOINTMENT_REMINDER_TRIGGER =
  'appointment.confirmed.reminder' as const;

/** Approved placeholders only; validated before upsert. */
export const APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE =
  'Hi {firstName}, reminder from {dealerName}: your visit is {appointmentDate} at {appointmentTime} for your {vehicle}.';

export const APPOINTMENT_REMINDER_CAMPAIGN_POLICY: Prisma.InputJsonValue = {
  delayMinutes: -24 * 60,
  pauseOnHumanTakeover: true,
  stopOnCustomerReply: true,
};

export type SeedAppointmentReminderCampaignInput = {
  tenantId: string;
  locationId?: string | null;
  createdByUserId?: string | null;
};

type FollowUpCampaignDelegate = Pick<
  PrismaClient,
  'followUpCampaign'
>['followUpCampaign'];

/**
 * Idempotent helper for scripts/admin — not wired into production bootstrap or `main.ts`.
 *
 * Creates or refreshes a **disabled** SMS campaign for `appointment.confirmed.reminder`.
 * Does **not** set tenant/location `automatedFollowup`.
 *
 * ## Enable after review
 * 1. Confirm transactional SMS consent flows for appointments (ConsentRecord + STOP handling).
 * 2. Turn on `automatedFollowup` on the tenant or location only after owner authorization
 *    (see Command Center Campaigns page and `INTEGRATION_CAPABILITIES.md`).
 * 3. Preview audience (`POST /api/campaigns/:id/preview`) and fix suppressions.
 * 4. PATCH the campaign with `{ "enabled": true }` via Command Center or API.
 */
export async function seedDisabledAppointmentReminderCampaign(
  prisma: { followUpCampaign: FollowUpCampaignDelegate },
  input: SeedAppointmentReminderCampaignInput,
): Promise<FollowUpCampaign> {
  const probe = renderTemplate(APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE, {
    firstName: 'x',
    dealerName: 'x',
    appointmentDate: 'x',
    appointmentTime: 'x',
    vehicle: 'x',
  });
  if (probe === null) {
    throw new Error('appointment reminder seed template failed validation');
  }

  const base = {
    trigger: APPOINTMENT_REMINDER_TRIGGER,
    channel: 'SMS',
    template: APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE,
    policy: APPOINTMENT_REMINDER_CAMPAIGN_POLICY,
    locationId: input.locationId ?? null,
    ...(input.createdByUserId
      ? { createdByUserId: input.createdByUserId }
      : {}),
  };

  return prisma.followUpCampaign.upsert({
    where: {
      tenantId_name: {
        tenantId: input.tenantId,
        name: APPOINTMENT_REMINDER_CAMPAIGN_NAME,
      },
    },
    create: {
      tenantId: input.tenantId,
      name: APPOINTMENT_REMINDER_CAMPAIGN_NAME,
      enabled: false,
      ...base,
    },
    update: base,
  });
}
