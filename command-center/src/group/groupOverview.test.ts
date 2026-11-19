import { describe, expect, it } from 'vitest';
import { capabilityTone, rooftopsOf, stageCount, statusTally, unconfirmedRequests, type GroupOverviewData, type OverviewStore } from './groupOverview';

const store = (name: string, over: Partial<OverviewStore> = {}): OverviewStore => ({
  tenant: { id: name, slug: name, name },
  isGroupSite: false,
  funnel: {
    stages: [{ stage: 'APPOINTMENT_REQUESTED', count: 5 }, { stage: 'APPOINTMENT_CONFIRMED', count: 2 }],
    notProven: { mailAcceptedSandboxOnly: 0, appointmentsSandboxConfirmed: 3, appointmentsStaffConfirmedNoReceipt: 0 },
    needsAttention: { crmRejected: 0, blocked: 0, failedOrDead: 0, acceptedNotConfirmedInCrm: 0 },
  },
  capabilities: { inventory: { status: 'DEMO', reason: 'Synthetic demo vehicles only.' } },
  ...over,
});
const data: Pick<GroupOverviewData, 'stores' | 'statuses'> = {
  statuses: ['LIVE VERIFIED', 'SANDBOX VERIFIED', 'DEMO', 'BLOCKED', 'NOT TESTED'],
  stores: [
    store('north'),
    store('south', { capabilities: { inventory: { status: 'BLOCKED', reason: 'No inventory feed is connected.' } } }),
    store('group', { isGroupSite: true }),
  ],
};

describe('group overview helpers', () => {
  it('only verified statuses are green; demo is never shown as success', () => {
    expect(capabilityTone('LIVE VERIFIED')).toBe('ok');
    expect(capabilityTone('SANDBOX VERIFIED')).toBe('ok');
    expect(capabilityTone('DEMO')).toBe('info');
    expect(capabilityTone('BLOCKED')).toBe('warn');
    expect(capabilityTone('NOT TESTED')).toBe('neutral');
  });
  it('leaves the group site out of store tallies', () => {
    expect(rooftopsOf(data).map((s) => s.tenant.name)).toEqual(['north', 'south']);
    expect(statusTally(data, 'inventory')).toEqual([{ status: 'DEMO', stores: 1 }, { status: 'BLOCKED', stores: 1 }]);
    expect(statusTally(data, 'missing')).toEqual([]);
  });
  it('keeps requests and provider confirmations apart', () => {
    expect(unconfirmedRequests(data.stores[0])).toBe(3);
    expect(stageCount(data.stores[0].funnel.stages, 'CRM_MATCHED')).toBe(0);
    expect(unconfirmedRequests(store('x', { funnel: { ...store('x').funnel, stages: [{ stage: 'APPOINTMENT_CONFIRMED', count: 9 }] } }))).toBe(0);
  });
});
