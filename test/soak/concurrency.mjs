/**
 * Concurrency correctness under load, checked against the database and the mock SMTP — not
 * only against what the API answered. Run on a freshly reset soak stack (the sandbox scheduler
 * has 15 bookable slots per rooftop and the checks below need specific ones to be free).
 *
 *   SOAK_OUT=… bash test/soak/infra/soak-env.sh node test/soak/concurrency.mjs
 *
 * Env: SOAK_RACE_N (30 shoppers per slot race) · SOAK_BASE_URL_B (a second API process: adds a
 * cross-process slot race) · SOAK_ISOLATION_N (300 parallel conversations).
 *
 *  C1  N shoppers race for the SAME sandbox slot      → exactly one CONFIRMED receipt
 *  C2  the same lead form submitted concurrently/again → one lead, one consent set, one delivery
 *  C3  identical turns on one conversation, in parallel
 *  C4  many conversations in parallel                  → unique ids, own-tenant vehicles only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLoopback, BASE, ROOFTOPS, GROUP, DEMO, chat, card, shopper, leadPayload, ledger, sleep, pick } from './lib/client.mjs';
import { Db, smtp } from './lib/probe.mjs';

assertLoopback();
const BASE_B = process.env.SOAK_BASE_URL_B?.replace(/\/$/, '');
if (BASE_B) assertLoopback(BASE_B);
const RACE_N = Number(process.env.SOAK_RACE_N || 30);
const ISOLATION_N = Number(process.env.SOAK_ISOLATION_N || 300);
const db = new Db();
const L = ledger('concurrency');
const NOT_BOOKED = /nothing (new )?was booked|no se reserv/i;
const is5xx = (r) => r.status >= 500 || r.status === 0;

const tenantId = async (slug) => (await db.one(`SELECT id FROM "Tenant" WHERE slug = $1`, slug))?.id;
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** test drive → lead form (unique synthetic shopper) → slot picker. */
async function toPicker(t, n, tag, base = BASE) {
  const a = await chat(t, { action: 'test_drive', vin: t.vins[n % t.vins.length], language: 'en' }, { base });
  const form = card(a.data, 'lead_form');
  if (!form) return { error: `no lead form (${a.status})` };
  const who = shopper(n, tag);
  const b = await chat(t, { action: 'lead_capture', conversationId: a.data.conversationId, language: 'en', lead: leadPayload(form.id, who) }, { base });
  const picker = card(b.data, 'appointment_picker');
  return { conversationId: a.data.conversationId, who, form, picker, error: picker?.mode === 'provider_slots' ? undefined : `no provider_slots picker (${b.status})` };
}
/** A slot start every picker offers; never day 1 17:00 UTC, which the sandbox always rejects. */
function commonStart(pickers, index) {
  const sets = pickers.map((p) => new Set(p.slots.map((s) => s.start)));
  const all = [...sets[0]].filter((s) => sets.every((x) => x.has(s))).sort();
  const firstDay = all[0]?.slice(0, 10);
  const usable = all.filter((s) => !(s.startsWith(firstDay) && s.slice(11, 13) === '17'));
  return usable[(usable.length + index) % usable.length];
}

async function slotRace(id, t, { bases, slotIndex }) {
  const tid = await tenantId(t.slug);
  const prepared = await pool(Array.from({ length: RACE_N }, (_, i) => i), 10, (i) => toPicker(t, 100_000 * slotIndex * -1 + i + (bases.length > 1 ? 5000 : 0), `${id}`, bases[i % bases.length]));
  const ready = prepared.filter((p) => !p.error);
  if (!L.check(`${id}.prepared`, ready.length === RACE_N, `${ready.length}/${RACE_N} shoppers reached a provider_slots picker${prepared.find((p) => p.error) ? ` (first problem: ${prepared.find((p) => p.error).error})` : ''}`)) return;
  const start = commonStart(ready.map((p) => p.picker), slotIndex);
  const results = await Promise.all(
    ready.map((p, i) =>
      chat(t, { action: 'appointment_select', conversationId: p.conversationId, appointment: { pickerId: p.picker.id, slotId: p.picker.slots.find((s) => s.start === start).id } }, { base: bases[i % bases.length] }),
    ),
  );
  const confirmed = results.filter((r) => card(r.data, 'appointment')?.outcome === 'confirmed');
  const told = results.filter((r) => r.data && card(r.data, 'appointment')?.outcome !== 'confirmed' && NOT_BOOKED.test(r.data.reply || ''));
  const other = results.length - confirmed.length - told.length;
  await sleep(500);
  const receipts = await db.one(
    `SELECT COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed, COUNT(*) FILTER (WHERE status = 'UNAVAILABLE')::int AS unavailable, COUNT(*)::int AS total
       FROM "AppointmentProviderReceipt" r JOIN "Appointment" a ON a.id = r."appointmentId"
      WHERE r."tenantId" = $1 AND (r."confirmedStart" = $2::timestamptz OR a."scheduledAt" = $2::timestamptz)`,
    tid, start,
  );
  const appts = await db.one(`SELECT COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed, COUNT(*)::int AS total FROM "Appointment" WHERE "tenantId" = $1 AND "scheduledAt" = $2::timestamptz`, tid, start);
  const detail = { tenant: t.slug, slot: start, shoppers: RACE_N, processes: bases.length, api: { confirmed: confirmed.length, toldNothingBooked: told.length, other, status5xx: results.filter(is5xx).length }, db: { confirmedReceipts: receipts?.confirmed, unavailableReceipts: receipts?.unavailable, confirmedAppointments: appts?.confirmed, appointmentRowsAtSlot: appts?.total } };
  L.check(`${id}.exactly_one_confirmed_receipt`, receipts?.confirmed === 1 && appts?.confirmed === 1, detail);
  L.check(`${id}.one_winner_told_confirmed`, confirmed.length === 1 && confirmed.every((r) => card(r.data, 'appointment').verified === true && /^SBX-/.test(card(r.data, 'appointment').providerRef || '')), `${confirmed.length} confirmed card(s)`);
  L.check(`${id}.losers_told_nothing_booked`, told.length === RACE_N - 1 && other === 0, `${told.length} told "nothing was booked", ${other} other${other ? `: "${(results.find((r) => !confirmed.includes(r) && !told.includes(r))?.data?.reply ?? results.find((r) => !r.data)?.text ?? '').slice(0, 160)}"` : ''}`);
  L.check(`${id}.no_5xx`, results.every((r) => !is5xx(r)), `${results.filter(is5xx).length} 5xx/transport failures`);
  return detail;
}

async function leadFormIdempotency() {
  const t = ROOFTOPS[1];
  const tid = await tenantId(t.slug);
  const M = 10;
  const K = 8;
  const convs = await pool(Array.from({ length: M }, (_, i) => i), 5, async (i) => {
    const a = await chat(t, { action: 'test_drive', vin: t.vins[i % t.vins.length], language: i % 2 ? 'es' : 'en' });
    return { conversationId: a.data?.conversationId, form: card(a.data, 'lead_form'), who: shopper(200_000 + i, 'c2'), lang: i % 2 ? 'es' : 'en' };
  });
  L.check('C2.prepared', convs.every((c) => c.form), `${convs.filter((c) => c.form).length}/${M} lead forms offered`);
  const all = [];
  await Promise.all(
    convs.filter((c) => c.form).map(async (c) => {
      const body = { action: 'lead_capture', conversationId: c.conversationId, language: c.lang, lead: leadPayload(c.form.id, c.who) };
      const burst = await Promise.all(Array.from({ length: K }, () => chat(t, body)));
      const retries = [];
      for (let i = 0; i < 3; i += 1) retries.push(await chat(t, body));
      all.push(...burst, ...retries);
    }),
  );
  L.check('C2.no_5xx', all.every((r) => !is5xx(r)), `${all.length} submissions (${M} forms × ${K} concurrent + 3 retries), ${all.filter(is5xx).length} 5xx, statuses ${JSON.stringify(all.reduce((o, r) => ((o[r.status] = (o[r.status] || 0) + 1), o), {}))}`);

  // Deliveries are sent by the outbox tick (every 10 s); wait for them to settle.
  let rows = [];
  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    rows = await db.q(
      `SELECT l.email, COUNT(DISTINCT l.id)::int AS leads,
              (SELECT COUNT(*)::int FROM "ConsentRecord" c WHERE c."tenantId" = $1 AND c."leadId" IN (SELECT id FROM "Lead" WHERE "tenantId" = $1 AND email = l.email)) AS consents,
              (SELECT COUNT(DISTINCT c.channel)::int FROM "ConsentRecord" c WHERE c."tenantId" = $1 AND c."leadId" IN (SELECT id FROM "Lead" WHERE "tenantId" = $1 AND email = l.email)) AS consent_channels,
              (SELECT COUNT(*)::int FROM "LeadDelivery" d WHERE d."tenantId" = $1 AND d."leadId" IN (SELECT id FROM "Lead" WHERE "tenantId" = $1 AND email = l.email)) AS deliveries,
              (SELECT string_agg(d.id || ':' || d.status::text, ',') FROM "LeadDelivery" d WHERE d."tenantId" = $1 AND d."leadId" IN (SELECT id FROM "Lead" WHERE "tenantId" = $1 AND email = l.email)) AS delivery_states
         FROM "Lead" l WHERE l."tenantId" = $1 AND l.email = ANY($2::text[]) GROUP BY l.email`,
      tid, convs.map((c) => c.who.email),
    );
    if (rows?.length === M && rows.every((r) => /:(ACCEPTED|DEAD|BLOCKED)/.test(r.delivery_states || ''))) break;
  }
  rows = rows ?? [];
  const orphanConsents = await db.one(
    `SELECT COUNT(*)::int AS n FROM "ConsentRecord" WHERE "tenantId" = $1 AND "conversationExternalKey" = ANY($2::text[])`,
    tid, convs.map((c) => c.conversationId),
  );
  L.check('C2.one_lead_per_form', rows.length === M && rows.every((r) => r.leads === 1), `${rows.length}/${M} shoppers have a lead; leads per shopper: ${JSON.stringify(rows.map((r) => r.leads))}`);
  L.check('C2.one_consent_set_per_form', rows.every((r) => r.consents === 2 && r.consent_channels === 2) && orphanConsents?.n === M * 2, `consent rows per shopper ${JSON.stringify(rows.map((r) => r.consents))} (expected 2 = EMAIL + CALL); ${orphanConsents?.n} rows across the ${M} conversations (expected ${M * 2})`);
  L.check('C2.one_delivery_row_per_lead', rows.every((r) => r.deliveries === 1), `delivery rows per lead ${JSON.stringify(rows.map((r) => r.deliveries))}`);
  const mail = await smtp.byDelivery();
  const perDelivery = rows.map((r) => {
    const [id, status] = String(r.delivery_states || ':').split(':');
    return { id, status, accepted: mail.get(id)?.length ?? 0 };
  });
  L.check('C2.one_accepted_send_per_delivery', perDelivery.every((d) => d.status === 'ACCEPTED' && d.accepted === 1), `status/accepted-at-mock per delivery: ${JSON.stringify(perDelivery.map((d) => `${d.status}/${d.accepted}`))}`);
}

async function identicalTurns() {
  const t = ROOFTOPS[2];
  const tid = await tenantId(t.slug);
  // (a) the same slot selection, eight times at once, on one conversation.
  const p = await toPicker(t, 300_001, 'c3');
  if (L.check('C3a.prepared', !p.error, p.error ?? 'picker ready')) {
    const slot = p.picker.slots.find((s) => s.start === commonStart([p.picker], -3));
    const body = { action: 'appointment_select', conversationId: p.conversationId, appointment: { pickerId: p.picker.id, slotId: slot.id } };
    const burst = await Promise.all(Array.from({ length: 8 }, () => chat(t, body)));
    const replay = await chat(t, body);
    const all = [...burst, replay];
    const refs = new Set(all.map((r) => card(r.data, 'appointment')?.providerRef).filter(Boolean));
    const conv = await db.one(`SELECT id FROM "Conversation" WHERE "tenantId" = $1 AND "externalKey" = $2`, tid, p.conversationId);
    const a = await db.one(
      `SELECT COUNT(*) FILTER (WHERE a.status = 'CONFIRMED')::int AS confirmed, COUNT(*)::int AS total,
              (SELECT COUNT(*)::int FROM "AppointmentProviderReceipt" r WHERE r."appointmentId" IN (SELECT id FROM "Appointment" WHERE "conversationId" = $1) AND r.status = 'CONFIRMED') AS receipts
         FROM "Appointment" a WHERE a."conversationId" = $1`,
      conv?.id,
    );
    const confirmedCards = all.filter((r) => card(r.data, 'appointment')?.outcome === 'confirmed').length;
    L.check('C3a.same_selection_books_once', a?.confirmed === 1 && a?.receipts === 1 && refs.size === 1, { slot: slot.start, requests: all.length, confirmedCards, distinctProviderRefs: refs.size, db: a, status5xx: all.filter(is5xx).length, statuses: all.map((r) => r.status).join(',') });
    L.check('C3a.no_5xx', all.every((r) => !is5xx(r)), `${all.filter(is5xx).length} 5xx; non-confirmed replies: ${JSON.stringify([...new Set(all.filter((r) => card(r.data, 'appointment')?.outcome !== 'confirmed').map((r) => (r.data?.reply ?? r.text ?? '').slice(0, 90)))])}`);
  }
  // (b) the same free-text turn, eight times at once, on one conversation.
  const first = await chat(t, { message: 'Hello', language: 'en' });
  const cid = first.data?.conversationId;
  const burst = await Promise.all(Array.from({ length: 8 }, () => chat(t, { message: 'Do you have any SUVs?', language: 'en', conversationId: cid })));
  await sleep(300);
  const conv = await db.one(
    `SELECT COUNT(*)::int AS rows, MAX(c."stateVersion")::int AS state_version,
            (SELECT COUNT(*)::int FROM "Message" m JOIN "Conversation" x ON x.id = m."conversationId" WHERE x."tenantId" = $1 AND x."externalKey" = $2 AND m.role::text ILIKE 'user') AS user_msgs,
            (SELECT COUNT(*)::int FROM "Message" m JOIN "Conversation" x ON x.id = m."conversationId" WHERE x."tenantId" = $1 AND x."externalKey" = $2 AND m.role::text NOT ILIKE 'user') AS other_msgs
       FROM "Conversation" c WHERE c."tenantId" = $1 AND c."externalKey" = $2`,
    tid, cid,
  );
  const sameId = burst.every((r) => r.data?.conversationId === cid);
  const replies = new Set(burst.map((r) => r.data?.reply));
  L.check('C3b.identical_text_turns_ok', burst.every((r) => r.status === 201) && sameId && conv?.rows === 1, { requests: burst.length, statuses: burst.map((r) => r.status).join(','), sameConversationId: sameId, distinctReplies: replies.size, db: conv });
  L.check('C3b.every_turn_persisted_once', conv?.user_msgs === 9 && conv?.other_msgs === 9, `user messages ${conv?.user_msgs} (expected 9 = 1 + 8), assistant messages ${conv?.other_msgs} (expected 9)`);
}

async function isolation() {
  const tenants = [...ROOFTOPS.map((t) => ({ ...t, kind: 'rooftop' })), { ...GROUP, kind: 'group' }, { ...DEMO, kind: 'demo' }];
  const groupVins = new Set(ROOFTOPS.flatMap((r) => r.vins));
  const jobs = Array.from({ length: ISOLATION_N }, (_, i) => tenants[i % tenants.length]);
  const messages = ['Do you have any SUVs?', 'Show me trucks', 'What do you have in stock?', '¿Qué SUV tienen disponibles?', 'Show me your new inventory'];
  const res = await pool(jobs, 50, async (t, i) => ({ t, r: await chat(t, { message: messages[i % messages.length], language: messages[i % messages.length].startsWith('¿') ? 'es' : 'en' }) }));
  const ids = res.map((x) => x.r.data?.conversationId);
  L.check('C4.all_turns_ok', res.every((x) => x.r.status === 201), `${res.filter((x) => x.r.status === 201).length}/${ISOLATION_N} first turns returned 201`);
  L.check('C4.conversation_ids_unique', new Set(ids).size === ISOLATION_N && ids.every((x) => /^cv1\./.test(x || '')), `${new Set(ids).size} distinct ids for ${ISOLATION_N} parallel conversations`);
  let vehicles = 0;
  const wrong = [];
  for (const { t, r } of res) {
    for (const v of r.data?.vehicles ?? []) {
      vehicles += 1;
      if (t.kind === 'rooftop' && (!t.vins.includes(v.vin) || v.rooftopName !== t.name)) wrong.push({ tenant: t.slug, vin: v.vin, rooftopName: v.rooftopName });
      if (t.kind === 'group') {
        const owner = ROOFTOPS.find((x) => x.vins.includes(v.vin));
        if (!owner || !String(v.rooftopName || '').startsWith(owner.name)) wrong.push({ tenant: t.slug, vin: v.vin, rooftopName: v.rooftopName });
      }
      if (t.kind === 'demo' && (groupVins.has(v.vin) || v.rooftopName !== t.name)) wrong.push({ tenant: t.slug, vin: v.vin, rooftopName: v.rooftopName });
    }
  }
  const perTenant = tenants.map((t) => `${t.slug}:${res.filter((x) => x.t.slug === t.slug).reduce((n, x) => n + (x.r.data?.vehicles?.length ?? 0), 0)}`);
  L.check('C4.vehicles_belong_to_tenant', wrong.length === 0 && vehicles > 0, { vehiclesChecked: vehicles, wrong: wrong.slice(0, 5), perTenant });
  // North and South CDJR must never be conflated: each store only ever names itself.
  const south = res.filter((x) => x.t.slug === 'dial-cdjr-of-chicago').flatMap((x) => x.r.data?.vehicles ?? []);
  const north = res.filter((x) => x.t.slug === 'jeep-of-chicago').flatMap((x) => x.r.data?.vehicles ?? []);
  L.check('C4.north_and_south_cdjr_separate', south.length > 0 && north.length > 0 && south.every((v) => v.vin.startsWith('DEMO00000000000S')) && north.every((v) => v.vin.startsWith('DEMO00000000000N')), `south ${south.length} vehicles, north ${north.length} vehicles, no VIN crossed over`);

  // A conversation id is bound to its tenant: replaying it with another tenant's token starts a new one.
  const sample = res.filter((x) => x.r.data?.conversationId).slice(0, 35);
  const replays = await pool(sample, 10, async ({ t, r }) => {
    const other = pick(tenants.filter((x) => x.slug !== t.slug));
    const rr = await chat(other, { message: 'What are your hours?', language: 'en', conversationId: r.data.conversationId });
    return { from: t.slug, to: other.slug, original: r.data.conversationId, got: rr.data?.conversationId, issued: rr.data?.conversationIdIssued, status: rr.status };
  });
  const leaked = replays.filter((x) => x.status !== 201 || x.got === x.original || x.issued !== true);
  const owners = await db.q(`SELECT c."externalKey" AS k, COUNT(DISTINCT c."tenantId")::int AS tenants FROM "Conversation" c WHERE c."externalKey" = ANY($1::text[]) GROUP BY 1`, sample.map((x) => x.r.data.conversationId));
  L.check('C4.conversation_id_is_tenant_bound', leaked.length === 0 && (owners ?? []).every((o) => o.tenants === 1), `${replays.length} cross-tenant replays, ${leaked.length} reused the foreign id; ${(owners ?? []).filter((o) => o.tenants !== 1).length} ids stored under more than one tenant`);

  // Asking one rooftop about another rooftop's VIN must not return that vehicle.
  const probes = [];
  for (const t of ROOFTOPS) {
    const other = pick(ROOFTOPS.filter((x) => x.slug !== t.slug));
    for (const action of ['vehicle_detail', 'test_drive', 'payment_estimate']) {
      const r = await chat(t, { action, vin: other.vins[0], language: 'en' });
      const blob = JSON.stringify(r.data ?? {});
      probes.push({ tenant: t.slug, action, foreignVin: other.vins[0], status: r.status, leaked: blob.includes(other.vins[0]) && (r.data?.vehicles ?? []).some((v) => v.vin === other.vins[0]), namesOther: blob.includes(other.name) });
    }
  }
  const bad = probes.filter((x) => x.leaked || x.namesOther || x.status >= 500);
  L.check('C4.foreign_vin_not_served', bad.length === 0, `${probes.length} foreign-VIN requests across the five rooftops, ${bad.length} returned the other rooftop's vehicle or name${bad.length ? ` ${JSON.stringify(bad.slice(0, 3))}` : ''}`);
}

async function main() {
  console.log(`concurrency checks → ${BASE}${BASE_B ? ` + ${BASE_B}` : ''} (deterministic engine, sandbox scheduler, synthetic shoppers)`);
  const races = [];
  races.push(await slotRace('C1', ROOFTOPS[0], { bases: [BASE], slotIndex: -1 }));
  if (BASE_B) races.push(await slotRace('C1x', ROOFTOPS[4], { bases: [BASE, BASE_B], slotIndex: -2 }));
  await leadFormIdempotency();
  await identicalTurns();
  await isolation();
  const result = { ...L.result(), at: new Date().toISOString(), races };
  if (process.env.SOAK_OUT) {
    mkdirSync(path.join(process.env.SOAK_OUT, 'out'), { recursive: true });
    const f = path.join(process.env.SOAK_OUT, 'out', `concurrency-${result.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(`result → ${f}`);
  }
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  await db.close();
  process.exit(result.failed ? 2 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
