/**
 * Paced load profiles against local disposable API (never production).
 * Open-loop hammering is intentionally rejected by rate limits — this harness
 * targets sustainable RPS under the test throttle ceiling.
 *
 * Profiles: SMOKE, EXPECTED_PILOT, BURST_2X, BURST_10X
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3001/api').replace(
  /\/$/,
  '',
);
const PROFILE = process.env.PROFILE || 'SMOKE';
const ORIGIN = process.env.LOAD_ORIGIN || 'http://127.0.0.1:18084';
const TENANT = process.env.LOAD_TENANT || 'pilot-alpha';
const LOCATION = process.env.LOAD_LOCATION || 'main';
/** When true, empty allowedOrigins → widget-token 403 is success (fail-closed canary). */
const EXPECT_TOKEN_FORBIDDEN = process.env.EXPECT_TOKEN_FORBIDDEN === '1';

/** durationSec, targetRps, workers */
const PROFILES = {
  SMOKE: { durationSec: 20, rps: 15, workers: 5 },
  EXPECTED_PILOT: { durationSec: 45, rps: 40, workers: 10 },
  /**
   * Staging canary: global Nest throttle is ~120/min in production NODE_ENV.
   * Stay well under that so 429s are not counted as platform faults.
   */
  STAGING_CANARY: { durationSec: 60, rps: 1.5, workers: 2 },
  BURST_2X: { durationSec: 30, rps: 80, workers: 20 },
  BURST_10X: { durationSec: 20, rps: 200, workers: 40 },
};

const cfg = PROFILES[PROFILE] || PROFILES.SMOKE;

async function requestNamed(name, fn, acceptStatuses = null) {
  const t0 = Date.now();
  try {
    const res = await fn();
    const ok = acceptStatuses ? acceptStatuses.includes(res.status) : res.ok;
    return { name, ok, status: res.status, ms: Date.now() - t0 };
  } catch {
    return { name, ok: false, status: 0, ms: Date.now() - t0 };
  }
}

async function oneCycle() {
  const out = [];
  out.push(await requestNamed('health', () => fetch(`${BASE}/health/live`)));
  out.push(
    await requestNamed('widget-config', () =>
      fetch(
        `${BASE}/public/widget-config?tenantSlug=${encodeURIComponent(TENANT)}&locationSlug=${encodeURIComponent(LOCATION)}`,
      ),
    ),
  );
  const tok = await requestNamed(
    'widget-token',
    () =>
      fetch(`${BASE}/public/widget-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ tenantSlug: TENANT, locationSlug: LOCATION }),
      }),
    EXPECT_TOKEN_FORBIDDEN ? [200, 201, 403] : [200, 201],
  );
  out.push(tok);
  let token = null;
  if (tok.ok && tok.status !== 403) {
    try {
      const res = await fetch(`${BASE}/public/widget-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ tenantSlug: TENANT, locationSlug: LOCATION }),
      });
      const body = await res.json();
      token = body?.data?.token || body?.token;
    } catch {
      token = null;
    }
  }
  if (token) {
    out.push(
      await requestNamed('chat', () =>
        fetch(`${BASE}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message: 'hello',
            conversationId: `load-${Math.random().toString(16).slice(2)}`,
          }),
        }),
      ),
    );
    out.push(
      await requestNamed('handoff', () =>
        fetch(`${BASE}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message: 'I need to talk to a human',
            conversationId: `load-h-${Math.random().toString(16).slice(2)}`,
          }),
        }),
      ),
    );
  }
  return out;
}

async function main() {
  const started = new Date().toISOString();
  const end = Date.now() + cfg.durationSec * 1000;
  const intervalMs = Math.max(1, Math.floor(1000 / cfg.rps));
  let total = 0;
  let ok = 0;
  let fail = 0;
  let sumMs = 0;
  const samples = [];
  const byName = {};

  async function worker(id) {
    // stagger workers
    await new Promise((r) => setTimeout(r, (id * intervalMs) / cfg.workers));
    while (Date.now() < end) {
      const tickStart = Date.now();
      const batch = await oneCycle();
      for (const r of batch) {
        total += 1;
        sumMs += r.ms;
        samples.push(r.ms);
        byName[r.name] = byName[r.name] || { ok: 0, fail: 0, sumMs: 0, n: 0 };
        byName[r.name].n += 1;
        byName[r.name].sumMs += r.ms;
        if (r.ok) {
          ok += 1;
          byName[r.name].ok += 1;
        } else {
          fail += 1;
          byName[r.name].fail += 1;
        }
      }
      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, intervalMs * cfg.workers - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  await Promise.all(Array.from({ length: cfg.workers }, (_, i) => worker(i)));

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] || 0;
  const p99 = samples[Math.floor(samples.length * 0.99)] || 0;
  const errorRate = total ? fail / total : 1;
  // Acceptance: under paced pilot load, error rate ≤1% and p95 ≤2s
  const gateProfiles = new Set(['SMOKE', 'EXPECTED_PILOT', 'STAGING_CANARY']);
  const passed = errorRate <= 0.01 && p95 <= 2000 && total > 0;
  const report = {
    profile: PROFILE,
    base: BASE,
    expectTokenForbidden: EXPECT_TOKEN_FORBIDDEN,
    started,
    ended: new Date().toISOString(),
    durationSec: cfg.durationSec,
    targetRps: cfg.rps,
    workers: cfg.workers,
    total,
    ok,
    fail,
    errorRate,
    avgMs: total ? Math.round(sumMs / total) : 0,
    p95Ms: p95,
    p99Ms: p99,
    achievedRps: Math.round(total / cfg.durationSec),
    byName,
    acceptance: {
      errorRateMax: 0.01,
      p95MaxMs: 2000,
      passed,
      note: PROFILE.startsWith('BURST')
        ? 'Burst profiles may intentionally exceed rate limits; pass criteria apply to SMOKE/EXPECTED_PILOT primarily.'
        : EXPECT_TOKEN_FORBIDDEN
          ? 'Staging canary: widget-token 403 counted OK (fail-closed origins).'
          : 'Paced load under test throttle ceiling.',
    },
  };

  const outDir = path.resolve('test/evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `load-${PROFILE}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, `load-${PROFILE}-latest.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outFile}`);
  if (!passed && gateProfiles.has(PROFILE)) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
