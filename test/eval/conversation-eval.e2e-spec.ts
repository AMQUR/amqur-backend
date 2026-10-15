import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { STORES } from '../simulator/stores';
import {
  CRITICAL,
  GENERIC,
  HOLDOUT_JOURNEYS,
  JOURNEYS as MAIN_JOURNEYS,
  type EvalTurn,
} from './conversation-eval.dataset';

/**
 * Conversational evaluation (101 turns, 11 journeys). Two modes:
 *  - in-process (default; CI): local test DB, demo inventory, no model unless a key is in the
 *    environment → measures the deterministic floor; asserts zero CRITICAL failures.
 *  - remote: EVAL_TARGET=http://localhost:3001 (the keyed owner demo) → measures the live
 *    model path through the real HTTP API; paced under the demo's chat rate limit.
 * Writes test/evidence/conversation-eval-<mode>.json and a readable .md transcript.
 */
const TARGET = process.env.EVAL_TARGET?.replace(/\/$/, '');
const SET = process.env.EVAL_SET === 'holdout' ? 'holdout' : 'main';
const JOURNEYS = SET === 'holdout' ? HOLDOUT_JOURNEYS : MAIN_JOURNEYS;
const TOTAL_TURNS = JOURNEYS.reduce((n, j) => n + j.turns.length, 0);
const MODE = `${TARGET ? 'remote' : 'in-process'}${SET === 'holdout' ? '-holdout' : ''}`;
const PACE = Number(process.env.EVAL_PACE_MS ?? (TARGET ? 1700 : 0));

type Body = {
  conversationId: string;
  reply: string;
  cards?: Array<{ kind: string }>;
  vehicles?: unknown[];
  provenance?: {
    languageModel?: string;
    modelInterpreted?: boolean;
    fallbackReason?: string;
  };
};

function score(turn: EvalTurn, status: number, b: Body | null) {
  const fails: string[] = [];
  const critical: string[] = [];
  if (status >= 300 || !b) {
    critical.push(`http_${status}`);
    return { fails: ['no reply'], critical };
  }
  const r = b.reply ?? '';
  const kinds = (b.cards ?? []).map((c) => c.kind);
  if (!r.trim()) fails.push('empty');
  if (!turn.allowGeneric && GENERIC.some((g) => g.test(r)))
    fails.push('generic deflection');
  if (turn.any && !turn.any.some((re) => re.test(r)))
    fails.push(`missing meaning ${turn.any.map(String).join(' | ')}`);
  for (const re of turn.not ?? [])
    if (re.test(r)) fails.push(`forbidden ${String(re)}`);
  for (const k of turn.cards ?? [])
    if (!kinds.includes(k)) fails.push(`missing card ${k}`);
  for (const k of turn.noCards ?? [])
    if (kinds.includes(k)) fails.push(`unexpected card ${k}`);
  for (const c of CRITICAL) if (c.re.test(r)) critical.push(c.why);
  return { fails, critical };
}

describe(`conversation evaluation (${MODE})`, () => {
  let ctx: E2eCtx | undefined;
  const prevWebhook = process.env.CRM_WEBHOOK_URL;
  afterAll(async () => {
    process.env.CRM_WEBHOOK_URL = prevWebhook;
    await ctx?.app.close();
  });

  it(`runs ${TOTAL_TURNS} turns and reports quality; zero critical failures`, async () => {
    let api: string;
    let tenantSlug: string;
    let locationSlug: string;
    let origin: string;
    if (TARGET) {
      api = TARGET;
      tenantSlug = process.env.EVAL_TENANT ?? 'dial-demo-local';
      locationSlug = process.env.EVAL_LOCATION ?? 'demo-rooftop';
      origin = process.env.EVAL_ORIGIN ?? 'http://localhost:5173';
    } else {
      // The demo has no delivery channel; the mock CRM's 200 is not a person being alerted.
      process.env.CRM_WEBHOOK_URL = '';
      ctx = await createE2eApp();
      const d = await seedDemoDealer(ctx.app, ctx.prisma, 'eval-demo');
      await ctx.prisma.tenant.update({
        where: { id: d.tenantId },
        data: { publicConfig: { assistantDisplayName: 'Dial Concierge' } },
      });
      // A second store must never leak into answers.
      await seedDemoDealer(ctx.app, ctx.prisma, 'eval-rival', {
        vehicles: STORES.find((s) => s.key === 'cdjr-south')!.vehicles,
      });
      const addr = (
        ctx.app.getHttpServer() as unknown as { address(): { port: number } }
      ).address();
      api = `http://127.0.0.1:${addr.port}`;
      tenantSlug = d.slug;
      locationSlug = 'main';
      origin = SIM_ORIGIN;
    }
    const results: Array<Record<string, unknown>> = [];
    const latencies: number[] = [];
    for (const j of JOURNEYS) {
      const tok = await request(api)
        .post('/api/public/widget-token')
        .set('Origin', origin)
        .send({ tenantSlug, locationSlug });
      const token = unwrap<{ token: string }>(tok.body).token;
      let cid: string | undefined;
      for (const turn of j.turns) {
        if (PACE) await new Promise((r) => setTimeout(r, PACE));
        const t0 = Date.now();
        let r = await request(api)
          .post('/api/chat')
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', origin)
          .send({ message: turn.say, conversationId: cid });
        if (r.status === 429) {
          await new Promise((res) => setTimeout(res, 61_000));
          r = await request(api)
            .post('/api/chat')
            .set('Authorization', `Bearer ${token}`)
            .set('Origin', origin)
            .send({ message: turn.say, conversationId: cid });
        }
        const ms = Date.now() - t0;
        latencies.push(ms);
        const b = r.status < 300 ? unwrap<Body>(r.body) : null;
        if (b) cid = b.conversationId;
        const s = score(turn, r.status, b);
        results.push({
          journey: j.id,
          tag: turn.tag,
          say: turn.say,
          reply: b?.reply ?? `HTTP ${r.status}`,
          cards: (b?.cards ?? []).map((c) => c.kind),
          vehicles: b?.vehicles?.length ?? 0,
          languageModel: b?.provenance?.languageModel ?? null,
          modelInterpreted: b?.provenance?.modelInterpreted ?? null,
          fallbackReason: b?.provenance?.fallbackReason ?? null,
          ms,
          pass: s.fails.length === 0 && s.critical.length === 0,
          fails: s.fails,
          critical: s.critical,
        });
      }
    }
    const passed = results.filter((x) => x.pass).length;
    const critical = results.filter((x) => (x.critical as string[]).length);
    const lm: Record<string, number> = {};
    for (const x of results) {
      const k = `${x.languageModel}${x.modelInterpreted ? '+interpreted' : ''}`;
      lm[k] = (lm[k] ?? 0) + 1;
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const p = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const report = {
      generatedAt: new Date().toISOString(),
      mode: MODE,
      target: TARGET ?? 'in-process',
      turns: results.length,
      passed,
      passRate: Math.round((passed / results.length) * 1000) / 10,
      criticalFailures: critical.length,
      provenance: lm,
      latencyMs: { p50: p(0.5), p90: p(0.9), max: sorted[sorted.length - 1] },
      failures: results.filter((x) => !x.pass),
      results,
    };
    const base = path.join(__dirname, `../evidence/conversation-eval-${MODE}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    const md = [
      `# Conversation evaluation — ${MODE}`,
      '',
      `${report.generatedAt} · ${report.turns} turns · pass ${passed}/${report.turns} (${report.passRate}%) · critical ${critical.length} · latency p50 ${report.latencyMs.p50} ms, p90 ${report.latencyMs.p90} ms`,
      '',
      `Provenance: ${Object.entries(lm)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
      '',
      ...JOURNEYS.flatMap((j) => [
        `## ${j.title}`,
        '',
        ...results
          .filter((x) => x.journey === j.id)
          .flatMap((x) => [
            `**Customer:** ${x.say}`,
            '',
            `**Assistant** _(${x.languageModel}${x.modelInterpreted ? ', model-interpreted' : ''}${(x.cards as string[]).length ? `, cards: ${(x.cards as string[]).join(', ')}` : ''}${x.vehicles ? `, ${x.vehicles} vehicle card(s)` : ''}, ${x.ms} ms)_: ${x.reply}`,
            '',
            x.pass
              ? ''
              : `> ❌ ${[...(x.fails as string[]), ...(x.critical as string[])].join('; ')}`,
            '',
          ]),
      ]),
    ].join('\n');
    fs.writeFileSync(`${base}.md`, md);
    console.log(
      `[eval ${MODE}] ${passed}/${results.length} (${report.passRate}%) critical=${critical.length} provenance=${JSON.stringify(lm)}`,
    );
    expect(critical).toEqual([]);
  }, 3_600_000);
});
