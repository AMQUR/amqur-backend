import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavedVehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    tenantId: string;
    conversationExternalKey: string;
  }) {
    return this.prisma.savedVehicle.findMany({
      where: {
        tenantId: params.tenantId,
        conversationExternalKey: params.conversationExternalKey,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async save(params: {
    tenantId: string;
    locationId?: string | null;
    conversationExternalKey: string;
    vin: string;
    consentOutbound?: boolean;
  }) {
    const vin = params.vin.toUpperCase().trim();
    // Verify vehicle belongs to tenant before save
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        tenantId_vin: { tenantId: params.tenantId, vin },
      },
      select: { vin: true },
    });
    if (!vehicle) {
      return { ok: false as const, error: 'VEHICLE_NOT_FOUND' };
    }
    const row = await this.prisma.savedVehicle.upsert({
      where: {
        tenantId_conversationExternalKey_vin: {
          tenantId: params.tenantId,
          conversationExternalKey: params.conversationExternalKey,
          vin,
        },
      },
      create: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationExternalKey: params.conversationExternalKey,
        vin,
        consentOutbound: params.consentOutbound === true,
      },
      update: {
        consentOutbound:
          params.consentOutbound === true ? true : undefined,
      },
    });
    return { ok: true as const, saved: row };
  }

  async remove(params: {
    tenantId: string;
    conversationExternalKey: string;
    vin: string;
  }) {
    await this.prisma.savedVehicle.deleteMany({
      where: {
        tenantId: params.tenantId,
        conversationExternalKey: params.conversationExternalKey,
        vin: params.vin.toUpperCase().trim(),
      },
    });
    return { ok: true as const };
  }
}
