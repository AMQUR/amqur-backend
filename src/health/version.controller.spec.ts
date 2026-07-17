import { VersionController } from './version.controller';

describe('VersionController', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('prefers APP_* environment variables', () => {
    process.env.APP_RELEASE_VERSION = '1.2.3';
    process.env.APP_COMMIT_SHA = 'abc123def456';
    process.env.APP_BUILD_TIME = '2026-07-16T00:00:00.000Z';
    process.env.APP_RELEASE_ID = 'rel-42';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';

    const v = new VersionController().version();
    expect(v).toEqual({
      version: '1.2.3',
      commitSha: 'abc123def456',
      environment: 'staging',
      buildTime: '2026-07-16T00:00:00.000Z',
      releaseId: 'rel-42',
    });
  });

  it('falls back to package.json version and unknown fields', () => {
    delete process.env.APP_RELEASE_VERSION;
    delete process.env.APP_COMMIT_SHA;
    delete process.env.APP_BUILD_TIME;
    delete process.env.APP_RELEASE_ID;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;

    const v = new VersionController().version();
    // package.json version resolves; release.json is a deploy artifact and
    // may legitimately exist locally after a deploy, so only assert shape.
    expect(v.version).toBeTruthy();
    expect(typeof v.commitSha).toBe('string');
    expect(typeof v.releaseId).toBe('string');
    expect(Object.keys(v).sort()).toEqual(
      ['version', 'commitSha', 'environment', 'buildTime', 'releaseId'].sort(),
    );
  });

  it('never exposes configuration or secret-like keys', () => {
    const raw = JSON.stringify(new VersionController().version()).toLowerCase();
    for (const forbidden of [
      'secret',
      'password',
      'database',
      'token',
      'key',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
