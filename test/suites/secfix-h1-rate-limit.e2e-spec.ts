import * as http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { ChatService } from '../../src/chat/chat.service';

/**
 * Security review H1 — rate-limit bypass by rotating a client-supplied `tenantSlug`, and
 * unbounded concurrent chat streams. Runs with the REAL production ceilings
 * (`RATE_LIMIT_PROFILE=production`); synthetic data only.
 */
describe('H1 rate limiting cannot be reset by the caller', () => {
  let ctx: E2eCtx;
  let dealer: DemoDealer;
  let token: string;
  /** A second rooftop's token: its throttle bucket is untouched by the ceiling tests. */
  let streamToken: string;
  const srv = () => request(ctx.app.getHttpServer());
  /**
   * `documented` is the route's documented production ceiling. (Today the global `auth` named
   * bucket — 20/min — also applies to every route, so the effective ceiling is lower; the
   * assertions hold for either.) Before the fix every rotated slug got a fresh bucket and
   * nothing was ever refused.
   */
  const expectCeiling = (statuses: number[], documented: number) => {
    expect(statuses[0]).not.toBe(429);
    const firstRefusal = statuses.indexOf(429);
    expect(firstRefusal).toBeGreaterThan(0);
    expect(firstRefusal).toBeLessThanOrEqual(documented);
    // once refused, rotating the slug never buys another request
    expect(statuses.slice(firstRefusal).every((x) => x === 429)).toBe(true);
    expect(statuses.length).toBeGreaterThan(documented);
  };
  const prevProfile = process.env.RATE_LIMIT_PROFILE;
  const prevTokenCap = process.env.CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN;

  beforeAll(async () => {
    ctx = await createE2eApp();
    dealer = await seedDemoDealer(ctx.app, ctx.prisma, 'secfix-h1', {
      creditPreview: false,
    });
    const r = await srv()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: dealer.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(r.body).token;
    expect(token).toBeTruthy();
    const other = await seedDemoDealer(
      ctx.app,
      ctx.prisma,
      'secfix-h1-stream',
      {
        creditPreview: false,
      },
    );
    const r2 = await srv()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: other.slug, locationSlug: 'main' });
    streamToken = unwrap<{ token: string }>(r2.body).token;
    expect(streamToken).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    if (prevProfile === undefined) delete process.env.RATE_LIMIT_PROFILE;
    else process.env.RATE_LIMIT_PROFILE = prevProfile;
    if (prevTokenCap === undefined)
      delete process.env.CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN;
    else process.env.CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN = prevTokenCap;
    await ctx.app.close();
  });

  describe('with production ceilings', () => {
    beforeAll(() => {
      process.env.RATE_LIMIT_PROFILE = 'production';
    });
    afterAll(() => {
      delete process.env.RATE_LIMIT_PROFILE;
    });

    it('chat: rotating tenantSlug in the query AND body does not reset the 40/min limit', async () => {
      const statuses: number[] = [];
      // The body is deliberately invalid (unknown property) so no model turn runs: the guard
      // counts the request before validation rejects it, which is exactly the bypass window.
      for (let i = 0; i < 45; i++) {
        const r = await srv()
          .post(`/api/chat?tenantSlug=rot-q-${i}`)
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', SIM_ORIGIN)
          .send({ tenantSlug: `rot-b-${i}` });
        statuses.push(r.status);
      }
      expectCeiling(statuses, 40);
      expect(statuses.filter((x) => x !== 429).every((x) => x === 400)).toBe(
        true,
      );
    });

    it('chat stream: same bucket rule (query rotation), 429 carries Retry-After', async () => {
      const statuses: number[] = [];
      let retryAfter: string | undefined;
      for (let i = 0; i < 43; i++) {
        const r = await srv()
          .post(`/api/chat/stream?tenantSlug=rot-s-${i}`)
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', SIM_ORIGIN)
          .send({ tenantSlug: `rot-sb-${i}` });
        statuses.push(r.status);
        if (r.status === 429)
          retryAfter = r.headers['retry-after'] as string | undefined;
      }
      expectCeiling(statuses, 40);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it('public widget-token: rotating tenantSlug in the body does not reset the 30/min limit', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 33; i++) {
        const r = await srv()
          .post('/api/public/widget-token')
          .set('Origin', SIM_ORIGIN)
          .send({ tenantSlug: `no-such-rooftop-${i}`, locationSlug: 'main' });
        if (r.status === 429) expect(r.headers['retry-after']).toMatch(/^\d+$/);
        statuses.push(r.status);
      }
      expectCeiling(statuses, 30);
    });

    it('public store-status: rotating tenantSlug in the query does not reset the 60/min limit', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 63; i++) {
        const r = await srv().get(
          `/api/public/store-status?tenantSlug=no-such-${i}&locationSlug=main`,
        );
        statuses.push(r.status);
      }
      expectCeiling(statuses, 60);
      expect(statuses.filter((x) => x !== 429).every((x) => x === 200)).toBe(
        true,
      );
    });
  });

  describe('concurrent stream cap', () => {
    const openStream = (
      port: number,
    ): Promise<{ status: number; req: http.ClientRequest; body: string }> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify({ message: 'What are your hours?' });
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/chat/stream',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              Authorization: `Bearer ${streamToken}`,
              Origin: SIM_ORIGIN,
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString('utf8')));
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, req, body }),
              );
              return;
            }
            // 200: the stream is open (turn.started was flushed); leave it open.
            res.once('data', () => resolve({ status: 200, req, body: '' }));
            res.on('error', () => undefined);
          },
        );
        req.on('error', (e) => reject(e));
        req.end(payload);
      });

    it('a third concurrent stream on one token is refused with a clean 429; dropping the socket does not free a slot; finishing the turn does', async () => {
      process.env.CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN = '2';
      const port = (
        (ctx.app.getHttpServer() as http.Server).address() as AddressInfo
      ).port;
      const svc = ctx.app.get(ChatService);
      const original = svc.chat.bind(svc);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let finished = 0;
      const spy = jest.spyOn(svc, 'chat').mockImplementation(async (i) => {
        await gate;
        try {
          return await original(i);
        } finally {
          finished++;
        }
      });
      try {
        const a = await openStream(port);
        const b = await openStream(port);
        expect([a.status, b.status]).toEqual([200, 200]);

        const refused = await srv()
          .post('/api/chat/stream')
          .set('Authorization', `Bearer ${streamToken}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message: 'hello' });
        expect(refused.status).toBe(429);
        expect(refused.headers['content-type']).toContain('application/json');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect(refused.text).not.toContain('turn.started');

        // Open-then-drop: the abandoned turns are still running, so the slots stay taken.
        a.req.destroy();
        b.req.destroy();
        await new Promise((r) => setTimeout(r, 150));
        const stillRefused = await openStream(port);
        expect(stillRefused.status).toBe(429);

        // The turns finish (and are persisted) → slots come back.
        release();
        for (let i = 0; i < 100 && finished < 2; i++)
          await new Promise((r) => setTimeout(r, 100));
        expect(finished).toBe(2);
        await new Promise((r) => setTimeout(r, 100));
        const after = await srv()
          .post('/api/chat/stream')
          .set('Authorization', `Bearer ${streamToken}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message: 'hello' });
        expect(after.status).toBe(200);
        expect(after.text).toContain('turn.completed');
      } finally {
        release();
        spy.mockRestore();
      }
    }, 60_000);
  });
});
