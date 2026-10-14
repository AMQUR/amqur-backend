/**
 * Full-chat, multi-store load profile against the LOCAL disposable API (never production).
 * Each virtual shopper runs a realistic multi-turn conversation (search → select → payment →
 * OTD → service) on one of several simulated stores, concurrently.
 *
 *   PROFILE=FIVE_STORE node scripts/load-chat-multistore.mjs
 *
 * Reports per-turn latency percentiles, error rate and throughput. LLM disabled unless the
 * API was started with a provider key — the report states which.
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const ORIGIN = process.env.LOAD_ORIGIN || 'http://127.0.0.1:18084';
const STORES = (process.env.LOAD_STORES || 'iso-south,iso-north,iso-chevy,iso-nissan,iso-infiniti,sim-motors').split(',');
const PROFILES = {
  ONE_STORE: { sessions: 25, stores: 1, rampMs: 2000 },
  FIVE_STORE: { sessions: 100, stores: 6, rampMs: 4000 },
  BURST: { sessions: 300, stores: 6, rampMs: 1500 },
  SOAK_LIGHT: { sessions: 60, stores: 6, rampMs: 30000, rounds: 5 },
};
const PROFILE = process.env.PROFILE || 'FIVE_STORE';
const cfg = PROFILES[PROFILE];
if (!cfg) throw new Error(`unknown PROFILE ${PROFILE}`);

const SCRIPTS = [
  ['Hi', 'Show me Wranglers', 'what would it be a month', '5k down', "what's the out the door price", 'can I schedule an oil change saturday at 10am'],
  ['Do you have a Compass?', 'how much per month', 'I am paying cash', 'thanks'],
  ['I need brake pads for my 2019 cherokee', 'my brakes are squeaking can you look at it friday at 9am', 'thanks'],
  ['hey', 'how are you', 'just looking around', 'what time do you close'],
  ['Show me Tahoes', 'Any Rogues?', 'show me the QX60', 'Can I talk to a person?'],
];

const lat = [];
let errors = 0;
let turns = 0;
const statusCounts = {};

async function token(store) {
  const r = await fetch(`${BASE}/public/widget-token`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ tenantSlug: store, locationSlug: 'main' }) });
  const j = await r.json();
  return j.data?.token ?? j.token;
}

async function shopper(i, tokens) {
  const store = STORES[i % Math.min(cfg.stores, STORES.length)];
  const tok = tokens[store];
  const script = SCRIPTS[i % SCRIPTS.length];
  let cid;
  for (const message of script) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${BASE}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN, authorization: `Bearer ${tok}` }, body: JSON.stringify({ message, conversationId: cid }) });
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      const j = await r.json();
      if (r.status >= 300) errors += 1;
      cid = j.data?.conversationId ?? cid;
    } catch {
      errors += 1;
    }
    lat.push(performance.now() - t0);
    turns += 1;
    // human-ish think time 300–1200 ms
    await new Promise((res) => setTimeout(res, 300 + Math.random() * 900));
  }
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

const tokens = {};
for (const s of STORES) tokens[s] = await token(s);
const started = performance.now();
const rounds = cfg.rounds ?? 1;
for (let round = 0; round < rounds; round += 1) {
  const runs = [];
  for (let i = 0; i < cfg.sessions; i += 1) {
    await new Promise((res) => setTimeout(res, cfg.rampMs / cfg.sessions));
    runs.push(shopper(i + round * cfg.sessions, tokens));
  }
  await Promise.all(runs);
}
const secs = (performance.now() - started) / 1000;
const mem = await fetch(`${BASE}/public/health`).then((r) => r.ok).catch(() => false);
console.log(
  JSON.stringify(
    {
      profile: PROFILE,
      sessions: cfg.sessions * rounds,
      stores: Math.min(cfg.stores, STORES.length),
      turns,
      errors,
      errorRate: Number((errors / Math.max(1, turns)).toFixed(4)),
      statusCounts,
      durationS: Number(secs.toFixed(1)),
      turnsPerSec: Number((turns / secs).toFixed(1)),
      latencyMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(Math.max(...lat)) },
      apiHealthyAfter: mem,
    },
    null,
    2,
  ),
);
