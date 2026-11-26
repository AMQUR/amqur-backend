/**
 * Outbox / lead-delivery behaviour under failure, with REAL processes: three API processes each
 * running the built-in outbox tick, the mock SMTP's failure modes, and SIGKILL mid-delivery.
 * Run on a freshly reset soak stack with NO API process running — this script starts, kills and
 * restarts its own (ports SOAK_API_PORT, +1, +2 and +3 for the crash-loop worker).
 *
 *   SOAK_OUT=… bash test/soak/infra/soak-env.sh node test/soak/outbox-failure.mjs
 *
 * Env: SOAK_PHASES (comma list, default all: baseline,tempfail,reject,drop,slowkill,midbatch,
 * crashloop) · SOAK_MIDBATCH_ROUNDS (4) · SOAK_MIDBATCH_LEADS (40).
 *
 * What "exactly once" means here: the documented guarantee (docs/ADF_LEAD_DELIVERY.md) is
 * at-least-once, with one remaining duplicate window — the process dies after the transport
 * accepted and before any database write. A duplicate is reported with its timeline and judged
 * against that window; it is not hidden and not automatically a failure.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLoopback, ROOFTOPS, chat, card, shopper, leadPayload, ledger, sleep, request, dropToken } from './lib/client.mjs';
import { Db, smtp, pidAlive } from './lib/probe.mjs';

const OUT = process.env.SOAK_OUT;
if (!OUT) {
  console.error('Set SOAK_OUT to a scratch directory outside the repository.');
  process.exit(1);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT0 = Number(process.env.SOAK_API_PORT || 3211);
const PHASES = (process.env.SOAK_PHASES || 'baseline,tempfail,reject,drop,slowkill,midbatch,crashloop').split(',').map((s) => s.trim());
const ROUNDS = Number(process.env.SOAK_MIDBATCH_ROUNDS || 4);
const ROUND_LEADS = Number(process.env.SOAK_MIDBATCH_LEADS || 40);
const OUTBOX_MAX_ATTEMPTS = 8; // src/integrations/core/outbox.service.ts
const OUTBOX_LEASE_S = 120;
const db = new Db();
const L = ledger('outbox-failure');
const report = { phases: {}, kills: [], duplicates: [] };

// ───────────────────────────────────────────────────────────── processes
const procs = new Map(); // name → { port, pid, entry }
const baseOf = (name) => `http://127.0.0.1:${procs.get(name).port}`;
async function start(name, port, env = {}) {
  await new Promise((resolve, reject) => {
    const c = spawn('bash', [path.join(HERE, 'infra/start-api.sh'), String(port), name], { env: { ...process.env, ...env, SOAK_OUT: OUT, SOAK_API_PORT: String(PORT0) }, stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`start-api ${name} exited ${code}`))));
  });
  const pid = Number(readFileSync(path.join(OUT, `${name}.pid`), 'utf8').trim());
  procs.set(name, { port, pid, entry: env.SOAK_ENTRY || 'dist/main.js' });
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 120; i += 1) {
    const r = await request('GET', url, { timeoutMs: 1000, useAgent: false });
    if (r.status === 200) return pid;
    if (!(await pidAlive(pid))) throw new Error(`${name} died during start (see ${OUT}/logs/${name}.log)`);
    await sleep(250);
  }
  throw new Error(`${name} did not become healthy`);
}
function kill9(name) {
  const p = procs.get(name);
  if (!p) return null;
  try {
    process.kill(p.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  const at = new Date();
  report.kills.push({ name, pid: p.pid, at: at.toISOString() });
  return at;
}
async function stopAll() {
  for (const [name, p] of procs) {
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    procs.delete(name);
  }
  await sleep(1500);
}
const nameOfPid = (pid) => [...procs].find(([, p]) => p.pid === pid)?.[0] ?? null;
const pidOfClaim = (claimedBy) => Number(String(claimedBy ?? '').split(':').pop()) || null;
async function liveBase() {
  for (const [name, p] of procs) if (p.entry === 'dist/main.js' && (await pidAlive(p.pid))) return baseOf(name);
  throw new Error('no live API process');
}

// ───────────────────────────────────────────────────────────── leads and their deliveries
let seq = 500_000;
/** `count` sales leads (test drive → lead form with consent) spread over the five rooftops. */
async function makeLeads(count, tag, { parallel = 8 } = {}) {
  const base = await liveBase();
  const emails = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, count) }, async () => {
      while (i < count) {
        const k = i++;
        const t = ROOFTOPS[k % ROOFTOPS.length];
        const who = shopper((seq += 1), tag);
        let a = await chat(t, { action: 'test_drive', vin: t.vins[k % t.vins.length], language: 'en' }, { base });
        if (a.status === 401) {
          dropToken(t, base);
          a = await chat(t, { action: 'test_drive', vin: t.vins[k % t.vins.length], language: 'en' }, { base });
        }
        const form = card(a.data, 'lead_form');
        if (!form) continue;
        const b = await chat(t, { action: 'lead_capture', conversationId: a.data.conversationId, language: 'en', lead: leadPayload(form.id, who) }, { base });
        if (b.status === 201) emails.push(who.email);
      }
    }),
  );
  return emails;
}
const deliveries = (emails) =>
  db.q(
    `SELECT d.id, d.status::text AS status, d.attempts, d."lastErrorCode" AS err, d."sentAt", d."acceptedAt", d."updatedAt",
            o.id AS outbox_id, o.status::text AS outbox_status, o.attempts AS outbox_attempts, o."claimedBy" AS claimed_by, o."lastError" AS outbox_error, o."leaseExpiresAt" AS lease, o."handlerStartedAt" AS handler_started_at
       FROM "LeadDelivery" d JOIN "Lead" l ON l.id = d."leadId" LEFT JOIN "OutboxEvent" o ON o.id = d."outboxEventId"
      WHERE l.email = ANY($1::text[]) ORDER BY d."createdAt"`,
    emails,
  );
const TERMINAL = new Set(['ACCEPTED', 'DEAD', 'BLOCKED']);
const tally = (rows, f = (r) => r.status) => rows.reduce((o, r) => ((o[f(r)] = (o[f(r)] || 0) + 1), o), {});
async function waitTerminal(emails, timeoutMs, label) {
  const t0 = Date.now();
  let rows = [];
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    rows = (await deliveries(emails)) ?? rows;
    const line = JSON.stringify(tally(rows));
    if (line !== last) {
      console.log(`   [${label} +${Math.round((Date.now() - t0) / 1000)}s] deliveries ${line} outbox ${JSON.stringify(tally(rows, (r) => r.outbox_status))}`);
      last = line;
    }
    if (rows.length >= emails.length && rows.every((r) => TERMINAL.has(r.status) && r.outbox_status !== 'PROCESSING' && r.outbox_status !== 'PENDING')) break;
    await sleep(1000);
  }
  return { rows, seconds: Math.round((Date.now() - t0) / 1000) };
}
async function acceptedCounts(rows) {
  const mail = await smtp.byDelivery();
  return rows.map((r) => ({ ...r, accepted: mail.get(r.id)?.length ?? 0, mail: mail.get(r.id) ?? [] }));
}
function noteDuplicates(phase, rows) {
  for (const r of rows.filter((x) => x.accepted > 1))
    report.duplicates.push({ phase, deliveryId: r.id, acceptedAtMock: r.mail.map((m) => m.at), sameMessageId: new Set(r.mail.map((m) => m.messageId)).size === 1, dbAcceptedAt: r.acceptedAt, deliveryAttempts: r.attempts, outboxAttempts: r.outbox_attempts });
}

// ───────────────────────────────────────────────────────────── phases
async function phaseBaseline() {
  await smtp.mode('none');
  const emails = await makeLeads(20, 'f0');
  const { rows, seconds } = await waitTerminal(emails, 60_000, 'baseline');
  const withMail = await acceptedCounts(rows);
  noteDuplicates('baseline', withMail);
  report.phases.baseline = { leads: emails.length, seconds, deliveries: tally(rows), claimedByProcesses: Object.keys(tally(rows, (r) => r.claimed_by)).length };
  L.check('F0.baseline_all_accepted_once', emails.length === 20 && rows.length === 20 && withMail.every((r) => r.status === 'ACCEPTED' && r.accepted === 1 && r.attempts === 1), { ...report.phases.baseline, acceptedPerDelivery: tally(withMail, (r) => r.accepted) });
}

async function phaseTempfail() {
  await smtp.mode('tempfail', { count: 15 });
  const emails = await makeLeads(15, 'f1');
  const { rows, seconds } = await waitTerminal(emails, 240_000, 'tempfail');
  await smtp.mode('none');
  const withMail = await acceptedCounts(rows);
  noteDuplicates('tempfail', withMail);
  const retried = rows.filter((r) => r.attempts > 1).length;
  report.phases.tempfail = { leads: emails.length, injected451: 15, seconds, deliveries: tally(rows), deliveryAttempts: tally(rows, (r) => r.attempts), outboxAttempts: tally(rows, (r) => r.outbox_attempts) };
  L.check('F1.tempfail_retried_then_accepted_once', rows.length === 15 && withMail.every((r) => r.status === 'ACCEPTED' && r.accepted === 1) && retried > 0, { ...report.phases.tempfail, acceptedPerDelivery: tally(withMail, (r) => r.accepted) });
  L.check('F1.attempts_bounded', rows.every((r) => r.attempts <= OUTBOX_MAX_ATTEMPTS && r.outbox_attempts <= OUTBOX_MAX_ATTEMPTS), `max delivery attempts ${Math.max(...rows.map((r) => r.attempts))}, max outbox attempts ${Math.max(...rows.map((r) => r.outbox_attempts))} (limit ${OUTBOX_MAX_ATTEMPTS})`);
}

async function phaseReject() {
  await smtp.mode('reject', { count: 5 });
  const emails = await makeLeads(5, 'f2', { parallel: 5 });
  const { rows, seconds } = await waitTerminal(emails, 90_000, 'reject');
  await smtp.mode('none');
  const withMail = await acceptedCounts(rows);
  report.phases.reject = { leads: emails.length, injected550: 5, seconds, deliveries: tally(rows), errors: tally(rows, (r) => r.err), deliveryAttempts: tally(rows, (r) => r.attempts), outbox: tally(rows, (r) => r.outbox_status) };
  L.check('F2.permanent_reject_dead_not_retried', rows.length === 5 && withMail.every((r) => r.status === 'DEAD' && r.accepted === 0 && r.attempts === 1 && /550/.test(r.err || '')), { ...report.phases.reject, acceptedPerDelivery: tally(withMail, (r) => r.accepted) });
}

async function phaseDrop() {
  await smtp.mode('drop', { count: 10 });
  const emails = await makeLeads(10, 'f3');
  const { rows, seconds } = await waitTerminal(emails, 240_000, 'drop');
  await smtp.mode('none');
  const withMail = await acceptedCounts(rows);
  noteDuplicates('drop', withMail);
  report.phases.drop = { leads: emails.length, injectedDrops: 10, seconds, deliveries: tally(rows), deliveryAttempts: tally(rows, (r) => r.attempts) };
  L.check('F3.dropped_connection_retried_then_accepted_once', rows.length === 10 && withMail.every((r) => r.status === 'ACCEPTED' && r.accepted === 1) && rows.some((r) => r.attempts > 1), { ...report.phases.drop, acceptedPerDelivery: tally(withMail, (r) => r.accepted) });
}

/** SMTP holds the reply to DATA for 12 s; the process doing the send is SIGKILLed meanwhile. */
async function phaseSlowKill() {
  await smtp.mode('slow', { delayMs: 12_000 });
  const emails = await makeLeads(6, 'f4', { parallel: 6 });
  let victim = null;
  let seen = [];
  for (let i = 0; i < 400 && !victim; i += 1) {
    seen = (await deliveries(emails)) ?? [];
    const inFlight = seen.filter((r) => r.status === 'SENT' && r.outbox_status === 'PROCESSING');
    if (inFlight.length) victim = nameOfPid(pidOfClaim(inFlight[0].claimed_by));
    else await sleep(50);
  }
  if (!L.check('F4.found_in_flight_delivery', !!victim, victim ? `process ${victim} (pid ${procs.get(victim).pid}) is mid-send` : 'no SENT delivery observed')) {
    await smtp.mode('none');
    return;
  }
  const victimPid = procs.get(victim).pid;
  const atKill = (await deliveries(emails)) ?? seen;
  const victimRows = atKill.filter((r) => pidOfClaim(r.claimed_by) === victimPid && r.outbox_status === 'PROCESSING');
  const killedAt = kill9(victim);
  await smtp.mode('none');
  console.log(`   SIGKILL ${victim} pid ${victimPid} holding ${victimRows.length} claimed event(s): ${JSON.stringify(tally(victimRows))}`);
  await sleep(3000);
  const mid = (await deliveries(emails)) ?? [];
  const stuck = mid.filter((r) => victimRows.some((v) => v.id === r.id));
  await start(victim, procs.get(victim).port);
  const { rows, seconds } = await waitTerminal(emails, 300_000, 'slowkill');
  const withMail = await acceptedCounts(rows);
  noteDuplicates('slowkill', withMail);
  const recovered = withMail.filter((r) => victimRows.some((v) => v.id === r.id));
  const expectedAttempts = new Map(victimRows.map((r) => [r.id, r.outbox_attempts + (r.handler_started_at ? 1 : 0)]));
  report.phases.slowkill = {
    leads: emails.length, victim, victimPid, killedAt: killedAt.toISOString(), eventsHeldByVictim: victimRows.length,
    stateAfterKill: tally(stuck, (r) => `${r.status}/${r.outbox_status}`),
    secondsFromKillToAllTerminal: Math.round((Date.now() - killedAt.getTime()) / 1000), waitSeconds: seconds,
    deliveries: tally(rows), outboxAttemptsOfVictimEvents: tally(recovered, (r) => r.outbox_attempts), acceptedPerDelivery: tally(withMail, (r) => r.accepted),
  };
  L.check('F4.rows_stayed_claimed_until_lease_expiry', stuck.length > 0 && stuck.every((r) => r.outbox_status === 'PROCESSING'), `3 s after the kill: ${JSON.stringify(report.phases.slowkill.stateAfterKill)} (nothing else may take a live lease)`);
  L.check('F4.all_terminal_after_recovery', rows.length === emails.length && rows.every((r) => r.status === 'ACCEPTED'), report.phases.slowkill);
  L.check('F4.no_duplicate_accepted_send', withMail.every((r) => r.accepted === 1), `accepted sends per delivery ${JSON.stringify(tally(withMail, (r) => r.accepted))}`);
  L.check('F4.abandoned_attempt_counted_on_reclaim', victimRows.some((r) => r.handler_started_at) && recovered.length === victimRows.length && recovered.every((r) => r.outbox_attempts === expectedAttempts.get(r.id)), `attempts after reclaim: ${JSON.stringify(tally(recovered, (r) => r.outbox_attempts))}; expected ${JSON.stringify(tally([...expectedAttempts.values()], (attempts) => attempts))} (only handlers that started consume an attempt)`);
  L.check('F4.recovery_time_matches_lease', report.phases.slowkill.secondsFromKillToAllTerminal >= OUTBOX_LEASE_S - 15 && report.phases.slowkill.secondsFromKillToAllTerminal <= OUTBOX_LEASE_S + 90, `${report.phases.slowkill.secondsFromKillToAllTerminal} s from SIGKILL to every delivery terminal (lease ${OUTBOX_LEASE_S} s + tick ≤ 10 s + retry backoff)`);
}

/** Mode none, a full batch in progress, SIGKILL the claiming process at a random moment. */
async function phaseMidBatch() {
  await smtp.mode('none');
  const all = [];
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const emails = await makeLeads(ROUND_LEADS, `f5r${round}`, { parallel: 10 });
    all.push(...emails);
    let victim = null;
    let snapshot = [];
    for (let i = 0; i < 1500 && !victim; i += 1) {
      snapshot = (await deliveries(emails)) ?? [];
      const claimed = snapshot.filter((r) => r.outbox_status === 'PROCESSING');
      // Wait until the batch is really moving (some rows already accepted, some still claimed).
      if (claimed.length >= 3 && snapshot.some((r) => r.status === 'ACCEPTED' || r.status === 'SENT')) {
        const byPid = tally(claimed, (r) => pidOfClaim(r.claimed_by));
        const pid = Number(Object.entries(byPid).sort((a, b) => b[1] - a[1])[0][0]);
        victim = nameOfPid(pid);
      } else await sleep(10);
    }
    if (!victim) {
      rounds.push({ round, leads: emails.length, killed: false, note: 'batch finished before a kill could land' });
      continue;
    }
    await sleep(Math.random() * 60);
    const pid = procs.get(victim).pid;
    const killedAt = kill9(victim);
    const after = (await deliveries(emails)) ?? [];
    const held = after.filter((r) => pidOfClaim(r.claimed_by) === pid && r.outbox_status === 'PROCESSING');
    rounds.push({ round, leads: emails.length, killed: true, victim, pid, killedAt: killedAt.toISOString(), heldByVictim: held.length, heldStates: tally(held), heldIds: held.map((r) => r.id), sentAtKill: held.filter((r) => r.status === 'SENT').map((r) => r.id) });
    console.log(`   round ${round}: SIGKILL ${victim} pid ${pid}, holding ${held.length} claimed event(s) ${JSON.stringify(tally(held))}`);
    await sleep(1500);
    await start(victim, procs.get(victim).port);
  }
  const { rows, seconds } = await waitTerminal(all, 420_000, 'midbatch');
  const withMail = await acceptedCounts(rows);
  noteDuplicates('midbatch', withMail);
  const dup = withMail.filter((r) => r.accepted > 1);
  // A duplicate is inside the documented window only if the row was SENT (handed to the transport,
  // outcome not yet recorded) in the process that was killed, and the first acceptance at the mock
  // is not later than that kill.
  const judged = dup.map((r) => {
    const rd = rounds.find((x) => x.killed && x.heldIds.includes(r.id));
    const firstAccept = r.mail.map((m) => Date.parse(m.at)).sort((a, b) => a - b)[0];
    const inside = !!rd && rd.sentAtKill.includes(r.id) && firstAccept <= Date.parse(rd.killedAt) + 250;
    return { deliveryId: r.id, accepted: r.accepted, acceptedAtMock: r.mail.map((m) => m.at), killedAt: rd?.killedAt ?? null, rowWasSentInKilledProcess: !!rd && rd.sentAtKill.includes(r.id), sameMessageId: new Set(r.mail.map((m) => m.messageId)).size === 1, insideDocumentedWindow: inside };
  });
  report.phases.midbatch = { rounds, leads: all.length, waitSeconds: seconds, deliveries: tally(rows), acceptedPerDelivery: tally(withMail, (r) => r.accepted), outboxAttempts: tally(rows, (r) => r.outbox_attempts), duplicates: judged };
  L.check('F5.kills_landed_mid_batch', rounds.filter((r) => r.killed && r.heldByVictim > 0).length > 0, `${rounds.filter((r) => r.killed).length}/${ROUNDS} rounds killed a process that held claimed events (${rounds.filter((r) => r.killed).map((r) => r.heldByVictim).join(', ')} events)`);
  L.check('F5.all_terminal_after_recovery', rows.length === all.length && rows.every((r) => r.status === 'ACCEPTED'), { leads: all.length, deliveries: tally(rows), outbox: tally(rows, (r) => r.outbox_status), waitSeconds: seconds });
  L.check('F5.no_lost_send', withMail.every((r) => r.accepted >= 1), `deliveries with zero accepted sends: ${withMail.filter((r) => r.accepted === 0).length}`);
  L.check('F5.no_duplicate_outside_documented_window', judged.every((d) => d.insideDocumentedWindow), dup.length ? { duplicates: judged } : `0 duplicates in ${withMail.length} deliveries across ${rounds.filter((r) => r.killed).length} mid-batch kills`);
  L.check('F5.attempts_bounded', rows.every((r) => r.outbox_attempts <= OUTBOX_MAX_ATTEMPTS && r.attempts <= OUTBOX_MAX_ATTEMPTS), `outbox attempts ${JSON.stringify(tally(rows, (r) => r.outbox_attempts))}`);
}

/**
 * The rule from commit 00e3fbf with a real process: an event whose worker dies on every attempt.
 * A local HTTP endpoint that never answers stands in for the CRM webhook; the worker is SIGKILLed
 * while it waits. The first lease is left to expire on the database clock (real 120 s); later
 * cycles expire the lease by SQL to save 14 minutes of waiting, which is the only shortcut.
 */
async function phaseCrashLoop() {
  await stopAll();
  let hits = 0;
  const hole = http.createServer((req) => {
    hits += 1;
    req.resume(); // never answer
  });
  const holePort = PORT0 + 79;
  await new Promise((r) => hole.listen(holePort, '127.0.0.1', r));
  const tenant = await db.one(`SELECT id FROM "Tenant" WHERE slug = 'dial-demo-local'`);
  const id = `soakcrash${Date.now().toString(36)}`;
  await db.q(
    `INSERT INTO "OutboxEvent" (id, "tenantId", topic, payload, "idempotencyKey", "updatedAt") VALUES ($1, $2, 'crm.webhook', $3::jsonb, $1, NOW())`,
    id, tenant.id, JSON.stringify({ webhookUrl: `http://127.0.0.1:${holePort}/never-answers`, synthetic: true, purpose: 'soak-crash-loop' }),
  );
  const row = () => db.one(`SELECT status::text AS status, attempts, "claimedBy" AS claimed_by, "lastError" AS err, "claimedAt", "leaseExpiresAt" AS lease, NOW() AS db_now FROM "OutboxEvent" WHERE id = $1`, id);
  const workerEnv = { SOAK_ENTRY: 'dist/worker.js', OUTBOX_POLL_MS: '1000', PROCESS_ROLE: 'worker' };
  const cycles = [];
  let naturalReclaimS = null;
  let earlyReclaim = false;
  let final = null;
  for (let cycle = 1; cycle <= OUTBOX_MAX_ATTEMPTS + 2; cycle += 1) {
    const before = hits;
    const startedAt = Date.now();
    await start('crash-worker', PORT0 + 3, workerEnv);
    // Wait for this worker to call the handler (hit) or to dead-letter the row without calling it.
    let r = null;
    const limit = cycle === 2 ? (OUTBOX_LEASE_S + 60) * 1000 : 40_000;
    while (Date.now() - startedAt < limit) {
      r = await row();
      if (hits > before || r?.status === 'DEAD') break;
      await sleep(200);
    }
    r = await row();
    if (r?.status === 'DEAD') {
      await sleep(2500); // a handler call, if one were coming, would have arrived by now
      final = { ...(await row()), cycle, handlerCalledInFinalCycle: hits > before, workerAlive: await pidAlive(procs.get('crash-worker').pid) };
      break;
    }
    if (hits === before) {
      cycles.push({ cycle, note: 'worker did not claim the event in time', status: r?.status, attempts: r?.attempts });
      break;
    }
    if (cycle === 2) {
      naturalReclaimS = Math.round((Date.parse(r.claimedAt) - Date.parse(cycles[0].claimedAt)) / 1000);
      earlyReclaim = naturalReclaimS < OUTBOX_LEASE_S;
    }
    cycles.push({ cycle, attemptsWhenClaimed: r.attempts, status: r.status, claimedAt: r.claimedAt, workerPid: procs.get('crash-worker').pid, handlerCalls: hits });
    kill9('crash-worker');
    console.log(`   cycle ${cycle}: handler called (call #${hits}) with attempts=${r.attempts}; worker pid ${procs.get('crash-worker').pid} SIGKILLed`);
    // Cycle 1 → 2 waits for the real lease. From cycle 2 on the lease is expired by SQL.
    if (cycle >= 2) await db.q(`UPDATE "OutboxEvent" SET "leaseExpiresAt" = NOW() - interval '1 second' WHERE id = $1 AND status = 'PROCESSING'`, id);
    else console.log(`   waiting for the real ${OUTBOX_LEASE_S} s lease to expire before the next worker may reclaim…`);
  }
  hole.close();
  hole.closeAllConnections?.();
  report.phases.crashloop = { eventId: id, cycles, naturalLeaseReclaimSeconds: naturalReclaimS, handlerCalls: hits, final };
  L.check('F6.lease_respected_before_reclaim', naturalReclaimS !== null && !earlyReclaim, `second claim came ${naturalReclaimS} s after the first (lease ${OUTBOX_LEASE_S} s, database clock; a restarted worker polling every 1 s did not take it early)`);
  L.check('F6.attempt_counted_on_each_reclaim', cycles.length === OUTBOX_MAX_ATTEMPTS && cycles.every((c, i) => c.attemptsWhenClaimed === i), `attempts seen at each claim: ${JSON.stringify(cycles.map((c) => c.attemptsWhenClaimed))} (expected 0..${OUTBOX_MAX_ATTEMPTS - 1})`);
  L.check('F6.dead_lettered_as_abandoned', final?.status === 'DEAD' && final?.err === 'abandoned_after_repeated_lease_expiry' && final?.attempts === OUTBOX_MAX_ATTEMPTS, final ?? 'event never reached DEAD');
  L.check('F6.handler_not_run_again_at_limit', hits === OUTBOX_MAX_ATTEMPTS && final?.handlerCalledInFinalCycle === false && final?.workerAlive === true, `handler calls ${hits} (expected ${OUTBOX_MAX_ATTEMPTS}); final cycle called the handler: ${final?.handlerCalledInFinalCycle}; worker alive afterwards: ${final?.workerAlive}`);
  await stopAll();
}

async function finalInvariants() {
  const stuck = await db.q(`SELECT status::text AS status, COUNT(*)::int AS n FROM "LeadDelivery" GROUP BY 1`);
  const outbox = await db.q(`SELECT status::text AS status, COUNT(*)::int AS n, MAX(attempts)::int AS max_attempts FROM "OutboxEvent" GROUP BY 1`);
  const d = Object.fromEntries((stuck ?? []).map((r) => [r.status, r.n]));
  const o = Object.fromEntries((outbox ?? []).map((r) => [r.status, r.n]));
  const maxAttempts = Math.max(0, ...(outbox ?? []).map((r) => r.max_attempts ?? 0));
  const mail = await smtp.byDelivery();
  const dupIds = [...mail].filter(([id, m]) => id !== '(none)' && m.length > 1).length;
  report.final = { deliveries: d, outbox: o, maxOutboxAttempts: maxAttempts, deliveriesWithMail: mail.size, deliveriesWithMoreThanOneAcceptedSend: dupIds };
  L.check('F7.no_delivery_left_non_terminal', !d.QUEUED && !d.SENT && !d.FAILED, d);
  L.check('F7.no_outbox_row_stuck', !o.PENDING && !o.PROCESSING, o);
  L.check('F7.outbox_attempts_bounded', maxAttempts <= OUTBOX_MAX_ATTEMPTS, `max attempts on any outbox event: ${maxAttempts} (limit ${OUTBOX_MAX_ATTEMPTS})`);
}

async function main() {
  assertLoopback(`http://127.0.0.1:${PORT0}`);
  for (const p of [PORT0, PORT0 + 1, PORT0 + 2, PORT0 + 3]) {
    const r = await request('GET', `http://127.0.0.1:${p}/api/health/live`, { timeoutMs: 500, useAgent: false });
    if (r.status !== 0) {
      console.error(`Port ${p} already answers. Stop the soak API processes first (bash test/soak/infra/stack.sh stop-apis).`);
      process.exit(1);
    }
  }
  await smtp.mode('none');
  await smtp.clear();
  try {
    const needApis = PHASES.some((p) => p !== 'crashloop');
    if (needApis) {
      await start('api-a', PORT0);
      await start('api-b', PORT0 + 1);
      await start('api-c', PORT0 + 2);
      console.log(`three API processes, each with the outbox tick: ${[...procs].map(([n, p]) => `${n}=${p.pid}`).join(' ')}`);
    }
    if (PHASES.includes('baseline')) await phaseBaseline();
    if (PHASES.includes('tempfail')) await phaseTempfail();
    if (PHASES.includes('reject')) await phaseReject();
    if (PHASES.includes('drop')) await phaseDrop();
    if (PHASES.includes('slowkill')) await phaseSlowKill();
    if (PHASES.includes('midbatch')) await phaseMidBatch();
    if (needApis) {
      // Give the last retries and webhooks a moment, then check nothing is left behind.
      for (let i = 0; i < 30; i += 1) {
        const o = await db.groupCounts('OutboxEvent');
        if (o && !o.PENDING && !o.PROCESSING) break;
        await sleep(5000);
      }
      await finalInvariants();
    }
    if (PHASES.includes('crashloop')) await phaseCrashLoop();
  } finally {
    await smtp.mode('none').catch(() => {});
    await stopAll();
  }
  const result = { ...L.result(), at: new Date().toISOString(), ...report };
  mkdirSync(path.join(OUT, 'out'), { recursive: true });
  const f = path.join(OUT, 'out', `outbox-failure-${result.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(f, JSON.stringify(result, null, 2));
  console.log(`result → ${f}`);
  console.log(`\n${result.passed} passed, ${result.failed} failed; duplicates observed: ${report.duplicates.length}`);
  await db.close();
  process.exit(result.failed ? 2 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await stopAll().catch(() => {});
  process.exit(1);
});
