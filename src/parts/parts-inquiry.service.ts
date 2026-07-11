import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PartsInquiryStatus } from '@prisma/client';

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
        // Never claim fitment/price/availability without verification
        fitmentVerified: false,
        availabilityVerified: false,
        priceVerified: false,
      },
    });
  }

  customerSafeMessage(): string {
    return (
      'I recorded your parts request for our parts team. ' +
      'I cannot confirm fitment, availability, or price until staff verifies it in the dealership system.'
    );
  }
}
