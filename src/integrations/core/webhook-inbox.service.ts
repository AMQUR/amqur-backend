import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IntegrationProvider,
  Prisma,
  WebhookInboxStatus,
} from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';

@Injectable()
export class WebhookInboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replay-safe webhook intake. Signature verification requires configured secret.
   * Without a secret, events are stored as REJECTED (never processed as trusted).
   */
  async receive(params: {
    tenantId: string;
    provider: IntegrationProvider;
    externalEventId: string;
    payload: Record<string, unknown>;
    signatureHeader?: string | null;
    webhookSecret?: string | null;
  }) {
    const existing = await this.prisma.webhookInbox.findUnique({
      where: {
        tenantId_provider_externalEventId: {
          tenantId: params.tenantId,
          provider: params.provider,
          externalEventId: params.externalEventId,
        },
      },
    });
    if (existing) {
      return { ...existing, status: WebhookInboxStatus.DUPLICATE };
    }

    let signatureValid = false;
    if (params.webhookSecret && params.signatureHeader) {
      const expected = createHash('sha256')
        .update(`${params.webhookSecret}.${JSON.stringify(params.payload)}`)
        .digest('hex');
      try {
        signatureValid = timingSafeEqual(
          Buffer.from(expected),
          Buffer.from(params.signatureHeader),
        );
      } catch {
        signatureValid = false;
      }
    }

    const status = signatureValid
      ? WebhookInboxStatus.RECEIVED
      : WebhookInboxStatus.REJECTED;

    return this.prisma.webhookInbox.create({
      data: {
        tenantId: params.tenantId,
        provider: params.provider,
        externalEventId: params.externalEventId,
        payload: params.payload as Prisma.InputJsonValue,
        signatureValid,
        status,
        errorMessage: signatureValid
          ? null
          : 'missing_or_invalid_signature — configure webhook secret from official partner docs',
      },
    });
  }
}
