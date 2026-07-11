import { TekionProvider } from './tekion.provider';

describe('TekionProvider mock', () => {
  const provider = new TekionProvider();

  it('is not live configured without credentials', () => {
    expect(provider.isLiveConfigured()).toBe(false);
  });

  it('deduplicates leads by idempotency key', async () => {
    const input = {
      tenantId: 't1',
      firstName: 'Ada',
      email: 'ada@example.com',
      phone: '3125550100',
      idempotencyKey: 'lead:t1:conv1:ada@example.com',
    };
    const a = await provider.createOrUpdateLead(input);
    const b = await provider.createOrUpdateLead(input);
    expect(a.externalLeadId).toBe(b.externalLeadId);
    expect(a.duplicated).toBe(false);
    expect(b.duplicated).toBe(true);
  });

  it('never confirms service appointments without live Tekion', async () => {
    const result = await provider.requestServiceAppointment({
      tenantId: 't1',
      idempotencyKey: 'svc:1',
      preferredDate: '2026-07-20',
    });
    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('REQUESTED');
  });

  it('does not invent repair order status', async () => {
    const ro = await provider.getRepairOrderStatus({
      tenantId: 't1',
      vin: '1C4RJFBG0JC123456',
    });
    expect(ro).toBeNull();
  });
});
