import { assertFeedUrlAllowed } from './feed-url.guard';

describe('assertFeedUrlAllowed', () => {
  const prevHosts = process.env.INVENTORY_FEED_ALLOWED_HOSTS;
  const prevTier = process.env.DEPLOYMENT_TIER;
  const prevNode = process.env.NODE_ENV;

  afterEach(() => {
    if (prevHosts === undefined)
      delete process.env.INVENTORY_FEED_ALLOWED_HOSTS;
    else process.env.INVENTORY_FEED_ALLOWED_HOSTS = prevHosts;
    if (prevTier === undefined) delete process.env.DEPLOYMENT_TIER;
    else process.env.DEPLOYMENT_TIER = prevTier;
    process.env.NODE_ENV = prevNode ?? 'development';
  });

  it('rejects private IP hosts', () => {
    expect(() => assertFeedUrlAllowed('http://127.0.0.1/feed.xml')).toThrow();
    expect(() => assertFeedUrlAllowed('http://10.0.0.5/feed.xml')).toThrow();
    expect(() => assertFeedUrlAllowed('http://192.168.1.1/feed.xml')).toThrow();
  });

  it('rejects non-https in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEPLOYMENT_TIER = 'production';
    process.env.INVENTORY_FEED_ALLOWED_HOSTS = 'feeds.example.com';
    expect(() =>
      assertFeedUrlAllowed('http://feeds.example.com/x.xml'),
    ).toThrow(/HTTPS/i);
  });

  it('requires allowlist on hosted tiers', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEPLOYMENT_TIER = 'staging';
    process.env.INVENTORY_FEED_ALLOWED_HOSTS = '';
    expect(() =>
      assertFeedUrlAllowed('https://feeds.example.com/x.xml'),
    ).toThrow(/INVENTORY_FEED_ALLOWED_HOSTS is required/);
  });

  it('enforces host allowlist when configured', () => {
    process.env.INVENTORY_FEED_ALLOWED_HOSTS = 'feeds.example.com';
    expect(() =>
      assertFeedUrlAllowed('https://evil.example.com/x.xml'),
    ).toThrow(/not in INVENTORY_FEED_ALLOWED_HOSTS/);
    expect(
      assertFeedUrlAllowed('https://feeds.example.com/x.xml').hostname,
    ).toBe('feeds.example.com');
  });
});
