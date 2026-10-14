import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IntegrationProvider,
  Prisma,
  WebhookInboxStatus,
} from '@prisma/client';
import { verifyWebhookSignature } from '../../common/security/webhook-signature';

@Injectable()
export class WebhookInboxService {
  private readonly logger = new Logger(WebhookInboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replay-safe intake for AMQUR-owned generic webhooks (HMAC-SHA256, timestamped,
   * unique event id, rotation-capable). Signature is verified BEFORE dedupe so an
   * unauthenticated sender cannot squat a legitimate event id. Rejected deliveries are
   * stored under a random key for audit and never processed.
   */
  async receive(params: {
    tenantId: string;
    provider: IntegrationProvider;
    externalEventId: string;
    rawBody: string | Buffer;
    payload: Record<string, unknown>;
    signatureHeader?: string | null;
    timestampHeader?: string | null;
    /** current secret first, previous (rotation) second */
    secrets: Array<string | null | undefined>;
    nowSeconds?: number;
  }) {
    const v = verifyWebhookSignature({
      rawBody: params.rawBody,
      signatureHeader: params.signatureHeader,
      timestampHeader: params.timestampHeader,
      eventId: params.externalEventId,
      secrets: params.secrets,
      nowSeconds: params.nowSeconds,
    });

    if (!v.ok) {
      this.logger.warn(
        `webhook rejected tenant=${params.tenantId} provider=${params.provider} reason=${v.reason}`,
      );
      return this.prisma.webhookInbox.create({
        data: {
          tenantId: params.tenantId,
          provider: params.provider,
          externalEventId: `rejected:${randomUUID()}`,
          payload: { claimedEventId: params.externalEventId.slice(0, 200) },
          signatureValid: false,
          status: WebhookInboxStatus.REJECTED,
          errorMessage: v.reason,
        },
      });
    }

    try {
      return await this.prisma.webhookInbox.create({
        data: {
          tenantId: params.tenantId,
          provider: params.provider,
          externalEventId: params.externalEventId,
          payload: params.payload as Prisma.InputJsonValue,
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
              tenantId: params.tenantId,
              provider: params.provider,
              externalEventId: params.externalEventId,
            },
          },
        });
        return { ...existing!, status: WebhookInboxStatus.DUPLICATE };
      }
      throw e;
    }
  }
}
