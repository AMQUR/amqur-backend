import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';
import { STAGE_LABEL, capabilityTone, rooftopsOf, stageCount, statusTally, unconfirmedRequests, type GroupOverviewData } from '../group/groupOverview';

const FUNNEL_ROWS = ['LEAD_CREATED', 'LEAD_QUEUED', 'MAIL_ACCEPTED', 'CRM_RECEIVED', 'CRM_MATCHED', 'APPOINTMENT_REQUESTED', 'APPOINTMENT_CONFIRMED'];

/**
 * Group overview: every store's lead and appointment funnel and its integration capability
 * matrix. Counts and status words only; a request is never shown as a confirmed booking and
 * test activity is listed apart.
 */
export function GroupOverview({ groupId, days }: { groupId: string; days: number }) {
  const overview = useAsync(() => api<GroupOverviewData>(`/dealer-groups/${groupId}/overview?days=${days}`), [groupId, days]);
  const o = overview.data;
  if (overview.error) return <ErrorNote error={overview.error} />;
  if (!o) return <p className="muted" aria-busy="true">Loading group overview…</p>;
  const stores = rooftopsOf(o);
  const capabilityKeys = Object.keys(o.capabilityLabels);

  return (
    <>
      <Card title={`Group funnel · since ${fmtDate(o.since)}`}>
        <p className="muted small">Each stage counts only what its own evidence proves. A requested appointment is not a confirmed one, and mail accepted is not a lead in the CRM.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <caption className="sr">Lead and appointment funnel by store</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                {stores.map((s) => <th scope="col" key={s.tenant.id}>{s.tenant.name}</th>)}
                <th scope="col">All stores</th>
              </tr>
            </thead>
            <tbody>
              {FUNNEL_ROWS.map((stage) => (
                <tr key={stage}>
                  <th scope="row">{STAGE_LABEL[stage] ?? stage}</th>
                  {stores.map((s) => <td key={s.tenant.id}>{stageCount(s.funnel.stages, stage)}</td>)}
                  <td><strong>{stageCount(o.totals.stages, stage)}</strong></td>
                </tr>
              ))}
              <tr>
                <th scope="row">Requests still to be confirmed</th>
                {stores.map((s) => <td key={s.tenant.id}>{unconfirmedRequests(s)}</td>)}
                <td><strong>{stores.reduce((n, s) => n + unconfirmedRequests(s), 0)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <dl className="row">
          <div><dt className="muted small">Accepted by mail, not confirmed in CRM</dt><dd>{o.totals.needsAttention.acceptedNotConfirmedInCrm}</dd></div>
          <div><dt className="muted small">Blocked, not sent</dt><dd>{o.totals.needsAttention.blocked}</dd></div>
          <div><dt className="muted small">Failed or stopped retrying</dt><dd>{o.totals.needsAttention.failedOrDead}</dd></div>
          <div><dt className="muted small">CRM rejected</dt><dd>{o.totals.needsAttention.crmRejected}</dd></div>
        </dl>
        <p className="muted small">
          Not counted above: {o.totals.notProven.mailAcceptedSandboxOnly} test deliveries, {o.totals.notProven.appointmentsSandboxConfirmed} demo-scheduler bookings, {o.totals.notProven.appointmentsStaffConfirmedNoReceipt} staff-confirmed without a provider receipt.
        </p>
      </Card>

      <Card title="Integration capability by store">
        <p className="muted small">
          Status comes from recorded evidence for that store, never from code being present. Verified means a real provider acknowledged a real transaction.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <caption className="sr">Integration capability matrix</caption>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                {stores.map((s) => <th scope="col" key={s.tenant.id}>{s.tenant.name}</th>)}
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {capabilityKeys.map((key) => (
                <tr key={key}>
                  <th scope="row">{o.capabilityLabels[key]}</th>
                  {stores.map((s) => {
                    const cell = s.capabilities[key];
                    return (
                      <td key={s.tenant.id}>
                        {cell ? (
                          <>
                            <Badge tone={capabilityTone(cell.status)}>{cell.status}</Badge>
                            <div className="muted small">{cell.reason}</div>
                          </>
                        ) : '—'}
                      </td>
                    );
                  })}
                  <td className="muted small">{statusTally(o, key).map((t) => `${t.stores} ${t.status}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{o.note}</p>
      </Card>
    </>
  );
}
