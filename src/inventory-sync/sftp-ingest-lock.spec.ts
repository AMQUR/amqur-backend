import {
  SFTP_INGEST_LOCK_KEY,
  SFTP_INGEST_LOCK_TTL_MS,
  tryAcquireSftpIngestLock,
} from './sftp-ingest-lock';

describe('tryAcquireSftpIngestLock', () => {
  it('returns a no-op release when Redis is unavailable', async () => {
    const release = await tryAcquireSftpIngestLock(() => null);
    expect(release).not.toBeNull();
    await expect(release!()).resolves.toBeUndefined();
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
