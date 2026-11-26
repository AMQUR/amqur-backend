/**
 * CRM WORKFORCE — pilot rooftop setup (employee-assisted mode).
 *
 *   npx ts-node --transpile-only scripts/crm-workforce-pilot-setup.ts --tenant dial-nissan-of-chicago            # dry run (default)
 *   npx ts-node --transpile-only scripts/crm-workforce-pilot-setup.ts --tenant dial-nissan-of-chicago --apply    # writes
 *
 * What --apply does, for ONE rooftop, and nothing else:
 *   1. turns the `crmWorkforce` flag on for the tenant (leaves every other flag as it is);
 *   2. sets the rooftop's operating mode to ASSIST with customer sending OFF;
 *   3. creates the proposed virtual identity for Sales (kept inactive for sending purposes by
 *      the rooftop send switch being off);
 *   4. switches on the employee-assisted connection (no CRM system connection is made).
 * It does NOT enable real imports, any Tekion connector, the engine, or any sending. It
 * touches no customer data. Running it against production is a release step that needs its
 * own approval; the script refuses production unless CRM_WORKFORCE_PILOT_APPROVAL_REF is set.
 */
import { PrismaClient } from '@prisma/client';
import { isProductionTier } from '../src/config/deployment-tier';
import {
  defaultDisclosure,
  PROPOSED_IDENTITIES,
} from '../src/crm-workforce/agents/playbooks';

const prisma = new PrismaClient();
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const slug = arg('tenant');
  const apply = process.argv.includes('--apply');
  if (!slug) throw new Error('--tenant <slug> is required');
  const approval = process.env.CRM_WORKFORCE_PILOT_APPROVAL_REF;
  if (apply && isProductionTier() && !approval)
    throw new Error(
      'Refusing: production needs CRM_WORKFORCE_PILOT_APPROVAL_REF (the recorded release approval).',
    );

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, featureFlags: true },
  });
  if (!tenant) throw new Error(`No tenant with slug ${slug}`);
  const locations = await prisma.location.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, name: true, slug: true },
  });
  if (locations.length !== 1)
    throw new Error(
      `Expected exactly one rooftop location for ${slug}, found ${locations.length}`,
    );
  const loc = locations[0];
  const identity = PROPOSED_IDENTITIES[slug] ?? {
    displayName: 'Assistant',
    title: 'Virtual BDC Manager',
  };
  const flags = (tenant.featureFlags ?? {}) as Record<string, unknown>;

  const plan = {
    tenant: tenant.name,
    rooftop: loc.name,
    steps: [
      `feature flag crmWorkforce: ${flags.crmWorkforce === true ? 'already on' : 'off → on'}`,
      'operating mode: ASSIST; customer sending: OFF',
      `virtual identity (Sales): ${identity.displayName}, ${identity.title}`,
      'connection: employee-assisted ON; export import OFF; Tekion API BLOCKED; Tekion browser BLOCKED',
      `real customer imports: ${flags.crmWorkforceRealImports === true ? 'ALREADY ON — review' : 'off (unchanged)'}`,
    ],
    mode: apply ? 'APPLY' : 'DRY RUN — nothing written',
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!apply) return;

  const reason = `pilot setup${approval ? ` (${approval})` : ''}`;
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        featureFlags: { ...flags, crmWorkforce: true },
        configVersion: { increment: 1 },
      },
    });
    const scopeKey = `L:${tenant.id}:${loc.id}`;
    await tx.crmWfControl.upsert({
      where: { scopeKey },
      create: {
        scope: 'LOCATION',
        scopeKey,
        tenantId: tenant.id,
        locationId: loc.id,
        mode: 'ASSIST',
        externalSendEnabled: false,
        reason,
      },
      update: { mode: 'ASSIST', externalSendEnabled: false, reason },
    });
    await tx.crmWfAgentProfile.upsert({
      where: {
        tenantId_locationId_department: {
          tenantId: tenant.id,
          locationId: loc.id,
          department: 'SALES',
        },
      },
      create: {
        tenantId: tenant.id,
        locationId: loc.id,
        department: 'SALES',
        displayName: identity.displayName,
        title: identity.title,
        disclosure: defaultDisclosure(
          identity.displayName,
          identity.title,
          tenant.name,
        ),
      },
      update: {},
    });
    await tx.crmWfConnector.upsert({
      where: {
        tenantId_locationId_adapterKey: {
          tenantId: tenant.id,
          locationId: loc.id,
          adapterKey: 'manual_assist',
        },
      },
      create: {
        tenantId: tenant.id,
        locationId: loc.id,
        adapterKey: 'manual_assist',
        enabled: true,
        status: 'READY',
        statusReason: 'no_system_connection',
      },
      update: { enabled: true, status: 'READY' },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: 'crmwf.pilot.setup',
        resource: 'Location',
        resourceId: loc.id,
        metadata: {
          mode: 'ASSIST',
          externalSendEnabled: false,
          approvalRef: approval ?? null,
        },
      },
    });
  });
  console.log('Applied. Customer sending remains OFF.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
