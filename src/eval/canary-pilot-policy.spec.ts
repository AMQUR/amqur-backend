/**
 * Canary policy — Jeep of Chicago pilot must not enable live Tekion/vAuto/voice
 * or claim customer traffic readiness without gates.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Dial Auto Group canary policy', () => {
  const cfgPath = path.join(
    __dirname,
    '../../config/canary-jeep-of-chicago.json',
  );
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    status: string;
    currentPhase: number;
    websiteInstallation: { installAuthorized: boolean };
    disabledUntilVerified: Record<string, boolean>;
    origins: { api: string; widgetCdn: string };
  };

  it('is prepared but not installed', () => {
    expect(cfg.status).toBe('PREPARED_NOT_INSTALLED');
    expect(cfg.websiteInstallation.installAuthorized).toBe(false);
    expect(cfg.currentPhase).toBe(0);
  });

  it('keeps dangerous capabilities disabled until verified', () => {
    expect(cfg.disabledUntilVerified.tekionIntegration).toBe(true);
    expect(cfg.disabledUntilVerified.vAutoFeed).toBe(true);
    expect(cfg.disabledUntilVerified.automatedFollowup).toBe(true);
    expect(cfg.disabledUntilVerified.voiceAi).toBe(true);
    expect(cfg.disabledUntilVerified.crossStoreInventory).toBe(true);
  });

  it('does not point canary at a provisioned production API yet', () => {
    expect(cfg.origins.api).toContain('NOT_PROVISIONED');
    expect(cfg.origins.widgetCdn).toContain('NOT_PROVISIONED');
  });
});
