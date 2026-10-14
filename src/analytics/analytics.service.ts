import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PII_KEYS = new Set([
  'email',
  'phone',
  'name',
  'firstName',
  'lastName',
  'customerName',
  'customerEmail',
  'customerPhone',
]);

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private stripPii(
    properties: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | undefined {
    if (!properties) return undefined;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (PII_KEYS.has(key)) continue;
      clean[key] = value;
    }
    return Object.keys(clean).length > 0 ? clean : undefined;
  }

  async trackEvent(
    tenantId: string,
    locationId: string | null | undefined,
    eventType: string,
    properties?: Record<string, unknown> | null,
    conversationExternalKey?: string | null,
  ) {
    // Non-critical by design: analytics failures must never break a customer turn or
    // surface as unhandled rejections from fire-and-forget callers.
    return this.prisma.analyticsEvent
      .create({
        data: {
          tenantId,
          locationId: locationId ?? null,
          eventType,
          properties: this.stripPii(properties ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          conversationExternalKey: conversationExternalKey ?? null,
        },
      })
      .catch(() => null);
  }
}
