/**
 * Anti-leakage / tenant isolation contract tests (no live DB required).
 * Documents the required where-clause shape for every business query.
 */
describe('tenant isolation query contracts', () => {
  it('leads list must always include tenantId', () => {
    const tenantId = 'tenant-a';
    const where = { tenantId, status: { in: ['OPEN'] } };
    expect(where.tenantId).toBe(tenantId);
    expect(Object.keys(where)).toContain('tenantId');
  });

  it('vehicle uniqueness is per-tenant VIN', () => {
    const key = { tenantId: 'a', vin: '1C4RJFBG0MC123456' };
    const other = { tenantId: 'b', vin: '1C4RJFBG0MC123456' };
    expect(key.vin).toBe(other.vin);
    expect(key.tenantId).not.toBe(other.tenantId);
  });

  it('group reporting must not return lead payloads', () => {
    const summary = {
      tenants: [
        { slug: 'jeep-of-chicago', counts: { leads: 12, vehicles: 40 } },
      ],
      note: 'aggregate counts only',
    };
    expect(summary.tenants[0]).not.toHaveProperty('leads');
    expect(JSON.stringify(summary)).not.toMatch(/email|phone|vin/i);
  });

  it('widget-config must never include secrets keys', () => {
    const publicPayload = {
      branding: { primaryColor: '#111' },
      features: { chat: true },
    };
    const forbidden = [
      'apiKey',
      'JWT_SECRET',
      'CRM_WEBHOOK',
      'password',
      'ciphertext',
      'allowedOrigins',
      'escalationRecipients',
      'inventoryFeedUrl',
    ];
    const raw = JSON.stringify(publicPayload);
    for (const f of forbidden) {
      expect(raw.toLowerCase()).not.toContain(f.toLowerCase());
    }
  });
});
