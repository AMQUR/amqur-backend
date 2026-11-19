/** Group overview: shapes returned by GET /dealer-groups/:id/overview and pure display helpers. */
export type CapabilityStatus = 'LIVE VERIFIED' | 'SANDBOX VERIFIED' | 'DEMO' | 'BLOCKED' | 'NOT TESTED';
export type CapabilityCell = { status: CapabilityStatus; reason: string };
export type FunnelStageRow = { stage: string; count: number };
export type OverviewStore = {
  tenant: { id: string; slug: string; name: string };
  isGroupSite: boolean;
  funnel: {
    stages: FunnelStageRow[];
    notProven: { mailAcceptedSandboxOnly: number; appointmentsSandboxConfirmed: number; appointmentsStaffConfirmedNoReceipt: number };
    needsAttention: { crmRejected: number; blocked: number; failedOrDead: number; acceptedNotConfirmedInCrm: number };
  };
  capabilities: Record<string, CapabilityCell>;
};
export type GroupOverviewData = {
  dealerGroup: { id: string; name: string };
  windowDays: number;
  since: string;
  statuses: CapabilityStatus[];
  capabilityLabels: Record<string, string>;
  stores: OverviewStore[];
  totals: { stages: FunnelStageRow[]; notProven: OverviewStore['funnel']['notProven']; needsAttention: OverviewStore['funnel']['needsAttention'] };
  note: string;
};

/** Only a verified status gets the success tone. Demo is informational, never green. */
export function capabilityTone(s: CapabilityStatus): 'ok' | 'warn' | 'info' | 'neutral' {
  if (s === 'LIVE VERIFIED' || s === 'SANDBOX VERIFIED') return 'ok';
  if (s === 'DEMO') return 'info';
  if (s === 'BLOCKED') return 'warn';
  return 'neutral';
}

export const STAGE_LABEL: Record<string, string> = {
  LEAD_CREATED: 'Leads created',
  LEAD_QUEUED: 'Leads queued for CRM',
  MAIL_ACCEPTED: 'Mail accepted',
  CRM_RECEIVED: 'CRM received',
  CRM_MATCHED: 'CRM matched',
  APPOINTMENT_REQUESTED: 'Appointments requested',
  APPOINTMENT_CONFIRMED: 'Appointments confirmed by a provider',
};

export const stageCount = (rows: FunnelStageRow[], stage: string): number => rows.find((r) => r.stage === stage)?.count ?? 0;

/** Stores that take customers (the group's own site holds no leads of its own). */
export const rooftopsOf = (o: Pick<GroupOverviewData, 'stores'>): OverviewStore[] => o.stores.filter((s) => !s.isGroupSite);

/** How many stores are at each status for one capability, in the fixed status order. */
export function statusTally(o: Pick<GroupOverviewData, 'stores' | 'statuses'>, capability: string): Array<{ status: CapabilityStatus; stores: number }> {
  return o.statuses
    .map((status) => ({ status, stores: rooftopsOf(o).filter((s) => s.capabilities[capability]?.status === status).length }))
    .filter((t) => t.stores > 0);
}

/** Requests that are not provider-confirmed, per store: what staff still have to confirm. */
export function unconfirmedRequests(s: OverviewStore): number {
  return Math.max(0, stageCount(s.funnel.stages, 'APPOINTMENT_REQUESTED') - stageCount(s.funnel.stages, 'APPOINTMENT_CONFIRMED'));
}
