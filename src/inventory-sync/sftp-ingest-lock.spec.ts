import {
  SFTP_INGEST_LOCK_KEY,
  SFTP_INGEST_LOCK_TTL_MS,
  tryAcquireSftpIngestLock,
} from './sftp-ingest-lock';

describe('tryAcquireSftpIngestLock', () => {
  const prevRedis = process.env.REDIS_URL;
  const prevTier = process.env.DEPLOYMENT_TIER;

  afterEach(() => {
    if (prevRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevRedis;
    if (prevTier === undefined) delete process.env.DEPLOYMENT_TIER;
    else process.env.DEPLOYMENT_TIER = prevTier;
  });

  it('returns a no-op release when Redis is unavailable locally', async () => {
    delete process.env.REDIS_URL;
    delete process.env.DEPLOYMENT_TIER;
    const release = await tryAcquireSftpIngestLock(() => null);
    expect(release).not.toBeNull();
    await expect(release!()).resolves.toBeUndefined();
  });

  it('fails closed on hosted tiers without Redis', async () => {
    delete process.env.REDIS_URL;
    process.env.DEPLOYMENT_TIER = 'staging';
    await expect(tryAcquireSftpIngestLock(() => null)).resolves.toBeNull();
  });

  it('acquires with SET NX and releases only the held token', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
        expect(key).toBe(SFTP_INGEST_LOCK_KEY);
        expect(args).toEqual(['PX', SFTP_INGEST_LOCK_TTL_MS, 'NX']);
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      eval: jest.fn(
        async (_script: string, _n: number, key: string, token: string) => {
          if (store.get(key) === token) {
            store.delete(key);
            return 1;
          }
          return 0;
        },
      ),
      disconnect: jest.fn(),
    };

    const first = await tryAcquireSftpIngestLock(() => redis);
    expect(first).not.toBeNull();
    const second = await tryAcquireSftpIngestLock(() => redis);
    expect(second).toBeNull();
    await first!();
    expect(store.has(SFTP_INGEST_LOCK_KEY)).toBe(false);
    expect(redis.disconnect).toHaveBeenCalled();
  });
});
