/**
 * Reconnect / abort: clients open POST /api/chat/stream and walk away mid-stream, at volume.
 * Verifies that nothing is left behind in the API process — heap (after a forced GC), file
 * descriptors, live timers (the heartbeat interval), HTTP responses and sockets all return to
 * the pre-test baseline — and that an abandoned turn still ran to completion server-side.
 *
 * Start the API with the inspector and a fast heartbeat so the interval really fires mid-turn:
 *   CHAT_STREAM_HEARTBEAT_MS=25 SOAK_NODE_FLAGS="--inspect=127.0.0.1:9311 --expose-gc" \
 *     SOAK_OUT=… bash test/soak/infra/start-api.sh 3211 api-a
 *   SOAK_INSPECT_PORT=9311 SOAK_OUT=… bash test/soak/infra/soak-env.sh node test/soak/sse-abort.mjs
 *
 * Env: SOAK_ABORT_WAVES (5) · SOAK_ABORT_STREAMS (2000 per wave) · SOAK_ABORT_CONCURRENCY (100).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLoopback, BASE, ROOFTOPS, GROUP, chatStream, ledger, sleep, request } from './lib/client.mjs';
import { Db, Inspector, pidFromFile, processStats } from './lib/probe.mjs';

assertLoopback();
const OUT = process.env.SOAK_OUT;
const WAVES = Number(process.env.SOAK_ABORT_WAVES || 5);
const STREAMS = Number(process.env.SOAK_ABORT_STREAMS || 2000);
const CONCURRENCY = Number(process.env.SOAK_ABORT_CONCURRENCY || 100);
const pid = Number(process.env.SOAK_API_PID) || (OUT ? pidFromFile(process.env.SOAK_API_PIDFILE || path.join(OUT, 'api-a.pid')) : null);
const inspector = process.env.SOAK_INSPECT_PORT ? new Inspector(Number(process.env.SOAK_INSPECT_PORT)) : null;
const db = new Db();
const L = ledger('sse-abort');
const TENANTS = [...ROOFTOPS, GROUP];
const MESSAGES = ['Do you have any SUVs?', 'Show me trucks', '¿Tienen camionetas?', 'What are your hours?', 'Can I talk to a person?'];
const MODES = ['headers', 'first-event', 'timed', 'timed', 'first-event', 'headers', 'timed', 'first-event', 'headers', 'complete'];

async function measure(label) {
  const heapAfterGc = inspector ? await inspector.gc() : null;
  const live = inspector ? await inspector.liveObjects() : null;
  const rt = inspector ? await inspector.runtimeStats() : null;
  const proc = await processStats(pid);
  const m = { label, at: new Date().toISOString(), heapAfterGc, rssBytes: proc.rssBytes, fds: proc.fds, tcpFds: proc.tcpFds, live, activeResources: rt?.res ?? null };
  const mb = (x) => (x == null ? '—' : (x / 1048576).toFixed(1));
  console.log(`   ${label.padEnd(28)} heap(after GC) ${mb(heapAfterGc)} MB | rss ${mb(proc.rssBytes)} MB | fds ${proc.fds} (tcp ${proc.tcpFds}) | timers ${live?.timeouts ?? '—'} responses ${live?.serverResponses ?? '—'} requests ${live?.incomingMessages ?? '—'} sockets ${live?.sockets ?? '—'}`);
  return m;
}

async function wave(n) {
  const counts = {};
  const abandoned = [];
  let i = 0;
  const bump = (k) => {
    counts[k] = (counts[k] || 0) + 1;
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < STREAMS) {
        const k = i++;
        const mode = MODES[k % MODES.length];
        const t = TENANTS[k % TENANTS.length];
        const abortAfter = mode === 'complete' ? undefined : mode === 'timed' ? 1 + Math.floor(Math.random() * 25) : mode;
        const r = await chatStream(t, { message: MESSAGES[k % MESSAGES.length], language: MESSAGES[k % MESSAGES.length].startsWith('¿') ? 'es' : 'en' }, { abortAfter });
        if (mode === 'complete') bump(r.data ? 'completed_ok' : `completed_bad_${r.status}`);
        else bump(`aborted_${mode}${r.status && r.status !== 200 ? `_status_${r.status}` : ''}`);
        if (mode === 'first-event' && abandoned.length < 40) {
          const id = r.events?.find((e) => e.type === 'turn.started')?.conversationId;
          if (id) abandoned.push({ slug: t.slug, id });
        }
      }
    }),
  );
  console.log(`   wave ${n}: ${JSON.stringify(counts)}`);
  return { counts, abandoned };
}

async function main() {
  console.log(`sse-abort → ${BASE}, ${WAVES} waves × ${STREAMS} streams, concurrency ${CONCURRENCY}, api pid ${pid ?? 'unknown'}${inspector ? '' : ' (no inspector: heap and object counts unavailable)'}`);
  // Warm-up so lazy initialisation and pool growth are not counted as a leak.
  for (let k = 0; k < 300; k += 1) await chatStream(TENANTS[k % TENANTS.length], { message: MESSAGES[k % MESSAGES.length], language: 'en' });
  await sleep(3000);
  const baseline = await measure('baseline (after warm-up)');
  const series = [baseline];
  const waves = [];
  const abandoned = [];
  const t0 = Date.now();
  for (let n = 1; n <= WAVES; n += 1) {
    const w = await wave(n);
    waves.push(w.counts);
    abandoned.push(...w.abandoned);
    await sleep(2000);
    series.push(await measure(`after wave ${n}`));
  }
  const stormSeconds = Math.round((Date.now() - t0) / 1000);

  // The server must still serve streams normally after the storm.
  let ok = 0;
  for (let k = 0; k < 50; k += 1) if ((await chatStream(TENANTS[k % TENANTS.length], { message: 'Do you have any SUVs?', language: 'en' })).data) ok += 1;
  L.check('S.streams_still_work_after_storm', ok === 50, `${ok}/50 normal streams completed after ${WAVES * STREAMS} streams (${stormSeconds} s)`);
  const health = await request('GET', `${BASE}/api/health`, { useAgent: false });
  L.check('S.health_ready_after_storm', health.status === 200, `GET /api/health → ${health.status}`);

  // A turn whose client left must still have been completed and stored.
  const tenantIds = Object.fromEntries(((await db.q(`SELECT id, slug FROM "Tenant"`)) ?? []).map((r) => [r.slug, r.id]));
  let persisted = 0;
  for (const a of abandoned) {
    const r = await db.one(`SELECT COUNT(*) FILTER (WHERE m.role = 'ASSISTANT')::int AS n FROM "Conversation" c JOIN "Message" m ON m."conversationId" = c.id WHERE c."tenantId" = $1 AND c."externalKey" = $2`, tenantIds[a.slug], a.id);
    if ((r?.n ?? 0) >= 1) persisted += 1;
  }
  L.check('S.abandoned_turns_completed_server_side', abandoned.length > 0 && persisted === abandoned.length, `${persisted}/${abandoned.length} sampled streams aborted after turn.started have their assistant reply stored`);

  await sleep(5000);
  const settled = await measure('settled (+5 s)');
  // The rate limiter keeps one timer per request for its 60 s window; wait it out before judging timers.
  await sleep(70_000);
  const final = await measure('final (+75 s)');
  series.push(settled, final);

  const mb = (x) => Math.round((x / 1048576) * 10) / 10;
  if (inspector && baseline.heapAfterGc && final.heapAfterGc) {
    const growth = final.heapAfterGc - baseline.heapAfterGc;
    const perStream = growth / (WAVES * STREAMS);
    L.check('S.heap_returns_to_baseline', growth < Math.max(8 * 1048576, baseline.heapAfterGc * 0.1), `heap after GC: baseline ${mb(baseline.heapAfterGc)} MB → final ${mb(final.heapAfterGc)} MB (${growth >= 0 ? '+' : ''}${mb(growth)} MB, ${Math.round(perStream)} bytes per aborted stream); per wave: ${series.slice(1, WAVES + 1).map((s) => mb(s.heapAfterGc)).join(', ')} MB`);
    L.check('S.no_leaked_timers', final.live.timeouts <= baseline.live.timeouts + 10, `live Timeout objects: baseline ${baseline.live.timeouts} → +5 s ${settled.live.timeouts} → +75 s ${final.live.timeouts} (a leaked heartbeat would leave one per abandoned stream: ${WAVES * STREAMS})`);
    L.check('S.no_leaked_responses_or_sockets', final.live.serverResponses <= baseline.live.serverResponses + 5 && final.live.sockets <= baseline.live.sockets + 10, `ServerResponse ${baseline.live.serverResponses} → ${final.live.serverResponses}, IncomingMessage ${baseline.live.incomingMessages} → ${final.live.incomingMessages}, Socket ${baseline.live.sockets} → ${final.live.sockets}`);
  } else L.check('S.inspector_available', false, 'no inspector connection — heap/timer/socket checks were NOT run');
  L.check('S.fds_return_to_baseline', final.fds !== null && final.fds <= baseline.fds + 5, `open descriptors: baseline ${baseline.fds} → peak ${Math.max(...series.map((s) => s.fds ?? 0))} → final ${final.fds}`);

  const result = { ...L.result(), at: new Date().toISOString(), waves, streams: WAVES * STREAMS, stormSeconds, series };
  if (OUT) {
    mkdirSync(path.join(OUT, 'out'), { recursive: true });
    const f = path.join(OUT, 'out', `sse-abort-${result.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(`result → ${f}`);
  }
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  inspector?.close();
  await db.close();
  process.exit(result.failed ? 2 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
