import {
  DOC_SIGNING_CAPABILITY,
  DocSigningService,
} from './doc-signing.service';

describe('DocSigningService (fail-closed)', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
  };
  const svc = new DocSigningService(prisma as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('requestSign returns not_connected and never claims signed', async () => {
    const result = await svc.requestSign({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      documentRef: 'purchase-agreement-42',
      signerEmail: 'buyer@example.com',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'not_connected' });
    expect(result).not.toHaveProperty('signed');
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        capability: DOC_SIGNING_CAPABILITY,
        enabled: true,
        liveReady: true,
        OR: [{ locationId: 'loc-1' }, { locationId: null }],
      },
      select: { id: true },
    });
  });

  it('getEnvelopeStatus returns not_configured when adapter is not live', async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });

    const result = await svc.getEnvelopeStatus({
      tenantId: 'tenant-1',
      locationId: null,
      envelopeId: 'env-1',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'not_configured' });
    expect(result).not.toHaveProperty('signed');
  });
});
