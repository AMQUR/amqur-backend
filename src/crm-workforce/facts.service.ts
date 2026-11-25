import { Injectable } from '@nestjs/common';
import { CrmWfLead } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreHoursService } from '../locations/store-hours.service';
import { Department, VerifiedFact } from './crm-workforce.types';

const INVENTORY_MAX_AGE_MS = 36 * 3_600_000;
const HOURS_MAX_AGE_MS = 180 * 86_400_000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const clock = (m: number) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/**
 * Verified dealership facts for one rooftop, from the same sources the Dial Concierge uses
 * (verified store hours, the inventory feed). Each fact carries sourceRecordId / asOf /
 * verified / rooftopId and is dropped — not downgraded — when it is unverified, synthetic or
 * older than its freshness limit. An agent that is given no fact cannot state one.
 */
@Injectable()
export class CrmWfFactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hours: StoreHoursService,
  ) {}

  async dealership(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        tenant: { select: { name: true, slug: true } },
      },
    });
    return loc
      ? {
          name: loc.tenant.name || loc.name,
          timezone: loc.timezone,
          tenantSlug: loc.tenant.slug,
        }
      : null;
  }

  async forLead(
    lead: CrmWfLead,
    now = new Date(),
  ): Promise<{
    facts: VerifiedFact[];
    appointmentConfirmed: boolean;
    vehicleAvailable: boolean | null;
  }> {
    const facts: VerifiedFact[] = [];
    const rooftopId = lead.locationId;

    const profile = await this.hours.getProfile(lead.tenantId, lead.locationId);
    if (
      profile?.verified &&
      !profile.synthetic &&
      profile.verifiedAt &&
      now.getTime() - new Date(profile.verifiedAt).getTime() <= HOURS_MAX_AGE_MS
    ) {
      const dept = (
        { SALES: 'sales', SERVICE: 'service', PARTS: 'parts' } as Record<
          Department,
          'sales' | 'service' | 'parts'
        >
      )[lead.department];
      const weekly = profile.weekly[dept] ?? profile.weekly.store;
      if (weekly) {
        const text = DAYS.map((d) => {
          const h = (
            weekly as Record<string, { open: number; close: number } | null>
          )[d];
          return `${d} ${h ? `${clock(h.open)}-${clock(h.close)}` : 'closed'}`;
        }).join(', ');
        facts.push({
          kind: 'hours',
          text: `${dept} hours (${profile.timezone}): ${text}`,
          sourceRecordId: `location:${lead.locationId}:hours:${dept}`,
          asOf: profile.verifiedAt,
          verified: true,
          rooftopId,
        });
      }
    }

    let vehicleAvailable: boolean | null = null;
    const vi = (lead.vehicleInterest ?? null) as {
      vin?: string;
      stock?: string;
    } | null;
    if (vi?.vin || vi?.stock) {
      const v = await this.prisma.vehicle.findFirst({
        // locationId is part of the filter: another rooftop's stock is never read.
        where: {
          tenantId: lead.tenantId,
          locationId: lead.locationId,
          ...(vi.vin ? { vin: vi.vin } : { stock: vi.stock }),
        },
        select: {
          id: true,
          vin: true,
          stock: true,
          year: true,
          make: true,
          model: true,
          trim: true,
          status: true,
          freshnessState: true,
          lastSeenAt: true,
        },
      });
      const fresh =
        !!v &&
        v.freshnessState === 'FRESH' &&
        !!v.lastSeenAt &&
        now.getTime() - v.lastSeenAt.getTime() <= INVENTORY_MAX_AGE_MS;
      if (v && fresh) {
        vehicleAvailable = v.status === 'AVAILABLE';
        facts.push({
          kind: 'inventory',
          // Price is deliberately omitted: quoting one needs the fee-inclusive, sourced price flow.
          text: `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}, stock ${v.stock ?? 'n/a'}: ${vehicleAvailable ? 'listed as available in the inventory feed' : 'NOT currently listed as available'}`,
          sourceRecordId: `vehicle:${v.id}`,
          asOf: v.lastSeenAt!.toISOString(),
          verified: true,
          rooftopId,
        });
      }
    }

    const appointmentConfirmed =
      lead.verified &&
      lead.appointmentState === 'SCHEDULED' &&
      !!lead.appointmentAt;
    if (appointmentConfirmed)
      facts.push({
        kind: 'appointment',
        text: `CRM shows a scheduled appointment at ${lead.appointmentAt!.toISOString()}`,
        sourceRecordId: `crm:${lead.adapterKey}:${lead.sourceRecordId}:appointment`,
        asOf: lead.asOf.toISOString(),
        verified: true,
        rooftopId,
      });

    return { facts, appointmentConfirmed, vehicleAvailable };
  }
}
