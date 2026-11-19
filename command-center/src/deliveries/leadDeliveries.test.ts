import { describe, it, expect } from 'vitest';
import { LADDER, actorLabel, blockedReasonText, capability, isConfirmedInCrm, listPath, needsAttention, reconcileBody, routeReadiness, statusSummary, statusTone, tally, type LeadDeliveryRoute, type LeadDeliveryStatus } from './leadDeliveries';

const ALL: LeadDeliveryStatus[] = ['QUEUED', 'SENT', 'ACCEPTED', 'DELIVERED', 'CRM_PARSED', 'CRM_MATCHED', 'CRM_REJECTED', 'FAILED', 'DEAD', 'BLOCKED'];

describe('lead delivery ledger helpers', () => {
  it('only CRM_MATCHED counts as in the CRM, and only it gets the success tone', () => {
    for (const s of ALL) {
      expect(isConfirmedInCrm(s)).toBe(s === 'CRM_MATCHED');
      expect(statusTone(s) === 'ok').toBe(s === 'CRM_MATCHED');
    }
  });
  it('never words an unproven state as delivered to or in the CRM', () => {
    for (const s of ['QUEUED', 'SENT', 'ACCEPTED', 'DELIVERED', 'CRM_PARSED'] as LeadDeliveryStatus[]) {
      expect(statusSummary(s)).not.toMatch(/^Confirmed in CRM$/);
    }
    expect(statusSummary('ACCEPTED')).toMatch(/not confirmed in CRM/);
    expect(statusSummary('DELIVERED')).toMatch(/not confirmed in CRM/);
    expect(LADDER.find((l) => l.status === 'ACCEPTED')!.evidence).toMatch(/Not proof of delivery/);
  });
  it('keeps the ladder in evidence order', () => {
    expect(LADDER.map((l) => l.status)).toEqual(['QUEUED', 'SENT', 'ACCEPTED', 'DELIVERED', 'CRM_PARSED', 'CRM_MATCHED']);
  });
  it('flags the states staff must chase by hand', () => {
    expect(ALL.filter(needsAttention)).toEqual(['CRM_REJECTED', 'FAILED', 'DEAD', 'BLOCKED']);
  });
  it('explains block reasons in plain language and falls back to the code', () => {
    expect(blockedReasonText('route_unverified')).toMatch(/not been verified/);
    expect(blockedReasonText('something_new')).toBe('Reason code: something_new');
    expect(blockedReasonText(null)).toBe('No reason recorded.');
  });
  it('mirrors the server role rules', () => {
    expect(capability({ status: 'FAILED' }, 'ADMIN')).toEqual({ canReplay: true, canReconcile: false });
    expect(capability({ status: 'FAILED' }, 'MANAGER').canReplay).toBe(false);
    expect(capability({ status: 'ACCEPTED' }, 'MANAGER')).toEqual({ canReplay: false, canReconcile: true });
    expect(capability({ status: 'ACCEPTED' }, 'STAFF').canReconcile).toBe(false);
    expect(capability({ status: 'CRM_MATCHED' }, 'SUPER_ADMIN')).toEqual({ canReplay: false, canReconcile: false });
  });
  it('requires a CRM record reference to mark a lead as in the CRM', () => {
    expect(() => reconcileBody('CRM_MATCHED', '  ')).toThrow(/record reference/);
    expect(reconcileBody('CRM_MATCHED', ' OPP-1 ', ' checked ')).toEqual({ result: 'CRM_MATCHED', crmRecordRef: 'OPP-1', note: 'checked' });
    expect(reconcileBody('CRM_REJECTED')).toEqual({ result: 'CRM_REJECTED' });
  });
  it('builds list paths', () => {
    expect(listPath('ALL')).toBe('/ops/lead-deliveries');
    expect(listPath('BLOCKED', 'loc1')).toBe('/ops/lead-deliveries?status=BLOCKED&locationId=loc1');
  });
  it('describes route readiness without overstating it', () => {
    const base: LeadDeliveryRoute = { id: 'r', locationId: 'l', department: 'SALES', environment: 'PRODUCTION', enabled: true, destinationMasked: 'l***@d***.net', format: 'XML_BODY', verified: false, verifiedAt: null, productionEnabled: false };
    expect(routeReadiness(base)).toEqual({ label: 'Not verified — cannot send', tone: 'warn' });
    expect(routeReadiness({ ...base, verified: true }).label).toMatch(/not approved for live/);
    expect(routeReadiness({ ...base, verified: true, productionEnabled: true }).tone).toBe('ok');
    expect(routeReadiness({ ...base, environment: 'SANDBOX', verified: true }).label).toMatch(/Sandbox only/);
  });
  it('tallies without counting unproven deliveries as in the CRM', () => {
    expect(tally([{ status: 'ACCEPTED' }, { status: 'CRM_MATCHED' }, { status: 'BLOCKED' }, { status: 'DELIVERED' }])).toEqual({ total: 4, inCrm: 1, unconfirmed: 2, attention: 1 });
  });
  it('labels pipeline steps as automatic and only real staff actions as staff', () => {
    expect(actorLabel(null)).toBe('automatic');
    expect(actorLabel('system')).toBe('automatic');
    expect(actorLabel('system:outbox')).toBe('automatic');
    expect(actorLabel('cli:adf-sandbox-demo')).toBe('automatic');
    expect(actorLabel('cmwmxuser0001')).toBe('by staff');
  });
});
