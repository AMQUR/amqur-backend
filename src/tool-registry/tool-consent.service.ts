import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConsentService,
  type ConsentChannel,
  type ConsentPurpose,
} from '../messaging/consent.service';
import type { ToolDefinition } from './tool-catalog';

export type ConsentVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verifies that a tool action's consentRef is a real, current ConsentRecord for the same
 * tenant, lead, rooftop, channel and purpose. Reasons are codes only: never the endpoint or
 * any other customer data. Re-checked at propose, approve and execute, because consent can be
 * revoked or an opt-out recorded between those moments (latest record wins).
 */
@Injectable()
export class ToolConsentService {
  private readonly ledger: ConsentService;

  constructor(private readonly prisma: PrismaService) {
    this.ledger = new ConsentService(prisma);
  }

  async verify(
    tool: ToolDefinition,
    a: {
      tenantId: string;
      locationId: string | null;
      input: Record<string, unknown>;
      consentRef: string | null;
    },
  ): Promise<ConsentVerdict> {
    if (!tool.requiresCustomerConsent) return { ok: true };
    const policy = tool.consent;
    if (!policy || !a.consentRef)
      return { ok: false, reason: 'consent_required' };
    const row = await this.prisma.consentRecord.findFirst({
      where: { id: a.consentRef, tenantId: a.tenantId },
    });
    if (!row) return { ok: false, reason: 'consent_not_found' };
    if (!row.granted || row.revokedAt)
      return { ok: false, reason: 'consent_not_granted' };
    if (!row.leadId || row.leadId !== a.input.leadId)
      return { ok: false, reason: 'consent_lead_mismatch' };
    if (row.locationId && row.locationId !== a.locationId)
      return { ok: false, reason: 'consent_location_mismatch' };
    if (policy.channel === 'FROM_INPUT' && row.channel !== a.input.channel)
      return { ok: false, reason: 'consent_channel_mismatch' };
    const purpose: ConsentPurpose = policy.purpose;
    const purposeOk =
      row.purpose === purpose ||
      (purpose !== 'MARKETING' && row.purpose === 'MARKETING');
    if (!purposeOk) return { ok: false, reason: 'consent_purpose_mismatch' };
    const status = await this.ledger.status(
      a.tenantId,
      row.channel as ConsentChannel,
      row.endpoint,
      purpose,
    );
    if (!status.allowed)
      return { ok: false, reason: `consent_${status.reason}` };
    return { ok: true };
  }
}
