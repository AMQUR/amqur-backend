import { readLeadDeliveryEnv } from './lead-delivery-gates';
import { ResendDeliveryMonitorService } from './resend-delivery-monitor.service';
import { FetchLike } from './transports/resend.transport';

const ID_A = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const ID_B = '5b1f2c3d-0ce1-4ea6-ab68-afcd6dc2e795';
const env = (key = 're_test_key_never_real_0000') =>
  readLeadDeliveryEnv({ NODE_ENV: 'production', RESEND_API_KEY: key });

function setup(
  rows: Array<{ id: string; providerRawStatus: string }>,
  events: Record<string, { status: number; last_event?: string }>,
) {
  const findMany = jest
    .fn()
    .mockResolvedValue(
      rows.map((r) => ({ ...r, tenantId: 't1', status: 'ACCEPTED' })),
    );
  const recordProviderOutcome = jest.fn().mockResolvedValue(true);
  const urls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    urls.push(url);
    const e = events[url.split('/').pop()!] ?? { status: 404 };
    return Promise.resolve({
      status: e.status,
      json: () => Promise.resolve({ last_event: e.last_event }),
    });
  };
  const svc = new ResendDeliveryMonitorService(
    { leadDelivery: { findMany } } as never,
    { recordProviderOutcome } as never,
    { increment: jest.fn() } as never,
  );
  return { svc, findMany, recordProviderOutcome, fetchImpl, urls };
}

describe('Resend delivery monitor', () => {
  it('does nothing without an API key', async () => {
    const s = setup([], {});
    expect(await s.svc.poll(env(''), s.fetchImpl)).toEqual({
      checked: 0,
      delivered: 0,
      bounced: 0,
    });
    expect(s.findMany).not.toHaveBeenCalled();
  });

  it('only looks at live deliveries accepted by resend', async () => {
    const s = setup([], {});
    await s.svc.poll(env(), s.fetchImpl);
    expect(s.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'ACCEPTED',
      providerName: 'resend',
      deliveryMode: 'live',
    });
  });

  it('records delivered and bounced separately and leaves in-flight mail alone', async () => {
    const s = setup(
      [
        { id: 'd1', providerRawStatus: `resend_accepted email_id=${ID_A}` },
        { id: 'd2', providerRawStatus: `resend_accepted email_id=${ID_B}` },
        { id: 'd3', providerRawStatus: 'resend_accepted' },
      ],
      {
        [ID_A]: { status: 200, last_event: 'delivered' },
        [ID_B]: { status: 200, last_event: 'bounced' },
      },
    );
    const out = await s.svc.poll(env(), s.fetchImpl);
    expect(out).toEqual({ checked: 2, delivered: 1, bounced: 1 });
    expect(s.urls).toEqual([
      `https://api.resend.com/emails/${ID_A}`,
      `https://api.resend.com/emails/${ID_B}`,
    ]);
    expect(s.recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1' }),
      'delivered',
      `resend:${ID_A}:delivered`,
      `resend_delivered email_id=${ID_A}`,
    );
    expect(s.recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd2' }),
      'bounced',
      `resend:${ID_B}:bounced`,
      `resend_bounced email_id=${ID_B}`,
    );
  });

  it('a "sent" message is not yet delivered', async () => {
    const s = setup(
      [{ id: 'd1', providerRawStatus: `resend_accepted email_id=${ID_A}` }],
      { [ID_A]: { status: 200, last_event: 'sent' } },
    );
    expect(await s.svc.poll(env(), s.fetchImpl)).toEqual({
      checked: 1,
      delivered: 0,
      bounced: 0,
    });
    expect(s.recordProviderOutcome).not.toHaveBeenCalled();
  });

  it('stops quietly when the key cannot read email status', async () => {
    const s = setup(
      [
        { id: 'd1', providerRawStatus: `resend_accepted email_id=${ID_A}` },
        { id: 'd2', providerRawStatus: `resend_accepted email_id=${ID_B}` },
      ],
      { [ID_A]: { status: 401 } },
    );
    await s.svc.poll(env(), s.fetchImpl);
    expect(s.urls).toHaveLength(1);
    expect(s.recordProviderOutcome).not.toHaveBeenCalled();
  });
});
