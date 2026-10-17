import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type QuotePaymentMethod = 'CASH' | 'FINANCE' | 'LEASE' | 'UNDECIDED';

/**
 * Out-the-door quote requests. One per conversation + vehicle (idempotent); staff fulfil it
 * with a written quote. The record keeps a snapshot of exactly what the customer was shown.
 */
@Injectable()
export class PriceQuoteService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertForConversation(p: {
    tenantId: string;
    locationId: string | null;
    conversationId: string;
    vehicleVin: string;
    vehicleLabel?: string | null;
    paymentMethod?: QuotePaymentMethod;
    registrationZip?: string | null;
    estimateShown?: unknown;
    missingInputs?: string[];
    customer?: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
    };
  }) {
    const data = {
      locationId: p.locationId,
      vehicleLabel: p.vehicleLabel ?? undefined,
      ...(p.paymentMethod ? { paymentMethod: p.paymentMethod } : {}),
      ...(p.registrationZip ? { registrationZip: p.registrationZip } : {}),
      ...(p.estimateShown !== undefined
        ? {
            estimateShown:
              p.estimateShown === null
                ? Prisma.DbNull
                : (p.estimateShown as Prisma.InputJsonValue),
          }
        : {}),
      ...(p.missingInputs ? { missingInputs: p.missingInputs } : {}),
      ...(p.customer?.name ? { customerName: p.customer.name } : {}),
      ...(p.customer?.phone ? { customerPhone: p.customer.phone } : {}),
      ...(p.customer?.email ? { customerEmail: p.customer.email } : {}),
      provenance: { source: 'chat' } as Prisma.InputJsonValue,
    };
    // Staff pick these up from the Command Center queue (ops/queues → quotes).
    return this.prisma.priceQuoteRequest.upsert({
      where: {
        tenantId_conversationId_vehicleVin: {
          tenantId: p.tenantId,
          conversationId: p.conversationId,
          vehicleVin: p.vehicleVin,
        },
      },
      create: {
        tenantId: p.tenantId,
        conversationId: p.conversationId,
        vehicleVin: p.vehicleVin,
        ...data,
      },
      update: data,
    });
  }

  list(tenantId: string, status?: string) {
    return this.prisma.priceQuoteRequest.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
