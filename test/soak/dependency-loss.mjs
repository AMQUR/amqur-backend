/**
 * Dependency loss: stop the soak stack's Redis, then its Postgres, in the middle of traffic, and
 * record what clients see, what the health endpoints say and how long recovery takes — without
 * restarting the API process.
 *
 *   SOAK_OUT=… bash test/soak/infra/soak-env.sh node test/soak/dependency-loss.mjs
 *
 * Only containers of the `amqur-soak` compose project are ever stopped (name-checked).
 * Env: SOAK_OUTAGE_S (40) · SOAK_DEP_SHOPPERS (6).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLoopback, BASE, ROOFTOPS, GROUP, chat, chatStream, card, shopper, leadPayload, leakMarkers, ledger, pick, request, sleep, summarize, ORIGIN } from './lib/client.mjs';
import { pidAlive, pidFromFile } from './lib/probe.mjs';

assertLoopback();
const OUT = process.env.SOAK_OUT;
const OUTAGE_S = Number(process.env.SOAK_OUTAGE_S || 40);
const SHOPPERS = Number(process.env.SOAK_DEP_SHOPPERS || 6);
const pid = Number(process.env.SOAK_API_PID) || (OUT ? pidFromFile(process.env.SOAK_API_PIDFILE || path.join(OUT, 'api-a.pid')) : null);
const L = ledger('dependency-loss');
const docker = (...args) =>
  new Promise((resolve) => {
    if (!args.slice(1).every((a) => !a.startsWith('amqur-') || a.startsWith('amqur-soak-'))) throw new Error('refusing to touch a container outside amqur-soak');
    execFile('docker', args, { timeout: 60_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
const REDIS = 'amqur-soak-redis-1';
const POSTGRES = 'amqur-soak-postgres-1';

// ───────────────────────────────────────────────────────────── traffic + health recording
let phase = 'baseline';
const events = []; // { t, phase, kind, status, ms, leaks, sample }
const healthLog = []; // { t, phase, ready, live, status, redis, database }
let stop = false;
let seq = 700_000;
function note(kind, r, startedAt) {
  const bad = r.status < 200 || r.status >= 300;
  const text = r.streamError ? JSON.stringify(r.streamError) : r.text;
  events.push({ t: Date.now(), startedAt, phase, kind, status: r.status === 0 ? `0:${r.error || 'transport'}` : r.streamError ? '200:turn.error' : String(r.status), ms: r.ms, leaks: bad || r.streamError ? leakMarkers(text) : [], sample: bad || r.streamError ? String(text || '').slice(0, 240) : undefined });
}
async function shopperLoop() {
  while (!stop) {
    const t = pick([...ROOFTOPS, GROUP]);
    let cid;
    const send = async (kind, body, stream = false) => {
      const startedAt = Date.now();
      const r = stream ? await chatStream(t, { ...body, conversationId: cid }, { timeoutMs: 15_000 }) : await chat(t, { ...body, conversationId: cid }, { timeoutMs: 15_000 });
      note(kind, r, startedAt);
      cid = r.data?.conversationId ?? cid;
      return r.data;
    };
    await send('search', { message: 'Do you have any SUVs?', language: 'en' });
    await sleep(150 + Math.random() * 200);
    await send('stream', { message: 'Show me trucks', language: 'en' }, true);
    await sleep(150 + Math.random() * 200);
    if (t.vins && Math.random() < 0.4) {
      const a = await send('test_drive', { action: 'test_drive', vin: pick(t.vins), language: 'en' });
      const form = card(a, 'lead_form');
      if (form) await send('lead_form', { action: 'lead_capture', language: 'en', lead: leadPayload(form.id, shopper((seq += 1), 'dep')) });
    } else await send('payment', { message: 'What would the monthly payment be with $3000 down for 60 months?', language: 'en' });
    await sleep(150 + Math.random() * 200);
  }
}
async function healthLoop() {
  while (!stop) {
    const [ready, live] = await Promise.all([
      request('GET', `${BASE}/api/health`, { timeoutMs: 5000, useAgent: false }),
      request('GET', `${BASE}/api/health/live`, { timeoutMs: 5000, useAgent: false }),
    ]);
    const d = ready.body?.data ?? ready.body ?? {};
    const checks = d.checks ?? d.message?.checks ?? ready.body?.message?.checks ?? {};
    healthLog.push({ t: Date.now(), phase, ready: ready.status, live: live.status, ms: Math.round(ready.ms), status: d.status ?? ready.body?.message?.status ?? null, redis: checks.redis ?? null, database: checks.database ?? null, leaks: ready.status >= 400 ? leakMarkers(ready.text) : [], sample: ready.status >= 400 ? ready.text.slice(0, 240) : undefined });
    await sleep(500);
  }
}
/** A fresh widget token needs the database: record what that endpoint does during an outage. */
async function tokenLoop() {
  while (!stop) {
    const startedAt = Date.now();
    const r = await request('POST', `${BASE}/api/public/widget-token`, { headers: { origin: ORIGIN }, body: { tenantSlug: 'jeep-of-chicago', locationSlug: 'main' }, timeoutMs: 15_000, useAgent: false });
    note('widget_token', r, startedAt);
    await sleep(2000);
  }
}

function phaseStats(name) {
  const ev = events.filter((e) => e.phase === name);
  const byStatus = ev.reduce((o, e) => ((o[e.status] = (o[e.status] || 0) + 1), o), {});
  const byKind = {};
  for (const e of ev) {
    byKind[e.kind] ??= {};
    byKind[e.kind][e.status] = (byKind[e.kind][e.status] || 0) + 1;
  }
  const leaks = ev.filter((e) => e.leaks.length);
  const samples = [...new Map(ev.filter((e) => e.sample).map((e) => [`${e.status}|${e.sample.replace(/"timestamp":"[^"]+"/, '').replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 120)}`, { status: e.status, body: e.sample }])).values()].slice(0, 6);
  const h = healthLog.filter((x) => x.phase === name);
  const healthSeen = h.reduce((o, x) => ((o[`${x.ready}/${x.status ?? '-'}/redis=${x.redis ?? '-'}/db=${x.database ?? '-'}`] = (o[`${x.ready}/${x.status ?? '-'}/redis=${x.redis ?? '-'}/db=${x.database ?? '-'}`] || 0) + 1), o), {});
  return { requests: ev.length, byStatus, byKind, latencyMs: summarize(ev.map((e) => e.ms)), bodiesWithInternals: leaks.length, leakKinds: [...new Set(leaks.flatMap((e) => e.leaks))], errorBodySamples: samples, health: healthSeen, live: h.reduce((o, x) => ((o[x.live] = (o[x.live] || 0) + 1), o), {}), healthBodiesWithInternals: h.filter((x) => x.leaks.length).length, healthErrorSample: h.find((x) => x.sample)?.sample };
}
const firstAfter = (t, pred, list) => {
  const hit = list.find((x) => x.t >= t && pred(x));
  return hit ? Math.round((hit.t - t) / 100) / 10 : null;
};
/** Seconds from `t` until the start of the first 5 s window with traffic and no failed request. */
function cleanFrom(t) {
  const after = events.filter((e) => e.t >= t && e.kind !== 'widget_token');
  for (const e of after) {
    const win = after.filter((x) => x.t >= e.t && x.t < e.t + 5000);
    if (win.length >= 5 && win.every((x) => /^2\d\d$/.test(x.status))) return Math.round((e.t - t) / 100) / 10;
  }
  return null;
}

async function outage(name, container, { holdS }) {
  phase = `${name}_down`;
  const stoppedAt = Date.now();
  const s = await docker('stop', '-t', '2', container);
  if (!s.ok) throw new Error(`failed to stop ${container}`);
  const confirmedDownAt = Date.now();
  console.log(`   ${container} stopped (${s.ok ? 'ok' : 'FAILED'}) — holding ${holdS} s`);
  await sleep(holdS * 1000);
  const startedAt = Date.now();
  if (!(await docker('start', container)).ok) throw new Error(`failed to restart ${container}`);
  phase = `${name}_recovering`;
  let healthyAfter = null;
  for (let i = 0; i < 120; i += 1) {
    const h = await docker('inspect', '-f', '{{.State.Health.Status}}', container);
    if (h.out === 'healthy') {
      healthyAfter = Math.round((Date.now() - startedAt) / 100) / 10;
      break;
    }
    await sleep(500);
  }
  await sleep(25_000);
  phase = `${name}_after`;
  await sleep(10_000);
  return { stoppedAt, confirmedDownAt, startedAt, downSeconds: Math.round((startedAt - stoppedAt) / 1000), containerHealthyAfterS: healthyAfter };
}

async function main() {
  console.log(`dependency-loss → ${BASE}, ${SHOPPERS} shoppers, outages of ${OUTAGE_S} s, api pid ${pid ?? 'unknown'} (never restarted)`);
  for (const c of [REDIS, POSTGRES]) {
    const h = await docker('inspect', '-f', '{{.State.Health.Status}}', c);
    if (h.out !== 'healthy') {
      console.error(`${c} is not healthy (${h.out || 'missing'}). Bring the soak stack up first.`);
      process.exit(1);
    }
  }
  const loops = [...Array.from({ length: SHOPPERS }, () => shopperLoop()), healthLoop(), tokenLoop()];
  await sleep(20_000);
  const redis = await outage('redis', REDIS, { holdS: OUTAGE_S });
  phase = 'between';
  await sleep(10_000);
  const pg = await outage('postgres', POSTGRES, { holdS: OUTAGE_S });
  phase = 'tail';
  await sleep(15_000);
  stop = true;
  await Promise.all(loops);

  const phases = Object.fromEntries(['baseline', 'redis_down', 'redis_recovering', 'redis_after', 'between', 'postgres_down', 'postgres_recovering', 'postgres_after', 'tail'].map((p) => [p, phaseStats(p)]));
  const recovery = {
    redis: {
      ...redis,
      healthReportsRedisUpAfterS: firstAfter(redis.startedAt, (x) => x.redis === 'up', healthLog),
      healthReadyAfterS: firstAfter(redis.startedAt, (x) => x.ready === 200 && x.status === 'ready', healthLog),
      firstCleanWindowAfterS: cleanFrom(redis.startedAt),
    },
    postgres: {
      ...pg,
      firstHealth200AfterS: firstAfter(pg.startedAt, (x) => x.ready === 200, healthLog),
      firstChat2xxAfterS: firstAfter(pg.startedAt, (x) => x.kind !== 'widget_token' && /^2\d\d$/.test(x.status), events),
      firstCleanWindowAfterS: cleanFrom(pg.startedAt),
    },
  };
  for (const [name, p] of Object.entries(phases)) console.log(`   ${name.padEnd(20)} req ${String(p.requests).padStart(5)} ${JSON.stringify(p.byStatus)} p50 ${p.latencyMs.p50} p95 ${p.latencyMs.p95} max ${p.latencyMs.max} | health ${JSON.stringify(p.health)}`);
  console.log(`   recovery ${JSON.stringify(recovery)}`);

  const all = Object.values(phases);
  const ok2xx = (p) => Object.entries(p.byStatus).filter(([k]) => /^2\d\d$/.test(k)).reduce((a, [, n]) => a + n, 0);
  const alive = pid ? await pidAlive(pid) : null;
  L.check('D.api_process_survived', alive === true, `api pid ${pid} alive at the end: ${alive} (it was never restarted)`);
  L.check('D.no_internals_in_any_body', all.every((p) => p.bodiesWithInternals === 0 && p.healthBodiesWithInternals === 0), `error bodies with stack traces / driver messages / hosts: ${all.reduce((a, p) => a + p.bodiesWithInternals + p.healthBodiesWithInternals, 0)} ${JSON.stringify([...new Set(all.flatMap((p) => p.leakKinds))])}`);
  const rejectedWindow = events.filter((e) => e.kind !== 'widget_token' && e.startedAt >= redis.confirmedDownAt && e.t < redis.startedAt);
  const redisChat = rejectedWindow.filter((e) => e.kind !== 'stream');
  const redisStream = rejectedWindow.filter((e) => e.kind === 'stream');
  const redisWindowCounts = { chat: redisChat.length, stream: redisStream.length };
  L.check('D.redis_loss_fails_closed', redisChat.length > 0 && redisChat.every((e) => e.status === '503' && e.sample?.includes('conversation_temporarily_unavailable')) && redisStream.length > 0 && redisStream.every((e) => e.status === '200:turn.error' || e.status === '503'), `Redis down within confirmed window: ${JSON.stringify(redisWindowCounts)}; overall ${JSON.stringify(phases.redis_down.byKind)}`);
  L.check('D.health_degraded_not_down_without_redis', Object.keys(phases.redis_down.health).some((k) => k.startsWith('200/degraded')) && !Object.keys(phases.redis_down.health).some((k) => k.startsWith('503')), JSON.stringify(phases.redis_down.health));
  L.check('D.redis_recovers_without_restart', recovery.redis.healthReportsRedisUpAfterS !== null && recovery.redis.firstCleanWindowAfterS !== null, `health reports redis up ${recovery.redis.healthReportsRedisUpAfterS} s after docker start; error-free window from ${recovery.redis.firstCleanWindowAfterS} s`);
  L.check('D.postgres_loss_reported_as_503', Object.keys(phases.postgres_down.health).some((k) => k.startsWith('503')) && phases.postgres_down.live['200'] > 0 && !phases.postgres_down.live['0'], `ready: ${JSON.stringify(phases.postgres_down.health)}; live: ${JSON.stringify(phases.postgres_down.live)}`);
  L.check('D.postgres_loss_gives_clean_errors', phases.postgres_down.requests > 0 && phases.postgres_down.bodiesWithInternals === 0 && !Object.keys(phases.postgres_down.byStatus).some((k) => k.startsWith('0:')), `Postgres down: ${JSON.stringify(phases.postgres_down.byStatus)}; samples ${JSON.stringify(phases.postgres_down.errorBodySamples.slice(0, 3))}`);
  L.check('D.postgres_recovers_without_restart', recovery.postgres.firstCleanWindowAfterS !== null && ok2xx(phases.tail) === phases.tail.requests && phases.tail.requests > 0, `first health 200 after ${recovery.postgres.firstHealth200AfterS} s, first chat 2xx after ${recovery.postgres.firstChat2xxAfterS} s, error-free from ${recovery.postgres.firstCleanWindowAfterS} s after docker start; tail: ${JSON.stringify(phases.tail.byStatus)}`);

  const result = { ...L.result(), at: new Date().toISOString(), outageSeconds: OUTAGE_S, phases, recovery, redisWindowCounts };
  if (OUT) {
    mkdirSync(path.join(OUT, 'out'), { recursive: true });
    const f = path.join(OUT, 'out', `dependency-loss-${result.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(`result → ${f}`);
  }
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  process.exit(result.failed ? 2 : 0);
}
main().catch(async (e) => {
  console.error(e);
  // Never leave the soak stack's own dependencies stopped.
  await docker('start', REDIS);
  await docker('start', POSTGRES);
  process.exit(1);
});
