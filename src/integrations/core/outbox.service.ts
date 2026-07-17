import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxStatus, Prisma } from '@prisma/client';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(params: {
    tenantId: string;
    topic: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    if (params.idempotencyKey) {
      const existing = await this.prisma.outboxEvent.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: params.tenantId,
            idempotencyKey: params.idempotencyKey,
          },
        },
      });
      if (existing) return existing;
    }

    return this.prisma.outboxEvent.create({
      data: {
        tenantId: params.tenantId,
        topic: params.topic,
        payload: params.payload as Prisma.InputJsonValue,
        idempotencyKey: params.idempotencyKey,
        status: OutboxStatus.PENDING,
      },
    });
  }

  async claimPending(limit = 50) {
    const rows = await this.prisma.outboxEvent.findMany({
      where: {
        status: OutboxStatus.PENDING,
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows;
  }

  async markPublished(id: string) {
    return this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
  }

  async markFailed(id: string, error: string, attempts: number) {
    const dead = attempts >= 8;
    return this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: dead ? OutboxStatus.DEAD : OutboxStatus.PENDING,
        attempts,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(
          Date.now() + Math.min(3600_000, 2 ** attempts * 1000),
        ),
      },
    });
  }
}
