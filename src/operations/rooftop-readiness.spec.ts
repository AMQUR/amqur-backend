import { loadRegistry, scoreRooftop, LiveFacts } from './rooftop-readiness';

const live: LiveFacts = {
  tenantExists: true,
  locationExists: true,
  allowedOrigins: [
    'https://www.jeepofchicago.com',
    'https://jeepofchicago.com',
  ],
  brandingConfigured: true,
  liveVehicles: 120,
  syntheticVehicles: 0,
  hoursVerified: true,
  hoursSynthetic: false,
  staffUsers: 12,
  tekionConnectionLive: true,
  creditAvailableLive: true,
  policyMode: 'DEALER_CONFIGURED',
  consentText: true,
  crmWebhookConfigured: true,
};

describe('rooftop readiness scoring', () => {
  const reg = loadRegistry();
  it('registry lists exactly the five rooftops, North and South distinct', () => {
    expect(reg.rooftops.map((r) => r.key).sort()).toEqual([
      'cdjr-south',
      'chevy',
      'infiniti',
      'jeep-north',
      'nissan',
    ]);
    const north = reg.rooftops.find((r) => r.key === 'jeep-north')!;
    const south = reg.rooftops.find((r) => r.key === 'cdjr-south')!;
    expect(north.tenantSlug).not.toBe(south.tenantSlug);
    expect(north.website.url).not.toBe(south.website.url);
  });
  it('unverified registry evidence never scores PASS, even with perfect live data', () => {
    for (const r of reg.rooftops) {
      const cells = scoreRooftop(r, live);
      for (const k of [
        'brandingVerified',
        'domainVerified',
        'inventoryConnected',
        'hoursVerified',
        'creditApplicationVerified',
        'productionApproved',
      ] as const)
        expect(cells[k]).not.toBe('PASS');
    }
  });
  it('fully verified evidence + live facts can reach PASS for configured rows', () => {
    const r = JSON.parse(
      JSON.stringify(reg.rooftops.find((x) => x.key === 'jeep-north')),
    );
    const V = { status: 'VERIFIED' };
    for (const k of [
      'identity',
      'inventorySource',
      'pricingPolicy',
      'hours',
      'staff',
      'crm',
      'creditApplication',
      'taxFeeRules',
      'consent',
      'handoffDestination',
      'monitoring',
      'appraisalProvider',
    ])
      r[k] = { ...r[k], ...V };
    r.website.productionOrigins.status = 'VERIFIED';
    r.website.provider.status = 'VERIFIED';
    const cells = scoreRooftop(r, live);
    expect(cells.inventoryConnected).toBe('PASS');
    expect(cells.creditApplicationVerified).toBe('PASS');
    expect(cells.otdPolicyVerified).toBe('PASS');
    // Synthetic hours never pass.
    expect(
      scoreRooftop(r, { ...live, hoursSynthetic: true }).hoursVerified,
    ).toBe('FAIL');
    // Without a live tenant nothing configured passes.
    expect(scoreRooftop(r, null).tenantConfigured).toBe('FAIL');
  });
});
