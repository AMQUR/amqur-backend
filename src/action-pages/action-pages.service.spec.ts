import { createHash } from 'crypto';
import { ActionPagesService } from './action-pages.service';

describe('ActionPagesService', () => {
  const hash = (t: string) => createHash('sha256').update(t).digest('hex');

  it('resolvePublic denies short tokens', async () => {
    const svc = new ActionPagesService({} as never);
    await expect(svc.resolvePublic('short')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('resolvePublic returns public-safe payload without staffMeta', async () => {
    const token = 'a'.repeat(24);
    const prisma = {
      customerActionPage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          tenantId: 't1',
          locationId: null,
          kind: 'SCHEDULE',
          title: 'Book a visit',
          description: 'Pick a time',
          formSchema: { fields: ['date'] },
          staffMeta: { secretVin: 'VIN123' },
          status: 'OPEN',
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Demo Motors', slug: 'demo' }),
      },
    };
    const svc = new ActionPagesService(prisma as never);
    const res = await svc.resolvePublic(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.title).toBe('Book a visit');
      expect(res.dealerName).toBe('Demo Motors');
      expect(JSON.stringify(res)).not.toContain('VIN123');
      expect(JSON.stringify(res)).not.toContain('staffMeta');
    }
    expect(prisma.customerActionPage.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hash(token) },
    });
  });

  it('completePublic strips staff/price keys from submission', async () => {
    const token = 'b'.repeat(24);
    const update = jest.fn().mockResolvedValue({});
    const trade = {
      createRequest: jest.fn().mockResolvedValue({ id: 'trade-1' }),
    };
    const prisma = {
      customerActionPage: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'p1',
            tenantId: 't1',
            locationId: null,
            kind: 'TRADE_INTAKE',
            title: 'Trade',
            description: null,
            formSchema: null,
            staffMeta: {},
            status: 'OPEN',
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .mockResolvedValueOnce({
            id: 'p1',
            tenantId: 't1',
            locationId: null,
            conversationId: null,
            leadId: null,
            kind: 'TRADE_INTAKE',
            staffMeta: {},
            status: 'OPEN',
            expiresAt: new Date(Date.now() + 86_400_000),
          }),
        update,
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Demo', slug: 'demo' }),
      },
      analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const svc = new ActionPagesService(
      prisma as never,
      undefined,
      trade as never,
      undefined,
    );
    const res = await svc.completePublic(token, {
      year: '2019',
      staffNote: 'hidden',
      price: '99999',
      apr: '0',
    });
    expect(res.ok).toBe(true);
    expect(trade.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', year: 2019 }),
    );
    const data = update.mock.calls[0][0].data;
    expect(data.staffMeta.customerSubmission).toEqual({ year: '2019' });
    expect(data.staffMeta.customerSubmission.price).toBeUndefined();
    expect(data.staffMeta.domainRouting).toEqual({
      routed: true,
      kind: 'TRADE_INTAKE',
      ref: 'trade-1',
    });
  });

  it('completePublic routes PARTS_INTAKE to PartsInquiryService', async () => {
    const token = 'c'.repeat(24);
    const update = jest.fn().mockResolvedValue({});
    const partsInquiry = {
      upsertFromActionPage: jest.fn().mockResolvedValue({ id: 'parts-1' }),
    };
    const prisma = {
      customerActionPage: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'p-parts',
            tenantId: 't1',
            locationId: 'loc-1',
            kind: 'PARTS_INTAKE',
            title: 'Parts request',
            description: null,
            formSchema: null,
            staffMeta: {},
            status: 'OPEN',
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .mockResolvedValueOnce({
            id: 'p-parts',
            tenantId: 't1',
            locationId: 'loc-1',
            conversationId: 'conv-1',
            leadId: null,
            kind: 'PARTS_INTAKE',
            staffMeta: {},
            status: 'OPEN',
            expiresAt: new Date(Date.now() + 86_400_000),
          }),
        update,
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Demo', slug: 'demo' }),
      },
      analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const svc = new ActionPagesService(
      prisma as never,
      undefined,
      undefined,
      undefined,
      partsInquiry as never,
    );
    const res = await svc.completePublic(token, {
      partDescription: 'Front wiper blades',
      vin: '1HGCM82633A004352',
      name: 'Alex',
      phone: '555-0100',
    });
    expect(res.ok).toBe(true);
    expect(partsInquiry.upsertFromActionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        locationId: 'loc-1',
        conversationId: 'conv-1',
        actionPageId: 'p-parts',
        description: 'Front wiper blades',
        vin: '1HGCM82633A004352',
        customer: expect.objectContaining({ name: 'Alex', phone: '555-0100' }),
      }),
    );
    expect(update.mock.calls[0][0].data.staffMeta.domainRouting).toEqual({
      routed: true,
      kind: 'PARTS_INTAKE',
      ref: 'parts-1',
    });
  });
});
