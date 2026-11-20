/**
 * Dial Difference SFTPGo layout → AMQUR rooftop mapping.
 *
 * Upload accounts (vauto_dd_*) are vendor-owned — AMQUR never uses them.
 * AMQUR connects only as the read-only `amqur_inventory_reader`.
 *
 * North (jeep_north) and South (cdjr_south) must never be conflated.
 */

export type DialDifferenceCondition = 'new' | 'used';

export type DialDifferenceFeedSource = {
  /** Stable key used for lifecycle isolation (e.g. chevy/new). */
  feedSourceKey: string;
  /** Absolute remote directory under the reader virtual root. */
  remoteDir: string;
  /** Expected AMQUR tenant slug (rooftop). */
  tenantSlug: string;
  /** Expected location slug within that tenant. */
  locationSlug: string;
  /** Merchandising bucket for this directory. */
  condition: DialDifferenceCondition;
  displayName: string;
};

export const DIAL_DIFFERENCE_FEED_SOURCES: readonly DialDifferenceFeedSource[] =
  [
    {
      feedSourceKey: 'chevy/new',
      remoteDir: '/chevy/new',
      tenantSlug: 'dial-chevy-of-chicago',
      locationSlug: 'main',
      condition: 'new',
      displayName: 'Dial Chevy of Chicago — New',
    },
    {
      feedSourceKey: 'chevy/used',
      remoteDir: '/chevy/used',
      tenantSlug: 'dial-chevy-of-chicago',
      locationSlug: 'main',
      condition: 'used',
      displayName: 'Dial Chevy of Chicago — Used',
    },
    {
      feedSourceKey: 'nissan/new',
      remoteDir: '/nissan/new',
      tenantSlug: 'dial-nissan-of-chicago',
      locationSlug: 'main',
      condition: 'new',
      displayName: 'Dial Nissan of Chicago — New',
    },
    {
      feedSourceKey: 'nissan/used',
      remoteDir: '/nissan/used',
      tenantSlug: 'dial-nissan-of-chicago',
      locationSlug: 'main',
      condition: 'used',
      displayName: 'Dial Nissan of Chicago — Used',
    },
    {
      feedSourceKey: 'infiniti/new',
      remoteDir: '/infiniti/new',
      tenantSlug: 'infiniti-of-chicago',
      locationSlug: 'main',
      condition: 'new',
      displayName: 'INFINITI of Chicago — New',
    },
    {
      feedSourceKey: 'infiniti/used',
      remoteDir: '/infiniti/used',
      tenantSlug: 'infiniti-of-chicago',
      locationSlug: 'main',
      condition: 'used',
      displayName: 'INFINITI of Chicago — Used',
    },
    {
      feedSourceKey: 'cdjr_south/new',
      remoteDir: '/cdjr_south/new',
      tenantSlug: 'dial-cdjr-of-chicago',
      locationSlug: 'main',
      condition: 'new',
      displayName: 'Dial CDJR South — New',
    },
    {
      feedSourceKey: 'cdjr_south/used',
      remoteDir: '/cdjr_south/used',
      tenantSlug: 'dial-cdjr-of-chicago',
      locationSlug: 'main',
      condition: 'used',
      displayName: 'Dial CDJR South — Used',
    },
    {
      feedSourceKey: 'jeep_north/new',
      remoteDir: '/jeep_north/new',
      tenantSlug: 'jeep-of-chicago',
      locationSlug: 'main',
      condition: 'new',
      displayName: 'Jeep of Chicago North — New',
    },
    {
      feedSourceKey: 'jeep_north/used',
      remoteDir: '/jeep_north/used',
      tenantSlug: 'jeep-of-chicago',
      locationSlug: 'main',
      condition: 'used',
      displayName: 'Jeep of Chicago North — Used',
    },
  ] as const;

export function feedSourceByKey(
  key: string,
): DialDifferenceFeedSource | undefined {
  return DIAL_DIFFERENCE_FEED_SOURCES.find((s) => s.feedSourceKey === key);
}

/** Reject path traversal and anything outside the ten allowlisted directories. */
export function assertAllowedRemotePath(remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, '/');
  if (
    normalized.includes('..') ||
    normalized.includes('\0') ||
    !normalized.startsWith('/')
  ) {
    throw new Error('sftp_path_rejected');
  }
  const allowed = DIAL_DIFFERENCE_FEED_SOURCES.some(
    (s) =>
      normalized === s.remoteDir ||
      normalized.startsWith(`${s.remoteDir}/`),
  );
  if (!allowed) throw new Error('sftp_path_not_in_allowlist');
  return normalized;
}
