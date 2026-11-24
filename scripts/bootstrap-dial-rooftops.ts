/**
 * IDENTITY-ONLY bootstrap of the five REAL Dial Auto Group rooftops + the group site.
 *
 * Creates (or tops up) the DealerGroup, the group-site tenant, five rooftop tenants, their
 * `main` locations (name / address / Sales main phone / timezone) and one published,
 * customer-visible "store directory" knowledge document per tenant, so the assistant can
 * truthfully answer "where are you", "what's the service number", "which stores are in the
 * group". Facts come from scripts/lib/dial-store-identity.ts.
 *
 * It does NOT create or change: vehicles / inventory, store hours, lead routes, scheduler or
 * any other integration connection, staff users, messaging. It never deletes anything, never
 * turns a feature flag off, and never removes an allowed origin. Idempotent: a second run
 * writes nothing.
 *
 * Fail-closed gate: scripts/lib/dial-bootstrap-gate.ts.
 *
 *   DIAL_BOOTSTRAP_ENABLED=true BOOTSTRAP_WIDGET_ORIGINS=https://… npm run bootstrap:dial-rooftops
 *   (production tier also needs DIAL_BOOTSTRAP_CONFIRM=identity-only)
 *
 * Uses PrismaClient directly (no Nest application context), so it needs only DATABASE_URL.
 */
import { createHash } from 'crypto';
import {
  KnowledgeAuthorityLevel,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeVisibility,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { assertDialBootstrapAllowed } from './lib/dial-bootstrap-gate';
import {
  buildGroupDirectoryDoc,
  buildRooftopDirectoryDoc,
  type DirectoryDoc,
} from './lib/dial-directory-docs';
import {
  DIAL_GROUP,
  DIAL_IDENTITY_AS_OF,
  DIAL_IDENTITY_SOURCE,
  DIAL_ROOFTOPS,
  describeSchedulerLink,
  formatDialAddress,
} from './lib/dial-store-identity';

type Outcome = 'created' | 'updated' | 'unchanged';
type Json = Record<string, unknown>;
type Tx = Prisma.TransactionClient;

const BOOTSTRAP_KEY = 'dial-store-directory';
const SYNTHETIC_SOURCE = 'synthetic_demo';
const LOCATION_SLUG = 'main';

/** Explicitly OFF on a tenant this script creates. Never applied to an existing tenant. */
const CAPABILITIES_OFF: Record<string, boolean> = {
  inventory: false,
  payments: false,
  financeCalculator: false,
  vehicleCompare: false,
  savedVehicles: false,
  leadCapture: false,
  appointments: false,
  serviceAi: false,
  partsAi: false,
  sms: false,
  adfLeadDelivery: false,
  sandboxScheduler: false,
  salesDeskCards: false,
};
/** Ensured ON (create and top-up): knowledge retrieval + the group membership opt-ins. */
const ROOFTOP_REQUIRED_FLAGS = { knowledge: true, groupInventoryListed: true };
const GROUP_REQUIRED_FLAGS = { knowledge: true, groupSiteShopping: true };

const BRANDING_DEFAULTS: Json = {
  assistantDisplayName: 'Dial Concierge',
  primaryColor: '#14213d',
  accentColor: '#ffffff',
  salesEnabled: true,
  serviceEnabled: true,
  partsEnabled: true,
  supportedLocales: ['en', 'es'],
  theme: 'showroom',
};

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as Json) }
    : {};
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Json)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Json)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const sha256 = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

function mergeOrigins(existing: string | null, add: string[]): string {
  const out = (existing ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const seen = new Set(out.map((o) => o.toLowerCase()));
  for (const o of add)
    if (!seen.has(o.toLowerCase())) {
      out.push(o);
      seen.add(o.toLowerCase());
    }
  return out.join(',');
}

type TenantPlan = {
  slug: string;
  name: string;
  sourceRecordId: string;
  createFlags: Record<string, boolean>;
  requiredFlags: Record<string, boolean>;
  /** Used only where the existing publicConfig has no value for the key. */
  brandingDefaults: Json;
  /** Identity keys: always set to these values. */
  identityConfig: Json;
  location: { name: string; address: string | null; phone: string | null };
  doc: DirectoryDoc;
};

function plans(): { group: TenantPlan; rooftops: TenantPlan[] } {
  const group: TenantPlan = {
    slug: DIAL_GROUP.slug,
    name: DIAL_GROUP.name.value,
    sourceRecordId: DIAL_GROUP.sourceRecordId,
    createFlags: {
      chat: true,
      multilingual: true,
      ...CAPABILITIES_OFF,
      handoff: false,
      ...GROUP_REQUIRED_FLAGS,
    },
    requiredFlags: GROUP_REQUIRED_FLAGS,
    brandingDefaults: {
      ...BRANDING_DEFAULTS,
      welcomeMessage:
        'Hi! I’m Dial Auto Group’s AI assistant. I can point you to the right Dial store and how to reach it.',
    },
    identityConfig: {},
    // The group has no phone line of its own, and no street address is written for it: the
    // only group address on file is a contact address shared with one rooftop.
    location: { name: DIAL_GROUP.name.value, address: null, phone: null },
    doc: buildGroupDirectoryDoc(),
  };
  const rooftops = DIAL_ROOFTOPS.map<TenantPlan>((r) => ({
    slug: r.tenantSlug,
    name: r.publicName.value,
    sourceRecordId: r.sourceRecordId,
    createFlags: {
      chat: true,
      multilingual: true,
      ...CAPABILITIES_OFF,
      ...ROOFTOP_REQUIRED_FLAGS,
    },
    requiredFlags: ROOFTOP_REQUIRED_FLAGS,
    brandingDefaults: {
      ...BRANDING_DEFAULTS,
      welcomeMessage: `Hi! I’m the AI assistant for ${r.publicName.value}. Ask me where we are or how to reach Sales, Service or Parts.`,
    },
    identityConfig: {
      phone: r.phones.sales.value,
      websiteUrl: r.websiteUrl.value,
      ...(r.groupSide ? { groupSide: r.groupSide } : {}),
      ...(r.groupAliases.length ? { groupAliases: r.groupAliases } : {}),
    },
    location: {
      name: r.publicName.value,
      address: formatDialAddress(r.address.value),
      phone: r.phones.sales.value,
    },
    doc: buildRooftopDirectoryDoc(r),
  }));
  return { group, rooftops };
}

async function upsertTenant(
  tx: Tx,
  plan: TenantPlan,
  dealerGroupId: string,
  origins: string[],
): Promise<{ id: string; outcome: Outcome }> {
  const existing = await tx.tenant.findUnique({ where: { slug: plan.slug } });
  if (!existing) {
    const created = await tx.tenant.create({
      data: {
        slug: plan.slug,
        name: plan.name,
        dealerGroupId,
        allowedOrigins: origins.join(','),
        featureFlags: plan.createFlags,
        publicConfig: {
          ...plan.brandingDefaults,
          ...plan.identityConfig,
        } as Prisma.InputJsonObject,
      },
    });
    return { id: created.id, outcome: 'created' };
  }
  const flags = { ...asObject(existing.featureFlags), ...plan.requiredFlags };
  const current = asObject(existing.publicConfig);
  const publicConfig: Json = { ...current, ...plan.identityConfig };
  for (const [k, v] of Object.entries(plan.brandingDefaults))
    if (current[k] === undefined || current[k] === null) publicConfig[k] = v;
  const allowedOrigins = mergeOrigins(existing.allowedOrigins, origins);
  const changed =
    existing.name !== plan.name ||
    existing.dealerGroupId !== dealerGroupId ||
    (existing.allowedOrigins ?? '') !== allowedOrigins ||
    !same(existing.featureFlags, flags) ||
    !same(existing.publicConfig, publicConfig);
  if (!changed) return { id: existing.id, outcome: 'unchanged' };
  await tx.tenant.update({
    where: { id: existing.id },
    data: {
      name: plan.name,
      dealerGroupId,
      allowedOrigins,
      featureFlags: flags as Prisma.InputJsonObject,
      publicConfig: publicConfig as Prisma.InputJsonObject,
      // widget-config is cached per configVersion.
      configVersion: { increment: 1 },
    },
  });
  return { id: existing.id, outcome: 'updated' };
}

/** name / address / phone / timezone only. Store hours are never read or written here. */
async function upsertLocation(
  tx: Tx,
  tenantId: string,
  loc: TenantPlan['location'],
): Promise<{ id: string; outcome: Outcome }> {
  const want = { ...loc, timezone: DIAL_GROUP.timezone };
  const existing = await tx.location.findUnique({
    where: { tenantId_slug: { tenantId, slug: LOCATION_SLUG } },
    select: {
      id: true,
      name: true,
      address: true,
      phone: true,
      timezone: true,
    },
  });
  if (!existing) {
    const created = await tx.location.create({
      data: { tenantId, slug: LOCATION_SLUG, ...want },
      select: { id: true },
    });
    return { id: created.id, outcome: 'created' };
  }
  const data: Prisma.LocationUpdateInput = {};
  if (existing.name !== want.name) data.name = want.name;
  if (existing.timezone !== want.timezone) data.timezone = want.timezone;
  // A null identity value (the group has no address/phone) never clears an existing one.
  if (want.address && existing.address !== want.address)
    data.address = want.address;
  if (want.phone && existing.phone !== want.phone) data.phone = want.phone;
  if (!Object.keys(data).length)
    return { id: existing.id, outcome: 'unchanged' };
  await tx.location.update({ where: { id: existing.id }, data });
  return { id: existing.id, outcome: 'updated' };
}

async function upsertDirectoryDoc(
  tx: Tx,
  tenantId: string,
  locationId: string,
  plan: TenantPlan,
): Promise<Outcome> {
  const keyed = { path: ['bootstrapKey'], equals: BOOTSTRAP_KEY };
  const provenance = {
    bootstrapKey: BOOTSTRAP_KEY,
    sourceRecordId: plan.sourceRecordId,
    rooftopId: plan.slug,
    source: DIAL_IDENTITY_SOURCE,
    asOf: DIAL_IDENTITY_AS_OF,
    verified: true,
  };
  const asOf = new Date(`${DIAL_IDENTITY_AS_OF}T00:00:00.000Z`);
  const { doc } = plan;

  let outcome: Outcome = 'unchanged';
  const touch = (o: Outcome) => {
    if (outcome !== 'created') outcome = o;
  };

  const sourceWant = {
    locationId,
    sourceType: KnowledgeSourceType.HOURS_CONTACT,
    title: doc.title,
    canonicalUrl: doc.canonicalUrl,
    authorityLevel: KnowledgeAuthorityLevel.APPROVED,
    status: KnowledgeStatus.PUBLISHED,
  };
  let source = await tx.knowledgeSource.findFirst({
    where: { tenantId, metadata: keyed },
    orderBy: { createdAt: 'asc' },
  });
  if (!source) {
    source = await tx.knowledgeSource.create({
      data: { tenantId, ...sourceWant, metadata: provenance },
    });
    touch('created');
  } else if (
    source.archivedAt ||
    (Object.keys(sourceWant) as Array<keyof typeof sourceWant>).some(
      (k) => source![k] !== sourceWant[k],
    )
  ) {
    await tx.knowledgeSource.update({
      where: { id: source.id },
      data: { ...sourceWant, archivedAt: null },
    });
    touch('updated');
  }

  const checksum = sha256(doc.content);
  const docWant = {
    locationId,
    sourceId: source.id,
    title: doc.title,
    canonicalUrl: doc.canonicalUrl,
    contentChecksum: checksum,
    status: KnowledgeStatus.PUBLISHED,
    visibility: KnowledgeVisibility.CUSTOMER,
  };
  let document = await tx.knowledgeDocument.findFirst({
    where: { tenantId, metadata: keyed },
    orderBy: { createdAt: 'asc' },
  });
  if (!document) {
    document = await tx.knowledgeDocument.create({
      data: {
        tenantId,
        ...docWant,
        content: doc.content,
        approvedAt: new Date(),
        lastVerifiedAt: asOf,
        metadata: provenance,
      },
    });
    touch('created');
  } else if (
    document.archivedAt ||
    document.effectiveAt ||
    document.expiresAt ||
    (Object.keys(docWant) as Array<keyof typeof docWant>).some(
      (k) => document![k] !== docWant[k],
    )
  ) {
    await tx.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        ...docWant,
        content: doc.content,
        version: { increment: 1 },
        approvedAt: new Date(),
        lastVerifiedAt: asOf,
        archivedAt: null,
        effectiveAt: null,
        expiresAt: null,
      },
    });
    touch('updated');
  }

  const chunks = await tx.knowledgeChunk.findMany({
    where: { documentId: document.id },
    select: { id: true, chunkIndex: true, content: true, locationId: true },
  });
  // Chunk layout is fixed, so there is never a chunk to remove. An unexpected extra chunk
  // means someone else edited this document: refuse (the transaction rolls back).
  if (chunks.some((c) => c.chunkIndex >= doc.chunks.length))
    throw new Error(
      `Refusing: knowledge document '${doc.title}' (${plan.slug}) holds chunks this bootstrap did not write.`,
    );
  for (const [chunkIndex, content] of doc.chunks.entries()) {
    const have = chunks.find((c) => c.chunkIndex === chunkIndex);
    if (have && have.content === content && have.locationId === locationId)
      continue;
    const data = {
      tenantId,
      locationId,
      content,
      tokenCount: Math.ceil(content.length / 4),
      // Text changed: any stored embedding no longer describes it.
      embedding: Prisma.DbNull,
      embeddingModel: null,
      metadata: {
        sourceId: source.id,
        documentTitle: doc.title,
        canonicalUrl: doc.canonicalUrl,
      },
    };
    if (have) await tx.knowledgeChunk.update({ where: { id: have.id }, data });
    else
      await tx.knowledgeChunk.create({
        data: { documentId: document.id, chunkIndex, ...data },
      });
    touch('updated');
  }
  return outcome;
}

async function main() {
  const gate = assertDialBootstrapAllowed();
  const { group, rooftops } = plans();
  const all = [group, ...rooftops];
  const prisma = new PrismaClient();

  try {
    // ── Read-only pre-checks: refuse before writing anything. ──────────────────────────
    const dealerGroup = await prisma.dealerGroup.findUnique({
      where: { slug: DIAL_GROUP.slug },
    });
    const present = await prisma.tenant.findMany({
      where: { slug: { in: all.map((p) => p.slug) } },
      select: { id: true, slug: true, dealerGroupId: true },
    });
    for (const t of present)
      if (t.dealerGroupId && t.dealerGroupId !== dealerGroup?.id)
        throw new Error(
          `Refusing: tenant '${t.slug}' already belongs to a different dealer group.`,
        );
    const groupTenant = present.find((t) => t.slug === group.slug);
    if (
      dealerGroup?.groupSiteTenantId &&
      dealerGroup.groupSiteTenantId !== groupTenant?.id
    )
      throw new Error(
        `Refusing: dealer group '${DIAL_GROUP.slug}' already designates a different group-site tenant.`,
      );

    // Vehicles are never touched. They are only counted, to refuse a database that is not
    // what this run expects.
    const vehicleRows = present.length
      ? await prisma.vehicle.groupBy({
          by: ['source'],
          where: { tenantId: { in: present.map((t) => t.id) } },
          _count: { _all: true },
        })
      : [];
    const synthetic = vehicleRows
      .filter((v) => v.source === SYNTHETIC_SOURCE)
      .reduce((n, v) => n + v._count._all, 0);
    const other = vehicleRows
      .filter((v) => v.source !== SYNTHETIC_SOURCE)
      .reduce((n, v) => n + v._count._all, 0);
    if (gate.tier === 'production' && synthetic > 0)
      throw new Error(
        'Refusing: production tier, but the target tenants hold synthetic demo vehicles. This does not look like the production database.',
      );
    if (
      other > 0 &&
      (process.env.DIAL_BOOTSTRAP_ALLOW_EXISTING_INVENTORY ?? '').trim() !==
        'true'
    )
      throw new Error(
        `Refusing: the target tenants already hold ${other} non-synthetic vehicle row(s) this bootstrap did not expect. ` +
          'Review, then set DIAL_BOOTSTRAP_ALLOW_EXISTING_INVENTORY=true to top up identity anyway (vehicles are never modified).',
      );

    // ── Writes: one transaction, so a failure leaves the database as it was. ───────────
    const result = await prisma.$transaction(
      async (tx) => {
        let groupOutcome: Outcome = 'unchanged';
        let dg = await tx.dealerGroup.findUnique({
          where: { slug: DIAL_GROUP.slug },
        });
        if (!dg) {
          dg = await tx.dealerGroup.create({
            data: { slug: DIAL_GROUP.slug, name: DIAL_GROUP.name.value },
          });
          groupOutcome = 'created';
        } else if (dg.name !== DIAL_GROUP.name.value) {
          await tx.dealerGroup.update({
            where: { id: dg.id },
            data: { name: DIAL_GROUP.name.value },
          });
          groupOutcome = 'updated';
        }

        const rows: Array<{
          slug: string;
          sourceRecordId: string;
          tenant: Outcome;
          location: Outcome;
          knowledgeDocument: Outcome;
        }> = [];
        for (const plan of all) {
          const tenant = await upsertTenant(tx, plan, dg.id, gate.origins);
          const location = await upsertLocation(tx, tenant.id, plan.location);
          const knowledgeDocument = await upsertDirectoryDoc(
            tx,
            tenant.id,
            location.id,
            plan,
          );
          rows.push({
            slug: plan.slug,
            sourceRecordId: plan.sourceRecordId,
            tenant: tenant.outcome,
            location: location.outcome,
            knowledgeDocument,
          });
          if (plan === group && dg.groupSiteTenantId !== tenant.id) {
            await tx.dealerGroup.update({
              where: { id: dg.id },
              data: { groupSiteTenantId: tenant.id },
            });
            if (groupOutcome === 'unchanged') groupOutcome = 'updated';
          }
        }
        return { groupOutcome, rows };
      },
      { maxWait: 15_000, timeout: 120_000 },
    );

    const tally = (xs: Outcome[]) => ({
      created: xs.filter((x) => x === 'created').length,
      updated: xs.filter((x) => x === 'updated').length,
      unchanged: xs.filter((x) => x === 'unchanged').length,
    });
    const counts = {
      dealerGroup: tally([result.groupOutcome]),
      tenants: tally(result.rows.map((r) => r.tenant)),
      locations: tally(result.rows.map((r) => r.location)),
      knowledgeDocuments: tally(result.rows.map((r) => r.knowledgeDocument)),
    };
    const changed = Object.values(counts).some(
      (c) => c.created + c.updated > 0,
    );

    console.log(
      JSON.stringify(
        {
          bootstrap: 'dial-rooftops (identity only)',
          gate: { tier: gate.tier, dbHost: gate.dbHost },
          identity: { source: DIAL_IDENTITY_SOURCE, asOf: DIAL_IDENTITY_AS_OF },
          changed,
          counts,
          groupSite: result.rows[0],
          rooftops: result.rows.slice(1).map((row, i) => ({
            ...row,
            // Never the URL itself: three of them carry an access token.
            schedulerHandoff: describeSchedulerLink(DIAL_ROOFTOPS[i]),
          })),
          widgetOriginsEnsured: gate.origins,
          flagsEnsured: {
            groupSite: GROUP_REQUIRED_FLAGS,
            rooftops: ROOFTOP_REQUIRED_FLAGS,
          },
          vehiclesUntouched: { synthetic, other },
          notTouched: [
            'vehicles / inventory',
            'store hours (new locations: NULL, unverified)',
            'lead routes',
            'scheduler and other integration connections',
            'staff users',
            'scheduler URLs (kept in the identity constant only; not written to the database)',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error(
    e instanceof Error ? e.message : 'dial rooftop bootstrap failed',
  );
  process.exit(1);
});
