import { SpotlightsService } from './spotlights.service';

type SpotlightRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  linkUrl: string | null;
  vehicleVin: string | null;
  disclaimer: string | null;
  status: string;
  startsAt: Date;
  endsAt: Date;
  tenantId: string;
  locationId: string;
};

function row(partial: Partial<SpotlightRow> & { id: string }): SpotlightRow {
  const now = Date.now();
  return {
    kind: 'OFFER',
    title: 'Approved offer',
    body: '$500 rebate on select models.',
    linkUrl: null,
    vehicleVin: null,
    disclaimer: 'See dealer for details. Ends soon.',
    status: 'APPROVED',
    startsAt: new Date(now - 86_400_000),
    endsAt: new Date(now + 86_400_000),
    tenantId: 'tenant-a',
    locationId: 'loc-a',
    ...partial,
  };
}

describe('SpotlightsService.activeForStore', () => {
  const now = new Date('2026-11-06T15:00:00.000Z');

  function serviceWith(rows: SpotlightRow[], vehicleOk = true) {
    const prisma = {
      spotlight: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
      vehicle: {
        count: jest.fn().mockResolvedValue(vehicleOk ? 1 : 0),
      },
    };
    return {
      svc: new SpotlightsService(prisma as never),
      prisma,
    };
  }

  it('returns approved in-window offers for this location', async () => {
    const { svc, prisma } = serviceWith([row({ id: 'ok' })]);
    const out = await svc.activeForStore('tenant-a', 'loc-a', now);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Approved offer');
    expect(prisma.spotlight.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          locationId: 'loc-a',
          status: 'APPROVED',
          startsAt: { lte: now },
          endsAt: { gt: now },
        }),
      }),
    );
  });

  it('excludes expired offers (endsAt <= now)', async () => {
    // Query layer filters; simulate empty result when expired.
    const { svc } = serviceWith([]);
    const out = await svc.activeForStore('tenant-a', 'loc-a', now);
    expect(out).toHaveLength(0);
  });

  it('excludes future / not-yet-started offers', async () => {
    const { svc } = serviceWith([]);
    expect(await svc.activeForStore('tenant-a', 'loc-a', now)).toEqual([]);
  });

  it('excludes unapproved (PENDING_APPROVAL / REJECTED / ARCHIVED) via query filter', async () => {
    const { svc, prisma } = serviceWith([]);
    await svc.activeForStore('tenant-a', 'loc-a', now);
    expect(prisma.spotlight.findMany.mock.calls[0][0].where.status).toBe(
      'APPROVED',
    );
  });

  it('scopes to the requested rooftop locationId (cross-rooftop isolation)', async () => {
    const { svc, prisma } = serviceWith([]);
    await svc.activeForStore('tenant-a', 'loc-b', now);
    expect(prisma.spotlight.findMany.mock.calls[0][0].where.locationId).toBe(
      'loc-b',
    );
    expect(prisma.spotlight.findMany.mock.calls[0][0].where.tenantId).toBe(
      'tenant-a',
    );
  });

  it('drops vehicle-tied offers when VIN is no longer in stock', async () => {
    const { svc } = serviceWith(
      [row({ id: 'vin-offer', vehicleVin: '1C4HJXDG0JW000001' })],
      false,
    );
    expect(await svc.activeForStore('tenant-a', 'loc-a', now)).toEqual([]);
  });
});
