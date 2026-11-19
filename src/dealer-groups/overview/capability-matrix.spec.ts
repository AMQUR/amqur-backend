import {
  CAPABILITY_KEYS,
  CAPABILITY_STATUSES,
  CapabilityEvidence,
  capabilityMatrix,
} from './capability-matrix';

const none: CapabilityEvidence = {
  allowedOriginCount: 0,
  flags: {},
  vehicles: { real: 0, synthetic: 0 },
  leadRoutes: {
    sandboxEnabled: 0,
    production: 0,
    productionVerified: 0,
    productionLive: 0,
  },
  deliveries: {
    acceptedOnProductionRoute: 0,
    crmMatchedOnProductionRoute: 0,
    acceptedOnSandboxRoute: 0,
  },
  scheduler: {
    realConnection: false,
    providerConfirmedReceipts: 0,
    sandboxConfirmedReceipts: 0,
  },
  tekion: { connection: false, enabledLiveReady: false },
  messaging: { smsConnection: false },
};
const demo: CapabilityEvidence = {
  ...none,
  flags: { sandboxScheduler: true, groupInventoryListed: true },
  vehicles: { real: 0, synthetic: 12 },
  leadRoutes: { ...none.leadRoutes, sandboxEnabled: 1 },
  deliveries: { ...none.deliveries, acceptedOnSandboxRoute: 40 },
  scheduler: { ...none.scheduler, sandboxConfirmedReceipts: 25 },
};

describe('rooftop capability matrix', () => {
  it('uses exactly the five status words and covers every capability', () => {
    expect([...CAPABILITY_STATUSES]).toEqual([
      'LIVE VERIFIED',
      'SANDBOX VERIFIED',
      'DEMO',
      'BLOCKED',
      'NOT TESTED',
    ]);
    const m = capabilityMatrix(demo);
    expect(Object.keys(m).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const c of Object.values(m)) {
      expect(CAPABILITY_STATUSES).toContain(c.status);
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });

  it('a store with nothing configured is BLOCKED everywhere', () => {
    for (const c of Object.values(capabilityMatrix(none)))
      expect(c.status).toBe('BLOCKED');
  });

  it('no amount of sandbox activity is ever more than DEMO', () => {
    const m = capabilityMatrix({
      ...demo,
      deliveries: { ...demo.deliveries, acceptedOnSandboxRoute: 100_000 },
      scheduler: { ...demo.scheduler, sandboxConfirmedReceipts: 100_000 },
    });
    expect(m.leadDelivery.status).toBe('DEMO');
    expect(m.appointmentBooking.status).toBe('DEMO');
    expect(m.inventory.status).toBe('DEMO');
    expect(m.groupListing.status).toBe('DEMO');
    expect(m.crmConfirmation.status).toBe('BLOCKED');
    expect(Object.values(m).some((c) => /VERIFIED/.test(c.status))).toBe(false);
  });

  it('mail-server acceptance on a live route is NOT TESTED, never LIVE VERIFIED', () => {
    const m = capabilityMatrix({
      ...none,
      leadRoutes: {
        sandboxEnabled: 0,
        production: 1,
        productionVerified: 1,
        productionLive: 1,
      },
      deliveries: { ...none.deliveries, acceptedOnProductionRoute: 9 },
    });
    expect(m.leadDelivery.status).toBe('NOT TESTED');
    expect(m.leadDelivery.reason).toMatch(/No CRM match/);
    expect(m.crmConfirmation.status).toBe('BLOCKED');
  });

  it('lead delivery is LIVE VERIFIED only with a CRM match on a live route', () => {
    const m = capabilityMatrix({
      ...none,
      leadRoutes: {
        sandboxEnabled: 0,
        production: 1,
        productionVerified: 1,
        productionLive: 1,
      },
      deliveries: {
        acceptedOnProductionRoute: 3,
        crmMatchedOnProductionRoute: 1,
        acceptedOnSandboxRoute: 0,
      },
    });
    expect(m.leadDelivery.status).toBe('LIVE VERIFIED');
    expect(m.crmConfirmation.status).toBe('LIVE VERIFIED');
  });

  it('an unverified or unapproved live destination is BLOCKED with the reason', () => {
    const base = { ...none.leadRoutes, production: 1 };
    expect(
      capabilityMatrix({ ...none, leadRoutes: base }).leadDelivery,
    ).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringMatching(/not been verified/),
    });
    expect(
      capabilityMatrix({
        ...none,
        leadRoutes: { ...base, productionVerified: 1 },
      }).leadDelivery,
    ).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringMatching(/not approved/),
    });
  });

  it('booking is LIVE VERIFIED only with a non-sandbox provider receipt', () => {
    expect(
      capabilityMatrix({
        ...none,
        scheduler: { ...none.scheduler, realConnection: true },
      }).appointmentBooking.status,
    ).toBe('NOT TESTED');
    expect(
      capabilityMatrix({
        ...none,
        scheduler: {
          realConnection: true,
          providerConfirmedReceipts: 1,
          sandboxConfirmedReceipts: 0,
        },
      }).appointmentBooking.status,
    ).toBe('LIVE VERIFIED');
  });

  it('a switch being on is never proof: SMS, email, voice, Tekion and feed inventory top out at NOT TESTED', () => {
    const m = capabilityMatrix({
      ...none,
      allowedOriginCount: 2,
      flags: {
        sms: true,
        email: true,
        voiceAi: true,
        groupInventoryListed: true,
      },
      vehicles: { real: 300, synthetic: 0 },
      tekion: { connection: true, enabledLiveReady: true },
      messaging: { smsConnection: true },
    });
    for (const k of [
      'websiteAssistant',
      'inventory',
      'tekion',
      'textMessaging',
      'email',
      'voice',
      'groupListing',
    ] as const)
      expect(m[k].status).toBe('NOT TESTED');
  });

  it('nothing in this derivation can emit SANDBOX VERIFIED (it needs a recorded vendor attestation)', () => {
    for (const e of [none, demo])
      for (const c of Object.values(capabilityMatrix(e)))
        expect(c.status).not.toBe('SANDBOX VERIFIED');
  });

  it('a store that has not opted in to group search is BLOCKED there, whatever its inventory', () => {
    expect(
      capabilityMatrix({ ...demo, flags: { sandboxScheduler: true } })
        .groupListing,
    ).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringMatching(/never searched/),
    });
  });
});
