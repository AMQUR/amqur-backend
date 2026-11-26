import { OpsAlertService } from './ops-alert.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

import axios from 'axios';

describe('OpsAlertService', () => {
  const metrics = { increment: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips delivery when webhook unset (fail-closed)', async () => {
    const svc = new OpsAlertService(
      { get: () => '' } as never,
      metrics as never,
    );
    const r = await svc.notify({
      code: 'inventory.sftp.auth_failed',
      severity: 'critical',
      summary: 'test',
    });
    expect(r).toEqual({
      delivered: false,
      reason: 'OPS_ALERT_WEBHOOK_URL_unset',
    });
    expect(axios.post).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith(
      'ops.alert.skipped_unconfigured',
    );
  });

  it('posts sanitized payload when webhook configured', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 204 });
    const svc = new OpsAlertService(
      {
        get: (k: string) =>
          k === 'OPS_ALERT_WEBHOOK_URL'
            ? 'https://hooks.example.invalid/ops'
            : k === 'DEPLOYMENT_TIER'
              ? 'staging'
              : '',
      } as never,
      metrics as never,
    );
    const r = await svc.notify({
      code: 'inventory.freshness.degraded',
      severity: 'warning',
      summary: 'stale vehicles',
      context: { staleCount: 3 },
    });
    expect(r.delivered).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'https://hooks.example.invalid/ops',
      expect.objectContaining({
        code: 'inventory.freshness.degraded',
        context: { staleCount: 3 },
        deploymentTier: 'staging',
      }),
      expect.any(Object),
    );
    expect(metrics.increment).toHaveBeenCalledWith('ops.alert.delivered');
  });
});
