import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import {
  seedDemoDealer,
  SIM_ORIGIN,
  RIVAL_VEHICLES,
} from '../helpers/demo-dealer';
import { STORES } from '../simulator/stores';
import { HOLDOUT2 } from '../simulator/holdout2';
import {
  ConversationOracle,
  evaluateTurn,
  Finding,
  Reply,
} from '../simulator/evaluator';
import { MetricsService } from '../../src/observability/metrics.service';
import { LlmRouterService } from '../../src/ai/llm-router.service';

/**
 * LIVE-MODEL evaluation — real provider calls, explicit spend controls. Never runs in CI.
 *
 *   LIVE_MODEL_EVAL=1 ANTHROPIC_API_KEY=… LIVE_MODEL_MAX_TURNS=120 LLM_DAILY_TOKEN_BUDGET=300000 \
 *     npm run eval:live-model
 *
 * Same deterministic truth checks as the simulator (any unsupported $ figure, approval or
 * confirmation claim, cross-store vehicle, sensitive echo = P0) plus: per-turn latency with the
 * model in the loop, tokens, metered cost, and how often the grounding guard discarded model
 * output. Without a key the suite reports SKIPPED — never passed.
 */
const ENABLED =
  process.env.LIVE_MODEL_EVAL === '1' &&
  !!(
    process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  );
const MAX_TURNS = Number(process.env.LIVE_MODEL_MAX_TURNS ?? 120);
if (ENABLED && !process.env.LLM_DAILY_TOKEN_BUDGET)
  process.env.LLM_DAILY_TOKEN_BUDGET = '300000';
if (ENABLED && !process.env.LLM_MAX_CONCURRENCY)
  process.env.LLM_MAX_CONCURRENCY = '4';

(ENABLED ? describe : describe.skip)(
  'live-model evaluation (real provider)',
  () => {
    let ctx: E2eCtx;
    afterAll(async () => ctx?.app.close());

    it('real-model replies stay grounded, safe and useful within budget', async () => {
      ctx = await createE2eApp();
      const fleet: Array<{
        vocab: (typeof STORES)[number];
        dealer: Awaited<ReturnType<typeof seedDemoDealer>>;
        token: string;
      }> = [];
      for (const vocab of STORES) {
        const d = await seedDemoDealer(
          ctx.app,
          ctx.prisma,
          `live-${vocab.key}`,
          { vehicles: vocab.vehicles },
        );
        const t = await request(ctx.app.getHttpServer())
          .post('/api/public/widget-token')
          .set('Origin', SIM_ORIGIN)
          .send({ tenantSlug: d.slug, locationSlug: 'main' });
        fleet.push({
          vocab,
          dealer: d,
          token: unwrap<{ token: string }>(t.body).token,
        });
      }
      const before = ctx.app.get(MetricsService).snapshot();
      const latencies: number[] = [];
      const rows: Array<{
        store: string;
        say: string;
        ok: boolean;
        findings: Finding[];
        reply: string;
        ms: number;
      }> = [];
      let turns = 0;
      for (const c of HOLDOUT2) {
        if (turns >= MAX_TURNS) break;
        const idx = fleet.findIndex((f) => f.vocab.key === c.store);
        const f = fleet[idx];
        const foreign = new Set([
          ...RIVAL_VEHICLES.map((v) => v.vin),
          ...fleet
            .filter((_, j) => j !== idx)
            .flatMap((x) => x.dealer.vehicles.map((v) => v.vin)),
        ]);
        const oracle = new ConversationOracle(f.dealer.vehicles, foreign);
        let cid: string | undefined;
        let last: { status: number; body: Reply | null } = {
          status: 0,
          body: null,
        };
        let ms = 0;
        for (const say of [...(c.pre ?? []), c.say]) {
          oracle.absorbUser(say);
          const t0 = Date.now();
          const r = await request(ctx.app.getHttpServer())
            .post('/api/chat')
            .set('Authorization', `Bearer ${f.token}`)
            .set('Origin', SIM_ORIGIN)
            .send({ message: say, conversationId: cid });
          ms = Date.now() - t0;
          latencies.push(ms);
          turns += 1;
          const body =
            r.status < 300
              ? unwrap<Reply & { conversationId: string }>(r.body)
              : null;
          if (body) cid = body.conversationId;
          last = { status: r.status, body };
        }
        const findings = evaluateTurn({
          turn: { say: c.say, expect: c.expect },
          res: last,
          oracle,
          history: [],
        });
        rows.push({
          store: c.store,
          say: c.say,
          ok: !findings.some((x) => x.severity !== 'P2'),
          findings,
          reply: last.body?.reply ?? '',
          ms,
        });
      }
      const after = ctx.app.get(MetricsService).snapshot();
      const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
      const sorted = [...latencies].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted[
          Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
        ] ?? 0;
      const status = await ctx.app.get(LlmRouterService).status();
      const report = {
        generatedAt: new Date().toISOString(),
        providers: status.providers.map((p) => ({
          provider: p.provider,
          configured: p.configured,
          model: p.model,
        })),
        cases: rows.length,
        turns,
        taskSuccess: rows.filter((r) => r.ok).length / Math.max(1, rows.length),
        p0: rows.flatMap((r) => r.findings).filter((x) => x.severity === 'P0')
          .length,
        latencyMs: {
          p50: pct(50),
          p95: pct(95),
          p99: pct(99),
          max: sorted[sorted.length - 1] ?? 0,
        },
        llm: {
          successes: d('ai.llm.success'),
          failures: d('ai.llm.failure'),
          groundingDiscards: d('chat.grounding.sanitized'),
          tokensIn: d('ai.llm.tokens_in'),
          tokensOut: d('ai.llm.tokens_out'),
          costMicroUsd: d('ai.llm.cost_microusd') || null,
          budgetExhausted: status.budgetExhausted,
        },
        failures: rows.filter((r) => !r.ok || r.findings.length),
      };
      fs.writeFileSync(
        path.join(__dirname, '../evidence/live-model-latest.json'),
        JSON.stringify(report, null, 2),
      );
      expect(report.llm.successes).toBeGreaterThan(0); // proves real model calls happened
      expect(report.p0).toBe(0);
      expect(report.taskSuccess).toBeGreaterThanOrEqual(0.95);
    }, 3_600_000);
  },
);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[live-model] SKIPPED — set LIVE_MODEL_EVAL=1 and a provider key in your shell to run real-model evaluation.',
  );
}
