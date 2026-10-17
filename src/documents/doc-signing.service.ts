import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DisabledDocSigningProvider,
  docSigningBlocked,
  type CreateEnvelopeParams,
  type CreateEnvelopeResult,
  type GetEnvelopeStatusParams,
  type GetEnvelopeStatusResult,
} from '../integrations/docs/doc-signing.provider';

/** IntegrationConnection.capability for e-sign workflow. */
export const DOC_SIGNING_CAPABILITY = 'document_signing';

/**
 * Fail-closed document signing: staff may request envelopes only when a
 * live-ready connection exists and a verified provider adapter is configured.
 * Never reports signed: true from the stub path.
 */
@Injectable()
export class DocSigningService {
  private readonly provider = new DisabledDocSigningProvider();

  constructor(private readonly prisma: PrismaService) {}

  async requestSign(params: CreateEnvelopeParams): Promise<CreateEnvelopeResult> {
    const gate = await this.resolveGate(params.tenantId, params.locationId);
    if (!gate.allowed) {
      return docSigningBlocked(gate.reason);
    }
    return this.provider.createEnvelope(params);
  }

  async getEnvelopeStatus(
    params: GetEnvelopeStatusParams,
  ): Promise<GetEnvelopeStatusResult> {
    const gate = await this.resolveGate(params.tenantId, params.locationId);
    if (!gate.allowed) {
      return docSigningBlocked(gate.reason);
    }
    return this.provider.getStatus(params);
  }

  private async resolveGate(
    tenantId: string,
    locationId?: string | null,
  ): Promise<
    | { allowed: true }
    | { allowed: false; reason: 'not_connected' | 'not_configured' }
  > {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        capability: DOC_SIGNING_CAPABILITY,
        enabled: true,
        liveReady: true,
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      select: { id: true },
    });
    if (!conn) {
      return { allowed: false, reason: 'not_connected' };
    }
    if (!this.provider.isLiveConfigured()) {
      return { allowed: false, reason: 'not_configured' };
    }
    return { allowed: true };
  }
}
