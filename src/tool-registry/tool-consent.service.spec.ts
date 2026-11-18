import { ToolConsentService } from './tool-consent.service';
import { findTool } from './tool-catalog';

const base = {
  id: 'rec1',
  tenantId: 't1',
  leadId: 'lead1',
  locationId: null as string | null,
  channel: 'SMS',
  endpoint: '+15551234567',
  purpose: 'CONVERSATIONAL',
  granted: true,
  revokedAt: null as Date | null,
  createdAt: new Date('2026-11-01'),
};

function setup(row: Record<string, unknown> | null, ledger: unknown[] = []) {
  const prisma = {
    consentRecord: {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(ledger),
    },
  };
  return { svc: new ToolConsentService(prisma as never), prisma };
}
const msg = findTool('message.send')!;
const appt = findTool('appointment.request')!;
const args = (o: Record<string, unknown> = {}) => ({
  tenantId: 't1',
  locationId: null as string | null,
  input: { leadId: 'lead1', channel: 'SMS', body: 'b' },
  consentRef: 'rec1',
  ...o,
});

describe('ToolConsentService', () => {
  it('passes for tools without consent and fails closed without a ref', async () => {
    const { svc } = setup(null);
    expect(await svc.verify(findTool('crm.note.add')!, args())).toEqual({
      ok: true,
    });
    expect(await svc.verify(msg, args({ consentRef: null }))).toEqual({
      ok: false,
      reason: 'consent_required',
    });
  });

  it('accepts a granted, matching record that is the latest on its channel', async () => {
    const { svc, prisma } = setup(base, [base]);
    expect(await svc.verify(msg, args())).toEqual({ ok: true });
    expect(prisma.consentRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'rec1', tenantId: 't1' },
    });
  });

  it.each([
    ['unknown or other-tenant record', null, 'consent_not_found'],
    ['opt-out record', { ...base, granted: false }, 'consent_not_granted'],
    [
      'revoked record',
      { ...base, revokedAt: new Date() },
      'consent_not_granted',
    ],
    ['different lead', { ...base, leadId: 'other' }, 'consent_lead_mismatch'],
    ['no lead on record', { ...base, leadId: null }, 'consent_lead_mismatch'],
    [
      'other rooftop',
      { ...base, locationId: 'locB' },
      'consent_location_mismatch',
    ],
    [
      'other channel',
      { ...base, channel: 'EMAIL' },
      'consent_channel_mismatch',
    ],
    [
      'wrong purpose',
      { ...base, purpose: 'TRANSACTIONAL' },
      'consent_purpose_mismatch',
    ],
  ])('rejects %s', async (_n, row, reason) => {
    const { svc } = setup(row, row ? [row] : []);
    expect(await svc.verify(msg, args())).toEqual({ ok: false, reason });
  });

  it('a later opt-out on the same endpoint revokes an earlier grant (latest wins)', async () => {
    const optOut = {
      ...base,
      id: 'rec2',
      granted: false,
      createdAt: new Date('2026-11-10'),
    };
    const { svc } = setup(base, [optOut, base]);
    expect(await svc.verify(msg, args())).toEqual({
      ok: false,
      reason: 'consent_opted_out',
    });
  });

  it('appointment.request accepts a TRANSACTIONAL grant on any channel but never leaks the endpoint', async () => {
    const row = {
      ...base,
      purpose: 'TRANSACTIONAL',
      channel: 'CALL',
      endpoint: '+15559998888',
    };
    const { svc } = setup(row, [row]);
    const v = await svc.verify(
      appt,
      args({ input: { leadId: 'lead1', startsAt: '2026-12-01T10:00:00Z' } }),
    );
    expect(v).toEqual({ ok: true });
    const bad = await setup({ ...row, leadId: 'x' }).svc.verify(
      appt,
      args({ input: { leadId: 'lead1' } }),
    );
    expect(JSON.stringify(bad)).not.toMatch(/555/);
  });

  it('a rooftop-scoped record cannot back a tenant-wide action', async () => {
    const { svc } = setup({ ...base, locationId: 'locA' }, [base]);
    expect(await svc.verify(msg, args({ locationId: null }))).toEqual({
      ok: false,
      reason: 'consent_location_mismatch',
    });
    expect(await svc.verify(msg, args({ locationId: 'locA' }))).toEqual({
      ok: true,
    });
  });
});
