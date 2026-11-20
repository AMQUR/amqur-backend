import {
  assertIsolatedStagingSeedAllowed,
  DEFAULT_ISOLATED_STAGING_PROJECT_ID,
} from './isolated-staging-seed-gate';

const base = {
  ISOLATED_STAGING_SEED_ENABLED: 'true',
  DEPLOYMENT_TIER: 'staging',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway',
  RAILWAY_PROJECT_ID: DEFAULT_ISOLATED_STAGING_PROJECT_ID,
};

describe('assertIsolatedStagingSeedAllowed', () => {
  it('allows the isolated Railway staging project on private Postgres', () => {
    expect(assertIsolatedStagingSeedAllowed(base)).toEqual({
      dbHost: 'postgres.railway.internal',
      projectId: DEFAULT_ISOLATED_STAGING_PROJECT_ID,
      tier: 'staging',
    });
  });

  it('refuses when the kill switch is off', () => {
    expect(() =>
      assertIsolatedStagingSeedAllowed({
        ...base,
        ISOLATED_STAGING_SEED_ENABLED: 'false',
      }),
    ).toThrow(/ISOLATED_STAGING_SEED_ENABLED/);
  });

  it('refuses the production tier', () => {
    expect(() =>
      assertIsolatedStagingSeedAllowed({
        ...base,
        DEPLOYMENT_TIER: 'production',
      }),
    ).toThrow(/production/);
  });

  it('refuses an unlisted database host', () => {
    expect(() =>
      assertIsolatedStagingSeedAllowed({
        ...base,
        DATABASE_URL: 'postgresql://u:p@other.railway.internal:5432/db',
      }),
    ).toThrow(/not in the allowlist/);
  });

  it('refuses loopback so local seeds stay the only local path', () => {
    expect(() =>
      assertIsolatedStagingSeedAllowed({
        ...base,
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
        ISOLATED_STAGING_SEED_DB_HOST_ALLOWLIST: '127.0.0.1',
      }),
    ).toThrow(/loopback/);
  });

  it('refuses a different Railway project', () => {
    expect(() =>
      assertIsolatedStagingSeedAllowed({
        ...base,
        RAILWAY_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
      }),
    ).toThrow(/not the isolated staging project/);
  });
});
