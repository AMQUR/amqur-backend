#!/usr/bin/env node
/**
 * Hosted isolated-staging acceptance journey (EN + ES) for five Dial rooftops.
 * Synthetic contacts only (example.invalid / 555-01xx). Requires:
 *   STAFF_JWT (MFA-verified SUPER_ADMIN) or STAGING_ADMIN_EMAIL + STAGING_ADMIN_PASSWORD + MFA_SECRET
 * Does not enable live CRM/SMS. ADF must be sandbox sink; scheduler sandbox.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const API =
  process.env.STAGING_API_BASE?.replace(/\/$/, '') ||
  'https://backend-staging-staging-b699.up.railway.app';
const ORIGIN =
  process.env.STAGING_WIDGET_ORIGIN ||
  'https://widget-staging-staging.up.railway.app';
const SECRETS = resolve(
  process.env.LOCAL_SECRETS_DIR ||
    resolve(import.meta.dirname, '../../.local-secrets'),
);

const ROOFTOPS = [
  { slug: 'dial-chevy-of-chicago', name: 'Dial Chevy of Chicago' },
  { slug: 'dial-nissan-of-chicago', name: 'Dial Nissan of Chicago' },
  { slug: 'infiniti-of-chicago', name: 'INFINITI of Chicago' },
  { slug: 'dial-cdjr-of-chicago', name: 'Dial Chrysler Dodge Jeep Ram of Chicago' },
  { slug: 'jeep-of-chicago', name: 'Jeep of Chicago' },
];

function secret(name) {
  try {
    return readFileSync(resolve(SECRETS, name), 'utf8').trim();
  } catch {
    return '';
  }
}

function base32ToBuf(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = s.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of cleaned) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secretB32, step = 30) {
  const key = base32ToBuf(secretB32);
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}

async function req(method, path, { headers = {}, body, cookieJar } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const h = { ...headers };
  if (cookieJar?.value) h.Cookie = cookieJar.value;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  if (cookieJar && setCookie.length) {
    const parts = setCookie.map((c) => c.split(';')[0]);
    cookieJar.value = parts.join('; ');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  const data = json?.data !== undefined ? json.data : json;
  return { status: res.status, json, data, ok: res.ok };
}

function unwrap(r, label) {
  if (!r.ok && r.status >= 400) {
    throw new Error(
      `${label} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`,
    );
  }
  return r.data;
}

function card(chat, kind) {
  return (chat?.cards || []).find((c) => c.kind === kind);
}

async function ensureStaffJwt() {
  let jwt = process.env.STAFF_JWT || secret('staff-jwt.txt');
  if (jwt) {
    // refresh if MFA already enrolled via login+otp
    const probe = await req('GET', '/api/ops/inbox', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (probe.status !== 403 || probe.json?.message !== 'mfa_enrollment_required') {
      if (probe.status < 500) return jwt;
    }
  }
  const email = process.env.STAGING_ADMIN_EMAIL || secret('admin-email.txt');
  const password =
    process.env.STAGING_ADMIN_PASSWORD || secret('admin-pass.txt');
  const mfaSecret = process.env.MFA_SECRET || secret('mfa-secret.txt');
  if (!email || !password) throw new Error('Missing staging admin credentials');
  const login = unwrap(
    await req('POST', '/api/auth/login', {
      body: { email, password, tenantSlug: 'dial-auto-group' },
    }),
    'login',
  );
  if (login.mfa_required || login.mfa_token) {
    const challenge = login.mfa_token;
    if (!mfaSecret || !challenge)
      throw new Error('MFA challenge present but no MFA_SECRET / challenge');
    const verified = unwrap(
      await req('POST', '/api/auth/mfa/verify', {
        body: { mfa_token: challenge, code: totp(mfaSecret) },
      }),
      'mfa/verify',
    );
    jwt = verified.access_token;
  } else if (login.access_token) {
    jwt = login.access_token;
  }
  if (!jwt) throw new Error('No staff JWT');
  writeFileSync(resolve(SECRETS, 'staff-jwt.txt'), jwt);
  return jwt;
}

async function mintWidget(jwt, slug) {
  const invite = unwrap(
    await req('POST', '/api/canary/invites', {
      headers: { Authorization: `Bearer ${jwt}` },
      body: {
        tenantSlug: slug,
        locationSlug: 'main',
        testerLabel: `hosted-e2e-${slug}`,
      },
    }),
    `canary/invite ${slug}`,
  );
  const jar = { value: '' };
  unwrap(
    await req('POST', '/api/public/canary-redeem', {
      headers: { Origin: ORIGIN },
      body: { inviteToken: invite.inviteToken },
      cookieJar: jar,
    }),
    `canary/redeem ${slug}`,
  );
  const tok = unwrap(
    await req('POST', '/api/public/widget-token', {
      headers: { Origin: ORIGIN, Cookie: jar.value },
      body: { tenantSlug: slug, locationSlug: 'main' },
    }),
    `widget-token ${slug}`,
  );
  return { token: tok.token, cookie: jar.value };
}

async function chat(token, message, extra = {}) {
  const r = await req('POST', '/api/chat', {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: ORIGIN,
    },
    body: { message, ...extra },
  });
  return { status: r.status, data: unwrap(r, 'chat') };
}

async function runRooftop(jwt, rooftop) {
  const result = {
    slug: rooftop.slug,
    name: rooftop.name,
    steps: {},
    ok: true,
    errors: [],
  };
  const fail = (step, err) => {
    result.ok = false;
    result.errors.push(`${step}: ${err}`);
    result.steps[step] = { ok: false, error: String(err) };
  };
  const pass = (step, detail = {}) => {
    result.steps[step] = { ok: true, ...detail };
  };

  let token;
  try {
    ({ token } = await mintWidget(jwt, rooftop.slug));
    pass('canary_widget_token', { tokenLen: token.length });
  } catch (e) {
    fail('canary_widget_token', e.message);
    return result;
  }

  // Group routing probe: discovery EN
  try {
    const { data } = await chat(token, 'What vehicles do you have in stock?', {
      language: 'en',
    });
    const vins = (data.vehicles || []).map((v) => v.vin);
    if (!vins.length) throw new Error('no vehicles');
    const foreign = (data.vehicles || []).filter(
      (v) => v.rooftopName && v.rooftopName !== rooftop.name,
    );
    if (foreign.length)
      throw new Error(`foreign rooftop vehicles: ${JSON.stringify(foreign)}`);
    pass('discovery_en', {
      vehicles: vins.length,
      conversationId: data.conversationId,
    });
    result.conversationId = data.conversationId;
  } catch (e) {
    fail('discovery_en', e.message);
  }

  // Discovery ES
  try {
    const { data } = await chat(token, '¿Qué vehículos tienen?', {
      language: 'es',
    });
    if (data.conversation?.language !== 'es')
      throw new Error(`language=${data.conversation?.language}`);
    if (!(data.vehicles || []).length) throw new Error('no vehicles es');
    pass('discovery_es', {
      vehicles: (data.vehicles || []).length,
      language: data.conversation.language,
    });
  } catch (e) {
    fail('discovery_es', e.message);
  }

  // Lead + consent + scheduler + ADF (sandbox)
  try {
    const disc = await chat(token, 'What vehicles do you have in stock?', {
      language: 'en',
      conversationId: result.conversationId,
    });
    const vin = (disc.data.vehicles || [])[0]?.vin;
    if (!vin) throw new Error('no vin for lead');
    result.conversationId = disc.data.conversationId;
    const offered = await chat(token, '', {
      conversationId: result.conversationId,
      action: 'test_drive',
      vin,
    });
    result.conversationId = offered.data.conversationId;
    const form = card(offered.data, 'lead_form');
    if (!form) throw new Error('no lead_form card');
    if (form.rooftopName !== rooftop.name)
      throw new Error(`form rooftop ${form.rooftopName}`);
    const submitted = await chat(token, '', {
      conversationId: result.conversationId,
      action: 'lead_capture',
      lead: {
        formId: form.id,
        firstName: 'Pat',
        lastName: 'Rivera',
        email: `pat.${rooftop.slug}@example.invalid`,
        phone: '312-555-0142',
        preferredChannel: 'EMAIL',
        consents: [
          { channel: 'EMAIL', granted: true, version: form.consent.version },
          { channel: 'CALL', granted: false, version: form.consent.version },
        ],
      },
    });
    result.conversationId = submitted.data.conversationId;
    const picker = card(submitted.data, 'appointment_picker');
    if (!picker?.slots?.length)
      throw new Error(`no appointment_picker: ${JSON.stringify(submitted.data.cards?.map((c)=>c.kind))}`);
    if (picker.mode !== 'provider_slots')
      throw new Error(`picker mode ${picker.mode}`);
    const booked = await chat(token, '', {
      conversationId: result.conversationId,
      action: 'appointment_select',
      appointment: { pickerId: picker.id, slotId: picker.slots[0].id },
    });
    result.conversationId = booked.data.conversationId;
    const appt = card(booked.data, 'appointment');
    if (!appt) throw new Error('no appointment card');
    if (appt.status !== 'CONFIRMED' || !appt.sandbox)
      throw new Error(`appt ${JSON.stringify(appt)}`);
    if (!String(appt.providerRef || '').startsWith('SBX-'))
      throw new Error(`providerRef ${appt.providerRef}`);
    pass('lead_consent_scheduler', {
      vin,
      appointmentId: appt.id,
      providerRef: appt.providerRef,
      formId: form.id,
    });
    result.appointmentId = appt.id;
  } catch (e) {
    fail('lead_consent_scheduler', e.message);
  }

  // ADF / outbox evidence via ops if available
  try {
    const deliveries = await req('GET', '/api/ops/lead-deliveries?limit=20', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // endpoint may differ — also try scorecard / inbox
    const score = await req('GET', '/api/ops/group/readiness', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    pass('ops_probe', {
      leadDeliveriesStatus: deliveries.status,
      readinessStatus: score.status,
      readinessKeys:
        score.data && typeof score.data === 'object'
          ? Object.keys(score.data).slice(0, 12)
          : [],
    });
  } catch (e) {
    fail('ops_probe', e.message);
  }

  // Human handoff
  try {
    const start = await chat(token, 'Hi', {
      language: 'en',
      conversationId: undefined,
    });
    const h = await chat(token, 'I want to talk to a person', {
      conversationId: start.data.conversationId,
    });
    const handoff = card(h.data, 'handoff');
    if (!handoff) throw new Error('no handoff card');
    const inbox = await req('GET', '/api/ops/inbox', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const items = inbox.data?.items || inbox.data || [];
    const found = Array.isArray(items)
      ? items.some((i) => i.id === start.data.conversationId || i.conversationId === start.data.conversationId)
      : false;
    pass('human_handoff', {
      handoff: true,
      inboxStatus: inbox.status,
      inboxFound: found,
      conversationId: start.data.conversationId,
    });
  } catch (e) {
    fail('human_handoff', e.message);
  }

  // Service / parts ES soft checks
  try {
    const s = await chat(token, 'Necesito un cambio de aceite', {
      language: 'es',
    });
    if (s.data.conversation?.language !== 'es')
      throw new Error('service not es');
    if (card(s.data, 'appointment'))
      throw new Error('service must not auto-book');
    const p = await chat(token, 'Do you have front brake pads for a 2019 model?', {
      language: 'en',
    });
    if (!card(p.data, 'parts') && !/VIN/i.test(p.data.reply || ''))
      throw new Error('parts reply missing VIN ask');
    if (/\$\s?\d|in stock|ordered/i.test(p.data.reply || ''))
      throw new Error('parts overclaimed');
    pass('service_parts_en_es', { serviceLang: s.data.conversation?.language });
  } catch (e) {
    fail('service_parts_en_es', e.message);
  }

  // Error recovery
  try {
    const a = await req('POST', '/api/chat', {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
      body: {
        message: '',
        action: 'appointment_select',
        appointment: { pickerId: 'pk_forged', slotId: 'sl_forged' },
      },
    });
    const b = await req('POST', '/api/chat', {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
      body: {
        message: '',
        action: 'lead_capture',
        lead: {
          formId: 'lf_forged',
          firstName: 'X',
          lastName: 'Y',
          email: 'x@example.invalid',
          preferredChannel: 'EMAIL',
          consents: [],
        },
      },
    });
    const blob = JSON.stringify(a.json) + JSON.stringify(b.json);
    if (/confirmed|SBX-/i.test(blob) && !/forged|invalid|not found/i.test(blob))
      throw new Error('forged actions looked confirmed');
    const ok = await chat(token, 'What vehicles do you have in stock?');
    if (!(ok.data.vehicles || []).length) throw new Error('recovery chat failed');
    pass('error_recovery', { a: a.status, b: b.status });
  } catch (e) {
    fail('error_recovery', e.message);
  }

  return result;
}

async function groupRouting(jwt) {
  // Mint tokens for two rooftops; ensure north/south CDJR not conflated via slugs
  const north = ROOFTOPS.find((r) => r.slug === 'jeep-of-chicago');
  const south = ROOFTOPS.find((r) => r.slug === 'dial-cdjr-of-chicago');
  const a = await mintWidget(jwt, north.slug);
  const b = await mintWidget(jwt, south.slug);
  const ra = await chat(a.token, 'What vehicles do you have in stock?');
  const rb = await chat(b.token, 'What vehicles do you have in stock?');
  const vinsA = new Set((ra.data.vehicles || []).map((v) => v.vin));
  const vinsB = new Set((rb.data.vehicles || []).map((v) => v.vin));
  const overlap = [...vinsA].filter((v) => vinsB.has(v));
  return {
    ok: vinsA.size > 0 && vinsB.size > 0 && overlap.length === 0,
    north: { slug: north.slug, vins: [...vinsA] },
    south: { slug: south.slug, vins: [...vinsB] },
    overlap,
  };
}

async function main() {
  const jwt = await ensureStaffJwt();
  const started = new Date().toISOString();
  const rooftops = [];
  for (const r of ROOFTOPS) {
    console.error(`… ${r.slug}`);
    rooftops.push(await runRooftop(jwt, r));
  }
  let group;
  try {
    group = await groupRouting(jwt);
  } catch (e) {
    group = { ok: false, error: e.message };
  }

  // Unauthorized origin still refused
  const evil = await req('POST', '/api/public/widget-token', {
    headers: { Origin: 'https://unauthorized.example' },
    body: { tenantSlug: 'jeep-of-chicago', locationSlug: 'main' },
  });

  const report = {
    started,
    finished: new Date().toISOString(),
    api: API,
    origin: ORIGIN,
    version: (await req('GET', '/api/version')).data,
    unauthorizedOriginStatus: evil.status,
    groupRouting: group,
    rooftops,
    summary: {
      rooftopsOk: rooftops.filter((r) => r.ok).length,
      rooftopsTotal: rooftops.length,
      allOk:
        rooftops.every((r) => r.ok) &&
        group.ok === true &&
        evil.status === 403,
    },
  };

  const outDir = resolve(import.meta.dirname, '../../docs/evidence');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(
    outDir,
    `hosted-isolated-staging-journey-${started.slice(0, 10).replace(/-/g, '')}.json`,
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outPath, summary: report.summary }, null, 2));
  if (!report.summary.allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
