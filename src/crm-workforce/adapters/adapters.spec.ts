import { AdapterBlockedError, OPERATION_SIDE_EFFECT } from './crm-adapter';
import { CrmAdapterRegistry } from './adapter.registry';
import { ExportImportError, parseCrmExport } from './export-import';

const scope = { tenantId: 't1', locationId: 'l1' };

describe('CRM adapters', () => {
  const reg = new CrmAdapterRegistry();

  it('every operation declares read-only, draft-only or external', () => {
    for (const a of reg.all())
      expect(Object.keys(a.capabilities()).sort()).toEqual(
        Object.keys(OPERATION_SIDE_EFFECT).sort(),
      );
    expect(OPERATION_SIDE_EFFECT['message.sms.send']).toBe('EXTERNAL');
    expect(OPERATION_SIDE_EFFECT['message.sms.prepare']).toBe('DRAFT_ONLY');
    expect(OPERATION_SIDE_EFFECT['lead.read']).toBe('READ_ONLY');
  });

  it.each(['tekion_api', 'tekion_browser'])(
    '%s is BLOCKED for every operation and cannot act',
    async (key) => {
      const a = reg.get(key)!;
      expect(
        Object.values(a.capabilities()).every((c) => c.status === 'BLOCKED'),
      ).toBe(true);
      expect((await a.health(scope)).status).toBe('BLOCKED');
      await expect(a.listLeads(scope)).rejects.toBeInstanceOf(
        AdapterBlockedError,
      );
      await expect(
        a.executeWrite({
          ...scope,
          operation: 'message.sms.send',
          leadSourceRecordId: 'x',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(AdapterBlockedError);
    },
  );

  it('no adapter claims a LIVE VERIFIED or SANDBOX VERIFIED capability', () => {
    for (const a of reg.all())
      for (const c of Object.values(a.capabilities()))
        expect(['LIVE VERIFIED', 'SANDBOX VERIFIED']).not.toContain(c.status);
  });

  it('export and manual adapters cannot write externally', async () => {
    for (const key of ['export_import', 'manual_assist']) {
      const a = reg.get(key)!;
      expect(a.capabilities()['message.sms.send'].status).toBe('BLOCKED');
      await expect(
        a.executeWrite({
          ...scope,
          operation: 'note.add',
          leadSourceRecordId: 'x',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(AdapterBlockedError);
    }
  });

  it('fixture adapter is refused in the production tier', async () => {
    const prev = { n: process.env.NODE_ENV, d: process.env.DEPLOYMENT_TIER };
    process.env.NODE_ENV = 'production';
    delete process.env.DEPLOYMENT_TIER;
    try {
      await expect(reg.fixture.listLeads(scope)).rejects.toBeInstanceOf(
        AdapterBlockedError,
      );
      expect((await reg.fixture.health()).status).toBe('BLOCKED');
    } finally {
      process.env.NODE_ENV = prev.n;
      if (prev.d) process.env.DEPLOYMENT_TIER = prev.d;
    }
  });

  it('fixture records are always synthetic and unverified, and scoped to their rooftop', async () => {
    reg.fixture.reset();
    reg.fixture.seed(scope, [
      {
        sourceRecordId: 'a',
        asOf: '2026-11-18T00:00:00Z',
        verified: true,
        synthetic: false,
        department: 'SALES',
        messages: [],
      },
    ]);
    const [r] = await reg.fixture.listLeads(scope);
    expect(r).toMatchObject({ synthetic: true, verified: false });
    expect(
      await reg.fixture.listLeads({ tenantId: 't2', locationId: 'l1' }),
    ).toEqual([]);
  });
});

describe('CRM export import', () => {
  const exportedAt = new Date('2026-11-18T12:00:00Z');
  const now = new Date('2026-11-18T16:00:00Z');

  it('maps a dealership export by header name with export-time provenance', () => {
    const csv = [
      'Lead ID,First Name,Last Name,Mobile,Email,Lead Source,Status,Salesperson,Make,Model,Created Date,Last Outbound,Last Inbound,Last Customer Message,Next Follow Up,Appt Status,Do Not Contact',
      'L-1,Test,Shopper,(312) 555-0101,shopper1@example.invalid,Website,Active,Pat Lee,Nissan,Rogue,2026-11-17T15:00:00Z,2026-11-17T16:00:00Z,2026-11-18T10:00:00Z,Is it still available?,,No Show,No',
      'L-2,Other,Person,,,,Lost,,,,2026-10-01T00:00:00Z,,,,2026-12-01T00:00:00Z,,Yes',
    ].join('\n');
    const { records, rejectedRows } = parseCrmExport(csv, { exportedAt, now });
    expect(rejectedRows).toEqual([]);
    expect(records[0]).toMatchObject({
      sourceRecordId: 'L-1',
      verified: true,
      synthetic: false,
      asOf: exportedAt.toISOString(),
      assignedTo: 'Pat Lee',
      appointmentState: 'MISSED',
      doNotContact: false,
      hasFutureFollowUp: false,
      vehicleInterest: { make: 'Nissan', model: 'Rogue' },
    });
    expect(records[0].messages.map((m) => m.direction)).toEqual([
      'OUTBOUND',
      'INBOUND',
    ]);
    expect(records[0].messages[1].body).toBe('Is it still available?');
    expect(records[1]).toMatchObject({
      doNotContact: true,
      hasFutureFollowUp: true,
    });
  });

  it('refuses exports that carry sensitive columns', () => {
    for (const h of [
      'SSN',
      'Credit Score',
      "Driver's License",
      'Date of Birth',
      'Monthly Income',
    ])
      expect(() => parseCrmExport(`Lead ID,${h}\n1,x`, { exportedAt })).toThrow(
        ExportImportError,
      );
  });

  it('rejects duplicate and id-less rows, and reports doNotContact as unknown when the column is absent', () => {
    const { records, rejectedRows } = parseCrmExport(
      'Lead ID,Status\nA,Active\nA,Active\n,Active',
      { exportedAt },
    );
    expect(records).toHaveLength(1);
    expect(records[0].doNotContact).toBeNull();
    expect(rejectedRows.map((r) => r.reason)).toEqual([
      'duplicate_lead_id',
      'missing_lead_id',
    ]);
  });

  it('needs a lead id column and valid CSV', () => {
    expect(() => parseCrmExport('Name\nx', { exportedAt })).toThrow(
      'missing_lead_id_column',
    );
  });
});
