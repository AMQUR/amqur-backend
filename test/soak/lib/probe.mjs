/**
 * Resource probes for the soak harness: the API process (ps / lsof / Node inspector), Postgres
 * (Prisma, already a dependency), Redis (ioredis, already a dependency) and the mock SMTP.
 * Every probe returns null fields instead of throwing, so a stopped dependency shows up as a
 * gap in the series, not as a harness crash.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { request, SMTP_API } from './client.mjs';

const require = createRequire(import.meta.url);

const sh = (cmd, args, timeout = 8000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
const withTimeout = (p, ms, fallback = null) =>
  Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms).unref())]);

export function pidFromFile(file) {
  if (!file || !existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
export async function pidAlive(pid) {
  return !!(await sh('ps', ['-p', String(pid), '-o', 'pid=']))?.trim();
}

/** RSS (bytes), %CPU and open file descriptors of a process, from `ps` and `lsof`. */
export async function processStats(pid, { postgresPort } = {}) {
  if (!pid) return { rssBytes: null, cpuPct: null, fds: null, postgresFds: null };
  const ps = await sh('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)]);
  const [rssKb, cpu] = (ps ?? '').trim().split(/\s+/);
  // -a ANDs the selections; without -n/-P lsof resolves names and is slow.
  const lsof = await sh('lsof', ['-a', '-n', '-P', '-p', String(pid)], 15000);
  const lines = lsof ? lsof.trim().split('\n').slice(1) : null;
  const numeric = lines ? lines.filter((l) => /^\S+\s+\d+\s+\S+\s+\d+[a-zA-Z]*\s/.test(l)) : null;
  const tcp = numeric?.filter((line) => /\sTCP\s/.test(line));
  const postgresFds = postgresPort
    ? tcp?.filter((line) => line.endsWith(`->127.0.0.1:${postgresPort} (ESTABLISHED)`)).length
    : null;
  return {
    rssBytes: rssKb ? Number(rssKb) * 1024 : null,
    cpuPct: cpu ? Number(cpu) : null,
    fds: numeric ? numeric.length : null,
    tcpFds: tcp?.length ?? null,
    postgresFds: postgresFds ?? null,
  };
}

/**
 * Node inspector client (start the API with `--inspect=127.0.0.1:<port> --expose-gc`).
 * Gives heap, event-loop delay and live object counts without touching application code.
 */
export class Inspector {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }
  async connect() {
    if (!this.port) return false;
    if (this.ws && this.ws.readyState === 1) return true;
    const list = await request('GET', `http://127.0.0.1:${this.port}/json/list`, { timeoutMs: 2000, useAgent: false });
    const url = list.body?.[0]?.webSocketDebuggerUrl;
    if (!url) return false;
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const fail = () => {
        for (const p of this.pending.values()) p(null);
        this.pending.clear();
        if (this.ws === ws) this.ws = null;
        resolve(false);
      };
      ws.addEventListener('open', () => {
        this.ws = ws;
        resolve(true);
      });
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p(m.error ? null : m.result);
        }
      });
      ws.addEventListener('close', fail);
      ws.addEventListener('error', fail);
    });
  }
  async send(method, params = {}, timeoutMs = 20000) {
    if (!(await this.connect())) return null;
    const id = ++this.seq;
    return withTimeout(
      new Promise((resolve) => {
        this.pending.set(id, resolve);
        this.ws.send(JSON.stringify({ id, method, params }));
      }),
      timeoutMs,
    );
  }
  async evalJson(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true });
    const v = r?.result?.value;
    if (typeof v !== 'string') return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  /** Heap / event-loop delay since the previous call / active libuv resources. */
  runtimeStats() {
    return this.evalJson(`(() => {
      const g = globalThis;
      if (!g.__soakEld) { g.__soakEld = require('node:perf_hooks').monitorEventLoopDelay({ resolution: 10 }); g.__soakEld.enable(); }
      const h = g.__soakEld, m = process.memoryUsage();
      // The histogram measures a 10 ms timer, so an idle loop reads ~10 ms: report the lag beyond it.
      const lag = (ns) => +Math.max(0, ns / 1e6 - 10).toFixed(2);
      const eld = h.count ? { meanMs: lag(h.mean), p99Ms: lag(h.percentile(99)), maxMs: lag(h.max) } : null;
      h.reset();
      const res = {};
      for (const r of process.getActiveResourcesInfo()) res[r] = (res[r] || 0) + 1;
      return JSON.stringify({ pid: process.pid, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, eld, res, uptimeS: Math.round(process.uptime()) });
    })()`);
  }
  /** Full GC (needs --expose-gc). Returns heapUsed after collection, or null. */
  async gc() {
    const r = await this.evalJson(`(() => { if (typeof gc !== 'function') return JSON.stringify(null); gc(); gc(); return JSON.stringify(process.memoryUsage().heapUsed); })()`);
    return typeof r === 'number' ? r : null;
  }
  /** Live (post-GC) instance count of the class whose prototype `protoExpr` evaluates to. */
  async countInstances(protoExpr) {
    const proto = await this.send('Runtime.evaluate', { expression: protoExpr, includeCommandLineAPI: true, objectGroup: 'soak' });
    const pid = proto?.result?.objectId;
    if (!pid) return null;
    const q = await this.send('Runtime.queryObjects', { prototypeObjectId: pid, objectGroup: 'soak' }, 60000);
    const arr = q?.objects?.objectId;
    if (!arr) return null;
    const len = await this.send('Runtime.callFunctionOn', { objectId: arr, functionDeclaration: 'function(){return this.length}', returnByValue: true });
    await this.send('Runtime.releaseObjectGroup', { objectGroup: 'soak' });
    return typeof len?.result?.value === 'number' ? len.result.value : null;
  }
  /** Counts that show a leaked stream handler: timers, HTTP responses/requests, sockets. */
  async liveObjects() {
    return {
      // The probe's own setTimeout is cleared at once, so it does not stay in the count.
      timeouts: await this.countInstances(`(() => { const t = setTimeout(() => {}, 1); clearTimeout(t); return Object.getPrototypeOf(t); })()`),
      serverResponses: await this.countInstances(`require('node:http').ServerResponse.prototype`),
      incomingMessages: await this.countInstances(`require('node:http').IncomingMessage.prototype`),
      sockets: await this.countInstances(`require('node:net').Socket.prototype`),
    };
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Postgres probe over Prisma with its own single connection (excluded from the counts). */
export class Db {
  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error('DATABASE_URL is not set (source test/soak/infra/soak-env.sh)');
    const port = process.env.SOAK_PG_PORT || '57432';
    if (!url.includes(`@127.0.0.1:${port}/`)) {
      console.error(`Refusing: DATABASE_URL is not the soak Postgres on 127.0.0.1:${port}.`);
      process.exit(1);
    }
    const { PrismaClient } = require('@prisma/client');
    const sep = url.includes('?') ? '&' : '?';
    this.prisma = new PrismaClient({
      datasources: { db: { url: `${url}${sep}connection_limit=1&connect_timeout=3&pool_timeout=3&application_name=soak-probe` } },
      log: [],
    });
  }
  /** Raw query; resolves null when the database is unreachable or slow. */
  q(sql, ...params) {
    return withTimeout(this.prisma.$queryRawUnsafe(sql, ...params), 6000);
  }
  async one(sql, ...params) {
    const rows = await this.q(sql, ...params);
    return rows?.[0] ?? null;
  }
  async groupCounts(table, column = 'status', where = '') {
    const rows = await this.q(`SELECT "${column}"::text AS k, COUNT(*)::int AS n FROM "${table}" ${where} GROUP BY 1`);
    return rows ? Object.fromEntries(rows.map((r) => [r.k, r.n])) : null;
  }
  async sample() {
    const conns = await this.one(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE state = 'active')::int AS active, COUNT(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx
         FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    const rows = await this.one(
      `SELECT (SELECT COUNT(*)::int FROM "Conversation") AS conversations, (SELECT COUNT(*)::int FROM "Message") AS messages,
              (SELECT COUNT(*)::int FROM "Lead") AS leads, (SELECT COUNT(*)::int FROM "Appointment") AS appointments,
              pg_database_size(current_database())::bigint AS db_bytes`,
    );
    return {
      pgConnections: conns?.total ?? null,
      pgActive: conns?.active ?? null,
      pgIdleInTx: conns?.idle_in_tx ?? null,
      outbox: await this.groupCounts('OutboxEvent'),
      deliveries: await this.groupCounts('LeadDelivery'),
      rows: rows ? { ...rows, db_bytes: Number(rows.db_bytes) } : null,
    };
  }
  close() {
    return this.prisma.$disconnect().catch(() => {});
  }
}

/** Redis probe: used memory and key count. */
export class RedisProbe {
  constructor(url = process.env.REDIS_URL) {
    const Redis = require('ioredis');
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      retryStrategy: (n) => Math.min(2000, 200 * n),
    });
    this.client.on('error', () => {});
  }
  async sample() {
    const info = await withTimeout(this.client.info('memory'), 2500);
    const keys = await withTimeout(this.client.dbsize(), 2500);
    const used = info ? Number(/used_memory:(\d+)/.exec(info)?.[1]) : null;
    return { redisUsedBytes: Number.isFinite(used) ? used : null, redisKeys: typeof keys === 'number' ? keys : null };
  }
  close() {
    this.client.disconnect();
  }
}

/** Mock SMTP inspection API (test-infra/mocks/mock-smtp.mjs). */
export const smtp = {
  async health() {
    return (await request('GET', `${SMTP_API}/health`, { timeoutMs: 3000, useAgent: false })).body ?? null;
  },
  async mode(mode, extra = {}) {
    const r = await request('POST', `${SMTP_API}/mode`, { body: { mode, ...extra }, timeoutMs: 3000, useAgent: false });
    if (r.status !== 200) throw new Error(`mock-smtp mode ${mode} → ${r.status}`);
    return r.body;
  },
  async clear() {
    await request('DELETE', `${SMTP_API}/messages`, { timeoutMs: 3000, useAgent: false });
  },
  /** Accepted messages grouped by X-AMQUR-Delivery-Id (the only thing read from them). */
  async byDelivery() {
    const r = await request('GET', `${SMTP_API}/messages`, { timeoutMs: 20000, useAgent: false });
    const out = new Map();
    for (const m of r.body?.messages ?? []) {
      const id = /^X-AMQUR-Delivery-Id:\s*(\S+)/im.exec(m.raw)?.[1] ?? '(none)';
      const messageId = /^Message-ID:\s*(\S+)/im.exec(m.raw)?.[1] ?? null;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ mockId: m.id, at: m.at, to: m.to, messageId });
    }
    return out;
  },
};

/** One combined sample of everything, used once a minute by the soak. */
export async function sampleAll({ pid, workerPid, inspector, db, redis, forceGc = false }) {
  const [proc, worker, rt, dbs, rds, mail] = await Promise.all([
    processStats(pid),
    workerPid ? processStats(workerPid) : null,
    inspector ? inspector.runtimeStats() : null,
    db ? db.sample() : null,
    redis ? redis.sample() : null,
    smtp.health().catch(() => null),
  ]);
  const heapAfterGc = forceGc && inspector ? await inspector.gc() : null;
  return {
    rssBytes: proc.rssBytes,
    cpuPct: proc.cpuPct,
    fds: proc.fds,
    tcpFds: proc.tcpFds,
    heapUsed: rt?.heapUsed ?? null,
    heapTotal: rt?.heapTotal ?? null,
    external: rt?.external ?? null,
    heapAfterGc,
    eventLoop: rt?.eld ?? null,
    activeResources: rt?.res ?? null,
    ...(dbs ?? { pgConnections: null, outbox: null, deliveries: null, rows: null }),
    ...(rds ?? { redisUsedBytes: null, redisKeys: null }),
    smtpAccepted: mail?.received ?? null,
    // 1-minute load average of the HOST: tells apart "the API got slower" from "the machine was busy".
    hostLoad1m: Math.round(os.loadavg()[0] * 100) / 100,
    hostCpus: os.cpus().length,
    ...(worker ? { worker: { rssBytes: worker.rssBytes, fds: worker.fds, cpuPct: worker.cpuPct } } : {}),
  };
}

/** First-quartile vs last-quartile comparison + least-squares slope per minute for a series. */
export function trend(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 4) return { n: v.length, note: 'too few samples' };
  const q = Math.max(1, Math.floor(v.length / 4));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const first = mean(v.slice(0, q));
  const last = mean(v.slice(-q));
  const xs = v.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(v);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (v[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  // Slope of the second half only: a warm-up that plateaus has a flat second half.
  const half = v.slice(Math.floor(v.length / 2));
  const hx = half.map((_, i) => i);
  const hmx = mean(hx);
  const hmy = mean(half);
  const slopeSecondHalf = half.length > 2 ? hx.reduce((s, x, i) => s + (x - hmx) * (half[i] - hmy), 0) / hx.reduce((s, x) => s + (x - hmx) ** 2, 0) : null;
  return {
    n: v.length,
    firstQuartileMean: Math.round(first),
    lastQuartileMean: Math.round(last),
    deltaPct: first ? Math.round(((last - first) / first) * 1000) / 10 : null,
    slopePerSample: Math.round(slope * 100) / 100,
    slopeSecondHalfPerSample: slopeSecondHalf === null ? null : Math.round(slopeSecondHalf * 100) / 100,
    min: Math.min(...v),
    max: Math.max(...v),
  };
}
