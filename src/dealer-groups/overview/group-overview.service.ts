import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DealerGroupsService } from '../dealer-groups.service';
import { LeadFunnelService } from '../../operations/funnel/lead-funnel.service';
import {
  clampWindowDays,
  FUNNEL_STAGES,
  FunnelStage,
  LeadFunnel,
} from '../../operations/funnel/lead-funnel';
import {
  CAPABILITY_LABELS,
  CAPABILITY_STATUSES,
  CapabilityCell,
  CapabilityEvidence,
  CapabilityKey,
  capabilityMatrix,
} from './capability-matrix';

export type GroupOverviewStore = {
  tenant: { id: string; slug: string; name: string };
  /** True for the group's own website tenant: it holds no leads or appointments of its own. */
  isGroupSite: boolean;
  funnel: LeadFunnel;
  capabilities: Record<CapabilityKey, CapabilityCell>;
};

export type GroupOverview = {
  dealerGroup: { id: string; name: string };
  windowDays: number;
  since: string;
  statuses: readonly string[];
  capabilityLabels: Record<CapabilityKey, string>;
  stores: GroupOverviewStore[];
  /** Sum of each store's own funnel. A request is never added into a confirmation. */
  totals: {
    stages: Array<{ stage: FunnelStage; count: number }>;
    notProven: LeadFunnel['notProven'];
    needsAttention: LeadFunnel['needsAttention'];
  };
  note: string;
};

/**
 * Group overview for the operator console: every member rooftop's funnel and capability
 * matrix side by side. Aggregate counts and status words only — no customer record, name,
 * address or message leaves a rooftop's tenant. Access: SUPER_ADMIN, or a member of the group.
 */
@Injectable()
export class GroupOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: DealerGroupsService,
    private readonly funnels: LeadFunnelService,
  ) {}

  async overview(params: {
    dealerGroupId: string;
    actorUserId: string;
    isSuperAdmin: boolean;
    days: unknown;
  }): Promise<GroupOverview> {
    if (!params.isSuperAdmin)
      await this.groups.assertMembership(
        params.actorUserId,
        params.dealerGroupId,
      );
    const group = await this.prisma.dealerGroup.findUnique({
      where: { id: params.dealerGroupId },
      select: { id: true, name: true, groupSiteTenantId: true },
    });
    if (!group) throw new NotFoundException('DEALER_GROUP_NOT_FOUND');
    const windowDays = clampWindowDays(params.days);
    const now = new Date();
    const tenants = await this.prisma.tenant.findMany({
      where: { dealerGroupId: group.id },
      select: {
        id: true,
        slug: true,
        name: true,
        allowedOrigins: true,
        featureFlags: true,
      },
      orderBy: { name: 'asc' },
    });

    const stores: GroupOverviewStore[] = [];
    for (const t of tenants) {
      const [funnel, evidence] = await Promise.all([
        this.funnels.funnel(
          { tenantId: t.id, locationId: null },
          windowDays,
          now,
        ),
        this.evidence(t),
      ]);
      stores.push({
        tenant: { id: t.id, slug: t.slug, name: t.name },
        isGroupSite: t.id === group.groupSiteTenantId,
        funnel,
        capabilities: capabilityMatrix(evidence),
      });
    }

    const sum = (pick: (f: LeadFunnel) => number) =>
      stores.reduce((n, s) => n + pick(s.funnel), 0);
    return {
      dealerGroup: { id: group.id, name: group.name },
      windowDays,
      since: new Date(now.getTime() - windowDays * 86_400_000).toISOString(),
      statuses: CAPABILITY_STATUSES,
      capabilityLabels: CAPABILITY_LABELS,
      stores,
      totals: {
        stages: FUNNEL_STAGES.map((stage) => ({
          stage,
          count: sum(
            (f) => f.stages.find((x) => x.stage === stage)?.count ?? 0,
          ),
        })),
        notProven: {
          mailAcceptedSandboxOnly: sum(
            (f) => f.notProven.mailAcceptedSandboxOnly,
          ),
          appointmentsSandboxConfirmed: sum(
            (f) => f.notProven.appointmentsSandboxConfirmed,
          ),
          appointmentsStaffConfirmedNoReceipt: sum(
            (f) => f.notProven.appointmentsStaffConfirmedNoReceipt,
          ),
        },
        needsAttention: {
          crmRejected: sum((f) => f.needsAttention.crmRejected),
          blocked: sum((f) => f.needsAttention.blocked),
          failedOrDead: sum((f) => f.needsAttention.failedOrDead),
          acceptedNotConfirmedInCrm: sum(
            (f) => f.needsAttention.acceptedNotConfirmedInCrm,
          ),
        },
      },
      note: 'Counts and status words only. Customer records stay in each store’s own account.',
    };
  }

  /** Counts and booleans for one rooftop. Never reads a customer field. */
  private async evidence(t: {
    id: string;
    allowedOrigins: string | null;
    featureFlags: unknown;
  }): Promise<CapabilityEvidence> {
    const tenantId = t.id;
    const prodRoute = { tenantId, environment: 'PRODUCTION' as const };
    const onProd = { tenantId, route: { environment: 'PRODUCTION' as const } };
    const [
      real,
      synthetic,
      sandboxEnabled,
      production,
      productionVerified,
      productionLive,
      acceptedOnProductionRoute,
      crmMatchedOnProductionRoute,
      acceptedOnSandboxRoute,
      realScheduler,
      providerConfirmedReceipts,
      sandboxConfirmedReceipts,
      tekion,
      tekionReady,
      sms,
    ] = await Promise.all([
      this.prisma.vehicle.count({
        where: {
          tenantId,
          status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
          NOT: { source: 'synthetic_demo' },
        },
      }),
      this.prisma.vehicle.count({
        where: { tenantId, source: 'synthetic_demo' },
      }),
      this.prisma.leadDeliveryRoute.count({
        where: { tenantId, environment: 'SANDBOX', enabled: true },
      }),
      this.prisma.leadDeliveryRoute.count({ where: prodRoute }),
      this.prisma.leadDeliveryRoute.count({
        where: { ...prodRoute, verified: true },
      }),
      this.prisma.leadDeliveryRoute.count({
        where: {
          ...prodRoute,
          verified: true,
          productionEnabled: true,
          enabled: true,
        },
      }),
      this.prisma.leadDelivery.count({
        where: { ...onProd, acceptedAt: { not: null } },
      }),
      this.prisma.leadDelivery.count({
        where: { ...onProd, crmMatchedAt: { not: null } },
      }),
      this.prisma.leadDelivery.count({
        where: {
          tenantId,
          route: { environment: 'SANDBOX' },
          acceptedAt: { not: null },
        },
      }),
      this.prisma.integrationConnection.count({
        where: {
          tenantId,
          capability: 'appointments',
          enabled: true,
          liveReady: true,
          NOT: { provider: 'MOCK' },
        },
      }),
      this.prisma.appointmentProviderReceipt.count({
        where: { tenantId, status: 'CONFIRMED', sandbox: false },
      }),
      this.prisma.appointmentProviderReceipt.count({
        where: { tenantId, status: 'CONFIRMED', sandbox: true },
      }),
      this.prisma.integrationConnection.count({
        where: { tenantId, provider: 'TEKION' },
      }),
      this.prisma.integrationConnection.count({
        where: { tenantId, provider: 'TEKION', enabled: true, liveReady: true },
      }),
      this.prisma.integrationConnection.count({
        where: { tenantId, provider: 'TWILIO', enabled: true, liveReady: true },
      }),
    ]);
    const flags: Record<string, boolean> = {};
    if (t.featureFlags && typeof t.featureFlags === 'object')
      for (const [k, v] of Object.entries(t.featureFlags))
        if (typeof v === 'boolean') flags[k] = v;
    return {
      allowedOriginCount: (t.allowedOrigins ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean).length,
      flags,
      vehicles: { real, synthetic },
      leadRoutes: {
        sandboxEnabled,
        production,
        productionVerified,
        productionLive,
      },
      deliveries: {
        acceptedOnProductionRoute,
        crmMatchedOnProductionRoute,
        acceptedOnSandboxRoute,
      },
      scheduler: {
        realConnection: realScheduler > 0,
        providerConfirmedReceipts,
        sandboxConfirmedReceipts,
      },
      tekion: { connection: tekion > 0, enabledLiveReady: tekionReady > 0 },
      messaging: { smsConnection: sms > 0 },
    };
  }
}
