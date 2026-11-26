import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  assertDialBootstrapAllowed,
  parseBootstrapWidgetOrigins,
} from './dial-bootstrap-gate';
import {
  buildGroupDirectoryDoc,
  buildRooftopDirectoryDoc,
  HOURS_NOT_ON_FILE,
} from './dial-directory-docs';
import {
  DIAL_GROUP,
  DIAL_IDENTITY_AS_OF,
  DIAL_IDENTITY_SOURCE,
  DIAL_ROOFTOPS,
  describeSchedulerLink,
  formatDialAddress,
} from './dial-store-identity';

/**
 * Expected values hard-asserted from
 *   dial-auto-group-platform/src/stores/config.ts   (read 2026-11-23; facts as of 2026-11-12)
 * `rooftops[].departments[].phone` (owner-approved MAIN lines), `address`, `sideOfTown`.
 * The sibling repo is not part of this repository, so CI cannot read it; when it happens to
 * be checked out next to this one, the last test cross-checks the constant against the file.
 */
const EXPECTED = [
  {
    id: 'chevy',
    slug: 'dial-chevy-of-chicago',
    name: 'Dial Chevy of Chicago',
    side: 'South Side',
    address: '6603 S Western Ave, Chicago, IL 60636',
    sales: '773-423-3000',
    service: '773-423-3002',
    parts: '773-423-3003',
  },
  {
    id: 'nissan',
    slug: 'dial-nissan-of-chicago',
    name: 'Dial Nissan of Chicago',
    side: 'South Side',
    address: '7410 S Western Ave, Chicago, IL 60636',
    sales: '773-776-8200',
    service: '773-776-9045',
    parts: '773-776-9056',
  },
  {
    id: 'infiniti',
    slug: 'infiniti-of-chicago',
    name: 'INFINITI of Chicago',
    side: 'Near South Side',
    address: '2711 S State St, Chicago, IL 60616',
    sales: '312-476-8000',
    service: '312-476-8020',
    parts: '312-476-8025',
  },
  {
    id: 'cdjr-south',
    slug: 'dial-cdjr-of-chicago',
    name: 'Dial Chrysler Dodge Jeep Ram of Chicago',
    side: 'South Side',
    address: '7340 S Western Ave, Chicago, IL 60636',
    sales: '773-476-7800',
    service: '773-476-7802',
    parts: '773-476-7729',
  },
  {
    id: 'cdjr-north',
    slug: 'jeep-of-chicago',
    name: 'Jeep of Chicago',
    side: 'North Side',
    address: '5950 N Western Ave, Chicago, IL 60659',
    sales: '773-334-3400',
    service: '773-828-1050',
    parts: '773-828-9952',
  },
] as const;

/**
 * Numbers that must NEVER appear: every `forwardingCandidate` in config.ts (2026-11-12) and
 * the Google Ads tracking line named in its call-tracking note.
 */
const FORBIDDEN_NUMBERS = [
  '773-432-3008',
  '773-423-3011',
  '773-432-3003',
  '773-471-8251',
  '772-471-8252',
  '773-471-8253',
  '773-476-7332',
  '773-476-8322',
  '773-476-9477',
  '872-365-4852',
  '872-365-4853',
  '872-365-4854',
  '773-974-6051',
];

const digits = (s: string) => s.replace(/\D/g, '');
const byId = (id: string) =>
  DIAL_ROOFTOPS.find((r) => r.sourceRecordId === id)!;
const allDocs = () => [
  buildGroupDirectoryDoc(),
  ...DIAL_ROOFTOPS.map(buildRooftopDirectoryDoc),
];

describe('Dial store identity constant', () => {
  it('holds exactly the five rooftops with unique ids and slugs', () => {
    expect(DIAL_ROOFTOPS).toHaveLength(5);
    expect(new Set(DIAL_ROOFTOPS.map((r) => r.tenantSlug)).size).toBe(5);
    expect(new Set(DIAL_ROOFTOPS.map((r) => r.sourceRecordId)).size).toBe(5);
    expect(DIAL_ROOFTOPS.map((r) => r.tenantSlug)).not.toContain(
      DIAL_GROUP.slug,
    );
    expect(DIAL_GROUP.slug).toBe('dial-auto-group');
    expect(DIAL_GROUP.groupPhone).toBeNull();
  });

  it.each(EXPECTED)(
    '$id matches config.ts name, side, address and MAIN phones',
    (e) => {
      const r = byId(e.id);
      expect(r.tenantSlug).toBe(e.slug);
      expect(r.publicName.value).toBe(e.name);
      expect(r.sideOfTown.value).toBe(e.side);
      expect(formatDialAddress(r.address.value)).toBe(e.address);
      expect(r.phones.sales.value).toBe(e.sales);
      expect(r.phones.service.value).toBe(e.service);
      expect(r.phones.parts.value).toBe(e.parts);
    },
  );

  it('carries provenance on every fact', () => {
    for (const r of DIAL_ROOFTOPS) {
      const facts = [
        r.publicName,
        r.sideOfTown,
        r.address,
        r.brands,
        r.websiteUrl,
        r.scheduleServiceUrl,
        ...Object.values(r.phones),
      ];
      for (const f of facts) {
        expect(f.source).toBe(DIAL_IDENTITY_SOURCE);
        expect(f.asOf).toBe(DIAL_IDENTITY_AS_OF);
        expect(['OWNER_APPROVED', 'PUBLIC_CORROBORATED']).toContain(f.status);
        expect(f.sourceRecordId).toBe(r.sourceRecordId);
      }
      for (const p of Object.values(r.phones))
        expect(p.status).toBe('OWNER_APPROVED');
    }
  });

  it('keeps the North and South CDJR stores apart', () => {
    const south = byId('cdjr-south');
    const north = byId('cdjr-north');
    expect(south.groupSide).toBe('south');
    expect(north.groupSide).toBe('north');
    expect(south.sideOfTown.value).toBe('South Side');
    expect(north.sideOfTown.value).toBe('North Side');
    expect(south.address.value.street).toBe('7340 S Western Ave');
    expect(north.address.value.street).toBe('5950 N Western Ave');
    expect(south.tenantSlug).not.toBe(north.tenantSlug);
    expect(south.websiteUrl.value).not.toBe(north.websiteUrl.value);
    expect(south.scheduleServiceUrl.value).not.toBe(
      north.scheduleServiceUrl.value,
    );
    for (const d of ['sales', 'service', 'parts'] as const)
      expect(south.phones[d].value).not.toBe(north.phones[d].value);
    // No other store carries a routing side.
    expect(
      DIAL_ROOFTOPS.filter((r) => r.groupSide).map((r) => r.sourceRecordId),
    ).toEqual(['cdjr-south', 'cdjr-north']);
  });

  it('uses fifteen distinct phone numbers', () => {
    const phones = DIAL_ROOFTOPS.flatMap((r) =>
      Object.values(r.phones).map((p) => p.value),
    );
    expect(phones).toHaveLength(15);
    expect(new Set(phones).size).toBe(15);
  });

  it('contains no forwarding-candidate or tracking number anywhere', () => {
    const haystack = digits(
      JSON.stringify(DIAL_ROOFTOPS) +
        JSON.stringify(DIAL_GROUP) +
        JSON.stringify(allDocs()),
    );
    for (const n of FORBIDDEN_NUMBERS)
      expect(haystack).not.toContain(digits(n));
  });

  it('describes a scheduler link without its query string', () => {
    for (const r of DIAL_ROOFTOPS) {
      const d = describeSchedulerLink(r);
      expect(d).not.toMatch(/accessToken|jdcauto|\?/i);
      expect(d).toContain(new URL(r.scheduleServiceUrl.value).host);
    }
  });
});

describe('Dial store directory documents', () => {
  it('never contain a scheduler URL or access token', () => {
    const text = JSON.stringify(allDocs());
    expect(text).not.toMatch(/accessToken|tekioncloud|jdcauto/i);
    for (const r of DIAL_ROOFTOPS)
      expect(text).not.toContain(r.scheduleServiceUrl.value);
  });

  it('give each rooftop one self-contained chunk with its own facts only', () => {
    for (const r of DIAL_ROOFTOPS) {
      const doc = buildRooftopDirectoryDoc(r);
      expect(doc.title).toBe(`${r.publicName.value} — store directory`);
      expect(doc.chunks).toHaveLength(1);
      // One orchestrator path truncates a hit to 700 characters.
      expect(doc.content.length).toBeLessThanOrEqual(700);
      expect(doc.content).toContain(formatDialAddress(r.address.value));
      expect(doc.content).toContain(HOURS_NOT_ON_FILE);
      for (const p of Object.values(r.phones))
        expect(doc.content).toContain(p.value);
      for (const other of DIAL_ROOFTOPS.filter((o) => o !== r))
        for (const p of Object.values(other.phones))
          expect(doc.content).not.toContain(p.value);
    }
  });

  it('lists all five stores for the group with the North/South note', () => {
    const doc = buildGroupDirectoryDoc();
    expect(doc.chunks).toHaveLength(1 + DIAL_ROOFTOPS.length);
    const [overview, ...stores] = doc.chunks;
    expect(overview.length).toBeLessThanOrEqual(700);
    expect(overview).toContain('North/South note');
    for (const r of DIAL_ROOFTOPS) {
      expect(overview).toContain(r.publicName.value);
      expect(overview).toContain(r.address.value.street);
    }
    stores.forEach((chunk, i) => {
      const r = DIAL_ROOFTOPS[i];
      expect(chunk.length).toBeLessThanOrEqual(700);
      expect(chunk).toContain(r.publicName.value);
      expect(chunk).toContain(r.phones.service.value);
      for (const other of DIAL_ROOFTOPS.filter((o) => o !== r))
        for (const p of Object.values(other.phones))
          expect(chunk).not.toContain(p.value);
    });
  });
});

describe('Dial bootstrap gate', () => {
  const base = {
    DIAL_BOOTSTRAP_ENABLED: 'true',
    DATABASE_URL: 'postgresql://u:p@db.example.invalid:5432/x',
    BOOTSTRAP_WIDGET_ORIGINS: 'https://widget.example.invalid',
  };
  const run = (env: Record<string, string | undefined>) =>
    assertDialBootstrapAllowed(env as NodeJS.ProcessEnv);

  it('refuses without the explicit enable switch', () => {
    expect(() => run({ ...base, DIAL_BOOTSTRAP_ENABLED: undefined })).toThrow(
      /DIAL_BOOTSTRAP_ENABLED/,
    );
    expect(() => run({ ...base, DIAL_BOOTSTRAP_ENABLED: '1' })).toThrow();
  });

  it('needs the confirm phrase in the production tier only', () => {
    expect(() => run({ ...base, NODE_ENV: 'production' })).toThrow(
      /DIAL_BOOTSTRAP_CONFIRM=identity-only/,
    );
    expect(
      run({
        ...base,
        NODE_ENV: 'production',
        DIAL_BOOTSTRAP_CONFIRM: 'identity-only',
      }).tier,
    ).toBe('production');
    expect(
      run({ ...base, NODE_ENV: 'production', DEPLOYMENT_TIER: 'staging' }).tier,
    ).toBe('staging');
    expect(run({ ...base, NODE_ENV: 'test' }).tier).toBe('test');
  });

  it('refuses an invalid tier combination and a missing database url', () => {
    expect(() =>
      run({ ...base, NODE_ENV: 'production', DEPLOYMENT_TIER: 'test' }),
    ).toThrow(/DEPLOYMENT_TIER/);
    expect(() => run({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('validates widget origins', () => {
    const parse = (raw: string | undefined, allowLoopbackHttp = true) =>
      parseBootstrapWidgetOrigins(raw, { allowLoopbackHttp });
    expect(
      parse('https://a.example.invalid, https://A.example.invalid/'),
    ).toEqual(['https://a.example.invalid']);
    expect(parse('http://localhost:18084,http://127.0.0.1:18084')).toEqual([
      'http://localhost:18084',
      'http://127.0.0.1:18084',
    ]);
    expect(() => parse(undefined)).toThrow(/required/);
    expect(() => parse(' , ')).toThrow(/required/);
    expect(() => parse('*')).toThrow(/wildcard/);
    expect(() => parse('https://*.example.invalid')).toThrow(/wildcard/);
    expect(() => parse('http://widget.example.invalid')).toThrow(/http/);
    expect(() => parse('http://localhost:18084', false)).toThrow(/http/);
    expect(() => parse('https://a.example.invalid/path')).toThrow(/bare/);
    expect(() => parse('ftp://a.example.invalid')).toThrow();
    expect(() => parse('not a url')).toThrow();
  });
});

const CONFIG_TS = join(
  __dirname,
  '../../../dial-auto-group-platform/src/stores/config.ts',
);
const describeIfSibling = existsSync(CONFIG_TS) ? describe : describe.skip;

describeIfSibling('cross-check against the sibling config.ts', () => {
  it('every phone equals departments[].phone and no forwardingCandidate is used', () => {
    const text = readFileSync(CONFIG_TS, 'utf8');
    const candidates = [
      ...text.matchAll(/forwardingCandidate: "([\d-]+)"/g),
    ].map((m) => m[1]);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(FORBIDDEN_NUMBERS).toContain(c);

    for (const r of DIAL_ROOFTOPS) {
      const start = text.indexOf(`id: "${r.sourceRecordId}",\n    tenantId`);
      expect(start).toBeGreaterThan(-1);
      const block = text.slice(start, text.indexOf('provenance:', start));
      for (const d of ['sales', 'service', 'parts'] as const) {
        const m = block.match(
          new RegExp(`\\{ id: "${d}", label: "[^"]+", phone: "([\\d-]+)"`),
        );
        expect(m?.[1]).toBe(r.phones[d].value);
      }
      expect(block).toContain(`publicName: "${r.publicName.value}"`);
      expect(block).toContain(`sideOfTown: "${r.sideOfTown.value}"`);
      expect(block).toContain(`street: "${r.address.value.street}"`);
      expect(block).toContain(`postalCode: "${r.address.value.postalCode}"`);
    }
  });
});
