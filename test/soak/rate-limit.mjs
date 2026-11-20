/**
 * Default rate limits: with the API started in development mode (limits NOT lifted), a burst must
 * be answered with clean 429s and the service must serve normally again once the window passes.
 *
 *   SOAK_NODE_ENV=development SOAK_OUT=… bash test/soak/infra/start-api.sh 3215 api-rl
 *   SOAK_BASE_URL=http://127.0.0.1:3215 SOAK_OUT=… bash test/soak/infra/soak-env.sh node test/soak/rate-limit.mjs
 *
 * See docs/operations/rate-limits.md in the backend. The globally registered auth bucket
 * caps these routes at 20/min each, per verified tracker. Public token mints share one IP
 * bucket across rooftops; authenticated chat uses the signed tenant and IP.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLoopback, BASE, ORIGIN, ROOFTOPS, chat, chatStream, leakMarkers, ledger, request, sleep, summarize } from './lib/client.mjs';

assertLoopback();
const OUT = process.env.SOAK_OUT;
const L = ledger('rate-limit');
const tally = (rs, f = (r) => r.status) => rs.reduce((o, r) => ((o[f(r)] = (o[f(r)] || 0) + 1), o), {});
const burst = async (n, size, fn) => {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < n) {
        i += 1;
        out.push(await fn());
      }
    }),
  );
  return out;
};

async function main() {
  const A = ROOFTOPS[0];
  const B = ROOFTOPS[1];
  console.log(`rate-limit → ${BASE} (expects NODE_ENV=development: limits not lifted)`);
  const first = await chat(A, { message: 'Do you have any SUVs?', language: 'en' });
  if (!L.check('R.service_up', first.status === 201, `first chat → ${first.status}`)) process.exit(2);
  const cid = first.data.conversationId;

  // The global auth bucket caps each route at 20/min even with a higher default limit.
  const t0 = Date.now();
  const rs = await burst(150, 10, () => chat(A, { message: 'Show me trucks', language: 'en', conversationId: cid }));
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const limited = rs.filter((r) => r.status === 429);
  const ok = rs.filter((r) => r.status === 201);
  const sample = limited[0];
  const leaks = limited.flatMap((r) => leakMarkers(r.text));
  L.check('R.burst_is_limited_with_429', ok.length === 19 && limited.length === rs.length - ok.length, `150 chat turns in ${seconds} s → ${JSON.stringify(tally(rs))} (20/min effective, including the first turn)`);
  L.check('R.429_body_is_clean_json', limited.length > 0 && limited.every((r) => r.body?.success === false) && leaks.length === 0, `sample: ${sample ? sample.text.slice(0, 200) : 'n/a'}; bodies with internals: ${leaks.length}`);
  L.check('R.429_has_retry_after', limited.length > 0 && limited.every((r) => Number(r.headers?.['retry-after']) > 0), `standard Retry-After: ${sample?.headers?.['retry-after'] ?? 'missing'}; Retry-After-auth: ${sample?.headers?.['retry-after-auth'] ?? 'missing'}; 429 latency ${JSON.stringify(summarize(limited.map((r) => r.ms)))}`);

  const streams = await burst(22, 1, () => chatStream(A, { message: 'Show me trucks', language: 'en', conversationId: cid }));
  const throttledStreams = streams.filter((r) => r.status === 429);
  L.check('R.stream_route_limited_as_json', streams.filter((r) => r.status === 200 && r.data).length === 20 && throttledStreams.length === 2 && throttledStreams.every((r) => r.body?.success === false && (r.events ?? []).length === 0), `POST /api/chat/stream → ${JSON.stringify(tally(streams))}`);

  // 3. While limited: health stays reachable; another tenant from the same address.
  const h = await request('GET', `${BASE}/api/health`, { useAgent: false });
  L.check('R.health_reachable_while_limited', h.status === 200, `GET /api/health → ${h.status}`);
  const other = await burst(5, 1, () => chat(B, { message: 'Do you have any SUVs?', language: 'en' }));
  const otherTally = tally(other);
  L.check('R.chat_bucket_is_tenant_scoped', other.every((r) => r.status === 201), `tenant ${B.slug} after ${A.slug}'s burst → ${JSON.stringify(otherTally)}`);

  // The public widget-token bucket is shared by callers on the same IP, across rooftops.
  const mint = (tenant) => request('POST', `${BASE}/api/public/widget-token`, { headers: { origin: ORIGIN }, body: { tenantSlug: tenant.slug, locationSlug: tenant.location } });
  let tokenIndex = 0;
  const rotation = ROOFTOPS.slice(0, -1);
  const tokens = await burst(45, 5, () => mint(rotation[tokenIndex++ % rotation.length]));
  const tokOther = await mint(ROOFTOPS.at(-1));
  L.check('R.widget_token_limited_per_ip', tokens.filter((r) => r.status === 201).length === 18 && tokens.filter((r) => r.status === 429).length === 27 && tokOther.status === 429, `45 token requests rotating ${rotation.length} rooftops, after two initial mints → ${JSON.stringify(tally(tokens))}; previously unused rooftop → ${tokOther.status}`);

  // 5. Recovery: once the window has passed, the same client is served again.
  const retryAfter = Math.max(...limited.map((r) => Number(r.headers?.['retry-after']) || 0), 60);
  console.log(`   waiting ${retryAfter + 3} s for the window to pass…`);
  await sleep((retryAfter + 3) * 1000);
  const after = await burst(10, 1, () => chat(A, { message: 'Show me trucks', language: 'en', conversationId: cid }));
  const afterOther = await chat(B, { message: 'Do you have any SUVs?', language: 'en' });
  L.check('R.recovers_after_window', after.every((r) => r.status === 201 && r.data?.conversationId === cid) && afterOther.status === 201, `10 turns after the window → ${JSON.stringify(tally(after))}, same conversation kept; other tenant → ${afterOther.status}; latency ${JSON.stringify(summarize(after.map((r) => r.ms)))}`);

  const result = { ...L.result(), at: new Date().toISOString(), burst: { requests: rs.length, seconds, byStatus: tally(rs) }, streams: tally(streams), widgetTokenBurst: tally(tokens), previouslyUnusedRooftopTokenStatus: tokOther.status, otherTenantSameAddressDuringLimit: otherTally, sample429: sample ? { body: sample.text.slice(0, 300), retryAfter: sample.headers?.['retry-after'] ?? null, retryAfterAuth: sample.headers?.['retry-after-auth'] ?? null } : null };
  if (OUT) {
    mkdirSync(path.join(OUT, 'out'), { recursive: true });
    const f = path.join(OUT, 'out', `rate-limit-${result.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(`result → ${f}`);
  }
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  process.exit(result.failed ? 2 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
