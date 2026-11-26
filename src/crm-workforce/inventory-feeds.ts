import { PrismaService } from '../prisma/prisma.service';
import { DIAL_DIFFERENCE_FEED_SOURCES } from '../integrations/vauto/dial-difference-feed-map';

export type FeedState =
  | 'ARRIVING'
  | 'STALE'
  | 'FAILING'
  | 'NOT_ARRIVING'
  | 'NOT_EXPECTED';

/**
 * For one store: each expected vAuto feed (new and used, from the Dial Difference map), whether
 * runs are arriving, how many vehicles it currently supplies, and — when nothing arrives — the
 * exact missing dependency. Read-only; never triggers an import and never touches the separate
 * Google Vehicle Listing Ads feed pipeline.
 */
export async function feedStatusForStore(
  prisma: PrismaService,
  tenantId: string,
  locationId: string,
  now = new Date(),
) {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
    select: {
      slug: true,
      inventoryFreshnessHours: true,
      tenant: { select: { slug: true } },
    },
  });
  if (!loc)
    return {
      feeds: [],
      syncEnabled: false,
      sftpEnabled: false,
      sftpCredentials: false,
      pricesPublished: false,
    };
  const syncEnabled = process.env.INVENTORY_SYNC_ENABLED === 'true';
  const sftpEnabled = process.env.AMQUR_VAUTO_SFTP_ENABLED === 'true';
  const sftpCredentials = [
    'AMQUR_VAUTO_SFTP_HOST',
    'AMQUR_VAUTO_SFTP_USER',
    'AMQUR_VAUTO_SFTP_PASSWORD',
    'AMQUR_VAUTO_SFTP_HOST_FINGERPRINT',
  ].every((k) => !!process.env[k]);
  const pricesPublished = process.env.AMQUR_VAUTO_PUBLISH_PRICES === 'true';
  const expected = DIAL_DIFFERENCE_FEED_SOURCES.filter(
    (f) => f.tenantSlug === loc.tenant.slug && f.locationSlug === loc.slug,
  );
  const feeds: Array<{
    feedSourceKey: string;
    name: string;
    condition: string;
    state: FeedState;
    lastRunAt: Date | null;
    lastSuccessAt: Date | null;
    vehiclesAvailable: number;
    missingDependency: string[];
  }> = [];
  for (const f of expected) {
    const [lastRun, lastOk, vehicles] = await Promise.all([
      prisma.inventoryImportRun.findFirst({
        where: { tenantId, feedSourceKey: f.feedSourceKey },
        orderBy: { startedAt: 'desc' },
        select: {
          status: true,
          startedAt: true,
          errorMessage: true,
          validCount: true,
        },
      }),
      prisma.inventoryImportRun.findFirst({
        where: {
          tenantId,
          feedSourceKey: f.feedSourceKey,
          status: 'SUCCEEDED',
        },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, validCount: true },
      }),
      prisma.vehicle.count({
        where: {
          tenantId,
          locationId,
          feedSourceKey: f.feedSourceKey,
          status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
        },
      }),
    ]);
    const ageH = lastOk
      ? (now.getTime() - lastOk.startedAt.getTime()) / 3_600_000
      : null;
    const state: FeedState = !lastRun
      ? 'NOT_ARRIVING'
      : lastOk && ageH !== null && ageH <= loc.inventoryFreshnessHours
        ? 'ARRIVING'
        : lastOk
          ? 'STALE'
          : 'FAILING';
    const missing: string[] = [];
    if (!syncEnabled)
      missing.push('INVENTORY_SYNC_ENABLED is off on the API and worker');
    if (!sftpEnabled) missing.push('AMQUR_VAUTO_SFTP_ENABLED is off');
    if (!sftpCredentials)
      missing.push(
        'read-only SFTP credentials for amqur_inventory_reader (host, user, password, host fingerprint) are not configured',
      );
    if (lastRun && state === 'FAILING')
      missing.push(
        `last run failed: ${(lastRun.errorMessage ?? 'no detail').slice(0, 200)}`,
      );
    feeds.push({
      feedSourceKey: f.feedSourceKey,
      name: f.displayName,
      condition: f.condition,
      state,
      lastRunAt: lastRun?.startedAt ?? null,
      lastSuccessAt: lastOk?.startedAt ?? null,
      vehiclesAvailable: vehicles,
      missingDependency: state === 'ARRIVING' ? [] : missing,
    });
  }
  return { feeds, syncEnabled, sftpEnabled, sftpCredentials, pricesPublished };
}
