import {
  assertAllowedRemotePath,
  DIAL_DIFFERENCE_FEED_SOURCES,
  feedSourceByKey,
} from './dial-difference-feed-map';

describe('Dial Difference feed map', () => {
  it('defines exactly ten New/Used sources with distinct North vs South paths', () => {
    expect(DIAL_DIFFERENCE_FEED_SOURCES).toHaveLength(10);
    const keys = DIAL_DIFFERENCE_FEED_SOURCES.map((s) => s.feedSourceKey);
    expect(new Set(keys).size).toBe(10);
    expect(feedSourceByKey('jeep_north/new')?.tenantSlug).toBe(
      'jeep-of-chicago',
    );
    expect(feedSourceByKey('cdjr_south/used')?.tenantSlug).toBe(
      'dial-cdjr-of-chicago',
    );
    expect(feedSourceByKey('jeep_north/new')?.tenantSlug).not.toBe(
      feedSourceByKey('cdjr_south/used')?.tenantSlug,
    );
  });

  it('allowlists only the ten directories and rejects traversal', () => {
    expect(assertAllowedRemotePath('/chevy/new/file.xml')).toBe(
      '/chevy/new/file.xml',
    );
    expect(() => assertAllowedRemotePath('/etc/passwd')).toThrow(
      /sftp_path_not_in_allowlist/,
    );
    expect(() =>
      assertAllowedRemotePath('/chevy/new/../../etc/passwd'),
    ).toThrow(/sftp_path_rejected/);
  });
});
