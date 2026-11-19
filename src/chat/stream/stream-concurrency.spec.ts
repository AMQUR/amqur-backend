import {
  StreamConcurrencyLimiter,
  streamCaps,
  tokenKey,
} from './stream-concurrency';

describe('StreamConcurrencyLimiter', () => {
  it('refuses once any key is at its cap and takes no partial slots', () => {
    const l = new StreamConcurrencyLimiter();
    const a = l.acquire([
      { key: 'ip:1', max: 2 },
      { key: 'tok:a', max: 1 },
    ]);
    expect(a).not.toBeNull();
    // token cap reached → refused, and the IP count is not incremented
    expect(
      l.acquire([
        { key: 'ip:1', max: 2 },
        { key: 'tok:a', max: 1 },
      ]),
    ).toBeNull();
    expect(l.count('ip:1')).toBe(1);
    const b = l.acquire([
      { key: 'ip:1', max: 2 },
      { key: 'tok:b', max: 1 },
    ]);
    expect(b).not.toBeNull();
    expect(
      l.acquire([
        { key: 'ip:1', max: 2 },
        { key: 'tok:c', max: 1 },
      ]),
    ).toBeNull();
    a!();
    a!(); // idempotent
    expect(l.count('ip:1')).toBe(1);
    expect(l.count('tok:a')).toBe(0);
    b!();
    expect(l.count('ip:1')).toBe(0);
  });

  it('caps come from env with safe defaults', () => {
    expect(streamCaps({})).toEqual({ perIp: 10, perToken: 4 });
    expect(
      streamCaps({
        CHAT_STREAM_MAX_CONCURRENT_PER_IP: '3',
        CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN: '0',
      }),
    ).toEqual({ perIp: 3, perToken: 4 });
  });

  it('token key is a digest, never the credential', () => {
    const k = tokenKey('Bearer abc.def.ghi');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain('abc');
    expect(tokenKey(undefined)).toBeNull();
  });
});
