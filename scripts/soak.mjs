/**
 * Soak test ≥30 min against local disposable API.
 * Usage: SOAK_MINUTES=30 BASE_URL=http://127.0.0.1:3001/api node scripts/soak.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3001/api').replace(
  /\/$/,
  '',
);
const MINUTES = Number(process.env.SOAK_MINUTES || 30);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY || 5);

async function tick() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      ms: Date.now() - t0,
      status: res.status,
      mem: process.memoryUsage(),
      ready: body?.data?.ok ?? body?.ok,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      status: 0,
      mem: process.memoryUsage(),
      error: e instanceof Error ? e.message : 'err',
    };
  }
}

async function main() {
  const started = Date.now();
  const end = started + MINUTES * 60 * 1000;
  const points = [];
  let total = 0;
  let fail = 0;

  console.log(
    `Soak start ${new Date().toISOString()} minutes=${MINUTES} base=${BASE}`,
  );

  while (Date.now() < end) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => tick()),
    );
    for (const r of batch) {
      total += 1;
      if (!r.ok) fail += 1;
    }
    const sample = batch[0];
    points.push({
      t: new Date().toISOString(),
      ok: sample.ok,
      ms: sample.ms,
      rss: sample.mem.rss,
      heapUsed: sample.mem.heapUsed,
      external: sample.mem.external,
    });
    // sample every ~5s
    await new Promise((r) => setTimeout(r, 5000));
  }

  const report = {
    started: new Date(started).toISOString(),
    ended: new Date().toISOString(),
    durationMin: MINUTES,
    concurrency: CONCURRENCY,
    total,
    fail,
    errorRate: total ? fail / total : 1,
    points,
    note: 'Local soak against disposable stack — staging soak not available in this run unless BASE_URL overridden.',
  };

  const outDir = path.resolve('test/evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `soak-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { ...report, points: `[${points.length} samples]` },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outFile}`);
  if (report.errorRate > 0.02) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
