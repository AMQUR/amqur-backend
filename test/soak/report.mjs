/**
 * Render a soak run (the .jsonl series written by soak.mjs) as Markdown: the per-minute table
 * and a first-quartile vs last-quartile comparison for every resource series.
 *
 *   node test/soak/report.mjs <SOAK_OUT>/out/soak-<stamp>.jsonl
 */
import { readFileSync } from 'node:fs';
import { trend } from './lib/probe.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/soak/report.mjs <series.jsonl>');
  process.exit(1);
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const minutes = rows.filter((r) => !r.baseline && !r.closing);
const baseline = rows.find((r) => r.baseline);
const closing = rows.find((r) => r.closing);
const mb = (x) => (x == null ? '—' : (x / 1048576).toFixed(0));
const n = (x) => (x == null ? '—' : String(x));
const errs = (r) => Object.values(r.errors ?? {}).reduce((a, x) => a + x, 0);
const backlog = (r) => (r.outbox ? `${r.outbox.PENDING ?? 0}/${r.outbox.PROCESSING ?? 0}/${r.outbox.DEAD ?? 0}` : '—');

console.log('| min | req | err | p50 | p95 | p99 | RSS MB | heap MB | heap after GC MB | loop lag p99 ms | FDs | PG conns | Redis MB / keys | outbox P/X/D | host load |');
console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|');
const line = (label, r) =>
  `| ${label} | ${n(r.requests)} | ${r.requests == null ? '—' : errs(r)} | ${n(r.latencyMs?.p50)} | ${n(r.latencyMs?.p95)} | ${n(r.latencyMs?.p99)} | ${mb(r.rssBytes)} | ${mb(r.heapUsed)} | ${r.heapAfterGc ? mb(r.heapAfterGc) : ''} | ${n(r.eventLoop?.p99Ms)} | ${n(r.fds)} | ${n(r.pgConnections)} | ${r.redisUsedBytes == null ? '—' : (r.redisUsedBytes / 1048576).toFixed(2)} / ${n(r.redisKeys)} | ${backlog(r)} | ${n(r.hostLoad1m)} |`;
if (baseline) console.log(line('start', baseline));
for (const r of minutes) console.log(line(r.minute, r));
if (closing) console.log(line('idle', closing));

const series = {
  'RSS (MB)': [(r) => r.rssBytes, 1048576],
  'heap used (MB)': [(r) => r.heapUsed, 1048576],
  'heap after forced GC (MB)': [(r) => r.heapAfterGc, 1048576],
  'open file descriptors': [(r) => r.fds, 1],
  'Postgres connections': [(r) => r.pgConnections, 1],
  'Redis used memory (MB)': [(r) => r.redisUsedBytes, 1048576],
  'Redis keys': [(r) => r.redisKeys, 1],
  'event-loop lag p99 (ms)': [(r) => r.eventLoop?.p99Ms, 1],
  'outbox PENDING + PROCESSING': [(r) => (r.outbox ? (r.outbox.PENDING ?? 0) + (r.outbox.PROCESSING ?? 0) : null), 1],
  'latency p50 (ms)': [(r) => r.latencyMs?.p50, 1],
  'latency p95 (ms)': [(r) => r.latencyMs?.p95, 1],
  'requests / minute': [(r) => r.requests, 1],
  'host load (1 min)': [(r) => r.hostLoad1m, 1],
  'worker RSS (MB)': [(r) => r.worker?.rssBytes, 1048576],
};
const f = (x, d) => (x == null ? '—' : (x / d).toFixed(d === 1 ? 1 : 1));
console.log('\n| series | samples | first-quartile mean | last-quartile mean | change | slope / sample (whole run) | slope / sample (second half) | min | max |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [name, [get, div]] of Object.entries(series)) {
  // Scale small-valued series so rounding in trend() does not flatten them.
  const scale = div === 1 ? 100 : 1;
  const t = trend(minutes.map((r) => {
    const v = get(r);
    return v == null ? null : v * scale;
  }));
  if (t.note) {
    console.log(`| ${name} | ${t.n} | — | — | — | — | — | — | — |`);
    continue;
  }
  const d = div * scale;
  console.log(`| ${name} | ${t.n} | ${f(t.firstQuartileMean, d)} | ${f(t.lastQuartileMean, d)} | ${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}% | ${(t.slopePerSample / d).toFixed(3)} | ${t.slopeSecondHalfPerSample == null ? '—' : (t.slopeSecondHalfPerSample / d).toFixed(3)} | ${f(t.min, d)} | ${f(t.max, d)} |`);
}
