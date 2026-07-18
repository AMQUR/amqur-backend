#!/usr/bin/env node
/**
 * Production fail-closed matrix — empty allowedOrigins.
 *
 *   node scripts/production-failclosed-matrix.mjs \
 *     [--api https://api.dialusnow.com/api]
 */
const API = (argValue('--api') || 'https://api.dialusnow.com/api').replace(
  /\/$/,
  '',
);

const TENANTS = [
  { slug: 'jeep-of-chicago', name: 'Jeep of Chicago' },
  { slug: 'dial-nissan-of-chicago', name: 'Dial Nissan of Chicago' },
  { slug: 'dial-chevy-of-chicago', name: 'Dial Chevy of Chicago' },
  { slug: 'infiniti-of-chicago', name: 'INFINITI of Chicago' },
  { slug: 'dial-cdjr-of-chicago', name: 'Dial CDJR of Chicago' },
];

const EXPECTED_DISCLAIMER =
  'Vehicle availability, pricing, incentives, and dealership information are provided only when verified.';
const EXPECTED_ESCALATION =
  'I can save your request for dealership staff to review.';
const STAGING_CONSENT =
  'Internal staging environment for authorized testing only. Do not enter real customer information.';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail ?? null });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function jsonGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body?.data ?? body, raw: body };
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
  return { status: res.status };
}

const version = await jsonGet(`${API}/version`);
record(
  'api /version reachable',
  version.status === 200,
  `env=${version.body?.environment ?? '?'}`,
);

const health = await jsonGet(`${API}/health/ready`);
record(
  'api ready',
  health.status === 200 &&
    health.body?.checks?.database === 'up' &&
    health.body?.checks?.redis === 'up',
);

const seen = new Set();
for (const { slug, name } of TENANTS) {
  const cfg = await jsonGet(
    `${API}/public/widget-config?tenantSlug=${slug}&locationSlug=main`,
  );
  record(`[${slug}] widget-config 200`, cfg.status === 200);
  const p = cfg.body ?? {};
  const raw = JSON.stringify(cfg.raw ?? p);
  record(
    `[${slug}] no internal ids / secrets in public payload`,
    !/"id"|allowedOrigins|escalationRecipients|inventoryFeedUrl|secret|password|BEGIN PRIVATE/i.test(
      raw,
    ),
  );
  record(
    `[${slug}] no staging consent leak`,
    p.consentText !== STAGING_CONSENT,
  );
  record(
    `[${slug}] verified-only disclaimer`,
    p.branding?.disclaimerText === EXPECTED_DISCLAIMER,
  );
  record(
    `[${slug}] durable handoff wording`,
    p.branding?.escalationMessage === EXPECTED_ESCALATION,
  );
  const f = p.features ?? {};
  record(
    `[${slug}] unverified capabilities disabled`,
    [f.inventory, f.payments, f.serviceAi, f.partsAi, f.appointments, f.voiceAi].every(
      (v) => !v,
    ),
  );
  record(
    `[${slug}] chat/leadCapture/handoff enabled`,
    Boolean(f.chat && f.leadCapture && f.handoff),
  );
  record(
    `[${slug}] distinct identity`,
    p.tenant?.slug === slug && p.tenant?.name === name && !seen.has(name),
    p.tenant?.name,
  );
  seen.add(name);
  record(
    `[${slug}] location main`,
    p.location?.slug === 'main',
  );

  for (const [label, origin] of [
    ['missing origin', null],
    ['evil origin', 'https://evil.example'],
    ['staging-widget origin', 'https://staging-widget.dialusnow.com'],
    ['foreign dealership origin', 'https://www.example.com'],
  ]) {
    const tok = await mintToken(slug, origin);
    record(`[${slug}] token 403 (${label})`, tok.status === 403, `HTTP ${tok.status}`);
  }
}

const bs = await fetch(`${API}/auth/bootstrap`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    secret: 'dummy-bootstrap-secret-xx',
    tenantName: 'x y',
    tenantSlug: 'x-y',
    email: 'second@example.com',
    password: 'irrelevant-1234',
    firstName: 'No',
    lastName: 'Body',
  }),
});
record('bootstrap disabled (not 2xx)', bs.status >= 400, `HTTP ${bs.status}`);

const failed = results.filter((r) => !r.pass);
const evidence = {
  ranAt: new Date().toISOString(),
  api: API,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('test/evidence', { recursive: true });
const file = `test/evidence/production-failclosed-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  'test/evidence/production-failclosed-latest.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(`\n${evidence.passed}/${evidence.total} — ${file}`);
process.exit(failed.length ? 1 : 0);
