import * as fs from 'fs';
import * as path from 'path';

/**
 * Five-rooftop configuration guard. North CDJR (Jeep of Chicago, jeepofchicago.com) and
 * South CDJR (Dial CDJR of Chicago, dialjeep.com) sell the same brands in the same city —
 * the easiest stores to cross-wire. Nothing here may be shared between rooftops: tenant,
 * website, origins, phones, address or onboarding file. Onboarding configs must also stay
 * unpublished (no origins) and conservative until each store's written approval exists.
 */
const ROOT = path.resolve(__dirname, '../../config');
type Rooftop = {
  key: string;
  displayName: string;
  tenantSlug: string;
  locationSlug: string;
  website: { url: string; productionOrigins?: { value?: string[] } };
  identity?: { address?: string; phones?: string[] };
};
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'rooftops/registry.json'), 'utf8'),
) as { rooftops: Rooftop[] };
const onboardingDir = path.join(ROOT, 'production-onboarding');
const onboarding = fs
  .readdirSync(onboardingDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    file: f,
    cfg: JSON.parse(fs.readFileSync(path.join(onboardingDir, f), 'utf8')) as {
      tenantSlug: string;
      tenantName: string;
      allowedOrigins: string[];
      featureFlags: Record<string, boolean>;
      branding?: { assistantDisplayName?: string; logoUrl?: string };
    },
  }));
const rooftops = registry.rooftops;
const byKey = (k: string) => rooftops.find((r) => r.key === k)!;
const host = (u: string) => new URL(u).hostname.replace(/^www\./, '');
const disjoint = (lists: string[][]) => {
  const seen = new Map<string, number>();
  lists.forEach((l, i) =>
    l.forEach((v) => {
      if (seen.has(v) && seen.get(v) !== i) throw new Error(`shared: ${v}`);
      seen.set(v, i);
    }),
  );
  return true;
};

describe('five-rooftop separation', () => {
  it('has exactly the five rooftops with unique tenants and names', () => {
    expect(rooftops.map((r) => r.tenantSlug).sort()).toEqual([
      'dial-cdjr-of-chicago',
      'dial-chevy-of-chicago',
      'dial-nissan-of-chicago',
      'infiniti-of-chicago',
      'jeep-of-chicago',
    ]);
    expect(new Set(rooftops.map((r) => r.displayName)).size).toBe(5);
    expect(new Set(rooftops.map((r) => r.key)).size).toBe(5);
  });

  it('North CDJR and South CDJR are distinct stores', () => {
    const north = byKey('jeep-north');
    const south = byKey('cdjr-south');
    expect(north.tenantSlug).toBe('jeep-of-chicago');
    expect(south.tenantSlug).toBe('dial-cdjr-of-chicago');
    expect(host(north.website.url)).toBe('jeepofchicago.com');
    expect(host(south.website.url)).toBe('dialjeep.com');
    expect(north.displayName).toMatch(/north/i);
    expect(north.displayName).not.toMatch(/south/i);
    expect(south.displayName).toMatch(/south/i);
    expect(south.displayName).not.toMatch(/north/i);
    if (north.identity?.address && south.identity?.address)
      expect(north.identity.address).not.toBe(south.identity.address);
  });

  it('websites, production origins and phones are never shared between rooftops', () => {
    expect(new Set(rooftops.map((r) => host(r.website.url))).size).toBe(5);
    expect(
      disjoint(
        rooftops.map((r) =>
          (r.website.productionOrigins?.value ?? []).map(host),
        ),
      ),
    ).toBe(true);
    expect(
      disjoint(
        rooftops.map((r) =>
          (r.identity?.phones ?? []).map((p) => p.replace(/\D/g, '')),
        ),
      ),
    ).toBe(true);
    // each rooftop's origins belong to its own website
    for (const r of rooftops)
      for (const o of r.website.productionOrigins?.value ?? [])
        expect(host(o)).toBe(host(r.website.url));
  });

  it('every rooftop has its own onboarding file, matched by tenant slug', () => {
    for (const r of rooftops) {
      const o = onboarding.find((x) => x.file === `${r.tenantSlug}.json`);
      expect(o?.cfg.tenantSlug).toBe(r.tenantSlug);
    }
    const names = onboarding.map((o) => o.cfg.tenantName);
    expect(new Set(names).size).toBe(names.length);
    const assistants = onboarding.map(
      (o) => o.cfg.branding?.assistantDisplayName,
    );
    expect(new Set(assistants).size).toBe(assistants.length);
    for (const o of onboarding)
      if (o.cfg.branding?.logoUrl)
        expect(o.cfg.branding.logoUrl).toContain(`/${o.cfg.tenantSlug}/`);
  });

  it('onboarding configs stay unpublished and conservative until each store approves', () => {
    for (const { cfg } of onboarding) {
      expect(cfg.allowedOrigins).toEqual([]); // no website can mint widget tokens yet
      for (const flag of [
        'inventory',
        'payments',
        'appointments',
        'serviceAi',
        'partsAi',
        'voiceAi',
        'proactiveEngagement',
      ])
        expect(cfg.featureFlags[flag]).not.toBe(true);
    }
  });

  it('no credit destination or token is stored in any store config', () => {
    for (const dir of ['rooftops', 'production-onboarding'])
      for (const f of fs.readdirSync(path.join(ROOT, dir))) {
        const text = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
        expect(text).not.toMatch(/tekioncloud|[?&]token=/i);
      }
  });
});
