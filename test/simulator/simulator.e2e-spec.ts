import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import {
  RIVAL_VEHICLES,
  seedDemoDealer,
  SIM_ORIGIN,
  DemoDealer,
} from '../helpers/demo-dealer';
import { generateScenarios, Scenario } from './generator';
import { ConversationOracle, evaluateTurn, Finding, Reply } from './evaluator';
import { HOLDOUT } from './holdout';
import { STORES, StoreVocab } from './stores';
import { HOLDOUT2 } from './holdout2';
import { dbInvariants } from './db-invariants';

/**
 * Autonomous customer simulator — drives the REAL HTTP API + Postgres with thousands of
 * generated, seeded conversations and evaluates every turn independently.
 *
 *   npm run test:simulator                       # default sizes below
 *   SIM_SEED=123 SIM_PROPERTY=50 npm run test:simulator   # reproduce / shrink
 *   SIM_ONLY=multi-turn-100042 npm run test:simulator     # replay one failing scenario
 *
 * Deterministic (LLM disabled in test env). Results: test/evidence/simulator-latest.json.
 * Gate: zero P0, zero P1, task success ≥ 95% overall AND on the hold-out split.
 */
const N = (k: string, d: number) => Number(process.env[k] ?? d);
const SEED = N('SIM_SEED', 20261014);

const DEPT: Record<string, string> = {
  search: 'sales',
  select: 'sales',
  compare: 'sales',
  payment: 'sales',
  otd: 'sales',
  shopping: 'sales',
  credit: 'finance',
  approval_question: 'finance',
  service: 'service',
  service_detail: 'service',
  hours: 'support',
  parts: 'parts',
  handoff: 'support',
  social: 'conversation',
  identity: 'conversation',
  decline: 'conversation',
  injection: 'security',
  sensitive: 'security',
  any: 'other',
};

describe('customer simulator', () => {
  let ctx: E2eCtx;
  let dealer: DemoDealer;
  let rival: DemoDealer;
  let token: string;
  const fleet: Array<{ vocab: StoreVocab; dealer: DemoDealer; token: string }> =
    [];

  beforeAll(async () => {
    ctx = await createE2eApp();
    for (const vocab of STORES) {
      const d = await seedDemoDealer(ctx.app, ctx.prisma, `sim5-${vocab.key}`, {
        vehicles: vocab.vehicles,
      });
      const tk = await request(ctx.app.getHttpServer())
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: d.slug, locationSlug: 'main' });
      fleet.push({
        vocab,
        dealer: d,
        token: unwrap<{ token: string }>(tk.body).token,
      });
    }
    dealer = await seedDemoDealer(ctx.app, ctx.prisma, 'sim-motors');
    rival = await seedDemoDealer(ctx.app, ctx.prisma, 'sim-rival', {
      vehicles: RIVAL_VEHICLES,
    });
    const t = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: dealer.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(t.body).token;
  });
  afterAll(async () => ctx.app.close());

  it('generated conversations meet the truth, safety and task gates', async () => {
    // ~3,000 scenarios across the five simulated stores by default (per-store = total / 5).
    const per = (k: string, d: number) =>
      Math.max(0, Math.round(N(k, d) / fleet.length));
    let scenarios: Array<Scenario & { store: number }> = fleet.flatMap((f, i) =>
      generateScenarios({
        baseSeed: SEED + i * 1_000_000,
        store: f.vocab,
        property: per('SIM_PROPERTY', 1750),
        multiTurn: per('SIM_MULTI', 900),
        adversarial: per('SIM_ADV', 250),
        long: per('SIM_LONG', 100),
      }).map((s) => ({ ...s, store: i })),
    );
    if (process.env.SIM_ONLY)
      scenarios = scenarios.filter((s) => s.id === process.env.SIM_ONLY);
    const foreignFor = (i: number) =>
      new Set([
        ...rival.vehicles.map((v) => v.vin),
        ...fleet
          .filter((_, j) => j !== i)
          .flatMap((f) => f.dealer.vehicles.map((v) => v.vin)),
      ]);
    const results: Array<{
      s: Scenario;
      findings: Finding[];
      transcript: Array<{ u: string; a: string }>;
    }> = [];
    let turns = 0;
    let throttleWaits = 0;
    const started = Date.now();
    for (const s of scenarios) {
      const store = fleet[s.store];
      const oracle = new ConversationOracle(
        store.dealer.vehicles,
        foreignFor(s.store),
      );
      const findings: Finding[] = [];
      const transcript: Array<{ u: string; a: string }> = [];
      let cid: string | undefined;
      let prev: Reply | null = null;
      const history: Reply[] = [];
      for (const turn of s.turns) {
        oracle.absorbUser(turn.say);
        const send = () =>
          request(ctx.app.getHttpServer())
            .post('/api/chat')
            .set('Authorization', `Bearer ${store.token}`)
            .set('Origin', SIM_ORIGIN)
            .send({ message: turn.say, conversationId: cid });
        let r = await send();
        // The harness outpaces any human: wait out the (unchanged) throttle window, then resend.
        if (r.status === 429) {
          throttleWaits += 1;
          await new Promise((res) => setTimeout(res, 61_000));
          r = await send();
        }
        const body =
          r.status < 300
            ? unwrap<Reply & { conversationId: string }>(r.body)
            : null;
        if (body) cid = body.conversationId;
        turns += 1;
        for (const f of evaluateTurn({
          turn,
          res: { status: r.status, body },
          prev,
          oracle,
          history,
        }))
          findings.push({
            ...f,
            detail: `[turn ${transcript.length + 1}] ${f.detail}`,
          });
        transcript.push({
          u: turn.say,
          a:
            body?.reply ??
            `HTTP ${r.status} ${String(r.text ?? '').slice(0, 200)} ct=${String(r.headers['content-type'] ?? '')} rid=${String(r.headers['x-request-id'] ?? '')}`,
        });
        if (body) {
          prev = body;
          history.push(body);
        }
      }
      results.push({ s, findings, transcript });
    }

    // ── database-level invariants (independent of replies)
    const dbFindings = await dbInvariants(
      ctx.prisma,
      fleet.map((f) => f.dealer.tenantId),
      [rival.tenantId],
    );

    // ── metrics
    const ok = (x: (typeof results)[number]) =>
      !x.findings.some((f) => f.severity !== 'P2');
    const rate = (xs: typeof results) =>
      xs.length ? xs.filter(ok).length / xs.length : 1;
    const byCat: Record<string, { n: number; success: number }> = {};
    const byDept: Record<string, { n: number; failed: number }> = {};
    const sev = { P0: 0, P1: 0, P2: 0 };
    const rules: Record<string, number> = {};
    for (const x of results) {
      const c = (byCat[x.s.category] ??= { n: 0, success: 0 });
      c.n += 1;
      if (ok(x)) c.success += 1;
      for (const f of x.findings) {
        sev[f.severity] += 1;
        rules[`${f.severity} ${f.rule}`] =
          (rules[`${f.severity} ${f.rule}`] ?? 0) + 1;
      }
      for (const t of x.s.turns) {
        const d = DEPT[t.expect.kind] ?? 'other';
        const b = (byDept[d] ??= { n: 0, failed: 0 });
        b.n += 1;
      }
      for (const f of x.findings.filter((f) => f.severity !== 'P2')) {
        const m = /task_(\w+):/.exec(f.rule);
        const d = m ? (DEPT[m[1]] ?? 'other') : 'cross-cutting';
        (byDept[d] ??= { n: 0, failed: 0 }).failed += 1;
      }
    }
    for (const f of dbFindings) sev[f.severity] += 1;
    const holdout = results.filter((x) => x.s.holdout);
    const report = {
      generatedAt: new Date().toISOString(),
      seed: SEED,
      mode: 'deterministic (LLM disabled)',
      scenarios: results.length,
      turns,
      durationMs: Date.now() - started,
      throttleWaits,
      taskSuccess: Number(rate(results).toFixed(4)),
      holdoutTaskSuccess: Number(rate(holdout).toFixed(4)),
      holdoutScenarios: holdout.length,
      byStore: Object.fromEntries(
        fleet.map((f, i) => {
          const xs = results.filter(
            (x) => (x.s as Scenario & { store: number }).store === i,
          );
          return [
            f.vocab.key,
            { scenarios: xs.length, taskSuccess: Number(rate(xs).toFixed(4)) },
          ];
        }),
      ),
      severities: sev,
      byCategory: Object.fromEntries(
        Object.entries(byCat).map(([k, v]) => [
          k,
          { ...v, rate: Number((v.success / v.n).toFixed(4)) },
        ]),
      ),
      byDepartmentTurns: byDept,
      topRules: Object.entries(rules)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
      dbFindings,
      failures: results
        .filter((x) => x.findings.length)
        .sort(
          (a, b) =>
            (a.findings.some((f) => f.severity === 'P0') ? -1 : 1) -
            (b.findings.some((f) => f.severity === 'P0') ? -1 : 1),
        )
        .slice(0, 150)
        .map((x) => ({
          id: x.s.id,
          seed: x.s.seed,
          persona: x.s.persona,
          findings: x.findings.slice(0, 6),
          transcript: x.transcript.slice(0, 40),
        })),
    };
    const out = path.join(__dirname, '../evidence/simulator-latest.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        {
          ...report,
          failures: report.failures.length,
          topRules: report.topRules.slice(0, 15),
        },
        null,
        2,
      ),
    );

    expect(sev.P0).toBe(0);
    expect(sev.P1).toBe(0);
    expect(report.taskSuccess).toBeGreaterThanOrEqual(0.95);
    expect(report.holdoutTaskSuccess).toBeGreaterThanOrEqual(0.95);
  }, 3_600_000);

  it('hold-out phrasings (written independently of the generator) meet the task gate', async () => {
    const foreign = new Set(rival.vehicles.map((v) => v.vin));
    const rows: Array<{
      say: string;
      kind: string;
      ok: boolean;
      findings: Finding[];
      reply: string;
    }> = [];
    for (const c of HOLDOUT) {
      const oracle = new ConversationOracle(dealer.vehicles, foreign);
      let cid: string | undefined;
      let last: { status: number; body: Reply | null } = {
        status: 0,
        body: null,
      };
      for (const say of [...(c.pre ?? []), c.say]) {
        oracle.absorbUser(say);
        const r = await request(ctx.app.getHttpServer())
          .post('/api/chat')
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message: say, conversationId: cid });
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
        say: c.say,
        kind: c.expect.kind,
        ok: !findings.some((f) => f.severity !== 'P2'),
        findings,
        reply: last.body?.reply ?? `HTTP ${last.status}`,
      });
    }
    const rate = rows.filter((r) => r.ok).length / rows.length;
    const p0 = rows
      .flatMap((r) => r.findings)
      .filter((f) => f.severity === 'P0').length;
    fs.writeFileSync(
      path.join(__dirname, '../evidence/holdout-latest.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          cases: rows.length,
          taskSuccess: Number(rate.toFixed(4)),
          p0,
          failures: rows.filter((r) => !r.ok || r.findings.length),
        },
        null,
        2,
      ),
    );
    expect(p0).toBe(0);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  }, 600_000);

  it('hold-out #2 (five stores, written blind) meets the task gate', async () => {
    const rows: Array<{
      store: string;
      say: string;
      kind: string;
      ok: boolean;
      findings: Finding[];
      reply: string;
    }> = [];
    for (const c of HOLDOUT2) {
      const idx = fleet.findIndex((f) => f.vocab.key === c.store);
      const f = fleet[idx];
      const foreign = new Set([
        ...rival.vehicles.map((v) => v.vin),
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
      for (const say of [...(c.pre ?? []), c.say]) {
        oracle.absorbUser(say);
        const r = await request(ctx.app.getHttpServer())
          .post('/api/chat')
          .set('Authorization', `Bearer ${f.token}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message: say, conversationId: cid });
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
        kind: c.expect.kind,
        ok: !findings.some((x) => x.severity !== 'P2'),
        findings,
        reply: last.body?.reply ?? `HTTP ${last.status}`,
      });
    }
    const rate = rows.filter((r) => r.ok).length / rows.length;
    const p0 = rows
      .flatMap((r) => r.findings)
      .filter((x) => x.severity === 'P0').length;
    fs.writeFileSync(
      path.join(__dirname, '../evidence/holdout2-latest.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          cases: rows.length,
          taskSuccess: Number(rate.toFixed(4)),
          p0,
          failures: rows.filter((r) => !r.ok || r.findings.length),
        },
        null,
        2,
      ),
    );
    expect(p0).toBe(0);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  }, 600_000);
});
