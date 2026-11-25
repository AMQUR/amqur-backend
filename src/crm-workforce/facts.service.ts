import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { dealerDirectoryFor } from '../dealer-directory/dealer-directory';
import { StoreHoursService } from '../locations/store-hours.service';
import { SpotlightsService } from '../spotlights/spotlights.service';
import { Department, VerifiedFact } from './crm-workforce.types';
import { LeadView as CrmWfLead } from './vault.service';

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
    private readonly spotlights: SpotlightsService,
  ) {}

  /**
   * Store-specific staff directory: the rooftop's own department lines from the verified
   * dealer directory, plus the staff accounts bound to this rooftop. Never another store's.
   */
  async directory(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { tenant: { select: { slug: true } } },
    });
    const store = loc
      ? (dealerDirectoryFor(loc.tenant.slug)?.self ?? null)
      : null;
    const staff = await this.prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: [{ locationId }, { locationId: null }],
      },
      select: { id: true, firstName: true, lastName: true, role: true },
      orderBy: { firstName: 'asc' },
    });
    return {
      departments: store
        ? (['sales', 'service', 'parts'] as const).map((d) => ({
            department: d.toUpperCase(),
            phone: store.phones[d],
            sourceRecordId: `dealer-directory:${store.sourceRecordId}:${d}`,
            asOf: store.asOf,
            verified: true,
            rooftopId: locationId,
          }))
        : [],
      staff: staff.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        role: u.role,
      })),
    };
  }

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

    // Approved, in-window dealership offers for THIS rooftop, verbatim with their disclaimer.
    for (const o of await this.spotlights.activeForStore(
      lead.tenantId,
      lead.locationId,
      now,
    )) {
      const text = [o.title, o.body, o.disclaimer]
        .filter((x) => typeof x === 'string' && x)
        .join(' — ');
      if (text)
        facts.push({
          kind: 'offer',
          text: `${text} (offer ends ${String(o.endsAt).slice(0, 10)})`,
          sourceRecordId: `spotlight:${String(o.id)}`,
          asOf: now.toISOString(),
          verified: true,
          rooftopId,
        });
    }

    // Verified alternatives when the requested vehicle is not (or no longer) available:
    // same rooftop, same make and model, fresh feed, listed available.
    const want = (lead.vehicleInterest ?? null) as {
      make?: string;
      model?: string;
      vin?: string;
    } | null;
    if (want?.make && want.model && vehicleAvailable !== true) {
      const alts = await this.prisma.vehicle.findMany({
        where: {
          tenantId: lead.tenantId,
          locationId: lead.locationId,
          make: { equals: want.make, mode: 'insensitive' },
          model: { equals: want.model, mode: 'insensitive' },
          status: 'AVAILABLE',
          freshnessState: 'FRESH',
          lastSeenAt: { gte: new Date(now.getTime() - INVENTORY_MAX_AGE_MS) },
          ...(want.vin ? { vin: { not: want.vin } } : {}),
          ...(process.env.NODE_ENV === 'production'
            ? { NOT: { source: 'synthetic_demo' } }
            : {}),
        },
        select: {
          id: true,
          year: true,
          make: true,
          model: true,
          trim: true,
          stock: true,
          lastSeenAt: true,
        },
        orderBy: { lastSeenAt: 'desc' },
        take: 2,
      });
      for (const v of alts)
        facts.push({
          kind: 'inventory',
          text: `Similar vehicle in stock: ${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}, stock ${v.stock ?? 'n/a'}, listed as available in the inventory feed`,
          sourceRecordId: `vehicle:${v.id}`,
          asOf: v.lastSeenAt!.toISOString(),
          verified: true,
          rooftopId,
        });
    }

    // The rooftop's own department line (verified directory) for "call us" handoffs.
    const dir = await this.directory(lead.tenantId, lead.locationId);
    const line = dir.departments.find((x) => x.department === lead.department);
    if (line)
      facts.push({
        kind: 'contact',
        text: `${lead.department.toLowerCase()} department phone: ${line.phone}`,
        sourceRecordId: line.sourceRecordId,
        asOf: `${line.asOf}T00:00:00.000Z`,
        verified: true,
        rooftopId,
      });

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
