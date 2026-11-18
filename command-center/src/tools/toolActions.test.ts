import { describe, it, expect } from 'vitest';
import { workflowTools, capability, decisionBody, expiryText, inputEntries, isExpired, listPath, type ToolActionRow, type ToolCatalogEntry } from './toolActions';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const row = (o: Partial<ToolActionRow> = {}): ToolActionRow => ({
  id: 'a1', locationId: 'l1', toolName: 'message.send', toolVersion: 1, input: { body: 'hi' }, checksum: 'abc123',
  consentRef: null, status: 'PENDING_APPROVAL', expiresAt: '2026-11-19T00:00:00Z', requestedByUserId: 'u-req',
  decidedByUserId: null, decidedAt: null, decisionNote: null, failureReason: null, createdAt: '2026-11-18T11:00:00Z', ...o,
});
const tool: ToolCatalogEntry = { name: 'message.send', version: 1, description: 'd', risk: 'HIGH', requiresCustomerConsent: true, proposerRoles: ['MANAGER', 'ADMIN'], approverRoles: ['ADMIN', 'SUPER_ADMIN'] };

describe('tool action inbox helpers', () => {
  it('lets an independent approver role decide', () => {
    expect(capability(row(), tool, { id: 'u-rev', role: 'ADMIN' }, NOW)).toEqual({ canDecide: true, canCancel: false });
  });
  it('blocks self-approval but allows the requester to cancel', () => {
    const c = capability(row(), tool, { id: 'u-req', role: 'ADMIN' }, NOW);
    expect(c.canDecide).toBe(false);
    expect(c.canCancel).toBe(true);
  });
  it('blocks roles that are not approvers (e.g. MANAGER on message.send)', () => {
    const c = capability(row(), tool, { id: 'u-rev', role: 'MANAGER' }, NOW);
    expect(c.canDecide).toBe(false);
    expect(c.reason).toContain('ADMIN');
  });
  it('blocks resolved, expired, and unknown-tool rows', () => {
    expect(capability(row({ status: 'APPROVED' }), tool, { id: 'u', role: 'ADMIN' }, NOW).canDecide).toBe(false);
    expect(capability(row({ expiresAt: '2026-11-18T11:59:00Z' }), tool, { id: 'u', role: 'ADMIN' }, NOW)).toMatchObject({ canDecide: false, canCancel: false, reason: 'Expired' });
    expect(capability(row(), undefined, { id: 'u', role: 'ADMIN' }, NOW).canDecide).toBe(false);
  });
  it('approval body echoes the reviewed checksum and trims/limits the note', () => {
    expect(decisionBody(row(), 'APPROVE')).toEqual({ decision: 'APPROVE', reviewedChecksum: 'abc123' });
    expect(decisionBody(row(), 'DENY', '  ' + 'x'.repeat(400)).note).toHaveLength(300);
    expect(decisionBody(row(), 'DENY', '   ')).not.toHaveProperty('note');
  });
  it('builds list paths and display helpers', () => {
    expect(listPath('ALL')).toBe('/ops/tools/actions');
    expect(listPath('PENDING_APPROVAL')).toBe('/ops/tools/actions?status=PENDING_APPROVAL');
    expect(inputEntries({ b: 2, a: 'x' })).toEqual([['a', 'x'], ['b', '2']]);
    expect(isExpired(row(), NOW)).toBe(false);
    expect(expiryText(row(), NOW)).toBe('expires in 12h');
    expect(expiryText(row({ status: 'DENIED' }), NOW)).toBe('');
  });
  it('offers only consent-free tools to workflows', () => {
    const consent = { ...tool, name: 'appointment.request' };
    const free = { ...tool, name: 'crm.note.add', requiresCustomerConsent: false };
    expect(workflowTools({ tools: [consent, free] }).map((t) => t.name)).toEqual(['crm.note.add']);
    expect(workflowTools(null)).toEqual([]);
  });
});
