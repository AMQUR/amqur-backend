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

  function svc(
    rows: Array<{
      purpose: string;
      granted: boolean;
      createdAt: Date;
      source?: string;
    }>,
  ) {
    const prisma = {
      consentRecord: {
        // Latest handset/provider-sourced row (the handset opt-out lock query).
        findFirst: jest.fn().mockImplementation(() => {
          const handset = rows
            .filter((r) => ['SMS_KEYWORD', 'PROVIDER'].includes(r.source ?? ''))
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                Number(a.granted) - Number(b.granted),
            )[0];
          return Promise.resolve(handset ? { granted: handset.granted } : null);
        }),
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
      {
        purpose: 'MARKETING',
        granted: false,
        createdAt: t1,
        source: 'SMS_KEYWORD',
      },
      {
        purpose: 'CONVERSATIONAL',
        granted: false,
        createdAt: t0,
        source: 'SMS_KEYWORD',
      },
      {
        purpose: 'MARKETING',
        granted: true,
        createdAt: new Date('2026-09-01T12:00:00Z'),
      },
      {
        purpose: 'CONVERSATIONAL',
        granted: true,
        createdAt: new Date('2026-09-01T12:00:00Z'),
      },
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
      {
        purpose: 'CONVERSATIONAL',
        granted: true,
        createdAt: new Date('2026-10-03T12:00:00Z'),
        source: 'SMS_KEYWORD',
      },
      {
        purpose: 'MARKETING',
        granted: false,
        createdAt: new Date('2026-10-02T12:00:00Z'),
        source: 'SMS_KEYWORD',
      },
      {
        purpose: 'CONVERSATIONAL',
        granted: false,
        createdAt: new Date('2026-10-02T11:00:00Z'),
        source: 'SMS_KEYWORD',
      },
    ]);

    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      consent.status(tenantId, 'SMS', endpoint, 'MARKETING'),
    ).resolves.toMatchObject({ allowed: false, reason: 'opted_out' });
  });

  // ── security review M2: a handset opt-out is lifted only from the handset
  describe('handset opt-out lock', () => {
    const stop = new Date('2026-10-02T12:00:00Z');
    const later = new Date('2026-10-05T12:00:00Z');
    const stopRows = [
      {
        purpose: 'MARKETING',
        granted: false,
        createdAt: stop,
        source: 'SMS_KEYWORD',
      },
      {
        purpose: 'CONVERSATIONAL',
        granted: false,
        createdAt: stop,
        source: 'SMS_KEYWORD',
      },
    ];

    it.each(['WIDGET', 'STAFF', 'IMPORT'])(
      'a later %s grant does NOT re-open texting after a handset STOP',
      async (source) => {
        const consent = svc([
          { purpose: 'MARKETING', granted: true, createdAt: later, source },
          {
            purpose: 'CONVERSATIONAL',
            granted: true,
            createdAt: later,
            source,
          },
          ...stopRows,
        ]);
        for (const purpose of ['CONVERSATIONAL', 'MARKETING'] as const)
          await expect(
            consent.status(tenantId, 'SMS', endpoint, purpose),
          ).resolves.toEqual({ allowed: false, reason: 'opted_out' });
      },
    );

    it('a provider-reported opt-out locks the same way', async () => {
      const consent = svc([
        {
          purpose: 'CONVERSATIONAL',
          granted: true,
          createdAt: later,
          source: 'WIDGET',
        },
        {
          purpose: 'CONVERSATIONAL',
          granted: false,
          createdAt: stop,
          source: 'PROVIDER',
        },
      ]);
      await expect(
        consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
      ).resolves.toEqual({ allowed: false, reason: 'opted_out' });
    });

    it('a handset START lifts it; an earlier form grant made while locked still does not count on its own', async () => {
      const start = new Date('2026-10-06T12:00:00Z');
      const consent = svc([
        {
          purpose: 'CONVERSATIONAL',
          granted: true,
          createdAt: start,
          source: 'SMS_KEYWORD',
        },
        ...stopRows,
      ]);
      await expect(
        consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
      ).resolves.toMatchObject({ allowed: true });
    });

    it('a form opt-out followed by a form grant is unchanged (no handset record involved)', async () => {
      const consent = svc([
        {
          purpose: 'CONVERSATIONAL',
          granted: true,
          createdAt: later,
          source: 'WIDGET',
        },
        {
          purpose: 'CONVERSATIONAL',
          granted: false,
          createdAt: stop,
          source: 'WIDGET',
        },
      ]);
      await expect(
        consent.status(tenantId, 'SMS', endpoint, 'CONVERSATIONAL'),
      ).resolves.toMatchObject({ allowed: true });
    });
  });
});
