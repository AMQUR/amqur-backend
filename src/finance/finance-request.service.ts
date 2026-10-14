import { Injectable } from '@nestjs/common';
import { FinanceRequest, FinanceRequestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Finance request capture — never invents APR/approval.
 * Educational estimates remain in PaymentService.
 */
@Injectable()
export class FinanceRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    tenantId: string;
    locationId?: string | null;
    conversationId?: string | null;
    vehicleVin?: string | null;
    desiredPayment?: number | null;
    downPayment?: number | null;
    termMonths?: number | null;
    leaseOrPurchase?: string | null;
    tradeInterest?: boolean;
    aprProvided?: number | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerEmail?: string | null;
    notes?: string | null;
  }) {
    return this.prisma.financeRequest.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: params.conversationId ?? null,
        vehicleVin: params.vehicleVin?.toUpperCase().trim() ?? null,
        desiredPayment: params.desiredPayment ?? null,
        downPayment: params.downPayment ?? null,
        termMonths: params.termMonths ?? null,
        leaseOrPurchase: params.leaseOrPurchase ?? null,
        tradeInterest: params.tradeInterest ?? false,
        // Only store APR when explicitly provided — never invent.
        aprProvided: params.aprProvided ?? null,
        customerName: params.customerName ?? null,
        customerPhone: params.customerPhone ?? null,
        customerEmail: params.customerEmail ?? null,
        notes: params.notes ?? null,
        status: FinanceRequestStatus.REQUESTED,
      },
    });
  }

  /**
   * One active FinanceRequest per conversation (idempotent). Later turns refine it rather
   * than spawning duplicates. Critical write — callers await it before acknowledging.
   */
  async upsertForConversation(p: FinanceUpsertInput): Promise<FinanceRequest> {
    const idempotencyKey = `finance:${p.conversationId}`;
    const existing = await this.prisma.financeRequest.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey },
      },
    });
    const data: Prisma.FinanceRequestUncheckedUpdateInput = {};
    if (p.vehicleVin) data.vehicleVin = p.vehicleVin.toUpperCase().trim();
    if (p.desiredPayment != null) data.desiredPayment = p.desiredPayment;
    if (p.downPayment != null) data.downPayment = p.downPayment;
    if (p.termMonths != null) data.termMonths = p.termMonths;
    if (p.leaseOrPurchase) data.leaseOrPurchase = p.leaseOrPurchase;
    if (p.tradeInterest) data.tradeInterest = true;
    if (p.customerApr != null) {
      data.aprProvided = p.customerApr;
      data.aprSource = 'CUSTOMER';
    }
    if (p.customer?.name) data.customerName = p.customer.name;
    if (p.customer?.phone) data.customerPhone = p.customer.phone;
    if (p.customer?.email) data.customerEmail = p.customer.email;
    if (p.handoffState) data.handoffState = p.handoffState;
    if (existing) {
      if (Object.keys(data).length === 0) return existing;
      return this.prisma.financeRequest.update({
        where: { id: existing.id },
        data,
      });
    }
    try {
      return await this.prisma.financeRequest.create({
        data: {
          ...(data as Record<string, unknown>),
          tenantId: p.tenantId,
          locationId: p.locationId ?? null,
          conversationId: p.conversationId,
          idempotencyKey,
          status: FinanceRequestStatus.REQUESTED,
          provenance: { source: 'chat', aprPolicy: 'customer_only' },
        },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return this.upsertForConversation(p);
      }
      throw e;
    }
  }

  async list(
    tenantId: string,
    opts: {
      locationId?: string | null;
      status?: FinanceRequestStatus;
      take?: number;
    },
  ) {
    return this.prisma.financeRequest.findMany({
      where: {
        tenantId,
        ...(opts.locationId ? { locationId: opts.locationId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 50, 200),
    });
  }
}

export type FinanceUpsertInput = {
  tenantId: string;
  locationId?: string | null;
  conversationId: string;
  vehicleVin?: string | null;
  desiredPayment?: number | null;
  downPayment?: number | null;
  termMonths?: number | null;
  leaseOrPurchase?: 'lease' | 'purchase' | null;
  tradeInterest?: boolean;
  /** Only when the CUSTOMER explicitly stated an APR. Never illustrative/dealer rates. */
  customerApr?: number | null;
  customer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  handoffState?: 'NONE' | 'REQUESTED' | 'QUEUED' | 'ASSIGNED';
};
