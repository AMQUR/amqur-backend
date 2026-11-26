/**
 * Soak: sustained mixed shopper traffic against a LOCAL disposable stack, with a per-minute
 * record of latency, errors and resource use. See docs/SOAK_AND_RELIABILITY.md.
 *
 *   SOAK_OUT=/path/outside/the/repo bash test/soak/infra/soak-env.sh node test/soak/soak.mjs
 *
 * Env: SOAK_MINUTES (20) · SOAK_SHOPPERS (12 concurrent shoppers) · SOAK_THINK_MS_MIN/MAX
 * (100/400) · SOAK_SSE_SHARE (0.25) · SOAK_API_PIDFILE or SOAK_API_PID (process to sample) ·
 * SOAK_INSPECT_PORT (Node inspector of that process: heap, event-loop delay) · SOAK_GC_EVERY
 * (force a full GC every N minutes for a post-GC heap series; 0 = never; needs --expose-gc) ·
 * SOAK_MAX_ERROR_RATE (0.01).
 *
 * The engine under test is deterministic (no language-model key). The numbers are a local
 * regression baseline for leaks and correctness, not a production capacity figure.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertLoopback, BASE, ROOFTOPS, GROUP, DEMO, chat, chatStream, card, shopper, leadPayload, leakMarkers,
  pick, sleep, summarize,
} from './lib/client.mjs';
import { Db, Inspector, RedisProbe, pidFromFile, sampleAll, trend } from './lib/probe.mjs';

assertLoopback();
const MINUTES = Number(process.env.SOAK_MINUTES || 20);
const SHOPPERS = Number(process.env.SOAK_SHOPPERS || 12);
const THINK_MIN = Number(process.env.SOAK_THINK_MS_MIN || 100);
const THINK_MAX = Number(process.env.SOAK_THINK_MS_MAX || 400);
const SSE_SHARE = Number(process.env.SOAK_SSE_SHARE || 0.25);
const GC_EVERY = Number(process.env.SOAK_GC_EVERY ?? 5);
const MAX_ERROR_RATE = Number(process.env.SOAK_MAX_ERROR_RATE || 0.01);
const OUT = process.env.SOAK_OUT;
if (!OUT) {
  console.error('Set SOAK_OUT to a scratch directory outside the repository (results and logs go there).');
  process.exit(1);
}
const outDir = path.join(OUT, 'out');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const seriesFile = path.join(outDir, `soak-${stamp}.jsonl`);
const summaryFile = path.join(outDir, `soak-${stamp}.summary.json`);

const apiPid = Number(process.env.SOAK_API_PID) || pidFromFile(process.env.SOAK_API_PIDFILE || path.join(OUT, 'api-a.pid'));
const workerPid = Number(process.env.SOAK_WORKER_PID) || pidFromFile(process.env.SOAK_WORKER_PIDFILE || path.join(OUT, 'worker.pid'));
const inspector = process.env.SOAK_INSPECT_PORT ? new Inspector(Number(process.env.SOAK_INSPECT_PORT)) : null;
const db = new Db();
const redis = new RedisProbe();

const GROUP_VINS = new Set(ROOFTOPS.flatMap((r) => r.vins));
const GROUP_NAMES = ROOFTOPS.map((r) => r.name);
const TENANTS = [...ROOFTOPS.map((t) => ({ ...t, kind: 'rooftop' })), { ...GROUP, kind: 'group' }, { ...DEMO, kind: 'demo' }];
/** Each rooftop gets an equal share; the group site and the demo rooftop a smaller one. */
const TENANT_WEIGHTS = [...ROOFTOPS.map(() => 3), 3, 1];
function pickTenant() {
  let x = Math.random() * TENANT_WEIGHTS.reduce((a, b) => a + b, 0);
  for (let i = 0; i < TENANTS.length; i += 1) {
    x -= TENANT_WEIGHTS[i];
    if (x <= 0) return TENANTS[i];
  }
  return TENANTS[0];
}

// ───────────────────────────────────────────────────────────── recording
const newBucket = () => ({ requests: 0, byStatus: {}, lat: [], sse: 0, conversations: 0 });
let bucket = newBucket();
const totals = { requests: 0, byStatus: {}, lat: [], sse: 0, conversations: 0, scenarios: {}, outcomes: {}, violations: {}, violationSamples: [] };
const bump = (o, k, n = 1) => {
  o[k] = (o[k] || 0) + n;
};
function violation(kind, detail) {
  bump(totals.violations, kind);
  if (totals.violationSamples.length < 40) totals.violationSamples.push({ kind, at: new Date().toISOString(), ...detail });
}
function record(r, { sse }) {
  const key = r.status === 0 ? `0:${r.error || 'transport'}` : String(r.status);
  for (const b of [bucket, totals]) {
    b.requests += 1;
    bump(b.byStatus, key);
    b.lat.push(r.ms);
    if (sse) b.sse += 1;
  }
  if (r.status < 200 || r.status >= 300) {
    const leaks = leakMarkers(r.text);
    if (leaks.length) violation('error_body_leaks_internals', { status: r.status, leaks, body: String(r.text).slice(0, 300) });
  }
}

// ───────────────────────────────────────────────────────────── one conversation
const SEARCH = {
  en: ['Do you have any SUVs?', 'Show me trucks', 'What do you have under $50,000?', 'Any all-wheel drive vehicles in stock?', 'Show me your new inventory'],
  es: ['¿Tienen camionetas?', '¿Qué SUV tienen disponibles?', 'Busco algo por menos de $50,000', '¿Tienen vehículos con tracción total?'],
};
const PAYMENT = {
  en: ['What would the monthly payment be on that with $3000 down for 60 months?', 'What is the payment with $5,000 down over 72 months?'],
  es: ['¿Cuánto sería el pago mensual con $3000 de enganche a 60 meses?', '¿Cuál sería la mensualidad con $5000 de enganche a 72 meses?'],
};
const SERVICE = {
  en: ['I need an oil change and tire rotation', 'It is a 2021 Jeep Grand Cherokee', 'My check engine light is on, can I bring it in?', 'How long does a brake inspection take?'],
  es: ['Necesito un cambio de aceite', 'Es un Jeep Grand Cherokee 2021', 'Tengo encendida la luz del motor, ¿puedo llevarlo?'],
};
const PARTS = {
  en: ['Do you have brake pads for a 2019 Jeep Wrangler?', 'I need wiper blades for a 2020 Chevrolet Equinox', 'Do you sell floor mats for a 2022 Nissan Rogue?'],
  es: ['¿Tienen pastillas de freno para un Jeep Wrangler 2019?', 'Necesito limpiaparabrisas para un Chevrolet Equinox 2020'],
};
const HANDOFF = { en: ['Can I talk to a person?', 'I would like someone to call me'], es: ['Quiero hablar con una persona', '¿Me puede llamar alguien?'] };
const HOURS = { en: ['What are your hours?', 'Are you open on Saturday?'], es: ['¿Cuál es su horario?', '¿Abren los sábados?'] };

let shopperSeq = Number(process.env.SOAK_SHOPPER_SEQ || 1) * 1000;
const think = () => sleep(THINK_MIN + Math.random() * Math.max(0, THINK_MAX - THINK_MIN));

function checkResponse(ctx, data) {
  const t = ctx.tenant;
  if (!data) return;
  if (ctx.conversationId && data.conversationId && data.conversationId !== ctx.conversationId)
    violation('conversation_id_changed', { tenant: t.slug, had: ctx.conversationId.slice(0, 12), got: data.conversationId.slice(0, 12) });
  if (data.conversationId) ctx.conversationId = data.conversationId;
  for (const v of data.vehicles ?? []) {
    const vin = String(v.vin || '');
    if (t.kind === 'rooftop') {
      if (!t.vins.includes(vin)) violation('wrong_tenant_vehicle', { tenant: t.slug, vin });
      if (v.rooftopName && v.rooftopName !== t.name) violation('wrong_rooftop_name', { tenant: t.slug, rooftopName: v.rooftopName });
    } else if (t.kind === 'group') {
      if (!GROUP_VINS.has(vin)) violation('wrong_tenant_vehicle', { tenant: t.slug, vin });
      const owner = ROOFTOPS.find((r) => r.vins.includes(vin));
      if (owner && !(String(v.rooftopName || '').startsWith(owner.name))) violation('wrong_rooftop_name', { tenant: t.slug, vin, rooftopName: v.rooftopName, expected: owner.name });
    } else if (GROUP_VINS.has(vin)) {
      violation('wrong_tenant_vehicle', { tenant: t.slug, vin });
    }
  }
  for (const c of data.cards ?? []) {
    if (!c.rooftopName || !['lead_form', 'appointment_picker', 'appointment'].includes(c.kind)) continue;
    const ok = t.kind === 'group' ? GROUP_NAMES.some((n) => String(c.rooftopName).startsWith(n)) : c.rooftopName === t.name;
    if (!ok) violation('wrong_rooftop_name', { tenant: t.slug, card: c.kind, rooftopName: c.rooftopName });
    if (t.kind === 'group' && ctx.groupVin) {
      const owner = ROOFTOPS.find((r) => r.vins.includes(ctx.groupVin));
      if (owner && !String(c.rooftopName).startsWith(owner.name)) violation('group_card_for_other_rooftop', { vin: ctx.groupVin, card: c.kind, rooftopName: c.rooftopName });
    }
  }
  const appt = card(data, 'appointment');
  if (appt?.outcome === 'confirmed' && appt.verified === true && !/^SBX-/.test(String(appt.providerRef || '')))
    violation('confirmed_without_sandbox_receipt', { tenant: t.slug, providerRef: appt.providerRef ?? null });
}

/** One turn (JSON or SSE), recorded and checked. Returns the chat response or null. */
async function turn(ctx, body) {
  const sse = Math.random() < SSE_SHARE;
  const payload = { language: ctx.lang, ...body, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) };
  const r = sse ? await chatStream(ctx.tenant, payload) : await chat(ctx.tenant, payload);
  record(r, { sse });
  if (sse && r.status === 200) {
    if (r.streamError) {
      bump(totals.outcomes, 'sse_turn_error');
      const leaks = leakMarkers(JSON.stringify(r.streamError));
      if (leaks.length) violation('error_body_leaks_internals', { status: 'turn.error', leaks });
    } else if (!r.data) violation('sse_without_turn_completed', { tenant: ctx.tenant.slug, events: (r.events ?? []).map((e) => e.type) });
    else {
      const started = r.events.find((e) => e.type === 'turn.started');
      if (started?.conversationId && started.conversationId !== r.data.conversationId) violation('sse_conversation_id_mismatch', { tenant: ctx.tenant.slug });
    }
  }
  if (!r.data) return null;
  checkResponse(ctx, r.data);
  ctx.turns += 1;
  return r.data;
}

/** Answer the structured cards the engine offers: lead form (with consent), then a slot. */
async function followCards(ctx, data) {
  for (let i = 0; i < 3 && data; i += 1) {
    const form = card(data, 'lead_form');
    if (form && ctx.submitLead && !ctx.forms.has(form.id)) {
      ctx.forms.add(form.id);
      await think();
      const withPhone = ctx.n % 3 === 0;
      const lead = leadPayload(form.id, ctx.who, withPhone ? {} : { phone: undefined, consents: [{ channel: 'EMAIL', granted: true, version: form.consent?.version ?? 'lead-form-consent-v1' }] });
      data = await turn(ctx, { action: 'lead_capture', lead });
      bump(totals.outcomes, data && !card(data, 'lead_form') ? 'lead_form_accepted' : 'lead_form_not_accepted');
      continue;
    }
    const picker = card(data, 'appointment_picker');
    if (picker && ctx.bookSlot && !ctx.pickers.has(picker.id)) {
      ctx.pickers.add(picker.id);
      await think();
      let appointment;
      if (picker.mode === 'provider_slots' && picker.slots?.length) appointment = { pickerId: picker.id, slotId: pick(picker.slots).id };
      else if (picker.days?.length) {
        const d = pick(picker.days);
        appointment = { pickerId: picker.id, requestedDate: typeof d === 'string' ? d : d.date, requestedWindow: pick(['morning', 'afternoon', 'evening']) };
      } else break;
      data = await turn(ctx, { action: 'appointment_select', appointment });
      const appt = data && card(data, 'appointment');
      if (appt?.outcome === 'confirmed') bump(totals.outcomes, 'slot_confirmed');
      else if (appt?.outcome === 'requested') bump(totals.outcomes, 'appointment_requested');
      else if (data && /nothing (new )?was booked|no se reserv/i.test(data.reply || '')) bump(totals.outcomes, 'slot_not_booked_told');
      else bump(totals.outcomes, 'slot_other');
      continue;
    }
    break;
  }
  return data;
}

const say = (ctx, bank) => pick(bank[ctx.lang]);
const SCENARIOS = {
  /** Search, then a payment illustration on a vehicle. */
  async browse_payment(ctx) {
    const found = await turn(ctx, { message: say(ctx, SEARCH) });
    await think();
    const vin = found?.vehicles?.[0]?.vin ?? (ctx.tenant.vins ? pick(ctx.tenant.vins) : undefined);
    if (vin) await turn(ctx, { action: 'vehicle_detail', vin });
    await think();
    await turn(ctx, { message: say(ctx, PAYMENT) });
    if (Math.random() < 0.4) {
      await think();
      await turn(ctx, { message: say(ctx, HOURS) });
    }
  },
  /** Test drive on a vehicle: lead form with consent, then a slot on the sandbox scheduler. */
  async test_drive(ctx) {
    ctx.submitLead = true;
    ctx.bookSlot = true;
    let data = await turn(ctx, { message: say(ctx, SEARCH) });
    await think();
    const vin = data?.vehicles?.[0]?.vin ?? pick(ctx.tenant.vins ?? ['DEMOCP25LTOOOOO06']);
    data = await turn(ctx, { action: 'test_drive', vin });
    data = await followCards(ctx, data);
    await think();
    await turn(ctx, { message: say(ctx, PAYMENT) });
  },
  async service(ctx) {
    ctx.submitLead = Math.random() < 0.5;
    for (const m of SERVICE[ctx.lang].slice(0, 2 + Math.floor(Math.random() * 2))) {
      const data = await turn(ctx, { message: m });
      await followCards(ctx, data);
      await think();
    }
  },
  async parts(ctx) {
    await turn(ctx, { message: say(ctx, PARTS) });
    await think();
    await turn(ctx, { message: say(ctx, HOURS) });
  },
  async handoff(ctx) {
    ctx.submitLead = true;
    await turn(ctx, { message: say(ctx, SEARCH) });
    await think();
    const data = await turn(ctx, { message: say(ctx, HANDOFF) });
    if (data && card(data, 'handoff')) bump(totals.outcomes, 'handoff_card');
    await followCards(ctx, data);
  },
  /** Group site: search every store, choose a vehicle, continue at the rooftop that holds it. */
  async group_shop(ctx) {
    ctx.submitLead = true;
    ctx.bookSlot = true;
    let data = await turn(ctx, { message: pick(ctx.lang === 'es' ? ['¿Tienen un Grand Cherokee?', '¿Tienen camionetas?', '¿Qué SUV tienen?'] : ['Do you have a Grand Cherokee?', 'Show me trucks', 'Do you have a Rogue?', 'Any SUVs in stock?']) });
    if (data && !data.vehicles?.length && data.quickReplies?.length) {
      await think();
      const q = pick(data.quickReplies);
      data = await turn(ctx, { message: typeof q === 'string' ? q : (q.label ?? q.text ?? 'Either') });
    }
    const v = data?.vehicles?.length ? pick(data.vehicles) : null;
    if (!v) return;
    await think();
    ctx.groupVin = v.vin;
    data = await turn(ctx, { action: 'test_drive', vin: v.vin, ...(v.rooftopRef ? { rooftopRef: v.rooftopRef } : {}) });
    data = await followCards(ctx, data);
    await think();
    await turn(ctx, { message: say(ctx, HANDOFF) });
  },
};
const ROOFTOP_MIX = [['test_drive', 30], ['browse_payment', 30], ['service', 15], ['parts', 10], ['handoff', 15]];
function pickScenario(t) {
  if (t.kind === 'group') return Math.random() < 0.7 ? 'group_shop' : 'browse_payment';
  let x = Math.random() * 100;
  for (const [name, w] of ROOFTOP_MIX) {
    x -= w;
    if (x <= 0) return name;
  }
  return 'browse_payment';
}

let stop = false;
async function shopperLoop() {
  while (!stop) {
    const tenant = pickTenant();
    const scenario = pickScenario(tenant);
    shopperSeq += 1;
    const ctx = { tenant, lang: Math.random() < 0.3 ? 'es' : 'en', n: shopperSeq, who: shopper(shopperSeq, 'soak'), forms: new Set(), pickers: new Set(), turns: 0 };
    bump(totals.scenarios, scenario);
    bucket.conversations += 1;
    totals.conversations += 1;
    try {
      await SCENARIOS[scenario](ctx);
    } catch (e) {
      violation('harness_exception', { scenario, message: e instanceof Error ? e.message : 'error' });
    }
    await think();
  }
}

// ───────────────────────────────────────────────────────────── per-minute series
const series = [];
async function minuteTick(minute) {
  const b = bucket;
  bucket = newBucket();
  const forceGc = GC_EVERY > 0 && minute % GC_EVERY === 0;
  const res = await sampleAll({ pid: apiPid, workerPid, inspector, db, redis, forceGc });
  const errors = Object.fromEntries(Object.entries(b.byStatus).filter(([k]) => !/^2\d\d$/.test(k)));
  const row = {
    minute,
    at: new Date().toISOString(),
    requests: b.requests,
    conversations: b.conversations,
    sse: b.sse,
    byStatus: b.byStatus,
    errors,
    latencyMs: summarize(b.lat),
    ...res,
  };
  series.push(row);
  appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
  const mb = (x) => (x == null ? '—' : (x / 1048576).toFixed(0));
  const ob = res.outbox ?? {};
  console.log(
    `min ${String(minute).padStart(2)} | req ${b.requests} err ${Object.values(errors).reduce((a, x) => a + x, 0)} | p50 ${row.latencyMs.p50} p95 ${row.latencyMs.p95} p99 ${row.latencyMs.p99} ms | rss ${mb(res.rssBytes)}MB heap ${mb(res.heapUsed)}MB${res.heapAfterGc ? ` (gc ${mb(res.heapAfterGc)}MB)` : ''} | eld p99 ${res.eventLoop?.p99Ms ?? '—'}ms | load ${res.hostLoad1m} cpu ${res.cpuPct ?? '—'}% | fds ${res.fds ?? '—'} | pg ${res.pgConnections ?? '—'} | redis ${mb(res.redisUsedBytes)}MB/${res.redisKeys ?? '—'}k | outbox P${ob.PENDING ?? 0}/X${ob.PROCESSING ?? 0}/D${ob.DEAD ?? 0}${res.worker ? ` | worker rss ${mb(res.worker.rssBytes)}MB fds ${res.worker.fds ?? '—'}` : ''}`,
  );
}

async function main() {
  console.log(`soak: ${MINUTES} min, ${SHOPPERS} concurrent shoppers, think ${THINK_MIN}-${THINK_MAX} ms, SSE share ${SSE_SHARE}, target ${BASE}, api pid ${apiPid ?? 'unknown'}`);
  console.log(`series → ${seriesFile}`);
  const startedAt = Date.now();
  const baseline = await sampleAll({ pid: apiPid, workerPid, inspector, db, redis, forceGc: GC_EVERY > 0 });
  appendFileSync(seriesFile, `${JSON.stringify({ minute: 0, at: new Date().toISOString(), baseline: true, ...baseline })}\n`);
  const loops = Array.from({ length: SHOPPERS }, () => shopperLoop());
  for (let minute = 1; minute <= MINUTES; minute += 1) {
    const target = startedAt + minute * 60_000;
    await sleep(Math.max(0, target - Date.now()));
    await minuteTick(minute);
  }
  stop = true;
  await Promise.all(loops);
  const endedAt = Date.now();

  // Let the outbox drain before the closing sample (its tick runs every 10 s).
  let drained = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(5000);
    const o = await db.groupCounts('OutboxEvent');
    if (o && !o.PENDING && !o.PROCESSING) {
      drained = (i + 1) * 5;
      break;
    }
  }
  const closing = await sampleAll({ pid: apiPid, workerPid, inspector, db, redis, forceGc: GC_EVERY > 0 });
  const liveObjects = inspector ? await inspector.liveObjects() : null;
  appendFileSync(seriesFile, `${JSON.stringify({ minute: MINUTES + 1, at: new Date().toISOString(), closing: true, drainedAfterS: drained, liveObjects, ...closing })}\n`);

  const errorCount = Object.entries(totals.byStatus).filter(([k]) => !/^2\d\d$/.test(k)).reduce((a, [, n]) => a + n, 0);
  const col = (f) => series.map(f);
  const summary = {
    engine: 'deterministic (no language-model key configured) — not a production capacity figure',
    target: BASE,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMinutes: Math.round(((endedAt - startedAt) / 60000) * 10) / 10,
    shoppers: SHOPPERS,
    thinkMs: [THINK_MIN, THINK_MAX],
    sseShare: SSE_SHARE,
    requests: totals.requests,
    requestsPerSecond: Math.round((totals.requests / ((endedAt - startedAt) / 1000)) * 10) / 10,
    conversations: totals.conversations,
    sseRequests: totals.sse,
    byStatus: totals.byStatus,
    errorCount,
    errorRate: totals.requests ? errorCount / totals.requests : 1,
    latencyMs: summarize(totals.lat),
    scenarios: totals.scenarios,
    outcomes: totals.outcomes,
    violations: totals.violations,
    violationSamples: totals.violationSamples,
    trends: {
      rssBytes: trend(col((r) => r.rssBytes)),
      workerRssBytes: trend(col((r) => r.worker?.rssBytes)),
      workerFds: trend(col((r) => r.worker?.fds)),
      smtpAccepted: trend(col((r) => r.smtpAccepted)),
      heapUsed: trend(col((r) => r.heapUsed)),
      heapAfterGc: trend(col((r) => r.heapAfterGc)),
      fds: trend(col((r) => r.fds)),
      pgConnections: trend(col((r) => r.pgConnections)),
      redisUsedBytes: trend(col((r) => r.redisUsedBytes)),
      redisKeys: trend(col((r) => r.redisKeys)),
      eventLoopP99Ms: trend(col((r) => r.eventLoop?.p99Ms)),
      latencyP50Ms: trend(col((r) => r.latencyMs.p50)),
      latencyP95Ms: trend(col((r) => r.latencyMs.p95)),
      requestsPerMinute: trend(col((r) => r.requests)),
      hostLoad1m: trend(col((r) => (r.hostLoad1m == null ? null : r.hostLoad1m * 100))),
      apiCpuPct: trend(col((r) => r.cpuPct)),
      outboxPending: trend(col((r) => (r.outbox ? (r.outbox.PENDING ?? 0) + (r.outbox.PROCESSING ?? 0) : null))),
    },
    baseline,
    closing: { ...closing, outboxDrainedAfterS: drained, liveObjects },
    seriesFile,
  };
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, violationSamples: summary.violationSamples.slice(0, 5), baseline: undefined, closing: undefined }, null, 2));
  console.log(`summary → ${summaryFile}`);
  inspector?.close();
  redis.close();
  await db.close();
  const violations = Object.values(totals.violations).reduce((a, n) => a + n, 0);
  process.exit(summary.errorRate > MAX_ERROR_RATE || violations > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
