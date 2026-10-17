import { TekionNotAuthorizedError, TekionProvider } from './tekion.provider';
import { TekionContractFixture } from './tekion.contract-fixture';
import { resolveTekionCapabilities } from './tekion.capabilities';

// Behavior intentionally changed (2026-10-13): the production TekionProvider previously
// returned in-memory "mock-tekion-lead-*" ids, which the writeback persisted as SYNCED.
// It now fails closed; idempotency logic is exercised against a test-only fixture.
describe('TekionProvider (no official contract configured)', () => {
  const provider = new TekionProvider();

  it('is not live configured and reports awaiting vendor credentials', async () => {
    expect(provider.isLiveConfigured()).toBe(false);
    const h = await provider.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.status).toBe('awaiting_vendor_credentials');
    expect(
      Object.values(provider.capabilities()).every((v) => v === false),
    ).toBe(true);
  });

  it('refuses CRM writes instead of fabricating success', async () => {
    await expect(
      provider.createOrUpdateLead({ tenantId: 't1', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(TekionNotAuthorizedError);
    await expect(
      provider.appendActivity({
        tenantId: 't1',
        summary: 's',
        channel: 'widget',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(TekionNotAuthorizedError);
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
    expect(
      await provider.getRepairOrderStatus({
        tenantId: 't1',
        vin: '1C4RJFBG0JC123456',
      }),
    ).toBeNull();
  });
});

describe('Tekion capability declaration', () => {
  it('grants nothing without a verified contract and https base URL', () => {
    expect(
      resolveTekionCapabilities({
        capabilities: { crmLeadCreateOrUpdate: true },
      }).crmLeadCreateOrUpdate,
    ).toBe(false);
    expect(
      resolveTekionCapabilities({
        apiBaseUrl: 'http://x',
        contractVerifiedAt: '2026-01-01',
        capabilities: { crmLeadCreateOrUpdate: true },
      }).crmLeadCreateOrUpdate,
    ).toBe(false);
  });

  it('grants only explicitly declared capabilities once verified', () => {
    const c = resolveTekionCapabilities({
      apiBaseUrl: 'https://partner.example',
      contractVerifiedAt: '2026-01-01',
      capabilities: { crmLeadCreateOrUpdate: true },
    });
    expect(c.crmLeadCreateOrUpdate).toBe(true);
    expect(c.appointmentCreate).toBe(false);
  });
});

describe('Tekion contract fixture (test-only)', () => {
  it('deduplicates leads by idempotency key', async () => {
    const f = new TekionContractFixture();
    const input = {
      tenantId: 't1',
      firstName: 'Ada',
      email: 'ada@example.com',
      idempotencyKey: 'lead:t1:conv1',
    };
    const a = await f.createOrUpdateLead(input);
    const b = await f.createOrUpdateLead(input);
    expect(a.externalLeadId).toBe(b.externalLeadId);
    expect(b.duplicated).toBe(true);
  });

  it('cannot be constructed outside tests', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new TekionContractFixture()).toThrow('test-only');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
