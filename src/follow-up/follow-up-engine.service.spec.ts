import { FollowUpEngineService } from './follow-up-engine.service';

describe('FollowUpEngineService', () => {
  it('blocks opt-out and disabled campaigns', async () => {
    const prisma = {
      followUpCampaign: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const engine = new FollowUpEngineService(prisma as any);
    const opt = await engine.evaluateDispatch({
      tenantId: 't1',
      campaignName: 'abandoned_chat',
      optOut: true,
    });
    expect(opt.allowed).toBe(false);
    expect(opt.reason).toBe('opt_out');

    const disabled = await engine.evaluateDispatch({
      tenantId: 't1',
      campaignName: 'abandoned_chat',
    });
    expect(disabled.allowed).toBe(false);
    expect(disabled.reason).toBe('campaign_disabled');
  });
});
