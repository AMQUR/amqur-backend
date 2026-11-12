import { ServiceUnavailableException } from '@nestjs/common';
import { DealerIntelligenceService } from './dealer-intelligence.service';
import { DealerIntelligenceController } from './dealer-intelligence.controller';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

describe('Dealer Intelligence endpoint fail-closed controls', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('defaults to unavailable without explicit enablement', async () => {
    delete process.env.DEALER_INTELLIGENCE_ENABLED;
    await expect(new DealerIntelligenceService().snapshot()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects enabled mode when protected report path is missing', async () => {
    process.env.DEALER_INTELLIGENCE_ENABLED = 'true';
    delete process.env.DEALER_INTELLIGENCE_PRIVATE_ROOT;
    delete process.env.DEALER_INTELLIGENCE_REPORT_PATH;
    await expect(new DealerIntelligenceService().snapshot()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires the existing SUPER_ADMIN role at the class level', () => {
    expect(new Reflector().get(ROLES_KEY, DealerIntelligenceController)).toEqual(['SUPER_ADMIN']);
  });
});