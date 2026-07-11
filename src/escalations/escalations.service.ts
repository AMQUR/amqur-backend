import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EscalationUrgency, Prisma } from '@prisma/client';
import axios from 'axios';

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.escalation.findMany({
      where: {
        tenantId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async create(params: {
    tenantId: string;
    locationId?: string | null;
    externalKey: string;
    reason: string;
    urgency?: EscalationUrgency;
    summary?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const conv = await this.prisma.conversation.findUnique({
      where: {
        tenantId_externalKey: {
          tenantId: params.tenantId,
          externalKey: params.externalKey,
        },
      },
      select: { id: true },
    });

    const escalation = await this.prisma.escalation.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: conv?.id ?? null,
        reason: params.reason,
        urgency: params.urgency ?? EscalationUrgency.NORMAL,
        summary: params.summary,
        metadata: params.metadata,
      },
    });

    let notified = false;
    const webhook = process.env.CRM_WEBHOOK_URL?.trim();
    if (webhook) {
      try {
        await axios.post(
          webhook,
          {
            event: 'HUMAN_HANDOFF',
            tenantId: params.tenantId,
            locationId: params.locationId,
            conversationId: params.externalKey,
            escalationId: escalation.id,
            reason: params.reason,
            urgency: escalation.urgency,
            summary: params.summary,
            timestamp: new Date().toISOString(),
          },
          { timeout: 8_000 },
        );
        notified = true;
        await this.prisma.escalation.update({
          where: { id: escalation.id },
          data: { notifiedAt: new Date() },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Escalation CRM notify failed: ${msg}`);
      }
    }

    return { escalation, notified };
  }
}
