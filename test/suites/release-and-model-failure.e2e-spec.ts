import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';
import { LlmRouterService } from '../../src/ai/llm-router.service';

type ChatBody = {
  conversationId: string;
  reply: string;
  provenance?: { languageModel?: string; fallbackReason?: string };
};

/**
 * (1) Release markers — the endpoints `scripts/staging-acceptance.sh` uses to prove the
 *     October build (not the August one) is deployed. If any of these change, the
 *     acceptance script must change with them.
 * (2) Model failure injection — no provider key exists in CI, so the router is replaced with a
 *     controllable fake: fabricated claims are discarded, provider failures and exceptions
 *     degrade to the deterministic reply, and provenance says which happened.
 */
describe('release markers and model failure handling', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  let token: string;
  let router: LlmRouterService;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'release-markers');
    const t = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(t.body).token;
    router = ctx.app.get(LlmRouterService);
  }, 60_000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => ctx.app.close());

  const chat = async (message: string) => {
    const r = await http()
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', SIM_ORIGIN)
      .send({ message });
    return { status: r.status, body: unwrap<ChatBody>(r.body) };
  };
  const fakeModel = (impl: () => Promise<unknown>) => {
    jest.spyOn(router, 'isAvailable').mockReturnValue(true);
    return jest.spyOn(router, 'route').mockImplementation(impl as never);
  };

  describe('release markers', () => {
    it('/api/version exposes the commit identity', async () => {
      const r = await http().get('/api/version');
      expect(r.status).toBe(200);
      expect(unwrap<object>(r.body)).toHaveProperty('commitSha');
    });
    it('/api/health reports the llm check (presence only, never a key)', async () => {
      const r = await http().get('/api/health');
      const b = unwrap<{ checks: { llm: string } }>(r.body);
      expect(['configured', 'missing']).toContain(b.checks.llm);
      expect(JSON.stringify(r.body)).not.toMatch(/sk-|api[_-]?key/i);
    });
    it('/api/public/spotlights answers 200 without auth', async () => {
      const r = await http().get(
        `/api/public/spotlights?tenantSlug=${d.slug}&locationSlug=main`,
      );
      expect(r.status).toBe(200);
    });
    it('/api/ops/ai/status exists and requires auth', async () => {
      expect((await http().get('/api/ops/ai/status')).status).toBe(401);
    });
  });

  describe('model failure injection', () => {
    it('without a provider, replies are deterministic and say so', async () => {
      jest.spyOn(router, 'isAvailable').mockReturnValue(false);
      const r = await chat('What vehicles do you have in stock?');
      expect(r.status).toBe(201);
      expect(r.body.reply.length).toBeGreaterThan(0);
      expect(r.body.provenance?.languageModel).toBe('none');
    });

    it('a model reply inventing a price and an approval is discarded; the draft is sent', async () => {
      fakeModel(async () => ({
        ok: true,
        attempts: 1,
        result: {
          text: 'Great news — you are approved for financing and it is yours for $9,999 today!',
          provider: 'fake',
          model: 'fake',
          latencyMs: 1,
        },
      }));
      const r = await chat('What vehicles do you have in stock?');
      expect(r.status).toBe(201);
      expect(r.body.reply).not.toContain('$9,999');
      expect(r.body.reply).not.toMatch(/approved/i);
      expect(r.body.provenance?.languageModel).toBe('discarded');
    });

    it('a grounded model rewrite is used and marked polished', async () => {
      const text =
        'Happy to help you look around. What kind of vehicle are you after?';
      fakeModel(async () => ({
        ok: true,
        attempts: 1,
        result: { text, provider: 'fake', model: 'fake', latencyMs: 1 },
      }));
      const r = await chat('hello there');
      expect(r.status).toBe(201);
      // Claude composes the reply; the validated text is what the customer sees.
      expect(r.body.provenance?.languageModel).toBe('composed');
      expect(r.body.reply).toBe(text);
    });

    it('provider failure (timeout / open circuit / spend cap) degrades to the deterministic reply', async () => {
      for (const reason of [
        'timeout',
        'all_circuits_open',
        'spend_cap_exhausted',
        'spend_cap_unpriced',
      ]) {
        fakeModel(async () => ({ ok: false, reason, attempts: 1 }));
        const r = await chat('What vehicles do you have in stock?');
        expect(r.status).toBe(201);
        expect(r.body.reply.length).toBeGreaterThan(0);
        // model attempted and failed → deterministic reply, with the reason recorded
        expect(r.body.provenance?.languageModel).toBe('discarded');
        expect(r.body.provenance?.fallbackReason).toBeTruthy();
        jest.restoreAllMocks();
      }
    });

    it('an unexpected router exception never breaks the conversation', async () => {
      const route = fakeModel(async () => {
        throw new Error('socket hang up');
      });
      for (const msg of [
        'What vehicles do you have in stock?',
        'hello there',
        'Do you have a red Wrangler?',
      ]) {
        const r = await chat(msg);
        expect(r.status).toBe(201);
        expect(r.body.reply.length).toBeGreaterThan(0);
        // model attempted and failed → deterministic reply, with the reason recorded
        // never a model-written reply; deterministic (urgent error turns skip the model)
        expect(['none', 'discarded']).toContain(
          r.body.provenance?.languageModel,
        );
      }
      expect(route).toHaveBeenCalled();
    });
  });
});
