import { ConsentService } from './consent.service';

describe('ConsentService.status', () => {
  const tenantId = 'tenant-1';
  const endpoint = '+15551234567';
  const baseRow = {
    tenantId,
    channel: 'SMS' as const,
    endpoint,
    revokedAt: null,
    wording: null,
    wordingVersion: null,
    locationId: null,
    leadId: null,
    conversationExternalKey: null,
    evidence: {},
  };

  function svc(rows: Array<{ purpose: string; granted: boolean; createdAt: Date; source?: string }>) {
    const prisma = {
      consentRecord: {
        findMany: jest.fn().mockResolvedValue(
          rows.map((r, i) => ({
            id: `row-${i}`,
            ...baseRow,
            purpose: r.purpose,
            granted: r.granted,
            createdAt: r.createdAt,
            source: r.source ?? 'WIDGET',
          })),
        ),
      },
    };
    return new ConsentService(prisma as never);
  }

  it('returns opted_out for CONVERSATIONAL and MARKETING after SMS STOP opt-outs', async () => {
    const t0 = new Date('2026-10-01T12:00:00Z');
    const t1 = new Date('2026-10-02T12:00:00Z');
    const consent = svc([
      { purpose: 'MARKETING', granted: false, createdAt: t1, source: 'SMS_KEYWORD' },
      { purpose: 'CONVERSATIONAL', granted: false, createdAt: t0, source: 'SMS_KEYWORD' },
      { purpose: 'MARKETING', granted: true, createdAt: new Date('2026-09-01T12:00:00Z') },
      { purpose: 'CONVERSATIONAL', granted: true, createdAt: new Date('2026-09-01T12:00:00Z') },
    ]);

    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
    ).resolves.toMatchObject({ allowed: false, reason: 'opted_out' });
    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'MARKETING'),
    ).resolves.toMatchObject({ allowed: false, reason: 'opted_out' });
  });

  it('keeps MARKETING blocked after START re-grants CONVERSATIONAL only', async () => {
    const consent = svc([
      { purpose: 'CONVERSATIONAL', granted: true, createdAt: new Date('2026-10-03T12:00:00Z'), source: 'SMS_KEYWORD' },
      { purpose: 'MARKETING', granted: false, createdAt: new Date('2026-10-02T12:00:00Z'), source: 'SMS_KEYWORD' },
      { purpose: 'CONVERSATIONAL', granted: false, createdAt: new Date('2026-10-02T11:00:00Z'), source: 'SMS_KEYWORD' },
    ]);

    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'MARKETING'),
    ).resolves.toMatchObject({ allowed: false, reason: 'opted_out' });
  });
});
