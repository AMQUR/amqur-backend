import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CreditApplicationService } from '../finance/credit-application.service';
import { StoreHoursService } from '../locations/store-hours.service';
import { mergePolicy } from '../finance/financial-assumption-policy';

/**
 * Five-rooftop readiness scorecard. Combines the registry (config/rooftops/registry.json —
 * dealership/vendor evidence states) with LIVE database state for each rooftop's own tenant.
 * Cells are PASS / FAIL / BLOCKED / NOT_TESTED — never inferred from confidence.
 *
 * PASS requires evidence. A capability whose vendor artifact is missing is BLOCKED; one that
 * is in our control but not yet done/configured is FAIL; one that needs a per-store
 * acceptance run that has not happened is NOT_TESTED.
 */
export type Cell = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_TESTED';
export type RowKey =
  | 'tenantConfigured'
  | 'brandingVerified'
  | 'domainVerified'
  | 'websiteVendorVerified'
  | 'inventoryConnected'
  | 'pricingVerified'
  | 'hoursVerified'
  | 'staffConfigured'
  | 'crmConnected'
  | 'tekionAuthorized'
  | 'creditApplicationVerified'
  | 'otdPolicyVerified'
  | 'serviceWorkflowVerified'
  | 'partsWorkflowVerified'
  | 'appraisalProviderConfigured'
  | 'consentConfigured'
  | 'handoffDestinationVerified'
  | 'securityTestsPassed'
  | 'aiTestsPassed'
  | 'mobileTestsPassed'
  | 'loadTestsPassed'
  | 'monitoringEnabled'
  | 'backupsVerified'
  | 'canaryApproved'
  | 'productionApproved'
  | 'publicWidgetInstalled'
  | 'liveTrafficVerified';

export const ROW_LABELS: Record<RowKey, string> = {
  tenantConfigured: 'Tenant configured',
  brandingVerified: 'Branding verified',
  domainVerified: 'Domain verified',
  websiteVendorVerified: 'Website vendor verified',
  inventoryConnected: 'Inventory connected',
  pricingVerified: 'Pricing verified',
  hoursVerified: 'Hours verified',
  staffConfigured: 'Staff configured',
  crmConnected: 'CRM connected',
  tekionAuthorized: 'Tekion authorized',
  creditApplicationVerified: 'Credit application verified',
  otdPolicyVerified: 'OTD policy verified',
  serviceWorkflowVerified: 'Service workflow verified',
  partsWorkflowVerified: 'Parts workflow verified',
  appraisalProviderConfigured: 'Appraisal provider configured',
  consentConfigured: 'Consent configured',
  handoffDestinationVerified: 'Handoff destination verified',
  securityTestsPassed: 'Security tests passed',
  aiTestsPassed: 'AI tests passed',
  mobileTestsPassed: 'Mobile tests passed',
  loadTestsPassed: 'Load tests passed',
  monitoringEnabled: 'Monitoring enabled',
  backupsVerified: 'Backups verified',
  canaryApproved: 'Canary approved',
  productionApproved: 'Production approved',
  publicWidgetInstalled: 'Public widget installed',
  liveTrafficVerified: 'Live traffic verified',
};

type Status = 'VERIFIED' | 'OBSERVED' | 'UNVERIFIED' | 'MISSING' | 'BLOCKED';
type Item = { status: Status; [k: string]: unknown };
export type RooftopEntry = {
  key: string;
  displayName: string;
  tenantSlug: string;
  locationSlug: string;
  website: {
    url: string;
    status: Status;
    provider: Item;
    productionOrigins: Item;
    installAuthorization: Item;
  };
  identity: Item;
  [k: string]: unknown;
};

export type LiveFacts = {
  tenantExists: boolean;
  locationExists: boolean;
  allowedOrigins: string[];
  brandingConfigured: boolean;
  liveVehicles: number;
  syntheticVehicles: number;
  hoursVerified: boolean;
  hoursSynthetic: boolean;
  staffUsers: number;
  tekionConnectionLive: boolean;
  creditAvailableLive: boolean;
  policyMode: 'ILLUSTRATIVE' | 'DEALER_CONFIGURED' | null;
  consentText: boolean;
  crmWebhookConfigured: boolean;
};

const st = (x: unknown): Status =>
  ((x as Item | undefined)?.status ?? 'MISSING') as Status;
const vendorGate = (s: Status): Cell =>
  s === 'VERIFIED'
    ? 'PASS'
    : s === 'MISSING' || s === 'BLOCKED'
      ? 'BLOCKED'
      : 'NOT_TESTED';

/** Pure scoring — unit-testable without a database. */
export function scoreRooftop(
  r: RooftopEntry,
  f: LiveFacts | null,
): Record<RowKey, Cell> {
  const live = f;
  const c = {} as Record<RowKey, Cell>;
  c.tenantConfigured =
    live?.tenantExists && live.locationExists ? 'PASS' : 'FAIL';
  c.brandingVerified =
    st(r.identity) === 'VERIFIED' && live?.brandingConfigured
      ? 'PASS'
      : st(r.identity) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  const originsOk =
    st(r.website.productionOrigins) === 'VERIFIED' &&
    !!live &&
    ((r.website.productionOrigins.value as string[] | undefined) ?? []).every(
      (o) => live.allowedOrigins.includes(o),
    );
  c.domainVerified = originsOk
    ? 'PASS'
    : st(r.website.productionOrigins) === 'VERIFIED'
      ? 'FAIL'
      : 'BLOCKED';
  c.websiteVendorVerified = vendorGate(st(r.website.provider));
  c.inventoryConnected =
    live && live.liveVehicles > 0 && st(r.inventorySource) === 'VERIFIED'
      ? 'PASS'
      : vendorGate(st(r.inventorySource)) === 'PASS'
        ? 'FAIL'
        : 'BLOCKED';
  c.pricingVerified =
    st(r.pricingPolicy) === 'VERIFIED' && c.inventoryConnected === 'PASS'
      ? 'PASS'
      : 'BLOCKED';
  c.hoursVerified =
    live?.hoursVerified && !live.hoursSynthetic && st(r.hours) === 'VERIFIED'
      ? 'PASS'
      : st(r.hours) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  c.staffConfigured =
    live && live.staffUsers > 0 && st(r.staff) === 'VERIFIED'
      ? 'PASS'
      : st(r.staff) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  c.crmConnected =
    live?.tekionConnectionLive && st(r.crm) === 'VERIFIED' ? 'PASS' : 'BLOCKED';
  c.tekionAuthorized = live?.tekionConnectionLive ? 'PASS' : 'BLOCKED';
  c.creditApplicationVerified =
    live?.creditAvailableLive && st(r.creditApplication) === 'VERIFIED'
      ? 'PASS'
      : st(r.creditApplication) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  c.otdPolicyVerified =
    live?.policyMode === 'DEALER_CONFIGURED' && st(r.taxFeeRules) === 'VERIFIED'
      ? 'PASS'
      : st(r.taxFeeRules) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  c.serviceWorkflowVerified =
    st(r.serviceScheduling) === 'VERIFIED' ? 'NOT_TESTED' : 'BLOCKED';
  c.partsWorkflowVerified =
    st(r.partsRouting) === 'VERIFIED' ? 'NOT_TESTED' : 'BLOCKED';
  c.appraisalProviderConfigured = vendorGate(st(r.appraisalProvider));
  c.consentConfigured =
    st(r.consent) === 'VERIFIED' && live?.consentText
      ? 'PASS'
      : st(r.consent) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  c.handoffDestinationVerified =
    st(r.handoffDestination) === 'VERIFIED' && live?.crmWebhookConfigured
      ? 'PASS'
      : st(r.handoffDestination) === 'VERIFIED'
        ? 'FAIL'
        : 'BLOCKED';
  // Platform suites run against simulated fixtures, not this store's configuration.
  c.securityTestsPassed = 'NOT_TESTED';
  c.aiTestsPassed = 'NOT_TESTED';
  c.mobileTestsPassed = 'NOT_TESTED';
  c.loadTestsPassed = 'NOT_TESTED';
  c.monitoringEnabled = st(r.monitoring) === 'VERIFIED' ? 'PASS' : 'BLOCKED';
  c.backupsVerified = 'BLOCKED';
  const ap = (r.approvals ?? {}) as { canary?: Status; production?: Status };
  c.canaryApproved = ap.canary === 'VERIFIED' ? 'PASS' : 'BLOCKED';
  c.productionApproved = ap.production === 'VERIFIED' ? 'PASS' : 'BLOCKED';
  c.publicWidgetInstalled =
    st(r.website.installAuthorization) === 'VERIFIED'
      ? 'NOT_TESTED'
      : 'BLOCKED';
  c.liveTrafficVerified = 'NOT_TESTED';
  return c;
}

export function loadRegistry(
  file = path.join(process.cwd(), 'config/rooftops/registry.json'),
) {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as {
    updatedAt: string;
    rooftops: RooftopEntry[];
  };
}

@Injectable()
export class RooftopReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditApplicationService,
  ) {}

  async facts(r: RooftopEntry): Promise<LiveFacts | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: r.tenantSlug },
      select: {
        id: true,
        allowedOrigins: true,
        publicConfig: true,
        consentText: true,
        financialPolicy: true,
      },
    });
    if (!tenant) return null;
    const loc = await this.prisma.location.findFirst({
      where: { tenantId: tenant.id, slug: r.locationSlug },
    });
    const [liveVehicles, syntheticVehicles, staffUsers, tekion] =
      await Promise.all([
        this.prisma.vehicle.count({
          where: {
            tenantId: tenant.id,
            NOT: { source: 'synthetic_demo' },
            status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
          },
        }),
        this.prisma.vehicle.count({
          where: { tenantId: tenant.id, source: 'synthetic_demo' },
        }),
        this.prisma.user.count({
          where: { tenantId: tenant.id, isActive: true },
        }),
        this.prisma.integrationConnection.findFirst({
          where: {
            tenantId: tenant.id,
            provider: 'TEKION',
            capability: 'crm',
            enabled: true,
            liveReady: true,
          },
          select: { id: true },
        }),
      ]);
    const hours = loc
      ? StoreHoursService.buildProfile({
          ...loc,
          storeHoursVerifiedBy: loc.storeHoursVerifiedBy,
        })
      : null;
    const credit = loc ? await this.credit.resolve(tenant.id, loc.id) : null;
    const pc = (tenant.publicConfig ?? {}) as Record<string, unknown>;
    return {
      tenantExists: true,
      locationExists: !!loc,
      allowedOrigins: (tenant.allowedOrigins ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      brandingConfigured:
        typeof pc.assistantDisplayName === 'string' &&
        !!pc.assistantDisplayName,
      liveVehicles,
      syntheticVehicles,
      hoursVerified: !!hours?.verified,
      hoursSynthetic: !!hours?.synthetic,
      staffUsers,
      tekionConnectionLive: !!tekion,
      creditAvailableLive: !!credit && credit.available && !credit.preview,
      policyMode: mergePolicy(tenant.financialPolicy, loc?.financialPolicy)
        .mode,
      consentText: !!tenant.consentText,
      crmWebhookConfigured: !!process.env.CRM_WEBHOOK_URL,
    };
  }

  async scorecard() {
    const reg = loadRegistry();
    const stores: Array<{
      key: string;
      displayName: string;
      tenantSlug: string;
      websiteUrl: string;
      syntheticVehiclesPresent: boolean;
      cells: Record<RowKey, Cell>;
      verdict: 'GO' | 'NO-GO';
    }> = [];
    for (const r of reg.rooftops) {
      const f = await this.facts(r);
      const cells = scoreRooftop(r, f);
      stores.push({
        key: r.key,
        displayName: r.displayName,
        tenantSlug: r.tenantSlug,
        websiteUrl: r.website.url,
        syntheticVehiclesPresent: (f?.syntheticVehicles ?? 0) > 0,
        cells,
        verdict: Object.values(cells).every((x) => x === 'PASS')
          ? ('GO' as const)
          : ('NO-GO' as const),
      });
    }
    return {
      registryUpdatedAt: reg.updatedAt,
      generatedAt: new Date().toISOString(),
      rows: ROW_LABELS,
      stores,
    };
  }
}
