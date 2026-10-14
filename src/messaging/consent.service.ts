import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ConsentChannel = 'SMS' | 'EMAIL' | 'CALL' | 'WHATSAPP';
export type ConsentPurpose = 'TRANSACTIONAL' | 'CONVERSATIONAL' | 'MARKETING';

export function normalizeEndpoint(
  channel: ConsentChannel,
  raw: string,
): string | null {
  if (channel === 'EMAIL') {
    const e = raw.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  }
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (raw.trim().startsWith('+') && d.length >= 8 && d.length <= 15)
    return `+${d}`;
  return null;
}

/**
 * Append-only consent ledger. The LATEST record for (channel, endpoint) wins; an opt-out on a
 * channel blocks every purpose on that channel. Possessing a phone number is never consent.
 * MARKETING requires an explicit MARKETING grant; CONVERSATIONAL/TRANSACTIONAL accept either
 * a matching grant or a MARKETING grant.
 */
@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async record(p: {
    tenantId: string;
    locationId?: string | null;
    leadId?: string | null;
    conversationExternalKey?: string | null;
    channel: ConsentChannel;
    endpoint: string;
    purpose: ConsentPurpose;
    granted: boolean;
    wording?: string | null;
    wordingVersion?: string | null;
    source: 'WIDGET' | 'STAFF' | 'SMS_KEYWORD' | 'PROVIDER' | 'IMPORT';
    evidence?: Record<string, unknown>;
  }) {
    const endpoint = normalizeEndpoint(p.channel, p.endpoint);
    if (!endpoint) throw new Error('invalid_endpoint');
    return this.prisma.consentRecord.create({
      data: {
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        leadId: p.leadId ?? null,
        conversationExternalKey: p.conversationExternalKey ?? null,
        channel: p.channel,
        endpoint,
        purpose: p.purpose,
        granted: p.granted,
        wording: p.wording ?? null,
        wordingVersion: p.wordingVersion ?? null,
        source: p.source,
        evidence: (p.evidence ?? {}) as object,
      },
    });
  }

  async status(
    tenantId: string,
    channel: ConsentChannel,
    rawEndpoint: string,
    purpose: ConsentPurpose,
  ) {
    const endpoint = normalizeEndpoint(channel, rawEndpoint);
    if (!endpoint)
      return { allowed: false, reason: 'invalid_endpoint' as const };
    const rows = await this.prisma.consentRecord.findMany({
      where: { tenantId, channel, endpoint, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const latestOptOut = rows.find((r) => !r.granted);
    const grant = rows.find(
      (r) =>
        r.granted &&
        (r.purpose === purpose ||
          (purpose !== 'MARKETING' && r.purpose === 'MARKETING')),
    );
    if (latestOptOut && (!grant || latestOptOut.createdAt >= grant.createdAt)) {
      return { allowed: false, reason: 'opted_out' as const };
    }
    if (!grant) return { allowed: false, reason: 'no_consent' as const };
    return { allowed: true as const, grantId: grant.id, endpoint };
  }
}
