import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IntegrationProvider, Prisma, WebhookInboxStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { verifyMetaHubSignature256 } from '../../common/security/meta-hub-signature';
import {
  extractMetaLeadgenExternalEventId,
  payloadAsJsonRecord,
} from './meta-lead-payload';

/**
 * Fail-closed Meta Lead Ads webhook intake (storage only — no live CRM sync).
 *
 * Required env (production):
 *   META_APP_SECRET — Meta app secret for X-Hub-Signature-256 verification
 *   META_LEAD_WEBHOOK_TENANT_ID — tenant cuid that owns inbound leadgen events
 *
 * Optional (hub subscription handshake — not wired in this stub):
 *   META_WEBHOOK_VERIFY_TOKEN
 */
@Injectable()
export class MetaLeadsWebhookService {
  private readonly logger = new Logger(MetaLeadsWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  assertIntakeConfigured(): { appSecret: string; tenantId: string } {
    const appSecret = process.env.META_APP_SECRET?.trim();
    const tenantId = process.env.META_LEAD_WEBHOOK_TENANT_ID?.trim();
    if (!appSecret || !tenantId) {
      throw new ServiceUnavailableException({
        reason: 'not_configured',
        message:
          'Meta lead webhook intake is not configured (META_APP_SECRET, META_LEAD_WEBHOOK_TENANT_ID).',
      });
    }
    return { appSecret, tenantId };
  }

  async intake(params: {
    rawBody: string | Buffer;
    signatureHeader?: string | null;
    parsedBody: unknown;
  }) {
    const { appSecret, tenantId } = this.assertIntakeConfigured();
    const payloadRecord = payloadAsJsonRecord(params.parsedBody);
    const signature = verifyMetaHubSignature256({
      rawBody: params.rawBody,
      signatureHeader: params.signatureHeader,
      appSecret,
    });

    if (!signature.ok) {
      this.logger.warn(`meta lead webhook rejected reason=${signature.reason}`);
      return this.storeRejected({
        tenantId,
        externalEventId: `rejected:${randomUUID()}`,
        payload: payloadRecord ?? { unparsed: true },
        errorMessage: signature.reason,
      });
    }

    const externalEventId = extractMetaLeadgenExternalEventId(params.parsedBody);
    if (!externalEventId || !payloadRecord) {
      this.logger.warn('meta lead webhook rejected reason=malformed_payload');
      return this.storeRejected({
        tenantId,
        externalEventId: `rejected:${randomUUID()}`,
        payload: payloadRecord ?? { unparsed: true },
        errorMessage: 'malformed_payload',
      });
    }

    try {
      return await this.prisma.webhookInbox.create({
        data: {
          tenantId,
          provider: IntegrationProvider.META,
          externalEventId,
          payload: payloadRecord as Prisma.InputJsonValue,
          signatureValid: true,
          status: WebhookInboxStatus.RECEIVED,
        },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await this.prisma.webhookInbox.findUnique({
          where: {
            tenantId_provider_externalEventId: {
              tenantId,
              provider: IntegrationProvider.META,
              externalEventId,
            },
          },
        });
        return { ...existing!, status: WebhookInboxStatus.DUPLICATE };
      }
      throw e;
    }
  }

  private storeRejected(params: {
    tenantId: string;
    externalEventId: string;
    payload: Record<string, unknown>;
    errorMessage: string;
  }) {
    return this.prisma.webhookInbox.create({
      data: {
        tenantId: params.tenantId,
        provider: IntegrationProvider.META,
        externalEventId: params.externalEventId,
        payload: params.payload as Prisma.InputJsonValue,
        signatureValid: false,
        status: WebhookInboxStatus.REJECTED,
        errorMessage: params.errorMessage,
      },
    });
  }
}
