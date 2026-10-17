import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PartsInquiry, PartsInquiryStatus, Prisma } from '@prisma/client';
import { isValidVinFormat } from '../common/vin/vin.util';

/** Staff workflow statuses — never auto-sets fitment/price/availability flags. */
export const STAFF_PARTS_STATUSES: PartsInquiryStatus[] = [
  'REQUESTED',
  'PENDING_STAFF',
  'FITMENT_PENDING',
  'QUOTED',
  'ORDERED',
  'CLOSED',
  'CANCELLED',
];

export type PartsUpsertInput = {
  tenantId: string;
  locationId?: string | null;
  conversationId: string;
  description: string;
  partNumber?: string | null;
  suspectedPart?: string | null;
  vin?: string | null;
  vehicle?: { year?: number; make?: string; model?: string } | null;
  preferredAction?: 'INFO' | 'QUOTE' | 'RESERVE' | 'ORDER' | 'INSTALL' | null;
  installationRequested?: boolean;
  customer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
};

/**
 * Parts inquiries are persisted even when no authoritative parts provider exists.
 * Fitment / price / availability / ETA flags stay false unless a PartsProvider verified
 * them — the LLM never infers fitment as a dealership fact.
 */
@Injectable()
export class PartsInquiryService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    tenantId: string;
    locationId?: string | null;
    conversationId?: string | null;
    vin?: string | null;
    partDescription: string;
    customerName?: string | null;
    customerPhone?: string | null;
    customerEmail?: string | null;
  }) {
    return this.prisma.partsInquiry.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: params.conversationId ?? null,
        vin: params.vin?.toUpperCase().trim() ?? null,
        partDescription: params.partDescription.slice(0, 500),
        customerName: params.customerName,
        customerPhone: params.customerPhone,
        customerEmail: params.customerEmail,
        status: PartsInquiryStatus.REQUESTED,
        fitmentVerified: false,
        availabilityVerified: false,
        priceVerified: false,
      },
    });
  }

  /** One open parts inquiry per conversation+part; refined across turns (idempotent). */
  async upsertForConversation(p: PartsUpsertInput): Promise<PartsInquiry> {
    const keyPart = (p.partNumber ?? p.suspectedPart ?? 'general')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .slice(0, 40);
    const idempotencyKey = `parts:${p.conversationId}:${keyPart}`;
    const existing = await this.prisma.partsInquiry.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey },
      },
    });
    const vin =
      p.vin && isValidVinFormat(p.vin.toUpperCase())
        ? p.vin.toUpperCase()
        : null;
    const data: Prisma.PartsInquiryUncheckedUpdateInput = {};
    if (vin) data.vin = vin;
    if (p.partNumber) data.partNumber = p.partNumber.slice(0, 40);
    if (p.vehicle?.year) data.vehicleYear = p.vehicle.year;
    if (p.vehicle?.make) data.vehicleMake = p.vehicle.make;
    if (p.vehicle?.model) data.vehicleModel = p.vehicle.model;
    if (p.preferredAction) data.preferredAction = p.preferredAction;
    if (p.installationRequested) data.installationRequested = true;
    if (p.customer?.name) data.customerName = p.customer.name;
    if (p.customer?.phone) data.customerPhone = p.customer.phone;
    if (p.customer?.email) data.customerEmail = p.customer.email;
    // Without VIN or part number staff must confirm fitment.
    const nextStatus =
      vin || p.partNumber
        ? PartsInquiryStatus.PENDING_STAFF
        : PartsInquiryStatus.FITMENT_PENDING;
    if (existing) {
      const becomingStaff =
        nextStatus === PartsInquiryStatus.PENDING_STAFF &&
        existing.status !== PartsInquiryStatus.PENDING_STAFF;
      if (
        existing.status === 'REQUESTED' ||
        existing.status === 'FITMENT_PENDING'
      )
        data.status = nextStatus;
      const updated = await this.prisma.partsInquiry.update({
        where: { id: existing.id },
        data,
      });
      if (becomingStaff)
        await this.notifyPartsAdvisor(updated).catch(() => undefined);
      return updated;
    }
    try {
      const created = await this.prisma.partsInquiry.create({
        data: {
          ...(data as Record<string, unknown>),
          tenantId: p.tenantId,
          locationId: p.locationId ?? null,
          conversationId: p.conversationId,
          idempotencyKey,
          partDescription: p.description.slice(0, 500),
          suspectedPart: p.suspectedPart ?? null,
          status: nextStatus,
          fitmentVerified: false,
          availabilityVerified: false,
          priceVerified: false,
          etaVerified: false,
          provenance: {
            source: 'chat',
            fitment: 'unverified',
            providerConfigured: false,
          },
        },
      });
      if (nextStatus === PartsInquiryStatus.PENDING_STAFF)
        await this.notifyPartsAdvisor(created).catch(() => undefined);
      return created;
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

  /**
   * Queue a parts advisor escalation when fitment cannot be verified automatically.
   * Never invents fitment/price — staff must confirm.
   */
  private async notifyPartsAdvisor(row: PartsInquiry) {
    if (!row.conversationId) return;
    const open = await this.prisma.escalation.findFirst({
      where: {
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
        reason: 'PARTS_ADVISOR',
      },
    });
    if (open) return;
    await this.prisma.escalation.create({
      data: {
        tenantId: row.tenantId,
        locationId: row.locationId,
        conversationId: row.conversationId,
        reason: 'PARTS_ADVISOR',
        urgency: 'NORMAL',
        summary:
          `Parts inquiry needs staff: ${row.suspectedPart ?? row.partNumber ?? row.partDescription}`.slice(
            0,
            280,
          ),
        metadata: {
          partsInquiryId: row.id,
          vin: row.vin,
          fitmentVerified: false,
        },
      },
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: row.tenantId,
          locationId: row.locationId,
          eventType: 'parts.advisor_queued',
          properties: { partsInquiryId: row.id },
        },
      })
      .catch(() => null);
  }

  async linkInstallAppointment(
    tenantId: string,
    id: string,
    appointmentId: string,
  ) {
    return this.prisma.partsInquiry.updateMany({
      where: { id, tenantId },
      data: {
        installAppointmentId: appointmentId,
        installationRequested: true,
      },
    });
  }

  async list(
    tenantId: string,
    opts: {
      locationId?: string | null;
      status?: PartsInquiryStatus;
      take?: number;
    },
  ) {
    return this.prisma.partsInquiry.findMany({
      where: {
        tenantId,
        ...(opts.locationId ? { locationId: opts.locationId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 50, 200),
    });
  }

  /** Staff workflow update — never marks fitment/price/availability verified. */
  async updateStaff(
    tenantId: string,
    locationId: string | null | undefined,
    partsInquiryId: string,
    userId: string,
    patch: {
      status?: PartsInquiryStatus;
      notes?: string | null;
      acknowledgeEscalation?: boolean;
    },
  ): Promise<PartsInquiry> {
    const row = await this.prisma.partsInquiry.findFirst({
      where: {
        id: partsInquiryId,
        tenantId,
        ...(locationId ? { locationId } : {}),
      },
    });
    if (!row) throw new NotFoundException('Parts inquiry not found');

    const data: Prisma.PartsInquiryUpdateInput = {};
    if (patch.status !== undefined) {
      if (!STAFF_PARTS_STATUSES.includes(patch.status)) {
        throw new BadRequestException('Invalid status');
      }
      data.status = patch.status;
    }
    if (patch.notes !== undefined) {
      const trimmed = patch.notes?.trim() ?? '';
      data.notes = trimmed.length ? trimmed.slice(0, 4000) : null;
    }
    const hasInquiryPatch = Object.keys(data).length > 0;
    const updated = hasInquiryPatch
      ? await this.prisma.partsInquiry.update({
          where: { id: row.id },
          data,
        })
      : row;

    if (patch.acknowledgeEscalation && row.conversationId) {
      const open = await this.prisma.escalation.findMany({
        where: {
          tenantId,
          conversationId: row.conversationId,
          reason: 'PARTS_ADVISOR',
          status: 'OPEN',
        },
      });
      const match = open.filter((e) => {
        const meta = e.metadata as { partsInquiryId?: string } | null;
        return !meta?.partsInquiryId || meta.partsInquiryId === row.id;
      });
      if (match.length) {
        await this.prisma.escalation.updateMany({
          where: { id: { in: match.map((e) => e.id) } },
          data: { status: 'ACKNOWLEDGED' },
        });
      }
    }

    if (hasInquiryPatch || patch.acknowledgeEscalation) {
      await this.prisma.auditLog
        .create({
          data: {
            tenantId,
            userId,
            action: 'parts_inquiry.update',
            resource: 'PartsInquiry',
            resourceId: row.id,
            metadata: {
              status: patch.status ?? row.status,
              notesUpdated: patch.notes !== undefined,
              escalationAcknowledged: !!patch.acknowledgeEscalation,
            },
          },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  customerSafeMessage(): string {
    return (
      'I recorded your parts request for our parts team. ' +
      'I cannot confirm fitment, availability, or price until staff verifies it in the dealership system.'
    );
  }
}
