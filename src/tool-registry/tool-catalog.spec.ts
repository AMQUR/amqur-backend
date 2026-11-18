import {
  actionChecksum,
  findTool,
  TOOL_CATALOG,
  validateToolInput,
  ToolInputError,
} from './tool-catalog';

describe('tool catalog', () => {
  it('only contains write tools with approver roles', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
    for (const t of TOOL_CATALOG) {
      expect(t.access).toBe('WRITE');
      expect(t.approverRoles.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown keys, wrong types, missing, oversize and out-of-set fields', () => {
    const t = findTool('crm.note.add')!;
    expect(() => validateToolInput(t, null)).toThrow(ToolInputError);
    expect(() =>
      validateToolInput(t, { leadId: 'l', note: 'n', x: 1 }),
    ).toThrow(/Unknown field/);
    expect(() => validateToolInput(t, { leadId: 'l' })).toThrow(/Missing/);
    expect(() => validateToolInput(t, { leadId: 1, note: 'n' })).toThrow(
      /string/,
    );
    expect(() =>
      validateToolInput(t, { leadId: 'l', note: 'x'.repeat(1001) }),
    ).toThrow(/length/);
    expect(() =>
      validateToolInput(findTool('message.send')!, {
        leadId: 'l',
        channel: 'FAX',
        body: 'b',
      }),
    ).toThrow(/invalid value/);
    expect(() =>
      validateToolInput(findTool('appointment.request')!, {
        leadId: 'l',
        startsAt: 'not-a-date!!',
      }),
    ).toThrow(/ISO/);
  });

  it('masks emails and phone numbers in free-text fields only', () => {
    const out = validateToolInput(findTool('crm.note.add')!, {
      leadId: 'lead-1',
      note: 'call 555-123-4567 or a@b.com',
    });
    expect(out.leadId).toBe('lead-1');
    expect(out.note).not.toMatch(/555|a@b\.com/);
  });

  it('checksum is stable across key order and changes with any bound field', () => {
    const base = {
      toolName: 't',
      toolVersion: 1,
      locationId: null as string | null,
      input: { a: '1', b: '2' },
      consentRef: null as string | null,
    };
    expect(actionChecksum(base)).toBe(
      actionChecksum({ ...base, input: { b: '2', a: '1' } }),
    );
    for (const change of [
      { toolVersion: 2 },
      { locationId: 'x' },
      { consentRef: 'c' },
      { input: { a: '1', b: '3' } },
    ])
      expect(actionChecksum({ ...base, ...change })).not.toBe(
        actionChecksum(base),
      );
  });
});
