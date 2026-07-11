import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_SOURCE_AUTHORITY: Array<{
  field: string;
  primarySource: string;
  fallbackSource?: string;
  freshnessSlaHours: number;
  notes: string;
}> = [
  {
    field: 'advertised_price',
    primarySource: 'vauto',
    fallbackSource: undefined,
    freshnessSlaHours: 24,
    notes: 'Customer-facing price from contracted inventory feed',
  },
  {
    field: 'inventory_availability',
    primarySource: 'vauto',
    fallbackSource: undefined,
    freshnessSlaHours: 24,
    notes: 'Never invent availability',
  },
  {
    field: 'service_appointment_status',
    primarySource: 'tekion',
    fallbackSource: undefined,
    freshnessSlaHours: 1,
    notes: 'Confirmed only when Tekion returns confirmation',
  },
  {
    field: 'repair_order_status',
    primarySource: 'tekion',
    fallbackSource: undefined,
    freshnessSlaHours: 1,
    notes: 'Never infer from chat text',
  },
  {
    field: 'customer_contact',
    primarySource: 'tekion',
    fallbackSource: 'amqur_lead',
    freshnessSlaHours: 168,
    notes: 'Temporary AMQUR capture until CRM writeback',
  },
  {
    field: 'conversation_state',
    primarySource: 'amqur',
    freshnessSlaHours: 8760,
    notes: 'AMQUR owns conversations',
  },
  {
    field: 'payment_estimate',
    primarySource: 'amqur_calculator',
    freshnessSlaHours: 1,
    notes: 'Educational estimate only unless dealer calculator verifies',
  },
];

@Injectable()
export class SourceAuthorityService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaults(tenantId: string) {
    for (const rule of DEFAULT_SOURCE_AUTHORITY) {
      await this.prisma.sourceAuthorityRule.upsert({
        where: {
          tenantId_field: { tenantId, field: rule.field },
        },
        create: {
          tenantId,
          field: rule.field,
          primarySource: rule.primarySource,
          fallbackSource: rule.fallbackSource,
          freshnessSlaHours: rule.freshnessSlaHours,
          notes: rule.notes,
        },
        update: {},
      });
    }
  }

  async resolve(tenantId: string, field: string) {
    const rule = await this.prisma.sourceAuthorityRule.findUnique({
      where: { tenantId_field: { tenantId, field } },
    });
    if (rule) return rule;
    return (
      DEFAULT_SOURCE_AUTHORITY.find((r) => r.field === field) ?? {
        field,
        primarySource: 'amqur',
        fallbackSource: undefined,
        freshnessSlaHours: 24,
        notes: 'default',
      }
    );
  }

  async recordConflict(params: {
    tenantId: string;
    field: string;
    entityType: string;
    entityId: string;
    primaryValue?: string | null;
    conflictingValue?: string | null;
    primarySource: string;
    conflictingSource: string;
  }) {
    return this.prisma.sourceConflict.create({
      data: {
        tenantId: params.tenantId,
        field: params.field,
        entityType: params.entityType,
        entityId: params.entityId,
        primaryValue: params.primaryValue,
        conflictingValue: params.conflictingValue,
        primarySource: params.primarySource,
        conflictingSource: params.conflictingSource,
      },
    });
  }
}
