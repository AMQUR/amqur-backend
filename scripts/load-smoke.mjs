/**
 * Lightweight local soak/load smoke (autocannon-style via fetch loop).
 * Does NOT hit production. Point at local/staging only.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000/api DURATION_SEC=10 CONCURRENCY=10 node scripts/load-smoke.js
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000/api').replace(
  /\/$/,
  '',
);
const DURATION_SEC = Number(process.env.DURATION_SEC || 10);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);

async function one() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/health/live`);
    return { ok: res.ok, ms: Date.now() - t0, status: res.status };
  } catch {
    return { ok: false, ms: Date.now() - t0, status: 0 };
  }
}

async function main() {
  const end = Date.now() + DURATION_SEC * 1000;
  let total = 0;
  let ok = 0;
  let fail = 0;
  let sumMs = 0;

  async function worker() {
    while (Date.now() < end) {
      const r = await one();
      total += 1;
      sumMs += r.ms;
      if (r.ok) ok += 1;
      else fail += 1;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(
    JSON.stringify(
      {
        base: BASE,
        durationSec: DURATION_SEC,
        concurrency: CONCURRENCY,
        total,
        ok,
        fail,
        avgMs: total ? Math.round(sumMs / total) : 0,
        rps: Math.round(total / DURATION_SEC),
      },
      null,
      2,
    ),
  );
  if (fail > total * 0.01) process.exit(2);
}

main();
