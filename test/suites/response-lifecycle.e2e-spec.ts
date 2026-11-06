/**
 * HTTP response lifecycle: request-id + no double-send after headers.
 * Runs against the disposable e2e stack (not staging/production).
 */
import request from 'supertest';
import { createE2eApp, E2eCtx } from '../helpers/e2e-app';

describe('response lifecycle (e2e)', () => {
  let ctx: E2eCtx;
  let base: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
    base = await ctx.app.getUrl();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  it('ordinary JSON responses carry X-Request-Id', async () => {
    const res = await request(base).get('/api/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f-]{8,}$/i,
    );
    expect(res.body?.success).toBe(true);
  });

  it('preserves inbound X-Request-Id on success', async () => {
    const res = await request(base)
      .get('/api/health/live')
      .set('X-Request-Id', 'e2e-corr-live-1')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('e2e-corr-live-1');
  });

  it('ordinary exceptions return one JSON envelope with request id', async () => {
    const res = await request(base)
      .get('/api/this-route-does-not-exist-e2e')
      .set('X-Request-Id', 'e2e-corr-404')
      .expect(404);
    expect(res.headers['x-request-id']).toBe('e2e-corr-404');
    expect(res.body?.success).toBe(false);
    expect(res.body?.statusCode).toBe(404);
  });

  it('manual @Res credit-link 404 does not explode with headers-sent', async () => {
    const res = await request(base)
      .get('/api/public/credit-link/not-a-real-token')
      .set('X-Request-Id', 'e2e-corr-credit')
      .expect(404);
    // Body already sent by @Res(); interceptor must not throw mid-flight.
    expect(res.text).toMatch(/no longer available/i);
    // Best-effort: header may be present if set before send.
    if (res.headers['x-request-id']) {
      expect(res.headers['x-request-id']).toBe('e2e-corr-credit');
    }
  });

  it('concurrent health requests each get a request id', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(base).get('/api/health/live').expect(200),
      ),
    );
    const ids = results.map((r) => r.headers['x-request-id']);
    expect(ids.every((id) => typeof id === 'string' && id.length > 8)).toBe(
      true,
    );
  });
});
