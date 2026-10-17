/**
 * E-sign envelope contracts — no live DocuSign/Adobe Sign calls.
 * Never claim a document was signed without verified provider completion.
 */
export type DocSigningBlockedReason = 'not_connected' | 'not_configured';

export type DocSigningBlocked = {
  status: 'blocked';
  reason: DocSigningBlockedReason;
};

export function docSigningBlocked(
  reason: DocSigningBlockedReason,
): DocSigningBlocked {
  return { status: 'blocked', reason };
}

export type DocSigningScope = {
  tenantId: string;
  locationId?: string | null;
};

export type CreateEnvelopeParams = DocSigningScope & {
  documentRef: string;
  signerEmail?: string | null;
  signerName?: string | null;
  idempotencyKey?: string | null;
};

export type CreateEnvelopeResult =
  | DocSigningBlocked
  | {
      status: 'pending';
      envelopeId: string;
      /** Always false until a live adapter confirms completion via getStatus. */
      signed: false;
    };

export type GetEnvelopeStatusParams = DocSigningScope & {
  envelopeId: string;
};

export type GetEnvelopeStatusResult =
  | DocSigningBlocked
  | {
      status: 'pending' | 'declined' | 'voided';
      envelopeId: string;
      signed: false;
    }
  | {
      status: 'completed';
      envelopeId: string;
      signed: true;
      completedAt: string;
    };

export interface DocSigningProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  createEnvelope(params: CreateEnvelopeParams): Promise<CreateEnvelopeResult>;
  getStatus(params: GetEnvelopeStatusParams): Promise<GetEnvelopeStatusResult>;
}

/** Stub until e-sign vendor OAuth + webhook verification is approved. */
export class DisabledDocSigningProvider implements DocSigningProvider {
  readonly providerId = 'disabled';

  isLiveConfigured(): boolean {
    return false;
  }

  async createEnvelope(
    _params: CreateEnvelopeParams,
  ): Promise<CreateEnvelopeResult> {
    return docSigningBlocked('not_configured');
  }

  async getStatus(
    _params: GetEnvelopeStatusParams,
  ): Promise<GetEnvelopeStatusResult> {
    return docSigningBlocked('not_configured');
  }
}
