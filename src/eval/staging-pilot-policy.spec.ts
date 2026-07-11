import { PLATFORM_FEATURE_DEFAULTS } from '../feature-flags/feature-flags.service';
import { TekionProvider } from '../integrations/tekion/tekion.provider';
import { inventoryFreshnessDisclaimer } from '../chat/engines/inventory-freshness';
import * as fs from 'fs';
import * as path from 'path';

const stagingFlags = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../config/staging-pilot.flags.json'),
    'utf8',
  ),
) as { featureFlags: Record<string, boolean> };

describe('staging pilot policy gates', () => {
  it('keeps Tekion/voice/follow-up off in platform defaults', () => {
    expect(PLATFORM_FEATURE_DEFAULTS.tekionIntegration).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.voiceAi).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.automatedFollowup).toBe(false);
  });

  it('staging flag file enables pilot UX and disables live integrations', () => {
    expect(stagingFlags.featureFlags.inventory).toBe(true);
    expect(stagingFlags.featureFlags.vehicleCompare).toBe(true);
    expect(stagingFlags.featureFlags.savedVehicles).toBe(true);
    expect(stagingFlags.featureFlags.payments).toBe(true);
    expect(stagingFlags.featureFlags.serviceAi).toBe(true);
    expect(stagingFlags.featureFlags.partsAi).toBe(true);
    expect(stagingFlags.featureFlags.multilingual).toBe(true);
    expect(stagingFlags.featureFlags.tekionIntegration).toBe(false);
    expect(stagingFlags.featureFlags.automatedFollowup).toBe(false);
    expect(stagingFlags.featureFlags.voiceAi).toBe(false);
    expect(stagingFlags.featureFlags.vAutoFeed).toBe(false);
  });

  it('Tekion never confirms appointments without live config', async () => {
    const tekion = new TekionProvider();
    expect(tekion.isLiveConfigured()).toBe(false);
    const appt = await tekion.requestServiceAppointment({
      tenantId: 'staging',
      idempotencyKey: 'pilot-1',
    });
    expect(appt.confirmed).toBe(false);
    expect(appt.status).toBe('REQUESTED');
  });

  it('never invents repair-order status', async () => {
    const tekion = new TekionProvider();
    expect(await tekion.getRepairOrderStatus({ tenantId: 'staging' })).toBeNull();
  });

  it('refuses availability claims when inventory UNAVAILABLE', () => {
    const text = inventoryFreshnessDisclaimer([{ freshnessState: 'UNAVAILABLE' }]);
    expect(text.toLowerCase()).toMatch(/could not be confirmed|will not claim/);
    expect(text.toLowerCase()).not.toMatch(/confirmed available|in stock now/);
  });
});
