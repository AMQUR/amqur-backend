#!/usr/bin/env node
/**
 * Automated internal-canary matrix — every check that can run without a
 * human, executed against live staging for all five pilot tenants.
 *
 * Usage:
 *   node scripts/canary-automated-matrix.mjs [--api https://...] [--widget https://...]
 *
 * Writes evidence JSON to test/evidence/canary-matrix-<timestamp>.json and
 * exits non-zero if any check fails. Human employee conversations are NOT
 * simulated here — see docs/canary/employee-test-script.md.
 */

const API = argValue('--api') || 'https://staging-api.dialusnow.com/api';
const WIDGET = argValue('--widget') || 'https://staging-widget.dialusnow.com';
const APPROVED_ORIGIN = 'https://staging-widget.dialusnow.com';

const TENANTS = [
  'jeep-of-chicago',
  'dial-nissan-of-chicago',
  'dial-chevy-of-chicago',
  'infiniti-of-chicago',
  'dial-cdjr-of-chicago',
];

const EXPECTED_CONSENT =
  'Internal staging environment for authorized testing only. Do not enter real customer information.';
const EXPECTED_DISCLAIMER =
  'Vehicle availability, pricing, incentives, and dealership information are provided only when verified.';
const EXPECTED_ESCALATION =
  'I can save your request for dealership staff to review.';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail ?? null });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

async function jsonGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body?.data ?? body };
}

async function mintToken(tenant, origin) {
  const res = await fetch(`${API}/public/widget-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ tenantSlug: tenant, locationSlug: 'main' }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, token: (body?.data ?? body)?.token };
}

// --- release identity ---------------------------------------------------
const version = await jsonGet(`${API.replace(/\/api$/, '')}/api/version`);
record(
  'api /version reachable with commit identity',
  version.status === 200 &&
    /^[0-9a-f]{40}$/.test(version.body?.commitSha ?? ''),
  `commit=${version.body?.commitSha}`,
);

const widgetVersion = await jsonGet(`${WIDGET}/version.json`);
record(
  'widget /version.json reachable with commit identity',
  widgetVersion.status === 200 &&
    /^[0-9a-f]{40}$/.test(widgetVersion.body?.commitSha ?? ''),
  `commit=${widgetVersion.body?.commitSha}`,
);

const loader = await fetch(`${WIDGET}/assistant-widget.iife.js`);
const head = (await loader.text()).slice(0, 40);
record(
  'widget loader served and namespaced',
  loader.status === 200 && head.includes('AmqurWidgetBundle'),
);

const health = await jsonGet(`${API}/health`);
record(
  'api health: database up',
  health.status === 200 && health.body?.checks?.database === 'up',
  `redis=${health.body?.checks?.redis}`,
);

// --- per-tenant checks ----------------------------------------------------
const seenNames = new Set();
for (const t of TENANTS) {
  const cfg = await jsonGet(
    `${API}/public/widget-config?tenantSlug=${t}&locationSlug=main`,
  );
  const p = cfg.body ?? {};
  record(`[${t}] widget-config 200`, cfg.status === 200);

  const raw = JSON.stringify(p);
  record(
    `[${t}] no internal ids or private keys in public payload`,
    !/"id"|allowedOrigins|escalationRecipients|inventoryFeedUrl|secret/i.test(
      raw,
    ),
  );

  record(
    `[${t}] staging consent text exact`,
    p.consentText === EXPECTED_CONSENT,
  );
  record(
    `[${t}] verified-only disclaimer exact`,
    p.branding?.disclaimerText === EXPECTED_DISCLAIMER,
  );
  record(
    `[${t}] durable-handoff escalation wording (never claims staff notified)`,
    p.branding?.escalationMessage === EXPECTED_ESCALATION,
  );

  const f = p.features ?? {};
  record(
    `[${t}] unverified capabilities disabled`,
    [
      f.inventory,
      f.payments,
      f.serviceAi,
      f.partsAi,
      f.multilingual,
      f.voiceAi,
    ].every((v) => !v),
    JSON.stringify({ inventory: f.inventory, payments: f.payments }),
  );
  record(
    `[${t}] pilot capabilities enabled (chat, leadCapture, handoff)`,
    Boolean(f.chat && f.leadCapture && f.handoff),
  );

  record(
    `[${t}] isolated tenant identity`,
    p.tenant?.slug === t && !seenNames.has(p.tenant?.name),
    p.tenant?.name,
  );
  seenNames.add(p.tenant?.name);

  const ok = await mintToken(t, APPROVED_ORIGIN);
  record(`[${t}] token 201 from approved origin`, ok.status === 201);

  const evil = await mintToken(t, 'https://unauthorized.example');
  record(`[${t}] token 403 from unauthorized origin`, evil.status === 403);

  const noOrigin = await mintToken(t, null);
  record(
    `[${t}] token 403 with missing origin (fail closed)`,
    noOrigin.status === 403,
  );

  if (ok.token) {
    // Forged tenant/location identifiers in the body must be rejected by
    // DTO whitelisting — trusted claims come from the token only.
    const forged = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ok.token}`,
      },
      body: JSON.stringify({
        message: 'hi',
        conversationId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'forged-tenant-id',
      }),
    });
    record(
      `[${t}] forged tenantId in body rejected (400)`,
      forged.status === 400,
    );
  }
}

// --- expired/garbage token ------------------------------------------------
const garbage = await fetch(`${API}/tenants`, {
  headers: { Authorization: 'Bearer not.a.jwt' },
});
record('garbage bearer token rejected (401)', garbage.status === 401);

// --- write evidence ---------------------------------------------------------
const failed = results.filter((r) => !r.pass);
const evidence = {
  ranAt: new Date().toISOString(),
  api: API,
  widget: WIDGET,
  apiCommit: version.body?.commitSha ?? null,
  widgetCommit: widgetVersion.body?.commitSha ?? null,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  notHumanVerified: [
    'employee conversations (100-conversation target)',
    'prompt-injection resistance in live chat',
    'duplicate lead handling through the full UI',
    'provider-outage fallback wording in live chat',
    'slow-network behavior on real devices',
  ],
};

const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('test/evidence', { recursive: true });
const file = `test/evidence/canary-matrix-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  'test/evidence/canary-matrix-latest.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  `\n${evidence.passed}/${evidence.total} checks passed — evidence: ${file}`,
);
process.exit(failed.length ? 1 : 0);
