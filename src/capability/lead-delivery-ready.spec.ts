import { CapabilityService } from './capability.service';

const PROD = {
  NODE_ENV: 'production',
  ADF_SEND_ENABLED: 'true',
  LEAD_DELIVERY_MODE: 'live',
  RESEND_API_KEY: 're_test_key_never_real_0000',
};

function svc(route: { id: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(route);
  const s = new CapabilityService(
    { leadDeliveryRoute: { findFirst } } as never,
    {} as never,
  );
  return { s, findFirst };
}

describe('public lead collection needs a deliverable route in production', () => {
  it('is always allowed outside the production tier', async () => {
    const { s, findFirst } = svc(null);
    expect(
      await s.leadDeliveryReady('t1', 'l1', false, { NODE_ENV: 'test' }),
    ).toBe(true);
    expect(
      await s.leadDeliveryReady('t1', 'l1', false, {
        NODE_ENV: 'production',
        DEPLOYMENT_TIER: 'staging',
      }),
    ).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('is refused while sending is off, sandboxed, or the store flag is off', async () => {
    const { s, findFirst } = svc({ id: 'r1' });
    for (const env of [
      { ...PROD, ADF_SEND_ENABLED: 'false' },
      { ...PROD, LEAD_DELIVERY_MODE: 'sandbox' },
    ])
      expect(await s.leadDeliveryReady('t1', 'l1', true, env)).toBe(false);
    expect(await s.leadDeliveryReady('t1', 'l1', false, PROD)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('needs a verified, production-enabled SALES route for that store', async () => {
    const none = svc(null);
    expect(await none.s.leadDeliveryReady('t1', 'l1', true, PROD)).toBe(false);
    const ok = svc({ id: 'r1' });
    expect(await ok.s.leadDeliveryReady('t1', 'l1', true, PROD)).toBe(true);
    expect(ok.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      locationId: 'l1',
      department: 'SALES',
      environment: 'PRODUCTION',
      enabled: true,
      verified: true,
      productionEnabled: true,
    });
  });

  it("one store's route never opens another store", async () => {
    const { s, findFirst } = svc({ id: 'r1' });
    await s.leadDeliveryReady('t1', 'l1', true, PROD);
    findFirst.mockResolvedValue(null);
    expect(await s.leadDeliveryReady('t2', 'l9', true, PROD)).toBe(false);
    expect(findFirst.mock.calls[1][0].where.tenantId).toBe('t2');
  });

  it('the CRM webhook also counts as a delivery destination', async () => {
    const { s } = svc(null);
    expect(
      await s.leadDeliveryReady('t1', 'l1', false, {
        NODE_ENV: 'production',
        CRM_WEBHOOK_URL: 'https://crm.example.com/hook',
      }),
    ).toBe(true);
  });
});
