/**
 * Canary release-blocking policy tests — Jeep of Chicago.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Jeep of Chicago canary release gates', () => {
  const cfgPath = path.join(
    __dirname,
    '../../config/canary-jeep-of-chicago.json',
  );
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    status: string;
    releaseLevel: number;
    blockedReasons: string[];
    websiteInstallation: { installAuthorized: boolean };
    featureFlags: {
      publicCustomerMode: Record<string, boolean>;
      hardDisabled: string[];
    };
    humanHandoff: { destinationVerified: boolean };
    origins: { api: { status: string; value: string | null }; widgetAsset: { value: string | null } };
  };

  const loaderPath = path.join(
    __dirname,
    '../../../amqur-widget/docs/deployment/amqur-canary-loader.js',
  );

  it('remains prepared, level 0, not installed', () => {
    expect(cfg.status).toBe('PREPARED_NOT_INSTALLED');
    expect(cfg.releaseLevel).toBe(0);
    expect(cfg.websiteInstallation.installAuthorized).toBe(false);
  });

  it('disables public inventory without live vAuto', () => {
    expect(cfg.featureFlags.publicCustomerMode.inventory).toBe(false);
    expect(cfg.featureFlags.publicCustomerMode.vehicleCompare).toBe(false);
    expect(cfg.featureFlags.publicCustomerMode.vAutoFeed).toBe(false);
    expect(cfg.featureFlags.hardDisabled).toContain('fixtureInventoryInPublicMode');
  });

  it('keeps Tekion and outbound messaging disabled', () => {
    expect(cfg.featureFlags.publicCustomerMode.tekionIntegration).toBe(false);
    expect(cfg.featureFlags.publicCustomerMode.automatedFollowup).toBe(false);
    expect(cfg.featureFlags.publicCustomerMode.voiceAi).toBe(false);
    expect(cfg.featureFlags.hardDisabled).toEqual(
      expect.arrayContaining([
        'tekionCrmWriteback',
        'liveAppointmentConfirmation',
        'crossStoreInventory',
      ]),
    );
  });

  it('blocks customer traffic without provisioned hosts and handoff', () => {
    expect(cfg.origins.api.value).toBeNull();
    expect(cfg.origins.widgetAsset.value).toBeNull();
    expect(cfg.humanHandoff.destinationVerified).toBe(false);
    expect(cfg.blockedReasons.length).toBeGreaterThan(0);
  });

  it('loader refuses localhost and placeholder hosts', () => {
    // Loader lives in sibling widget repo when checked out as workspace pair.
    const alt = path.join(
      process.cwd(),
      '../amqur-widget/docs/deployment/amqur-canary-loader.js',
    );
    const p = fs.existsSync(loaderPath) ? loaderPath : alt;
    if (!fs.existsSync(p)) {
      // Backend-only CI checkout: skip file assert but keep config gates.
      return;
    }
    const src = fs.readFileSync(p, 'utf8');
    expect(src).toMatch(/forbidden_host_pattern/);
    expect(src).toMatch(/hostname_rejected/);
    expect(src).toMatch(/kill_switch/);
    expect(src).toMatch(/duplicate_blocked/);
    expect(src).toMatch(/stableBucket|BUCKET_KEY/);
    expect(src).not.toMatch(/JWT_SECRET|DATABASE_URL|TEKION_CLIENT_SECRET/);
  });
});
