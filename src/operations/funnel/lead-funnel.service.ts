import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { buildLeadFunnel, LeadFunnel } from './lead-funnel';
import {
  NOT_REAL_DELIVERY,
  REAL_DELIVERY,
} from '../../integrations/adf/real-delivery';

/**
 * Counts for the funnel. Every query is scoped to the caller's tenant (and rooftop when the
 * caller is rooftop-bound or asks for one). Counts only — no customer data leaves this service.
 */
@Injectable()
export class LeadFunnelService {
  constructor(private readonly prisma: PrismaService) {}

  async funnel(
    scope: { tenantId: string; locationId: string | null },
    windowDays: number,
    now: Date = new Date(),
  ): Promise<LeadFunnel> {
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const where = {
      tenantId: scope.tenantId,
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    };
    const inWindow = { ...where, createdAt: { gte: since } };
    // "Real" is decided by HOW the hand-off was made, not only by where the route points: the
    // delivery was sent by the LIVE transport (`deliveryMode = 'live'`) AND on a PRODUCTION
    // route. Anything a sandbox transport acknowledged — whatever the route says — and anything
    // on a SANDBOX route is never counted as mail accepted by a dealership's mail server.
    const real = REAL_DELIVERY;
    const sandbox = NOT_REAL_DELIVERY;
    const [
      leads,
      deliveriesQueued,
      deliveriesAccepted,
      deliveriesAcceptedSandbox,
      deliveriesCrmReceived,
      deliveriesCrmMatched,
      deliveriesCrmRejected,
      deliveriesBlocked,
      deliveriesFailedOrDead,
      appointments,
      confirmed,
    ] = await Promise.all([
      this.prisma.lead.count({ where: inWindow }),
      this.prisma.leadDelivery.count({ where: inWindow }),
      this.prisma.leadDelivery.count({
        where: { ...inWindow, acceptedAt: { not: null }, ...real },
      }),
      this.prisma.leadDelivery.count({
        where: {
          ...inWindow,
          acceptedAt: { not: null },
          ...sandbox,
        },
      }),
      this.prisma.leadDelivery.count({
        where: {
          ...inWindow,
          ...real,
          OR: [{ crmParsedAt: { not: null } }, { crmMatchedAt: { not: null } }],
        },
      }),
      this.prisma.leadDelivery.count({
        where: { ...inWindow, ...real, crmMatchedAt: { not: null } },
      }),
      this.prisma.leadDelivery.count({
        where: { ...inWindow, status: 'CRM_REJECTED' },
      }),
      this.prisma.leadDelivery.count({
        where: { ...inWindow, status: 'BLOCKED' },
      }),
      this.prisma.leadDelivery.count({
        where: { ...inWindow, status: { in: ['FAILED', 'DEAD'] } },
      }),
      this.prisma.appointment.count({ where: inWindow }),
      this.prisma.appointment.findMany({
        where: { ...inWindow, status: 'CONFIRMED' },
        select: {
          id: true,
          providerReceipts: {
            where: { tenantId: scope.tenantId, status: 'CONFIRMED' },
            select: { sandbox: true },
            take: 5,
          },
        },
        take: 5000,
      }),
    ]);

    let provider = 0;
    let sandboxConfirmed = 0;
    let staff = 0;
    for (const a of confirmed) {
      if (a.providerReceipts.some((r) => !r.sandbox)) provider += 1;
      else if (a.providerReceipts.length) sandboxConfirmed += 1;
      else staff += 1;
    }

    return buildLeadFunnel(
      {
        leads,
        deliveriesQueued,
        deliveriesAccepted,
        deliveriesAcceptedSandbox,
        deliveriesCrmReceived,
        deliveriesCrmMatched,
        deliveriesCrmRejected,
        deliveriesBlocked,
        deliveriesFailedOrDead,
        appointments,
        appointmentsProviderConfirmed: provider,
        appointmentsSandboxConfirmed: sandboxConfirmed,
        appointmentsStaffConfirmed: staff,
      },
      windowDays,
      since,
    );
  }
}
