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
    const svc = new ActionPagesService(prisma as never);
    const res = await svc.completePublic(token, {
      year: '2019',
      staffNote: 'hidden',
      price: '99999',
      apr: '0',
    });
    expect(res.ok).toBe(true);
    const data = update.mock.calls[0][0].data;
    expect(data.staffMeta.customerSubmission).toEqual({ year: '2019' });
    expect(data.staffMeta.customerSubmission.price).toBeUndefined();
  });
});
