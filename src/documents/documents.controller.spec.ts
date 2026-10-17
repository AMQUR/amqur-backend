import { BadRequestException } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocSigningService } from './doc-signing.service';

describe('DocumentsController', () => {
  const docSigning = {
    requestSign: jest.fn(),
    getEnvelopeStatus: jest.fn(),
  };
  const ctrl = new DocumentsController(docSigning as unknown as DocSigningService);

  const user = {
    id: 'u1',
    role: 'MANAGER',
    tenantId: 'tenant-1',
    locationId: 'loc-1',
  } as never;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('envelopeStatus rejects missing envelopeId', () => {
    expect(() => ctrl.envelopeStatus(user, '', 'loc-1')).toThrow(BadRequestException);
  });

  it('envelopeStatus delegates to DocSigningService', async () => {
    docSigning.getEnvelopeStatus.mockResolvedValue({
      status: 'blocked',
      reason: 'not_connected',
    });

    await expect(
      ctrl.envelopeStatus(user, 'env-abc', 'loc-1'),
    ).resolves.toEqual({ status: 'blocked', reason: 'not_connected' });

    expect(docSigning.getEnvelopeStatus).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      envelopeId: 'env-abc',
    });
  });
});
