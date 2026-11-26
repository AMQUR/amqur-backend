/**
 * Shared HTTP client for the soak / reliability harness (plain Node ESM, no dependencies).
 * Loopback only: every script refuses a base URL that is not 127.0.0.1 / localhost.
 * Synthetic data only: example.invalid mailboxes and 555-01xx phone numbers.
 */
import http from 'node:http';

export const BASE = (process.env.SOAK_BASE_URL || 'http://127.0.0.1:3211').replace(/\/$/, '');
export const ORIGIN = process.env.SOAK_ORIGIN || 'http://localhost:5173';
export const SMTP_API = (process.env.SOAK_SMTP_API || 'http://127.0.0.1:19085').replace(/\/$/, '');
export const CONSENT_VERSION = 'lead-form-consent-v1';

/** Seeded tenants (scripts/seed-group-rooftops.ts + scripts/seed-local-demo.ts). */
export const ROOFTOPS = [
  { slug: 'dial-chevy-of-chicago', location: 'main', name: 'Dial Chevy of Chicago', vinPrefix: 'DEMO00000000000C', vins: ['DEMO00000000000C1', 'DEMO00000000000C2', 'DEMO00000000000C3', 'DEMO00000000000C4'], makes: ['Chevrolet'] },
  { slug: 'dial-nissan-of-chicago', location: 'main', name: 'Dial Nissan of Chicago', vinPrefix: 'DEMO0000000000NR', vins: ['DEMO0000000000NR1', 'DEMO0000000000NR2', 'DEMO0000000000NR3'], makes: ['Nissan'] },
  { slug: 'infiniti-of-chicago', location: 'main', name: 'INFINITI of Chicago', vinPrefix: 'DEMO0000000000QX', vins: ['DEMO0000000000QX1', 'DEMO0000000000QX2', 'DEMO0000000000QX3'], makes: ['INFINITI'] },
  { slug: 'dial-cdjr-of-chicago', location: 'main', name: 'Dial Chrysler Dodge Jeep Ram of Chicago', vinPrefix: 'DEMO00000000000S', vins: ['DEMO00000000000S1', 'DEMO00000000000S2', 'DEMO00000000000S3', 'DEMO00000000000S4', 'DEMO00000000000S5'], makes: ['Jeep', 'Ram', 'Dodge', 'Chrysler'] },
  { slug: 'jeep-of-chicago', location: 'main', name: 'Jeep of Chicago', vinPrefix: 'DEMO00000000000N', vins: ['DEMO00000000000N1', 'DEMO00000000000N2', 'DEMO00000000000N3', 'DEMO00000000000N4'], makes: ['Jeep', 'Ram'] },
];
export const GROUP = { slug: 'dial-auto-group', location: 'main', name: 'Dial Auto Group' };
export const DEMO = { slug: 'dial-demo-local', location: 'demo-rooftop', name: 'Demo Rooftop (simulated data)' };

export function assertLoopback(url = BASE) {
  const h = new URL(url).hostname;
  if (h !== '127.0.0.1' && h !== 'localhost') {
    console.error(`Refusing: ${url} is not loopback. The soak harness only targets a local disposable stack.`);
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length)];

/** One keep-alive agent per harness process so the client is not the bottleneck / FD hog. */
export const agent = new http.Agent({ keepAlive: true, maxSockets: Number(process.env.SOAK_MAX_SOCKETS || 256) });

/**
 * Raw request. Never throws: returns { status, ms, body, text, error }.
 * status 0 = transport failure (connection refused/reset/timeout).
 */
export function request(method, url, { headers = {}, body, timeoutMs = 30_000, useAgent = agent } = {}) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        agent: useAgent,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, headers: res.headers, text, body: json });
        });
        res.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, error: e.code || e.message, text: '' }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('client_timeout'), { code: 'CLIENT_TIMEOUT' })));
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, error: e.code || e.message, text: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

const unwrap = (b) => (b && typeof b === 'object' && 'data' in b ? b.data : b);

const tokenCache = new Map();
/** Widget bearer token for a tenant/location (cached ~3 h; the server issues 4 h tokens). */
export async function widgetToken(t, { base = BASE, fresh = false } = {}) {
  const key = `${base}|${t.slug}|${t.location}`;
  const hit = tokenCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 3 * 3600_000) return hit.token;
  const r = await request('POST', `${base}/api/public/widget-token`, {
    headers: { origin: ORIGIN },
    body: { tenantSlug: t.slug, locationSlug: t.location },
  });
  const token = unwrap(r.body)?.token;
  if (!token) throw Object.assign(new Error(`widget-token ${t.slug} → ${r.status} ${r.error || ''}`), { response: r });
  tokenCache.set(key, { token, at: Date.now() });
  return token;
}
export const dropToken = (t, base = BASE) => tokenCache.delete(`${base}|${t.slug}|${t.location}`);

/** POST /api/chat. Returns the raw result plus `data` (the unwrapped chat response) on 2xx. */
export async function chat(t, body, { base = BASE, timeoutMs } = {}) {
  let token;
  try {
    token = await widgetToken(t, { base });
  } catch (e) {
    return { status: e.response?.status ?? 0, ms: e.response?.ms ?? 0, error: 'token', text: e.response?.text ?? '', tokenFailure: true };
  }
  const r = await request('POST', `${base}/api/chat`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    body,
    timeoutMs,
  });
  if (r.status === 401) dropToken(t, base);
  if (r.status >= 200 && r.status < 300) r.data = unwrap(r.body);
  return r;
}

export function parseSse(text) {
  return text
    .split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return { type: '__unparseable__' };
      }
    });
}

/**
 * POST /api/chat/stream. `abortAfter`: 'headers' | 'first-event' | number (ms after request start)
 * destroys the socket mid-stream (a client that walks away). Resolves with
 * { status, ms, events, data, aborted, ttfbMs }.
 */
export async function chatStream(t, body, { base = BASE, abortAfter, timeoutMs = 30_000, useAgent } = {}) {
  let token;
  try {
    token = await widgetToken(t, { base });
  } catch (e) {
    return { status: e.response?.status ?? 0, ms: 0, error: 'token', text: '', tokenFailure: true };
  }
  const t0 = performance.now();
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/chat/stream`);
    const payload = Buffer.from(JSON.stringify(body));
    let aborted = false;
    let ttfbMs;
    const done = (r) => resolve({ ms: performance.now() - t0, aborted, ttfbMs, ...r });
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        // An aborted stream must not poison a pooled socket: aborting clients get their own socket.
        agent: abortAfter !== undefined ? false : (useAgent ?? agent),
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`,
          origin: ORIGIN,
        },
      },
      (res) => {
        ttfbMs = performance.now() - t0;
        let text = '';
        const abort = () => {
          aborted = true;
          req.destroy();
          done({ status: res.statusCode ?? 0, events: parseSse(text), text });
        };
        if (abortAfter === 'headers') return abort();
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (abortAfter === 'first-event' && !aborted && text.includes('\n\n')) abort();
        });
        res.on('end', () => {
          if (aborted) return;
          const sse = String(res.headers['content-type'] || '').includes('text/event-stream');
          const events = sse ? parseSse(text) : [];
          const completed = events.find((e) => e.type === 'turn.completed');
          let json;
          if (!sse) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          done({ status: res.statusCode ?? 0, headers: res.headers, events, text, body: json, data: completed?.response, streamError: events.find((e) => e.type === 'turn.error') });
        });
        res.on('error', (e) => {
          if (!aborted) done({ status: 0, error: e.code || e.message, events: parseSse(text), text });
        });
      },
    );
    if (typeof abortAfter === 'number')
      setTimeout(() => {
        if (aborted) return;
        aborted = true;
        req.destroy();
        done({ status: 0, events: [], text: '' });
      }, abortAfter).unref();
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('client_timeout'), { code: 'CLIENT_TIMEOUT' })));
    req.on('error', (e) => {
      if (!aborted) done({ status: 0, error: e.code || e.message, events: [], text: '' });
    });
    req.write(payload);
    req.end();
  });
}

export const card = (data, kind) => (data?.cards ?? []).find((c) => c.kind === kind);

/** Letters-only suffix: the lead form rejects names that do not look like names. */
const alpha = (n) => {
  let out = '';
  let x = Math.max(0, Math.floor(n));
  do {
    out = String.fromCharCode(97 + (x % 26)) + out;
    x = Math.floor(x / 26);
  } while (x > 0);
  return out.padStart(4, 'a');
};
/** A synthetic shopper. `n` makes the contact unique; nothing here is a real person. */
export function shopper(n, tag = 'soak') {
  const id = String(n).padStart(6, '0');
  return {
    firstName: 'Testy',
    lastName: `Soak${alpha(n)}`,
    email: `${tag}.shopper.${id}@example.invalid`,
    // 555-01xx is the reserved fictional range.
    phone: `312-555-01${String(n % 100).padStart(2, '0')}`,
  };
}
export const leadPayload = (formId, who, over = {}) => ({
  formId,
  firstName: who.firstName,
  lastName: who.lastName,
  email: who.email,
  phone: who.phone,
  preferredChannel: 'EMAIL',
  consents: [
    { channel: 'EMAIL', granted: true, version: CONSENT_VERSION },
    { channel: 'CALL', granted: true, version: CONSENT_VERSION },
  ],
  ...over,
});

/** Bodies must never leak internals. Returns the list of leak markers found (empty = clean). */
const LEAK_PATTERNS = [
  [/\bat [\w$.<>\[\] ]+ \((?:\/|node:|file:)[^)]*:\d+:\d+\)/, 'stack_frame'],
  [/node_modules\//, 'node_modules_path'],
  [/\/(?:Users|home|app|usr)\/[\w./-]+\.(?:js|ts)\b/, 'file_path'],
  [/Prisma\w*Error|PrismaClient|prisma\.\w+\.\w+\(/i, 'prisma_internal'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/, 'socket_errno'],
  [/\b(?:postgres(?:ql)?|redis):\/\//i, 'connection_url'],
  [/\b127\.0\.0\.1:\d{4,5}\b|\blocalhost:\d{4,5}\b/, 'host_port'],
  [/Can't reach database server|Connection is closed|MaxRetriesPerRequest|P10\d\d|P20\d\d/, 'driver_message'],
  [/SELECT |INSERT INTO|UPDATE "|relation "|column "/, 'sql'],
];
export function leakMarkers(text) {
  if (!text) return [];
  return LEAK_PATTERNS.filter(([re]) => re.test(text)).map(([, name]) => name);
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, i)] * 10) / 10;
}
export function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null };
}

/** Simple check ledger used by the correctness scripts. */
export function ledger(name) {
  const checks = [];
  return {
    checks,
    check(id, pass, detail) {
      checks.push({ id, pass: !!pass, detail });
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      return !!pass;
    },
    result() {
      const failed = checks.filter((c) => !c.pass);
      return { name, passed: checks.length - failed.length, failed: failed.length, checks };
    },
  };
}
