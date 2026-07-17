import { assertFeedUrlAllowed } from './feed-url.guard';

describe('assertFeedUrlAllowed', () => {
  const prev = process.env.INVENTORY_FEED_ALLOWED_HOSTS;

  afterEach(() => {
    process.env.INVENTORY_FEED_ALLOWED_HOSTS = prev;
    process.env.NODE_ENV = 'development';
  });

  it('rejects private IP hosts', () => {
    expect(() => assertFeedUrlAllowed('http://127.0.0.1/feed.xml')).toThrow();
    expect(() => assertFeedUrlAllowed('http://10.0.0.5/feed.xml')).toThrow();
    expect(() => assertFeedUrlAllowed('http://192.168.1.1/feed.xml')).toThrow();
  });

  it('rejects non-https in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.INVENTORY_FEED_ALLOWED_HOSTS = '';
    expect(() =>
      assertFeedUrlAllowed('http://feeds.example.com/x.xml'),
    ).toThrow(/HTTPS/i);
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
